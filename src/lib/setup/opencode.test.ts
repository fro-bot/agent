import type {ExecAdapter, Logger, PlatformInfo, ToolCacheAdapter} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {buildDownloadUrl, FALLBACK_VERSION, getPlatformInfo, installOpenCode} from './opencode.js'

// Mock tool-cache adapter
function createMockToolCache(overrides: Partial<ToolCacheAdapter> = {}): ToolCacheAdapter {
  return {
    find: vi.fn().mockReturnValue(''),
    downloadTool: vi.fn().mockResolvedValue('/tmp/download'),
    extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
    extractZip: vi.fn().mockResolvedValue('/tmp/extracted'),
    cacheDir: vi.fn().mockResolvedValue('/cached/opencode'),
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

describe('opencode', () => {
  let mockLogger: Logger
  let originalPlatform: NodeJS.Platform
  let originalArch: NodeJS.Architecture

  beforeEach(() => {
    mockLogger = createMockLogger()
    originalPlatform = process.platform
    originalArch = process.arch
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {value: originalPlatform})
    Object.defineProperty(process, 'arch', {value: originalArch})
    vi.restoreAllMocks()
  })

  describe('getPlatformInfo', () => {
    it('returns correct info for Linux x64', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      // #when
      const info = getPlatformInfo()

      // #then
      expect(info.os).toBe('linux')
      expect(info.arch).toBe('x64')
      expect(info.ext).toBe('.tar.gz')
    })

    it('returns correct info for macOS arm64', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'darwin'})
      Object.defineProperty(process, 'arch', {value: 'arm64'})

      // #when
      const info = getPlatformInfo()

      // #then
      expect(info.os).toBe('darwin')
      expect(info.arch).toBe('arm64')
      expect(info.ext).toBe('.zip')
    })

    it('returns correct info for Windows x64', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'win32'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      // #when
      const info = getPlatformInfo()

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
      const info = getPlatformInfo()

      // #then
      expect(info.os).toBe('linux')
      expect(info.arch).toBe('x64')
    })
  })

  describe('buildDownloadUrl', () => {
    it('builds correct URL for Linux', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when
      const url = buildDownloadUrl('1.1.1', info)

      // #then
      expect(url).toBe('https://github.com/anomalyco/opencode/releases/download/v1.1.1/opencode-linux-x64.tar.gz')
    })

    it('builds correct URL for macOS arm64', () => {
      // #given
      const info: PlatformInfo = {os: 'darwin', arch: 'arm64', ext: '.zip'}

      // #when
      const url = buildDownloadUrl('1.1.0', info)

      // #then
      expect(url).toBe('https://github.com/anomalyco/opencode/releases/download/v1.1.0/opencode-darwin-arm64.zip')
    })

    it('builds correct URL for Windows', () => {
      // #given
      const info: PlatformInfo = {os: 'windows', arch: 'x64', ext: '.zip'}

      // #when
      const url = buildDownloadUrl('1.1.1', info)

      // #then
      expect(url).toBe('https://github.com/anomalyco/opencode/releases/download/v1.1.1/opencode-windows-x64.zip')
    })

    it('handles version with v prefix', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when
      const url = buildDownloadUrl('v1.1.1', info)

      // #then
      expect(url).toBe('https://github.com/anomalyco/opencode/releases/download/v1.1.1/opencode-linux-x64.tar.gz')
    })
  })

  describe('installOpenCode', () => {
    it('returns cached path when tool is found in cache', async () => {
      // #given
      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue('/cached/opencode/1.0.0'),
      })
      const mockExec = createMockExecAdapter()

      // #when
      const result = await installOpenCode('1.0.0', mockLogger, mockToolCache, mockExec)

      // #then
      expect(result.cached).toBe(true)
      expect(result.path).toBe('/cached/opencode/1.0.0')
      expect(result.version).toBe('1.0.0')
      expect(mockToolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('downloads and caches on cache miss', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockResolvedValue('/tmp/opencode.tar.gz'),
        extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue('/cached/opencode/1.0.0'),
      })
      const mockExec = createMockExecAdapter({
        exec: vi.fn().mockResolvedValue(0),
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'gzip compressed data',
          stderr: '',
        }),
      })

      // #when
      const result = await installOpenCode('1.0.0', mockLogger, mockToolCache, mockExec)

      // #then
      expect(result.cached).toBe(false)
      expect(result.path).toBe('/cached/opencode/1.0.0')
      expect(mockToolCache.downloadTool).toHaveBeenCalled()
      expect(mockToolCache.extractTar).toHaveBeenCalled()
      expect(mockToolCache.cacheDir).toHaveBeenCalled()
    })

    it('uses extractZip for Windows', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'win32'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        extractZip: vi.fn().mockResolvedValue('/tmp/extracted'),
      })
      const mockExec = createMockExecAdapter()

      // #when
      await installOpenCode('1.0.0', mockLogger, mockToolCache, mockExec)

      // #then
      expect(mockToolCache.extractZip).toHaveBeenCalled()
      expect(mockToolCache.extractTar).not.toHaveBeenCalled()
    })

    it('falls back to FALLBACK_VERSION on primary version failure', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      let downloadCallCount = 0
      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async () => {
          downloadCallCount++
          if (downloadCallCount === 1) {
            throw new Error('Download failed')
          }
          return Promise.resolve('/tmp/opencode.tar.gz')
        }),
        extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue(`/cached/opencode/${FALLBACK_VERSION}`),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'gzip compressed',
          stderr: '',
        }),
      })

      // #when
      const result = await installOpenCode('999.0.0', mockLogger, mockToolCache, mockExec)

      // #then
      expect(result.version).toBe(FALLBACK_VERSION)
      expect(downloadCallCount).toBe(2)
      expect(mockLogger.warning).toHaveBeenCalled()
    })

    it('throws when both primary and fallback fail', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      const mockExec = createMockExecAdapter()

      // #when / #then
      await expect(installOpenCode('1.0.0', mockLogger, mockToolCache, mockExec)).rejects.toThrow(
        /Failed to install OpenCode/,
      )
    })

    it('skips fallback when version equals FALLBACK_VERSION', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockRejectedValue(new Error('Network error')),
      })
      const mockExec = createMockExecAdapter()

      // #when / #then
      await expect(installOpenCode(FALLBACK_VERSION, mockLogger, mockToolCache, mockExec)).rejects.toThrow(
        `Failed to install OpenCode version ${FALLBACK_VERSION}`,
      )
    })
  })

  describe('FALLBACK_VERSION', () => {
    it('is a valid semver version', () => {
      expect(FALLBACK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    })
  })
})
