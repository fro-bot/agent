import type {ExecAdapter, Logger, OpenCodeInstallResult, PlatformInfo, ToolCacheAdapter} from './types.js'
import os from 'node:os'
import process from 'node:process'

import {DEFAULT_OPENCODE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'

const TOOL_NAME = 'opencode'
const DOWNLOAD_BASE_URL = 'https://github.com/anomalyco/opencode/releases/download'
const HARNESS_DOWNLOAD_BASE_URL = 'https://github.com/fro-bot/agent/releases/download'

/** Known stable version for fallback when latest fails */
export const FALLBACK_VERSION = DEFAULT_OPENCODE_VERSION

/**
 * Returns true when the version string is a harness-pinned build.
 *
 * Harness versions use the `+harness.<sha>` build-metadata suffix (semver §10),
 * e.g. `1.17.3+harness.abc12345`. The `+` form is the binary/release form used
 * by fro-bot/agent releases. The npm-compatible hyphen form (`1.17.3-harness.x`)
 * is intentionally NOT treated as a harness version here.
 */
export function isHarnessVersion(version: string): boolean {
  return version.includes('+harness.')
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
 * Build download URL for OpenCode binary.
 *
 * Harness-pinned versions (containing `+harness.`) are routed to the
 * fro-bot/agent releases. The `+` in the version tag MUST be percent-encoded
 * as `%2B` in the URL path segment — GitHub stores the tag URL-encoded and a
 * raw `+` is misread as a space. Stock versions route to anomalyco/opencode
 * with no encoding changes.
 */
export function buildDownloadUrl(version: string, info: PlatformInfo): string {
  const filename = `opencode-${info.os}-${info.arch}${info.ext}`

  if (isHarnessVersion(version)) {
    // Percent-encode `+` in the version tag for the URL path segment.
    const rawTag = version.startsWith('v') ? version : `v${version}`
    const encodedTag = rawTag.replaceAll('+', '%2B')
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
 */
export function buildChecksumsUrl(version: string): string {
  const rawTag = version.startsWith('v') ? version : `v${version}`
  const encodedTag = rawTag.replaceAll('+', '%2B')
  return `${HARNESS_DOWNLOAD_BASE_URL}/${encodedTag}/SHA256SUMS`
}

/**
 * Verify a harness archive against the release's SHA256SUMS file.
 *
 * Downloads the SHA256SUMS asset from the same release, reads it via `cat`,
 * computes the archive's sha256 via `shasum -a 256`, and asserts the hashes
 * match for this platform's asset filename. Throws on mismatch or missing line.
 *
 * This is ONLY called for harness versions — stock anomalyco/opencode releases
 * do not publish a SHA256SUMS asset.
 */
async function verifyHarnessChecksum(
  archivePath: string,
  version: string,
  platformInfo: PlatformInfo,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  logger: Logger,
): Promise<void> {
  const checksumsUrl = buildChecksumsUrl(version)
  logger.debug('Downloading SHA256SUMS for harness release', {url: checksumsUrl})

  const checksumsPath = await toolCache.downloadTool(checksumsUrl)

  // Read the checksums file
  const {stdout: checksumsContent} = await execAdapter.getExecOutput('cat', [checksumsPath], {silent: true})

  // Find the line for this platform's archive filename
  const archiveFilename = `opencode-${platformInfo.os}-${platformInfo.arch}${platformInfo.ext}`
  const matchingLine = checksumsContent
    .split('\n')
    .map(line => line.trim())
    .find(line => line.endsWith(archiveFilename))

  if (matchingLine === undefined || matchingLine.length === 0) {
    throw new Error(`SHA256SUMS does not contain an entry for ${archiveFilename}`)
  }

  // SHA256SUMS format: "<hash>  <filename>"
  const expectedHash = matchingLine.split(/\s+/)[0]
  if (expectedHash === undefined || expectedHash.length === 0) {
    throw new Error(`Could not parse hash from SHA256SUMS line: ${matchingLine}`)
  }

  // Compute the archive's sha256
  const {stdout: shasumOutput} = await execAdapter.getExecOutput('shasum', ['-a', '256', archivePath], {silent: true})
  // shasum output: "<hash>  <path>"
  const actualHash = shasumOutput.trim().split(/\s+/)[0]
  if (actualHash === undefined || actualHash.length === 0) {
    throw new Error('Could not compute SHA256 of downloaded archive')
  }

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
 * Tries requested version first, falls back to known stable version on failure.
 * Pattern from oMo Sisyphus workflow.
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
  const cachedPath = toolCache.find(TOOL_NAME, version, platformInfo.arch)
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
      logger.warning(
        'Harness OpenCode download failed (checksum mismatch, missing SHA256SUMS, or network error); falling back to stock OpenCode',
        {
          harnessVersion: version,
          fallbackVersion,
          error: toErrorMessage(error),
        },
      )
    } else {
      logger.warning('Primary version install failed, trying fallback', {
        requestedVersion: version,
        fallbackVersion,
        error: toErrorMessage(error),
      })
    }
  }

  // Fallback to known stable version
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
    await verifyHarnessChecksum(downloadPath, version, platformInfo, toolCache, execAdapter, logger)
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
  const toolPath = await toolCache.cacheDir(extractedPath, TOOL_NAME, version, platformInfo.arch)

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
