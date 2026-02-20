import type {ExecAdapter, Logger, ToolCacheAdapter} from './types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {toErrorMessage} from '../../utils/errors.js'
import {DEFAULT_BUN_VERSION} from '../constants.js'

const TOOL_NAME = 'bun'
const DOWNLOAD_BASE_URL = 'https://github.com/oven-sh/bun/releases/download'

export {DEFAULT_BUN_VERSION}

export interface BunInstallResult {
  readonly path: string
  readonly version: string
  readonly cached: boolean
}

export interface BunPlatformInfo {
  readonly os: 'darwin' | 'linux' | 'windows'
  readonly arch: 'aarch64' | 'x64' | 'x64-baseline'
  readonly ext: '.zip'
}

/**
 * Bun uses aarch64 instead of arm64, and always uses .zip
 */
export function getBunPlatformInfo(): BunPlatformInfo {
  const platform = process.platform
  const arch = process.arch

  const osMap: Partial<Record<NodeJS.Platform, 'darwin' | 'linux' | 'windows'>> = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows',
  }

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

export function buildBunDownloadUrl(version: string, info: BunPlatformInfo): string {
  const versionTag = version.startsWith('v') ? version : `v${version}`
  const filename = `bun-${info.os}-${info.arch}${info.ext}`
  return `${DOWNLOAD_BASE_URL}/bun-${versionTag}/${filename}`
}

/**
 * Install Bun runtime for running oh-my-opencode via bunx.
 *
 * Downloads Bun binary, extracts it, caches it in the runner tool-cache,
 * and adds to PATH so bunx is available for oMo installation.
 */
export async function installBun(
  logger: Logger,
  toolCache: ToolCacheAdapter,
  execAdapter: ExecAdapter,
  addPath: (inputPath: string) => void,
  version: string = DEFAULT_BUN_VERSION,
): Promise<BunInstallResult> {
  const platformInfo = getBunPlatformInfo()

  const cachedPath = toolCache.find(TOOL_NAME, version, platformInfo.arch)
  if (cachedPath.length > 0) {
    logger.info('Bun found in cache', {version, path: cachedPath})
    addPath(cachedPath)
    await createBunXSymlink(cachedPath)
    return {path: cachedPath, version, cached: true}
  }

  logger.info('Downloading Bun', {version})
  const downloadUrl = buildBunDownloadUrl(version, platformInfo)

  try {
    const downloadPath = await toolCache.downloadTool(downloadUrl)

    if (process.platform !== 'win32') {
      const isValid = await validateBunDownload(downloadPath, logger, execAdapter)
      if (!isValid) {
        throw new Error('Downloaded Bun archive appears corrupted')
      }
    }

    logger.info('Extracting Bun')
    const extractedZipPath = await toolCache.extractZip(downloadPath)
    const extractedBunPath = await extractBun(extractedZipPath, toolCache)
    const bunBinPath = path.dirname(extractedBunPath)

    logger.info('Caching Bun')
    const toolPath = await toolCache.cacheDir(bunBinPath, TOOL_NAME, version, platformInfo.arch)

    addPath(toolPath)
    await createBunXSymlink(toolPath)

    logger.info('Bun installed', {version, path: toolPath})
    return {path: toolPath, version, cached: false}
  } catch (error) {
    const errorMsg = toErrorMessage(error)
    throw new Error(`Failed to install Bun ${version}: ${errorMsg}`)
  }
}

async function extractBun(inputPath: string, toolCache: ToolCacheAdapter): Promise<string> {
  for (const entry of await fs.readdir(inputPath, {withFileTypes: true})) {
    const {name} = entry
    const entryPath = path.join(inputPath, name)
    if (entry.isFile()) {
      if (name === 'bun' || name === 'bun.exe') {
        return entryPath
      }
      if (/^bun.*\.zip/.test(name)) {
        const extractedPath = await toolCache.extractZip(entryPath)
        return extractBun(extractedPath, toolCache)
      }
    }
    if (name.startsWith('bun') && entry.isDirectory()) {
      return extractBun(entryPath, toolCache)
    }
  }
  throw new Error('Could not find executable: bun')
}

async function createBunXSymlink(binPath: string): Promise<void> {
  const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)
  const bunPath = path.join(binPath, exe('bun'))
  try {
    await fs.symlink(bunPath, path.join(binPath, exe('bunx')))
  } catch (error) {
    const code = typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
      throw error
    }
  }
}

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
    return true
  }
}

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
