import type {ExecAdapter, Logger, ToolCacheAdapter} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {buildBunDownloadUrl, DEFAULT_BUN_VERSION, getBunPlatformInfo, installBun, isBunAvailable} from './bun.js'

// Mock logger
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

// Mock tool-cache adapter
function createMockToolCache(overrides: Partial<ToolCacheAdapter> = {}): ToolCacheAdapter {
  return {
    find: vi.fn().mockReturnValue(''),
    downloadTool: vi.fn().mockResolvedValue('/tmp/download'),
    extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
    extractZip: vi.fn().mockResolvedValue('/tmp/extracted'),
    cacheDir: vi.fn().mockResolvedValue('/cached/bun'),
    ...overrides,
  }
}

// Mock exec adapter
function createMockExecAdapter(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''}),
    ...overrides,
  }
}

describe('bun', () => {
  let mockLogger: Logger
  let mockAddPath: (inputPath: string) => void
  let originalPlatform: NodeJS.Platform
  let originalArch: NodeJS.Architecture

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockAddPath = vi.fn() as unknown as (inputPath: string) => void
    originalPlatform = process.platform
    originalArch = process.arch
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {value: originalPlatform})
    Object.defineProperty(process, 'arch', {value: originalArch})
    vi.restoreAllMocks()
  })

  describe('getBunPlatformInfo', () => {
    it('returns correct info for Linux x64', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      // #when
      const info = getBunPlatformInfo()

      // #then
      expect(info.os).toBe('linux')
      expect(info.arch).toBe('x64')
      expect(info.ext).toBe('.zip')
    })

    it('returns correct info for macOS arm64 (uses aarch64)', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'darwin'})
      Object.defineProperty(process, 'arch', {value: 'arm64'})

      // #when
      const info = getBunPlatformInfo()

      // #then
      expect(info.os).toBe('darwin')
      expect(info.arch).toBe('aarch64')
      expect(info.ext).toBe('.zip')
    })

    it('returns correct info for Windows x64', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'win32'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      // #when
      const info = getBunPlatformInfo()

      // #then
      expect(info.os).toBe('windows')
      expect(info.arch).toBe('x64')
      expect(info.ext).toBe('.zip')
    })

    it('defaults to linux x64 for unknown platform', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'freebsd'})
      Object.defineProperty(process, 'arch', {value: 'mips'})

      // #when
      const info = getBunPlatformInfo()

      // #then
      expect(info.os).toBe('linux')
      expect(info.arch).toBe('x64')
    })
  })

  describe('buildBunDownloadUrl', () => {
    it('builds correct URL for Linux x64', () => {
      // #given
      const info = {os: 'linux' as const, arch: 'x64' as const, ext: '.zip' as const}

      // #when
      const url = buildBunDownloadUrl('1.2.5', info)

      // #then
      expect(url).toBe('https://github.com/oven-sh/bun/releases/download/bun-v1.2.5/bun-linux-x64.zip')
    })

    it('builds correct URL for macOS aarch64', () => {
      // #given
      const info = {os: 'darwin' as const, arch: 'aarch64' as const, ext: '.zip' as const}

      // #when
      const url = buildBunDownloadUrl('1.2.5', info)

      // #then
      expect(url).toBe('https://github.com/oven-sh/bun/releases/download/bun-v1.2.5/bun-darwin-aarch64.zip')
    })

    it('handles version with v prefix', () => {
      // #given
      const info = {os: 'linux' as const, arch: 'x64' as const, ext: '.zip' as const}

      // #when
      const url = buildBunDownloadUrl('v1.2.5', info)

      // #then
      expect(url).toBe('https://github.com/oven-sh/bun/releases/download/bun-v1.2.5/bun-linux-x64.zip')
    })
  })

  describe('installBun', () => {
    it('returns cached path when Bun is found in cache', async () => {
      // #given
      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue('/cached/bun/1.2.5'),
      })
      const mockExec = createMockExecAdapter()

      // #when
      const result = await installBun(mockLogger, mockToolCache, mockExec, mockAddPath, '1.2.5')

      // #then
      expect(result.cached).toBe(true)
      expect(result.path).toBe('/cached/bun/1.2.5')
      expect(result.version).toBe('1.2.5')
      expect(mockToolCache.downloadTool).not.toHaveBeenCalled()
      expect(mockAddPath).toHaveBeenCalledWith('/cached/bun/1.2.5')
    })

    it('downloads and caches on cache miss', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockResolvedValue('/tmp/bun.zip'),
        extractZip: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue('/cached/bun/1.2.5'),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'Zip archive data',
          stderr: '',
        }),
      })

      // #when
      const result = await installBun(mockLogger, mockToolCache, mockExec, mockAddPath, '1.2.5')

      // #then
      expect(result.cached).toBe(false)
      expect(result.path).toBe('/cached/bun/1.2.5')
      expect(mockToolCache.downloadTool).toHaveBeenCalled()
      expect(mockToolCache.extractZip).toHaveBeenCalled()
      expect(mockToolCache.cacheDir).toHaveBeenCalledWith(
        expect.stringContaining('bun-linux-x64'),
        'bun',
        '1.2.5',
        'x64',
      )
      expect(mockAddPath).toHaveBeenCalledWith('/cached/bun/1.2.5')
    })

    it('uses default version when not specified', async () => {
      // #given
      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue('/cached/bun'),
      })
      const mockExec = createMockExecAdapter()

      // #when
      const result = await installBun(mockLogger, mockToolCache, mockExec, mockAddPath)

      // #then
      expect(result.version).toBe(DEFAULT_BUN_VERSION)
    })

    it('throws on download failure', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      const mockExec = createMockExecAdapter()

      // #when / #then
      await expect(installBun(mockLogger, mockToolCache, mockExec, mockAddPath, '1.2.5')).rejects.toThrow(
        /Failed to install Bun 1.2.5/,
      )
    })

    it('throws on corrupted download (non-Windows)', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockResolvedValue('/tmp/bun.zip'),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'HTML document', // Not a zip
          stderr: '',
        }),
      })

      // #when / #then
      await expect(installBun(mockLogger, mockToolCache, mockExec, mockAddPath, '1.2.5')).rejects.toThrow(/corrupted/)
    })

    it('skips validation on Windows', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'win32'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockResolvedValue('/tmp/bun.zip'),
        extractZip: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue('/cached/bun/1.2.5'),
      })
      const mockExec = createMockExecAdapter()

      // #when
      const result = await installBun(mockLogger, mockToolCache, mockExec, mockAddPath, '1.2.5')

      // #then - should succeed without calling file validation
      expect(result.path).toBe('/cached/bun/1.2.5')
      expect(mockExec.getExecOutput).not.toHaveBeenCalledWith('file', expect.anything(), expect.anything())
    })
  })

  describe('isBunAvailable', () => {
    it('returns true when bun --version succeeds', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: '1.2.5', stderr: ''}),
      })

      // #when
      const result = await isBunAvailable(mockExec)

      // #then
      expect(result).toBe(true)
      expect(mockExec.getExecOutput).toHaveBeenCalledWith('bun', ['--version'], expect.any(Object))
    })

    it('returns false when bun --version fails', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 127, stdout: '', stderr: 'command not found'}),
      })

      // #when
      const result = await isBunAvailable(mockExec)

      // #then
      expect(result).toBe(false)
    })

    it('returns false when bun command throws', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockRejectedValue(new Error('spawn error')),
      })

      // #when
      const result = await isBunAvailable(mockExec)

      // #then
      expect(result).toBe(false)
    })
  })

  describe('DEFAULT_BUN_VERSION', () => {
    it('is a valid semver version', () => {
      expect(DEFAULT_BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    })
  })
})
