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
const HARNESS_DOWNLOAD_BASE_URL = 'https://github.com/fro-bot/agent/releases/download'
const HARNESS_MARKER = '+harness.'

/**
 * Known stable stock version for fallback when latest-fetch fails or for non-harness paths.
 * This is a plain anomalyco/opencode release — not a harness build.
 */
export const FALLBACK_VERSION = '1.19.4'

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
 * Anything that does not start with a numeric major (e.g. `latest`) is not a V2 pin.
 */
export function isV2Version(version: string): boolean {
  const major = /^v?(\d+)\./.exec(version)?.[1]
  return major !== undefined && Number(major) >= 2
}

/**
 * A stock (anomalyco/opencode) V2 pin. Harness builds keep their own, already fail-closed, path
 * regardless of major.
 */
function isStockV2Pin(version: string): boolean {
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
 * Install OpenCode CLI with version fallback.
 *
 * For explicit harness pins (`isHarnessVersion(version) === true`), any
 * download or checksum failure THROWS immediately — no stock fallback is
 * attempted. Integrity over availability: a harness pin must resolve to the
 * exact harness binary or fail closed.
 *
 * For stock V2 pins (major 2 or higher), see `installStockV2`: digest-verified
 * or it throws, with no fallback.
 *
 * For stock versions below V2, falls back to the known stable FALLBACK_VERSION
 * on failure.
 */
export async function installOpenCode(
  version: string,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  fallbackVersion: string = FALLBACK_VERSION,
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

  // Try primary version
  try {
    const result = await downloadAndInstall(version, platformInfo, logger, toolCache, execAdapter)
    return result
  } catch (error) {
    if (isHarnessVersion(version)) {
      // Fail closed: harness pins must not silently downgrade to stock OpenCode.
      // A checksum mismatch, missing SHA256SUMS, or network error on a harness pin
      // is a hard failure — throw immediately, no fallback.
      throw new Error(
        `Harness OpenCode download/verify failed for explicit pin "${version}": ${toErrorMessage(error)}. ` +
          `No stock fallback is attempted for an explicit harness pin (fail-closed).`,
      )
    }

    logger.warning('Primary version install failed, trying fallback', {
      requestedVersion: version,
      fallbackVersion,
      error: toErrorMessage(error),
    })
  }

  // Fallback to known stable version (stock versions only — harness pins throw above)
  if (version !== fallbackVersion) {
    try {
      const result = await downloadAndInstall(fallbackVersion, platformInfo, logger, toolCache, execAdapter)
      logger.info('Installed fallback version', {version: fallbackVersion})
      return result
    } catch (error) {
      throw new Error(`Failed to install OpenCode (tried ${version} and ${fallbackVersion}): ${toErrorMessage(error)}`)
    }
  }

  throw new Error(`Failed to install OpenCode version ${version}`)
}

/**
 * Install a stock V2 pin. Integrity over availability: the install succeeds only for the version
 * recorded in `v2Pin`, with an archive that matches the recorded digest and the release's
 * SHA256SUMS line, and that `file` recognises as the expected archive type. Every failure throws.
 * There is no FALLBACK_VERSION retry and no check that passes because it could not run.
 *
 * A version or platform with no recorded digest fails before anything is downloaded.
 */
async function installStockV2(
  version: string,
  platformInfo: PlatformInfo,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  v2Pin: V2Pin,
): Promise<OpenCodeInstallResult> {
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

  const cachedPath = toolCache.find(TOOL_NAME, toolCacheVersion(version), platformInfo.arch)
  if (cachedPath.length > 0) {
    logger.info('OpenCode found in cache', {version, path: cachedPath})
    return {path: cachedPath, version, cached: true}
  }

  try {
    return await downloadAndInstall(version, platformInfo, logger, toolCache, execAdapter, recordedDigest)
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
  v2RecordedDigest?: string,
): Promise<OpenCodeInstallResult> {
  logger.info('Downloading OpenCode', {version})
  const downloadUrl = buildDownloadUrl(version, platformInfo)
  const downloadPath = await toolCache.downloadTool(downloadUrl)

  if (v2RecordedDigest !== undefined) {
    // Stock V2 pin: digest + SHA256SUMS verification, then a magic-byte check that cannot be skipped.
    await verifyHarnessChecksum(downloadPath, version, platformInfo, toolCache, logger, v2RecordedDigest)
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
  const toolPath = await toolCache.cacheDir(extractedPath, TOOL_NAME, toolCacheVersion(version), platformInfo.arch)

  logger.info('OpenCode installed', {version, path: toolPath})
  return {path: toolPath, version, cached: false}
}

/**
 * Fetch latest OpenCode version from GitHub API.
 *
 * This function is the STOCK-latest resolver — it only makes sense for
 * anomalyco/opencode stock releases. It must never be called with a harness
 * pin, because harness versions are already fully-qualified and have no
 * "latest" concept on the stock release feed.
 *
 * Guard: if `pinnedVersion` is provided and is a harness pin, return it
 * unchanged without fetching. This covers any future call-site that might
 * inadvertently pass a harness pin through the "resolve latest" path.
 *
 * Current call-site analysis (setup.ts ~line 43): `getLatestVersion` is only
 * called when `version === 'latest'`. A harness pin like `1.17.3+harness.x`
 * never equals `'latest'`, so the guard is a belt-and-suspenders safety net.
 *
 * @param logger - Logger instance for diagnostics.
 * @param pinnedVersion - Optional already-resolved version; if harness-pinned,
 *   returned immediately without a network call.
 */
export async function getLatestVersion(logger: Logger, pinnedVersion?: string): Promise<string> {
  // Guard: harness pins are fully-qualified — never route them to stock latest.
  if (pinnedVersion !== undefined && isHarnessVersion(pinnedVersion)) {
    logger.debug('Skipping stock latest fetch for harness-pinned version', {version: pinnedVersion})
    return pinnedVersion
  }

  const response = await fetch('https://api.github.com/repos/anomalyco/opencode/releases/latest')
  if (!response.ok) {
    throw new Error(`Failed to fetch latest OpenCode version: ${response.statusText}`)
  }
  const data = (await response.json()) as {tag_name: string}
  const version = data.tag_name.replace(/^v/, '')
  logger.info('Latest OpenCode version', {version})
  return version
}
