import type {ExecAdapter, Logger, OpenCodeInstallResult, PlatformInfo, ToolCacheAdapter} from './types.js'
import os from 'node:os'
import process from 'node:process'

import {toErrorMessage} from '../../utils/errors.js'

const TOOL_NAME = 'opencode'
const DOWNLOAD_BASE_URL = 'https://github.com/anomalyco/opencode/releases/download'

/** Known stable version for fallback when latest fails */
export const FALLBACK_VERSION = '1.1.1'

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
 */
export function buildDownloadUrl(version: string, info: PlatformInfo): string {
  const versionTag = version.startsWith('v') ? version : `v${version}`
  const filename = `opencode-${info.os}-${info.arch}${info.ext}`
  return `${DOWNLOAD_BASE_URL}/${versionTag}/${filename}`
}

/**
 * Validate downloaded archive is not corrupted.
 * Uses `file` command on Unix to check file type.
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
    logger.warning('Primary version install failed, trying fallback', {
      requestedVersion: version,
      fallbackVersion,
      error: toErrorMessage(error),
    })
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

  const isValid = await validateDownload(downloadPath, platformInfo.ext, logger, execAdapter)
  if (!isValid) {
    throw new Error('Downloaded archive appears corrupted')
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
 */
export async function getLatestVersion(logger: Logger): Promise<string> {
  const response = await fetch('https://api.github.com/repos/anomalyco/opencode/releases/latest')
  if (!response.ok) {
    throw new Error(`Failed to fetch latest OpenCode version: ${response.statusText}`)
  }
  const data = (await response.json()) as {tag_name: string}
  const version = data.tag_name.replace(/^v/, '')
  logger.info('Latest OpenCode version', {version})
  return version
}
