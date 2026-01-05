import type {ExecAdapter, Logger, ToolCacheAdapter} from './types.js'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const TOOL_NAME = 'bun'
const DOWNLOAD_BASE_URL = 'https://github.com/oven-sh/bun/releases/download'

/** Default Bun version to install */
export const DEFAULT_BUN_VERSION = '1.2.5'

/**
 * Bun installation result
 */
export interface BunInstallResult {
  readonly path: string
  readonly version: string
  readonly cached: boolean
}

/**
 * Platform information for Bun binary downloads.
 * Bun uses different naming conventions than OpenCode.
 */
export interface BunPlatformInfo {
  readonly os: 'darwin' | 'linux' | 'windows'
  readonly arch: 'aarch64' | 'x64' | 'x64-baseline'
  readonly ext: '.zip'
}

/**
 * Get platform information for Bun binary downloads.
 * Bun uses aarch64 instead of arm64, and always uses .zip
 */
export function getBunPlatformInfo(): BunPlatformInfo {
  const platform = os.platform()
  const arch = os.arch()

  const osMap: Partial<Record<NodeJS.Platform, 'darwin' | 'linux' | 'windows'>> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows',
  }

  // Bun uses aarch64 for arm64, x64 for x64
  const archMap: Partial<Record<NodeJS.Architecture, 'aarch64' | 'x64'>> = {
    arm64: 'aarch64',
    x64: 'x64',
  }

  return {
    os: osMap[platform] ?? 'linux',
    arch: archMap[arch] ?? 'x64',
    ext: '.zip',
  }
}

/**
 * Build download URL for Bun binary.
 * Format: https://github.com/oven-sh/bun/releases/download/bun-v{version}/bun-{os}-{arch}.zip
 */
export function buildBunDownloadUrl(version: string, info: BunPlatformInfo): string {
  const versionTag = version.startsWith('v') ? version : `v${version}`
  const filename = `bun-${info.os}-${info.arch}${info.ext}`
  return `${DOWNLOAD_BASE_URL}/bun-${versionTag}/${filename}`
}

/**
 * Install Bun runtime for running oh-my-opencode.
 *
 * Downloads Bun binary, extracts it, caches it, and adds to PATH.
 * Required because oh-my-opencode is built with --target bun.
 */
export async function installBun(
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  addPath: (inputPath: string) => void,
  version: string = DEFAULT_BUN_VERSION,
): Promise<BunInstallResult> {
  const platformInfo = getBunPlatformInfo()

  // Check cache first
  const cachedPath = toolCache.find(TOOL_NAME, version, platformInfo.arch)
  if (cachedPath.length > 0) {
    logger.info('Bun found in cache', {version, path: cachedPath})
    addPath(cachedPath)
    return {path: cachedPath, version, cached: true}
  }

  logger.info('Downloading Bun', {version})
  const downloadUrl = buildBunDownloadUrl(version, platformInfo)

  try {
    const downloadPath = await toolCache.downloadTool(downloadUrl)

    // Validate download on non-Windows
    if (process.platform !== 'win32') {
      const isValid = await validateBunDownload(downloadPath, logger, execAdapter)
      if (!isValid) {
        throw new Error('Downloaded Bun archive appears corrupted')
      }
    }

    logger.info('Extracting Bun')
    const extractedPath = await toolCache.extractZip(downloadPath)

    // Bun extracts to a subdirectory like bun-linux-x64/
    const bunSubdir = `bun-${platformInfo.os}-${platformInfo.arch}`
    const bunBinPath = path.join(extractedPath, bunSubdir)

    logger.info('Caching Bun')
    const toolPath = await toolCache.cacheDir(bunBinPath, TOOL_NAME, version, platformInfo.arch)

    // Add to PATH so bunx is available
    addPath(toolPath)

    logger.info('Bun installed', {version, path: toolPath})
    return {path: toolPath, version, cached: false}
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to install Bun ${version}: ${errorMsg}`)
  }
}

/**
 * Validate downloaded Bun archive is not corrupted.
 */
async function validateBunDownload(downloadPath: string, logger: Logger, execAdapter: ExecAdapter): Promise<boolean> {
  try {
    const {stdout} = await execAdapter.getExecOutput('file', [downloadPath], {silent: true})
    const isValid = stdout.includes('Zip archive') || stdout.includes('ZIP')

    if (!isValid) {
      logger.warning('Bun download validation failed', {output: stdout.trim()})
    }
    return isValid
  } catch {
    logger.debug('Could not validate Bun download (file command unavailable)')
    return true // Assume valid if we can't check
  }
}

/**
 * Check if Bun is already available in PATH.
 */
export async function isBunAvailable(execAdapter: ExecAdapter): Promise<boolean> {
  try {
    const {exitCode} = await execAdapter.getExecOutput('bun', ['--version'], {
      silent: true,
      ignoreReturnCode: true,
    })
    return exitCode === 0
  } catch {
    return false
  }
}
