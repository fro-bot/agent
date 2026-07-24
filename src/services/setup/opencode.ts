import type {Buffer} from 'node:buffer'
import type {ExecAdapter, Logger, OpenCodeInstallResult, PlatformInfo, ToolCacheAdapter} from './types.js'
import {createHash} from 'node:crypto'
import {createReadStream, readFileSync} from 'node:fs'
import os from 'node:os'
import process from 'node:process'

import {toErrorMessage} from '../../shared/errors.js'

const TOOL_NAME = 'opencode'
const DOWNLOAD_BASE_URL = 'https://github.com/anomalyco/opencode/releases/download'
const HARNESS_DOWNLOAD_BASE_URL = 'https://github.com/fro-bot/agent/releases/download'
const HARNESS_MARKER = '+harness.'

/**
 * Known stable stock version for fallback when latest-fetch fails or for non-harness paths.
 * This is a plain anomalyco/opencode release — not a harness build.
 */
export const FALLBACK_VERSION = '1.18.4'

/**
 * Semver-ish pattern for version validation (defense-in-depth, path-traversal guard).
 * Matches: 1.2.3, 1.2.3-rc.1, 1.2.3+harness.abc12345, 1.2.3+harness.abc12345-extra
 * Rejects: anything with `/`, `..`, shell metacharacters, or other traversal sequences.
 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[.-][\w.-]+)?(?:\+[\w.-]+)?$/

/**
 * Returns true when the version string is a harness-pinned build.
 *
 * Harness versions use the `+harness.<sha>` build-metadata suffix (semver §10),
 * e.g. `1.17.3+harness.abc12345`. The `+` form is the binary/release form used
 * by fro-bot/agent releases. The npm-compatible hyphen form (`1.17.3-harness.x`)
 * is intentionally NOT treated as a harness version here.
 */
export function isHarnessVersion(version: string): boolean {
  return version.includes(HARNESS_MARKER)
}

/**
 * Convert a version string to a form safe for @actions/tool-cache.
 *
 * `@actions/tool-cache` passes the version through `semver.clean()` internally
 * (find, cacheDir, _createToolPath). `semver.clean('1.17.3+harness.2c9cdbd2')`
 * strips build-metadata and returns `'1.17.3'` — colliding with a stock 1.17.3
 * cache entry. Converting the `+harness.` build-metadata marker to `-harness.`
 * (a prerelease segment) preserves the full identity:
 * `semver.clean('1.17.3-harness.2c9cdbd2') === '1.17.3-harness.2c9cdbd2'`.
 *
 * Only the `+harness.` marker is converted — all other version forms are
 * returned unchanged. Use this ONLY at tool-cache call sites (find, cacheDir).
 * Download URLs, checksums, return values, and logs must keep the raw `+harness.`
 * form.
 */
export function toolCacheVersion(version: string): string {
  return version.includes(HARNESS_MARKER) ? version.replace(HARNESS_MARKER, '-harness.') : version
}

/**
 * Get platform information for binary downloads.
 */
export function getPlatformInfo(): PlatformInfo {
  const platform = os.platform()
  const arch = os.arch()

  const osMap: Partial<Record<NodeJS.Platform, string>> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows',
  }

  const archMap: Partial<Record<NodeJS.Architecture, string>> = {
    x64: 'x64',
    arm64: 'arm64',
  }

  // macOS and Windows use .zip, Linux uses .tar.gz
  const ext = platform === 'win32' || platform === 'darwin' ? '.zip' : '.tar.gz'

  return {
    os: osMap[platform] ?? 'linux',
    arch: archMap[arch] ?? 'x64',
    ext,
  }
}

/**
 * Encode a harness version string as a URL-safe release tag.
 *
 * Harness release tags are NON-v-prefixed (e.g. `1.17.3+harness.<sha>`).
 * Strips any leading `v` and percent-encodes `+` as `%2B` so the URL path
 * segment is valid — GitHub stores tags URL-encoded and a raw `+` is
 * misread as a space.
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
 * Harness-pinned versions (containing `+harness.`) are routed to the
 * fro-bot/agent releases. The `+` in the version tag MUST be percent-encoded
 * as `%2B` in the URL path segment — GitHub stores the tag URL-encoded and a
 * raw `+` is misread as a space. Stock versions route to anomalyco/opencode
 * with no encoding changes.
 *
 * Throws if the version does not match the semver-ish pattern (path-traversal guard).
 */
export function buildDownloadUrl(version: string, info: PlatformInfo): string {
  assertValidVersion(version)

  const filename = `opencode-${info.os}-${info.arch}${info.ext}`

  if (isHarnessVersion(version)) {
    const encodedTag = encodeHarnessTag(version)
    return `${HARNESS_DOWNLOAD_BASE_URL}/${encodedTag}/${filename}`
  }

  const versionTag = version.startsWith('v') ? version : `v${version}`
  return `${DOWNLOAD_BASE_URL}/${versionTag}/${filename}`
}

/**
 * Build the SHA256SUMS asset URL for a harness release.
 *
 * The SHA256SUMS file lives in the same release as the archive, at the same
 * base URL but with filename `SHA256SUMS`. The `+` in the version tag is
 * percent-encoded as `%2B` (same as in `buildDownloadUrl`).
 *
 * Throws if `version` is not a harness version — SHA256SUMS only exists for
 * harness releases.
 */
export function buildChecksumsUrl(version: string): string {
  assertValidVersion(version)
  if (!isHarnessVersion(version)) {
    throw new Error('buildChecksumsUrl requires a harness version (must contain +harness.)')
  }
  const encodedTag = encodeHarnessTag(version)
  return `${HARNESS_DOWNLOAD_BASE_URL}/${encodedTag}/SHA256SUMS`
}

/**
 * Verify a harness archive against the release's SHA256SUMS file.
 *
 * Downloads the SHA256SUMS asset from the same release, reads it with node:fs,
 * computes the archive's sha256 with node:crypto, and asserts the hashes match
 * for this platform's asset filename. Throws on mismatch or missing line.
 *
 * This is ONLY called for harness versions — stock anomalyco/opencode releases
 * do not publish a SHA256SUMS asset.
 *
 * No shell commands (cat, shasum) are used — platform-independent by design.
 */
async function verifyHarnessChecksum(
  archivePath: string,
  version: string,
  platformInfo: PlatformInfo,
  toolCache: ToolCacheAdapter,
  logger: Logger,
): Promise<void> {
  const checksumsUrl = buildChecksumsUrl(version)
  logger.debug('Downloading SHA256SUMS for harness release', {url: checksumsUrl})

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

  logger.debug('Harness archive SHA256 verified', {filename: archiveFilename, hash: actualHash})
}

/**
 * Validate downloaded archive is not corrupted.
 * Uses `file` command on Unix to check file type.
 *
 * This is used for STOCK (anomalyco/opencode) downloads only. Harness downloads
 * use `verifyHarnessChecksum` instead.
 */
async function validateDownload(
  downloadPath: string,
  ext: string,
  logger: Logger,
  execAdapter: ExecAdapter,
): Promise<boolean> {
  // Skip validation on Windows - trust HTTP response
  if (process.platform === 'win32') {
    return true
  }

  try {
    const {stdout} = await execAdapter.getExecOutput('file', [downloadPath], {silent: true})

    const expectedTypes = ext === '.zip' ? ['Zip archive', 'ZIP'] : ['gzip', 'tar', 'compressed']
    const isValid = expectedTypes.some(type => stdout.includes(type))

    if (!isValid) {
      logger.warning('Download validation failed', {output: stdout.trim()})
    }
    return isValid
  } catch {
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
 * For stock versions, falls back to the known stable FALLBACK_VERSION on
 * failure (pattern from oMo Sisyphus workflow).
 */
export async function installOpenCode(
  version: string,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  fallbackVersion: string = FALLBACK_VERSION,
): Promise<OpenCodeInstallResult> {
  const platformInfo = getPlatformInfo()

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

async function downloadAndInstall(
  version: string,
  platformInfo: PlatformInfo,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
): Promise<OpenCodeInstallResult> {
  logger.info('Downloading OpenCode', {version})
  const downloadUrl = buildDownloadUrl(version, platformInfo)
  const downloadPath = await toolCache.downloadTool(downloadUrl)

  if (isHarnessVersion(version)) {
    // Harness releases publish a SHA256SUMS asset — verify before extraction.
    // execAdapter is not passed: verification uses node:crypto + node:fs only.
    await verifyHarnessChecksum(downloadPath, version, platformInfo, toolCache, logger)
  } else {
    // Stock releases: use magic-byte check only (no SHA256SUMS asset exists).
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
