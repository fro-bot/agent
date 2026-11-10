import type {Buffer} from 'node:buffer'
import type {ExecAdapter, Logger, OpenCodeInstallResult, PlatformInfo, ToolCacheAdapter} from './types.js'
import {createHash} from 'node:crypto'
import {createReadStream, readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import v2PinFile from '../../../packages/runtime/src/shared/opencode-v2-pin.json'
import {toErrorMessage} from '../../shared/errors.js'

const TOOL_NAME = 'opencode'
const DOWNLOAD_BASE_URL = 'https://github.com/anomalyco/opencode/releases/download'

/**
 * The pinned stock V2 release: its version and the sha256 of each asset we install.
 *
 * `packages/runtime/src/shared/opencode-v2-pin.json` is the single source. `deploy/workspace.Dockerfile`
 * reads the same file in its `opencode-v2` build stage, so a digest is never copied by hand. A V2 pin
 * installs only when the archive matches the digest recorded here AND the release's `SHA256SUMS` line.
 */
export interface V2Pin {
  readonly version: string
  readonly assets: Readonly<Record<string, string>>
}

export const RECORDED_V2_PIN: V2Pin = v2PinFile

/**
 * Resolve the requested `opencode-version`. `latest` means the recorded V2 pin: no network lookup, so it never
 * follows upstream's `releases/latest` (an unverified stock release with no recorded digest). Any explicit
 * version is returned unchanged; `resolveStockV2Policy` then accepts only the pin.
 */
export function resolveRequestedVersion(requested: string, v2Pin: V2Pin = RECORDED_V2_PIN): string {
  return requested === 'latest' ? v2Pin.version : requested
}

/** Hex characters of the recorded digest used in V2 cache identities (64 bits: collision-proof for a pin). */
const V2_CACHE_DIGEST_LENGTH = 16

/**
 * Resolves the OpenCode executable inside an install directory.
 *
 * `OpenCodeInstallResult.path` is the tool-cache DIRECTORY — what `tc.cacheDir`/`tc.find` return
 * and what `core.addPath` expects. Spawning it directly fails with EACCES. Callers that need an
 * executable must go through here rather than passing the directory to a child process.
 *
 * No Windows extension: `getPlatformInfo` rejects `win32` before any install runs.
 */
export function opencodeBinaryPath(installDir: string): string {
  return path.join(installDir, TOOL_NAME)
}

/**
 * Semver-ish pattern for version validation (defense-in-depth, path-traversal guard).
 * Matches: 2.2.6, 2.2.6-rc.1, 2.2.6+build.1
 * Rejects: anything with `/`, `..`, shell metacharacters, or other traversal sequences.
 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[.-][\w.-]+)?(?:\+[\w.-]+)?$/

/**
 * Get platform information for binary downloads.
 */
export function getPlatformInfo(): PlatformInfo {
  const platform = os.platform()
  const arch = os.arch()

  // The release publishes linux/darwin × x64/arm64 only, so an unsupported platform would otherwise
  // name an asset that is never published, and an unsupported arch would silently resolve to the
  // x64 asset and download a binary that cannot execute. Both surfaced with no indication that
  // the platform was the problem.
  if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'x64' && arch !== 'arm64')) {
    throw new Error(
      `Unsupported platform: ${platform}/${arch}. This action supports linux/darwin × x64/arm64 only (no windows).`,
    )
  }

  // macOS uses .zip, Linux uses .tar.gz
  const ext = platform === 'darwin' ? '.zip' : '.tar.gz'

  return {
    os: platform,
    arch,
    ext,
  }
}

/**
 * Validate that a version string is semver-ish (defense-in-depth, path-traversal guard).
 *
 * Throws if the version contains `/`, `..`, or any character outside the allowed set.
 * Called before constructing download URLs.
 */
function assertValidVersion(version: string): void {
  // Strip leading 'v' before matching (the pattern covers the numeric part only)
  const bare = version.startsWith('v') ? version.slice(1) : version
  if (!SEMVER_PATTERN.test(bare)) {
    throw new Error(
      `Invalid version string: "${version}". Must match semver-ish pattern (no path traversal or shell metacharacters).`,
    )
  }
}

/**
 * Build the download URL for an OpenCode release asset (anomalyco/opencode, no encoding changes).
 *
 * Throws if the version does not match the semver-ish pattern (path-traversal guard).
 */
export function buildDownloadUrl(version: string, info: PlatformInfo): string {
  assertValidVersion(version)

  const filename = `opencode-${info.os}-${info.arch}${info.ext}`
  const versionTag = version.startsWith('v') ? version : `v${version}`
  return `${DOWNLOAD_BASE_URL}/${versionTag}/${filename}`
}

/**
 * Build the SHA256SUMS asset URL for a release.
 *
 * The SHA256SUMS file lives in the same release as the archive, at the same
 * base URL but with filename `SHA256SUMS`.
 *
 * Throws if the version does not match the semver-ish pattern (path-traversal guard).
 */
export function buildChecksumsUrl(version: string): string {
  assertValidVersion(version)
  const versionTag = version.startsWith('v') ? version : `v${version}`
  return `${DOWNLOAD_BASE_URL}/${versionTag}/SHA256SUMS`
}

/**
 * Verify an archive against the release's SHA256SUMS file.
 *
 * Downloads the SHA256SUMS asset from the same release, reads it with node:fs,
 * computes the archive's sha256 with node:crypto, and asserts the hashes match
 * for this platform's asset filename. Throws on mismatch or missing line.
 *
 * `recordedDigest`: the SHA256SUMS line must ALSO equal the digest recorded in
 * the repo, so replacing the archive and SHA256SUMS together upstream is not
 * enough to pass.
 *
 * No shell commands (cat, shasum) are used — platform-independent by design.
 */
async function verifyChecksum(
  archivePath: string,
  version: string,
  platformInfo: PlatformInfo,
  toolCache: ToolCacheAdapter,
  logger: Logger,
  recordedDigest: string,
): Promise<void> {
  const checksumsUrl = buildChecksumsUrl(version)
  logger.debug('Downloading SHA256SUMS for release', {url: checksumsUrl})

  const checksumsPath = await toolCache.downloadTool(checksumsUrl)

  // Read the checksums file with node:fs (no shell dependency)
  const checksumsContent = readFileSync(checksumsPath, 'utf8')

  // Find the line for this platform's archive filename (exact filename match, not endsWith)
  const archiveFilename = `opencode-${platformInfo.os}-${platformInfo.arch}${platformInfo.ext}`
  const matchingLine = checksumsContent
    .split('\n')
    .map(line => line.trim())
    .find(line => {
      const parts = line.split(/\s+/)
      return parts.length >= 2 && parts.at(-1) === archiveFilename
    })

  if (matchingLine === undefined) {
    throw new Error(`SHA256SUMS does not contain an entry for ${archiveFilename}`)
  }

  // SHA256SUMS format: "<hash>  <filename>"
  const expectedHash = matchingLine.split(/\s+/)[0]
  if (expectedHash === undefined || expectedHash.length === 0) {
    throw new Error(`Could not parse hash from SHA256SUMS line: ${matchingLine}`)
  }

  if (expectedHash.toLowerCase() !== recordedDigest.toLowerCase()) {
    throw new Error(
      `SHA256SUMS entry for ${archiveFilename} disagrees with the recorded digest: ` +
        `SHA256SUMS has ${expectedHash}, recorded ${recordedDigest}`,
    )
  }

  // Compute the archive's sha256 with node:crypto via streaming (no shell dependency, no full-file buffer)
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(archivePath)
    stream.on('error', reject)
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk)
    })
    stream.on('end', () => {
      resolve()
    })
  })
  const actualHash = hash.digest('hex')

  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`SHA256 mismatch for ${archiveFilename}: expected ${expectedHash}, got ${actualHash}`)
  }

  logger.debug('Archive SHA256 verified', {filename: archiveFilename, hash: actualHash})
}

/**
 * Validate downloaded archive is not corrupted.
 * Uses `file` command on Unix to check file type.
 *
 * Fail closed: a check that cannot run THROWS instead of passing, so a missing
 * `file` binary never counts as a valid archive.
 */
async function validateDownload(
  downloadPath: string,
  ext: string,
  logger: Logger,
  execAdapter: ExecAdapter,
): Promise<boolean> {
  try {
    const {stdout} = await execAdapter.getExecOutput('file', [downloadPath], {silent: true})

    const expectedTypes = ext === '.zip' ? ['Zip archive', 'ZIP'] : ['gzip', 'tar', 'compressed']
    const isValid = expectedTypes.some(type => stdout.includes(type))

    if (!isValid) {
      logger.warning('Download validation failed', {output: stdout.trim()})
    }
    return isValid
  } catch (error) {
    throw new Error(`Could not validate download (file command unavailable): ${toErrorMessage(error)}`)
  }
}

/**
 * Install the OpenCode CLI. Only the pinned stock V2 release installs: the digest-bound policy runs first, so a
 * version or platform with no recorded digest fails before any cache lookup or download. Every failure throws, with
 * no fallback to another version.
 */
export async function installOpenCode(
  version: string,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  v2Pin: V2Pin = RECORDED_V2_PIN,
): Promise<OpenCodeInstallResult> {
  return installStockV2(version, getPlatformInfo(), logger, toolCache, execAdapter, v2Pin)
}

/**
 * What the pinned release is allowed to install on this platform, and the cache identity that binds any
 * reusable installation to the recorded digest.
 */
export interface StockV2Policy {
  /** The sha256 recorded for this platform's asset. */
  readonly recordedDigest: string
  /** `sha256-<first 16 hex of the digest>`: the digest component of every V2 cache key. */
  readonly cacheId: string
  /** `<version>-<cacheId>`: the @actions/tool-cache version. A prerelease, so semver keeps it whole. */
  readonly cacheVersion: string
}

/**
 * Enforce the V2 pin policy: the version must be the recorded one and this platform must have a
 * recorded digest. Call it BEFORE consulting any cache (the local tool cache or the persistent tools
 * cache): a cache hit must never be accepted for a version or platform the pin does not cover.
 *
 * The returned identity ties every reusable installation to the recorded digest. An entry cached
 * under the bare version by an earlier release, or under a different digest, can never match it.
 */
export function resolveStockV2Policy(version: string, platformInfo: PlatformInfo, v2Pin: V2Pin): StockV2Policy {
  const bareVersion = version.startsWith('v') ? version.slice(1) : version
  if (bareVersion !== v2Pin.version) {
    throw new Error(
      `OpenCode ${version} is a V2 pin with no recorded digest: only ${v2Pin.version} is pinned in ` +
        `opencode-v2-pin.json. Record the digests for ${bareVersion} there before using it.`,
    )
  }

  const archiveFilename = `opencode-${platformInfo.os}-${platformInfo.arch}${platformInfo.ext}`
  const recordedDigest = v2Pin.assets[archiveFilename]
  if (recordedDigest === undefined) {
    throw new Error(`OpenCode ${version} has no recorded digest for ${archiveFilename} in opencode-v2-pin.json`)
  }

  const cacheId = `sha256-${recordedDigest.slice(0, V2_CACHE_DIGEST_LENGTH).toLowerCase()}`
  return {recordedDigest, cacheId, cacheVersion: `${bareVersion}-${cacheId}`}
}

/**
 * Install a stock V2 pin. Integrity over availability: the install succeeds only for the version
 * recorded in `v2Pin`, with an archive that matches the recorded digest and the release's
 * SHA256SUMS line, and that `file` recognises as the expected archive type. Every failure throws.
 * There is no retry here and no check that passes because it could not run.
 *
 * The pin policy runs first, so a version or platform with no recorded digest fails before any
 * cache lookup or download. The local tool cache is keyed by the digest-bound version: entries
 * cached before digests were recorded, or for another digest, are never reused.
 */
async function installStockV2(
  version: string,
  platformInfo: PlatformInfo,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  v2Pin: V2Pin,
): Promise<OpenCodeInstallResult> {
  const {recordedDigest, cacheVersion} = resolveStockV2Policy(version, platformInfo, v2Pin)

  const cachedPath = toolCache.find(TOOL_NAME, cacheVersion, platformInfo.arch)
  if (cachedPath.length > 0) {
    logger.info('OpenCode found in cache', {version, path: cachedPath})
    return {path: cachedPath, version, cached: true}
  }

  try {
    return await downloadAndInstall(version, platformInfo, logger, toolCache, execAdapter, {
      recordedDigest,
      cacheVersion,
    })
  } catch (error) {
    throw new Error(
      `Stock V2 OpenCode download/verify failed for pin "${version}": ${toErrorMessage(error)}. ` +
        `No fallback is attempted for a V2 pin (fail-closed).`,
    )
  }
}

async function downloadAndInstall(
  version: string,
  platformInfo: PlatformInfo,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  install: Pick<StockV2Policy, 'recordedDigest' | 'cacheVersion'>,
): Promise<OpenCodeInstallResult> {
  logger.info('Downloading OpenCode', {version})
  const downloadUrl = buildDownloadUrl(version, platformInfo)
  const downloadPath = await toolCache.downloadTool(downloadUrl)

  // Digest + SHA256SUMS verification, then a magic-byte check that cannot be skipped.
  await verifyChecksum(downloadPath, version, platformInfo, toolCache, logger, install.recordedDigest)
  const isValid = await validateDownload(downloadPath, platformInfo.ext, logger, execAdapter)
  if (!isValid) {
    throw new Error('Downloaded archive appears corrupted')
  }

  logger.info('Extracting OpenCode')
  const extractedPath =
    platformInfo.ext === '.zip' ? await toolCache.extractZip(downloadPath) : await toolCache.extractTar(downloadPath)

  logger.info('Caching OpenCode')
  const toolPath = await toolCache.cacheDir(extractedPath, TOOL_NAME, install.cacheVersion, platformInfo.arch)

  logger.info('OpenCode installed', {version, path: toolPath})
  return {path: toolPath, version, cached: false}
}
