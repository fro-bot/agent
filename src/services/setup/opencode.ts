import type {Buffer} from 'node:buffer'
import type {ExecAdapter, Logger, OpenCodeInstallResult, PlatformInfo, ToolCacheAdapter} from './types.js'
import {createHash} from 'node:crypto'
import {createReadStream, readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {selectOpenCodeGeneration} from '@fro-bot/runtime'
import v2PinFile from '../../../packages/runtime/src/shared/opencode-v2-pin.json'
import {toErrorMessage} from '../../shared/errors.js'

const TOOL_NAME = 'opencode'
const DOWNLOAD_BASE_URL = 'https://github.com/anomalyco/opencode/releases/download'
const HARNESS_DOWNLOAD_BASE_URL = 'https://github.com/fro-bot/agent/releases/download'
const HARNESS_MARKER = '+harness.'

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
 * version, harness build or stock, is returned unchanged.
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
 * No Windows extension: `getPlatformInfo` rejects `win32` before any install runs, matching
 * `@fro.bot/harness`'s own supported matrix.
 */
export function opencodeBinaryPath(installDir: string): string {
  return path.join(installDir, TOOL_NAME)
}

/**
 * Semver-ish pattern for version validation (defense-in-depth, path-traversal guard).
 * Matches: 1.2.3, 1.2.3-rc.1, 1.2.3+harness.abc12345, 1.2.3-harness.abc12345
 * Rejects: anything with `/`, `..`, shell metacharacters, or other traversal sequences.
 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[.-][\w.-]+)?(?:\+[\w.-]+)?$/

/**
 * Returns true when the version string is a harness-pinned build.
 *
 * Harness versions use either the `+harness.<sha>` build-metadata suffix
 * (semver §10) or the equivalent `-harness.<sha>` prerelease suffix, e.g.
 * `1.17.3+harness.abc12345` or `1.17.3-harness.abc12345`. Both forms identify
 * fro-bot/agent harness releases; the hyphen form is also the public release-tag
 * form users may copy from GitHub.
 */
export function isHarnessVersion(version: string): boolean {
  return version.includes(HARNESS_MARKER) || version.includes('-harness.')
}

/**
 * Convert a harness build version to its prerelease representation.
 *
 * This form is used for both the @actions/tool-cache key and the harness release
 * tag. `@actions/tool-cache` passes the version through `semver.clean()` internally
 * (find, cacheDir, _createToolPath). `semver.clean('1.17.3+harness.2c9cdbd2')`
 * strips build-metadata and returns `'1.17.3'` — colliding with a stock 1.17.3
 * cache entry. Converting the `+harness.` build-metadata marker to `-harness.`
 * (a prerelease segment) preserves the full identity:
 * `semver.clean('1.17.3-harness.2c9cdbd2') === '1.17.3-harness.2c9cdbd2'`.
 * Release tags use the same prerelease segment so Renovate's stable-candidate
 * discovery excludes harness releases.
 *
 * Only the `+harness.` marker is converted — an already-prerelease `-harness.`
 * form and all other version forms are returned unchanged.
 */
export function toHarnessReleaseTag(version: string): string {
  return version.includes(HARNESS_MARKER) ? version.replace(HARNESS_MARKER, '-harness.') : version
}

/**
 * Convert a version string to the form used by @actions/tool-cache.
 *
 * This delegates to `toHarnessReleaseTag`; the cache behavior is intentionally
 * unchanged, including leaving non-harness versions untouched.
 */
export function toolCacheVersion(version: string): string {
  return toHarnessReleaseTag(version)
}

/**
 * Returns true when the version's major is 2 or higher (a V2 pin), with or without a `v` prefix.
 *
 * The rule is the runtime's `selectOpenCodeGeneration`, the one selector every caller shares. Anything it cannot read
 * (e.g. `latest`) is not a V2 pin.
 */
export function isV2Version(version: string): boolean {
  const generation = selectOpenCodeGeneration(version)
  return generation.success && generation.data === 'v2'
}

/**
 * A stock (anomalyco/opencode) V2 pin. Harness builds keep their own, already fail-closed, path
 * regardless of major.
 */
export function isStockV2Pin(version: string): boolean {
  return isV2Version(version) && !isHarnessVersion(version)
}

/**
 * Get platform information for binary downloads.
 */
export function getPlatformInfo(): PlatformInfo {
  const platform = os.platform()
  const arch = os.arch()

  // Fail here rather than three layers down, and gate both halves — the message promises both.
  // The harness publishes linux/darwin × x64/arm64 only (`packages/harness/src/platform.ts`), and
  // the default OpenCode version is a harness build, so an unsupported platform would otherwise
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
 * Encode a harness version string as a URL-safe release tag.
 *
 * Harness release tags are NON-v-prefixed (e.g. `1.17.3-harness.<sha>`).
 * Strips any leading `v` and percent-encodes any `+` as `%2B` so this helper
 * remains safe for legacy tags — GitHub stores tags URL-encoded and a raw `+`
 * is misread as a space. Current harness callers map `+harness.` to
 * `-harness.` before reaching this function.
 */
function encodeHarnessTag(version: string): string {
  const rawTag = version.startsWith('v') ? version.slice(1) : version
  return rawTag.replaceAll('+', '%2B')
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
 * Build download URL for OpenCode binary.
 *
 * Harness-pinned versions (containing `+harness.` or `-harness.`) are routed
 * to the fro-bot/agent releases. Their release tag is derived with
 * `toHarnessReleaseTag`, which maps the `+harness.` input form to the
 * `-harness.` release-tag form and leaves an existing hyphen form unchanged.
 * Stock versions route to anomalyco/opencode
 * with no encoding changes.
 *
 * Throws if the version does not match the semver-ish pattern (path-traversal guard).
 */
export function buildDownloadUrl(version: string, info: PlatformInfo): string {
  assertValidVersion(version)

  const filename = `opencode-${info.os}-${info.arch}${info.ext}`

  if (isHarnessVersion(version)) {
    const encodedTag = encodeHarnessTag(toHarnessReleaseTag(version))
    return `${HARNESS_DOWNLOAD_BASE_URL}/${encodedTag}/${filename}`
  }

  const versionTag = version.startsWith('v') ? version : `v${version}`
  return `${DOWNLOAD_BASE_URL}/${versionTag}/${filename}`
}

/**
 * Build the SHA256SUMS asset URL for a harness or stock V2 release.
 *
 * The SHA256SUMS file lives in the same release as the archive, at the same
 * base URL but with filename `SHA256SUMS`. The release tag is derived with
 * `toHarnessReleaseTag`, matching `buildDownloadUrl`.
 *
 * Throws if `version` is neither a harness version nor a stock V2 version —
 * stock releases below V2 publish no SHA256SUMS.
 */
export function buildChecksumsUrl(version: string): string {
  assertValidVersion(version)
  if (isStockV2Pin(version)) {
    const versionTag = version.startsWith('v') ? version : `v${version}`
    return `${DOWNLOAD_BASE_URL}/${versionTag}/SHA256SUMS`
  }
  if (!isHarnessVersion(version)) {
    throw new Error('buildChecksumsUrl requires a harness version (must contain +harness. or -harness.)')
  }
  const encodedTag = encodeHarnessTag(toHarnessReleaseTag(version))
  return `${HARNESS_DOWNLOAD_BASE_URL}/${encodedTag}/SHA256SUMS`
}

/**
 * Verify an archive against the release's SHA256SUMS file.
 *
 * Downloads the SHA256SUMS asset from the same release, reads it with node:fs,
 * computes the archive's sha256 with node:crypto, and asserts the hashes match
 * for this platform's asset filename. Throws on mismatch or missing line.
 *
 * Called for harness versions and for stock V2 pins (`buildChecksumsUrl` throws
 * for any other version — stock releases below V2 publish no SHA256SUMS).
 *
 * `recordedDigest` is passed only for a stock V2 pin: the SHA256SUMS line must
 * ALSO equal the digest recorded in the repo, so replacing the archive and
 * SHA256SUMS together upstream is not enough to pass.
 *
 * No shell commands (cat, shasum) are used — platform-independent by design.
 */
async function verifyHarnessChecksum(
  archivePath: string,
  version: string,
  platformInfo: PlatformInfo,
  toolCache: ToolCacheAdapter,
  logger: Logger,
  recordedDigest?: string,
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

  if (recordedDigest !== undefined && expectedHash.toLowerCase() !== recordedDigest.toLowerCase()) {
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
 * This is the only check on STOCK (anomalyco/opencode) V1 downloads. Harness
 * downloads use `verifyHarnessChecksum` instead; a stock V2 pin runs both.
 *
 * `failClosed` (stock V2 pins): a check that cannot run THROWS instead of
 * passing, so a missing `file` binary never counts as a valid archive.
 */
async function validateDownload(
  downloadPath: string,
  ext: string,
  logger: Logger,
  execAdapter: ExecAdapter,
  failClosed = false,
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
    if (failClosed) {
      throw new Error(`Could not validate download (file command unavailable): ${toErrorMessage(error)}`)
    }
    logger.debug('Could not validate download (file command unavailable)')
    return true // Assume valid if we can't check
  }
}

/**
 * Install OpenCode CLI. There is no fallback: the caller has already chosen V1 or V2 setup, caches and session keys
 * from the requested version, so a binary of the other generation would run against the wrong setup.
 *
 * V1 requests (a harness build, or a stock version below V2) fail closed. Any download, checksum or
 * validation failure THROWS an error naming the requested version and the reason: a harness pin must resolve to
 * the exact harness binary, and a stock V1 failure must not turn into a V2 install.
 *
 * V2 requests (major 2 or higher) install through `installStockV2`, digest-verified or throwing, with no retry. A V2
 * version with no recorded digest never reaches here: `runSetup` rejects it first.
 */
export async function installOpenCode(
  version: string,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  v2Pin: V2Pin = RECORDED_V2_PIN,
): Promise<OpenCodeInstallResult> {
  const platformInfo = getPlatformInfo()

  if (isStockV2Pin(version)) {
    return installStockV2(version, platformInfo, logger, toolCache, execAdapter, v2Pin)
  }

  // Check cache first
  const cachedPath = toolCache.find(TOOL_NAME, toolCacheVersion(version), platformInfo.arch)
  if (cachedPath.length > 0) {
    logger.info('OpenCode found in cache', {version, path: cachedPath})
    return {path: cachedPath, version, cached: true}
  }

  try {
    return await downloadAndInstall(version, platformInfo, logger, toolCache, execAdapter)
  } catch (error) {
    if (isHarnessVersion(version)) {
      throw new Error(
        `Harness OpenCode download/verify failed for explicit pin "${version}": ${toErrorMessage(error)}. ` +
          `No fallback is attempted for an explicit harness pin (fail-closed).`,
      )
    }
    throw new Error(
      `Failed to install OpenCode ${version}: ${toErrorMessage(error)}. ` +
        `No fallback is attempted for a V1 request: the V2 pin is a different generation (fail-closed).`,
    )
  }
}

/**
 * What a stock V2 pin is allowed to install on this platform, and the cache identity that binds any
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
 * The returned identity ties every reusable V2 installation to the recorded digest. An entry cached
 * under the bare version by an earlier release, or under a different digest, can never match it.
 * V1 and harness pins keep their existing identities; this applies to stock V2 only.
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
  v2Install?: Pick<StockV2Policy, 'recordedDigest' | 'cacheVersion'>,
): Promise<OpenCodeInstallResult> {
  logger.info('Downloading OpenCode', {version})
  const downloadUrl = buildDownloadUrl(version, platformInfo)
  const downloadPath = await toolCache.downloadTool(downloadUrl)

  if (v2Install !== undefined) {
    // Stock V2 pin: digest + SHA256SUMS verification, then a magic-byte check that cannot be skipped.
    await verifyHarnessChecksum(downloadPath, version, platformInfo, toolCache, logger, v2Install.recordedDigest)
    const isValid = await validateDownload(downloadPath, platformInfo.ext, logger, execAdapter, true)
    if (!isValid) {
      throw new Error('Downloaded archive appears corrupted')
    }
  } else if (isHarnessVersion(version)) {
    // Harness releases publish a SHA256SUMS asset — verify before extraction.
    // execAdapter is not passed: verification uses node:crypto + node:fs only.
    await verifyHarnessChecksum(downloadPath, version, platformInfo, toolCache, logger)
  } else {
    // Stock releases below V2: use magic-byte check only (no SHA256SUMS asset exists).
    const isValid = await validateDownload(downloadPath, platformInfo.ext, logger, execAdapter)
    if (!isValid) {
      throw new Error('Downloaded archive appears corrupted')
    }
  }

  logger.info('Extracting OpenCode')
  const extractedPath =
    platformInfo.ext === '.zip' ? await toolCache.extractZip(downloadPath) : await toolCache.extractTar(downloadPath)

  logger.info('Caching OpenCode')
  const toolPath = await toolCache.cacheDir(
    extractedPath,
    TOOL_NAME,
    v2Install?.cacheVersion ?? toolCacheVersion(version),
    platformInfo.arch,
  )

  logger.info('OpenCode installed', {version, path: toolPath})
  return {path: toolPath, version, cached: false}
}
