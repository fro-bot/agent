import type {ExecAdapter, Logger, PlatformInfo, ToolCacheAdapter} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  buildDownloadUrl,
  FALLBACK_VERSION,
  getLatestVersion,
  getPlatformInfo,
  installOpenCode,
  isHarnessVersion,
} from './opencode.js'

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

    it('builds correct stock URL for 1.17.3 linux-x64 (unchanged)', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when
      const url = buildDownloadUrl('1.17.3', info)

      // #then
      expect(url).toBe('https://github.com/anomalyco/opencode/releases/download/v1.17.3/opencode-linux-x64.tar.gz')
    })

    it('builds harness URL for linux-x64 with %2B-encoded tag', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when
      const url = buildDownloadUrl('1.17.3+harness.abc12345', info)

      // #then
      expect(url).toBe(
        'https://github.com/fro-bot/agent/releases/download/v1.17.3%2Bharness.abc12345/opencode-linux-x64.tar.gz',
      )
    })

    it('builds harness URL for darwin-arm64 with %2B-encoded tag', () => {
      // #given
      const info: PlatformInfo = {os: 'darwin', arch: 'arm64', ext: '.zip'}

      // #when
      const url = buildDownloadUrl('1.17.3+harness.abc12345', info)

      // #then
      expect(url).toBe(
        'https://github.com/fro-bot/agent/releases/download/v1.17.3%2Bharness.abc12345/opencode-darwin-arm64.zip',
      )
    })
  })

  describe('isHarnessVersion', () => {
    it('returns true for a version containing +harness.', () => {
      // #given / #when / #then
      expect(isHarnessVersion('1.17.3+harness.abc12345')).toBe(true)
    })

    it('returns true for a harness version with v prefix', () => {
      // #given / #when / #then
      expect(isHarnessVersion('v1.17.3+harness.abc12345')).toBe(true)
    })

    it('returns false for a plain stock version', () => {
      // #given / #when / #then
      expect(isHarnessVersion('1.17.3')).toBe(false)
    })

    it('returns false for a hyphen-form version (npm form, not binary form)', () => {
      // #given / #when / #then
      expect(isHarnessVersion('1.17.3-harness.abc12345')).toBe(false)
    })

    it('returns false for latest', () => {
      // #given / #when / #then
      expect(isHarnessVersion('latest')).toBe(false)
    })
  })

  describe('getLatestVersion', () => {
    it('does not fetch anomalyco/opencode latest when given a harness pin', async () => {
      // #given
      // A harness pin must never trigger the stock latest fetch — the guard returns the pin unchanged.
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      // #when
      const result = await getLatestVersion(mockLogger, '1.17.3+harness.abc12345')

      // #then
      expect(result).toBe('1.17.3+harness.abc12345')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('fetches anomalyco/opencode latest when no pin is provided', async () => {
      // #given
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({tag_name: 'v2.0.0'}), {status: 200}))

      // #when
      const result = await getLatestVersion(mockLogger)

      // #then
      expect(result).toBe('2.0.0')
      expect(fetchSpy).toHaveBeenCalledWith('https://api.github.com/repos/anomalyco/opencode/releases/latest')
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

  describe('harness SHA256 verification', () => {
    const HARNESS_VERSION = '1.17.3+harness.abc12345'
    const ARCHIVE_FILENAME = 'opencode-linux-x64.tar.gz'
    const ARCHIVE_PATH = '/tmp/opencode-linux-x64.tar.gz'
    const CHECKSUMS_PATH = '/tmp/SHA256SUMS'
    const VALID_HASH = 'a'.repeat(64)
    const CHECKSUMS_CONTENT = `${VALID_HASH}  ${ARCHIVE_FILENAME}\n`

    function createHarnessToolCache(overrides: Partial<ToolCacheAdapter> = {}): ToolCacheAdapter {
      return createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async (url: string) => {
          if (url.endsWith('SHA256SUMS')) {
            return Promise.resolve(CHECKSUMS_PATH)
          }
          return Promise.resolve(ARCHIVE_PATH)
        }),
        extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue('/cached/opencode/harness'),
        ...overrides,
      })
    }

    function createHarnessExecAdapter(checksumOutput: string): ExecAdapter {
      return createMockExecAdapter({
        getExecOutput: vi.fn().mockImplementation(async (cmd: string, _args?: string[]) => {
          // shasum -a 256 <archivePath> → "<hash>  <filename>"
          if (cmd === 'shasum' || cmd === 'sha256sum') {
            return {exitCode: 0, stdout: `${VALID_HASH}  ${ARCHIVE_FILENAME}\n`, stderr: ''}
          }
          // cat <checksumsPath> → checksums file content
          if (cmd === 'cat') {
            return {exitCode: 0, stdout: checksumOutput, stderr: ''}
          }
          // file command for magic-byte check (should NOT be called for harness)
          return {exitCode: 0, stdout: 'gzip compressed data', stderr: ''}
        }),
      })
    }

    it('happy path: harness version downloads SHA256SUMS and verifies matching hash', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createHarnessToolCache()
      const mockExec = createHarnessExecAdapter(CHECKSUMS_CONTENT)

      // #when
      const result = await installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)

      // #then
      expect(result.cached).toBe(false)
      expect(result.version).toBe(HARNESS_VERSION)
      // SHA256SUMS must have been downloaded (two downloadTool calls: archive + SHA256SUMS)
      expect(mockToolCache.downloadTool).toHaveBeenCalledTimes(2)
      const calls = (mockToolCache.downloadTool as ReturnType<typeof vi.fn>).mock.calls as [string][]
      expect(calls.some(([url]) => url.endsWith('SHA256SUMS'))).toBe(true)
      // Extraction should proceed
      expect(mockToolCache.extractTar).toHaveBeenCalled()
    })

    it('error: harness checksum mismatch → falls back to FALLBACK_VERSION (stock)', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const WRONG_HASH = 'b'.repeat(64)
      const mismatchChecksums = `${WRONG_HASH}  ${ARCHIVE_FILENAME}\n`

      // Primary harness: returns mismatched checksum; fallback stock: succeeds
      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('fro-bot') && url.endsWith('SHA256SUMS')) {
            return Promise.resolve(CHECKSUMS_PATH)
          }
          if (url.includes('fro-bot')) {
            return Promise.resolve(ARCHIVE_PATH)
          }
          // Stock fallback download
          return Promise.resolve('/tmp/opencode-stock.tar.gz')
        }),
        extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue(`/cached/opencode/${FALLBACK_VERSION}`),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockImplementation(async (cmd: string, _args?: string[]) => {
          if (cmd === 'shasum' || cmd === 'sha256sum') {
            return {exitCode: 0, stdout: `${VALID_HASH}  ${ARCHIVE_FILENAME}\n`, stderr: ''}
          }
          if (cmd === 'cat') {
            return {exitCode: 0, stdout: mismatchChecksums, stderr: ''}
          }
          return {exitCode: 0, stdout: 'gzip compressed data', stderr: ''}
        }),
      })

      // #when
      const result = await installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)

      // #then
      expect(result.version).toBe(FALLBACK_VERSION)
      // Warning logged for primary failure
      expect(mockLogger.warning).toHaveBeenCalled()
    })

    it('error: harness SHA256SUMS download fails (404) → falls back to FALLBACK_VERSION', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async (url: string) => {
          if (url.endsWith('SHA256SUMS')) {
            throw new Error('HTTP 404: Not Found')
          }
          if (url.includes('fro-bot')) {
            return Promise.resolve(ARCHIVE_PATH)
          }
          // Stock fallback
          return Promise.resolve('/tmp/opencode-stock.tar.gz')
        }),
        extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue(`/cached/opencode/${FALLBACK_VERSION}`),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'gzip compressed data', stderr: ''}),
      })

      // #when
      const result = await installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)

      // #then
      expect(result.version).toBe(FALLBACK_VERSION)
      expect(mockLogger.warning).toHaveBeenCalled()
    })

    it('happy path: stock version uses magic-byte validateDownload only, no SHA256SUMS download', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockResolvedValue('/tmp/opencode.tar.gz'),
        extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue('/cached/opencode/1.17.3'),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'gzip compressed data', stderr: ''}),
      })

      // #when
      const result = await installOpenCode('1.17.3', mockLogger, mockToolCache, mockExec)

      // #then
      expect(result.version).toBe('1.17.3')
      // Only ONE downloadTool call (archive only, no SHA256SUMS)
      expect(mockToolCache.downloadTool).toHaveBeenCalledTimes(1)
      const calls = (mockToolCache.downloadTool as ReturnType<typeof vi.fn>).mock.calls as [string][]
      expect(calls.every(([url]) => !url.endsWith('SHA256SUMS'))).toBe(true)
    })
  })
})
