import type {ExecAdapter, Logger, PlatformInfo, ToolCacheAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_OPENCODE_VERSION} from '../../shared/constants.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  buildChecksumsUrl,
  buildDownloadUrl,
  FALLBACK_VERSION,
  getLatestVersion,
  getPlatformInfo,
  installOpenCode,
  isHarnessVersion,
} from './opencode.js'

// ---------------------------------------------------------------------------
// ESM-compatible fs mock: vi.mock hoists to the top of the module so the
// mocked version is in place before opencode.ts imports node:fs.
// Individual tests set fsState.readFileSyncImpl to control readFileSync output.
// Individual tests set fsState.createReadStreamImpl to control createReadStream output.
// ---------------------------------------------------------------------------

const fsState: {
  readFileSyncImpl: ((path: unknown) => Buffer | string) | null
  createReadStreamImpl: ((path: unknown) => Buffer) | null
} = {readFileSyncImpl: null, createReadStreamImpl: null}

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (path: unknown, encoding?: unknown) => {
      if (fsState.readFileSyncImpl !== null) {
        const result = fsState.readFileSyncImpl(path)
        if (encoding === 'utf8' && Buffer.isBuffer(result)) {
          return result.toString('utf8')
        }
        return result
      }
      // Fall through to real implementation
      if (encoding !== undefined) {
        return actual.readFileSync(path as string, encoding as BufferEncoding)
      }
      return actual.readFileSync(path as string)
    },
    createReadStream: (path: unknown) => {
      const emitter = new EventEmitter()
      // Emit asynchronously so listeners can be attached before events fire
      setImmediate(() => {
        if (fsState.createReadStreamImpl === null) {
          // No mock impl: emit error so tests that forget to set it fail loudly
          emitter.emit('error', new Error(`createReadStream mock not configured for path: ${String(path)}`))
          return
        }
        const bytes = fsState.createReadStreamImpl(path)
        emitter.emit('data', bytes)
        emitter.emit('end')
      })
      return emitter
    },
  }
})

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
    fsState.readFileSyncImpl = null
    fsState.createReadStreamImpl = null
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {value: originalPlatform})
    Object.defineProperty(process, 'arch', {value: originalArch})
    fsState.readFileSyncImpl = null
    fsState.createReadStreamImpl = null
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

    it('rejects a version containing path traversal (../) — semver guard', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when / #then
      expect(() => buildDownloadUrl('../evil', info)).toThrow(/Invalid version string/)
    })

    it('rejects a version containing a forward slash — semver guard', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when / #then
      expect(() => buildDownloadUrl('1.0.0/evil', info)).toThrow(/Invalid version string/)
    })
  })

  describe('buildChecksumsUrl', () => {
    it('returns correct %2B-encoded SHA256SUMS URL for a harness version', () => {
      // #given / #when
      const url = buildChecksumsUrl('1.17.3+harness.abc12345')

      // #then
      expect(url).toBe('https://github.com/fro-bot/agent/releases/download/v1.17.3%2Bharness.abc12345/SHA256SUMS')
    })

    it('throws for a stock (non-harness) version', () => {
      // #given / #when / #then
      expect(() => buildChecksumsUrl('1.17.3')).toThrow(/requires a harness version/)
    })

    it('throws for the npm hyphen form (not a harness download version)', () => {
      // #given / #when / #then
      expect(() => buildChecksumsUrl('1.17.3-harness.abc12345')).toThrow(/requires a harness version/)
    })

    it('throws for a version containing path traversal (../) — semver guard', () => {
      // #given — a traversal-containing string that also contains +harness. to bypass the isHarnessVersion check
      // assertValidVersion must fire BEFORE isHarnessVersion so traversal is rejected regardless
      // #when / #then
      expect(() => buildChecksumsUrl('../evil+harness.abc12345')).toThrow(/Invalid version string/)
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

    it('falls back to FALLBACK_VERSION on primary stock version failure', async () => {
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

    it('fail-closed: harness-pin checksum mismatch throws, does NOT fall back to stock', async () => {
      // #given — FIX 2: explicit harness pin must fail closed, no stock downgrade
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const HARNESS_VERSION = '1.17.3+harness.abc12345'
      const ARCHIVE_FILENAME = 'opencode-linux-x64.tar.gz'
      const ARCHIVE_PATH = '/tmp/opencode-linux-x64.tar.gz'
      const CHECKSUMS_PATH = '/tmp/SHA256SUMS'
      const WRONG_HASH = 'b'.repeat(64)

      // SHA256SUMS file contains the WRONG hash (archive will hash to something different)
      const mismatchChecksums = `${WRONG_HASH}  ${ARCHIVE_FILENAME}\n`

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async (url: string) => {
          if (url.endsWith('SHA256SUMS')) return Promise.resolve(CHECKSUMS_PATH)
          return Promise.resolve(ARCHIVE_PATH)
        }),
      })

      // SHA256SUMS via readFileSync; archive bytes via createReadStream (streaming path)
      fsState.readFileSyncImpl = (path: unknown) => {
        if (path === CHECKSUMS_PATH) return mismatchChecksums
        return Buffer.alloc(0)
      }
      // Archive bytes — will hash to something that does NOT match WRONG_HASH
      fsState.createReadStreamImpl = (_path: unknown) => Buffer.from('fake-archive-bytes')

      const mockExec = createMockExecAdapter()

      // #when / #then — must throw, NOT return FALLBACK_VERSION
      await expect(installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)).rejects.toThrow(
        /fail-closed|harness.*failed|SHA256 mismatch/i,
      )

      // Confirm no fallback was attempted (no stock anomalyco downloads)
      const calls = (mockToolCache.downloadTool as ReturnType<typeof vi.fn>).mock.calls as [string][]
      const stockCalls = calls.filter(([url]) => url.includes('anomalyco'))
      expect(stockCalls).toHaveLength(0)
    })

    it('fail-closed: harness-pin 404 (SHA256SUMS download fails) throws, does NOT fall back to stock', async () => {
      // #given — FIX 2: harness pin 404 must fail closed
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const HARNESS_VERSION = '1.17.3+harness.abc12345'

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async (url: string) => {
          if (url.endsWith('SHA256SUMS')) throw new Error('HTTP 404: Not Found')
          return Promise.resolve('/tmp/opencode-linux-x64.tar.gz')
        }),
      })
      const mockExec = createMockExecAdapter()

      // #when / #then — must throw, NOT return FALLBACK_VERSION
      await expect(installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)).rejects.toThrow(
        /fail-closed|harness.*failed|404/i,
      )

      // Confirm no stock fallback download was attempted
      const calls = (mockToolCache.downloadTool as ReturnType<typeof vi.fn>).mock.calls as [string][]
      const stockCalls = calls.filter(([url]) => url.includes('anomalyco'))
      expect(stockCalls).toHaveLength(0)
    })
  })

  describe('FALLBACK_VERSION', () => {
    it('is a valid semver version', () => {
      expect(FALLBACK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    })

    it('is not a harness version', () => {
      expect(isHarnessVersion(FALLBACK_VERSION)).toBe(false)
    })

    it('is not equal to DEFAULT_OPENCODE_VERSION (no re-aliasing)', () => {
      expect(FALLBACK_VERSION).not.toBe(DEFAULT_OPENCODE_VERSION)
    })
  })

  describe('DEFAULT_OPENCODE_VERSION', () => {
    it('equals the pinned harness build', () => {
      expect(DEFAULT_OPENCODE_VERSION).toBe('1.17.3+harness.2c9cdbd2')
    })

    it('is a harness version', () => {
      expect(isHarnessVersion(DEFAULT_OPENCODE_VERSION)).toBe(true)
    })
  })

  describe('harness SHA256 verification', () => {
    const HARNESS_VERSION = '1.17.3+harness.abc12345'
    const ARCHIVE_FILENAME = 'opencode-linux-x64.tar.gz'
    const ARCHIVE_PATH = '/tmp/opencode-linux-x64.tar.gz'
    const CHECKSUMS_PATH = '/tmp/SHA256SUMS'

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

    it('happy path: harness version downloads SHA256SUMS and verifies hash via streaming node:crypto (no exec calls)', async () => {
      // #given — hash computed via streaming createReadStream + node:crypto, no shasum/cat exec calls
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const archiveBytes = Buffer.from('fake-archive-content')
      const realHash = createHash('sha256').update(archiveBytes).digest('hex')
      const checksums = `${realHash}  ${ARCHIVE_FILENAME}\n`

      const mockToolCache = createHarnessToolCache()
      const mockExec = createMockExecAdapter()

      // SHA256SUMS is still read via readFileSync (it's tiny); archive is streamed via createReadStream
      fsState.readFileSyncImpl = (path: unknown) => {
        if (path === CHECKSUMS_PATH) return checksums
        return Buffer.alloc(0)
      }
      fsState.createReadStreamImpl = (path: unknown) => {
        if (path === ARCHIVE_PATH) return archiveBytes
        return Buffer.alloc(0)
      }

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
      // No exec calls for shasum or cat — streaming node:crypto path only
      expect(mockExec.getExecOutput).not.toHaveBeenCalledWith('shasum', expect.anything(), expect.anything())
      expect(mockExec.getExecOutput).not.toHaveBeenCalledWith('cat', expect.anything(), expect.anything())
    })

    it('exact filename match: decoy line with prefix does not match real archive filename', async () => {
      // #given — exact filename match, not endsWith
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const archiveBytes = Buffer.from('real-archive-content')
      const realHash = createHash('sha256').update(archiveBytes).digest('hex')
      const decoyHash = 'c'.repeat(64)

      // SHA256SUMS with a decoy line that endsWith the real filename but is NOT an exact match
      const checksums = `${decoyHash}  x-opencode-linux-x64.tar.gz\n${realHash}  ${ARCHIVE_FILENAME}\n`

      const mockToolCache = createHarnessToolCache()
      const mockExec = createMockExecAdapter()

      // SHA256SUMS via readFileSync; archive bytes via createReadStream
      fsState.readFileSyncImpl = (path: unknown) => {
        if (path === CHECKSUMS_PATH) return checksums
        return Buffer.alloc(0)
      }
      fsState.createReadStreamImpl = (path: unknown) => {
        if (path === ARCHIVE_PATH) return archiveBytes
        return Buffer.alloc(0)
      }

      // #when — should succeed using the REAL line's hash, not the decoy
      const result = await installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)

      // #then — resolved to the real hash, not the decoy
      expect(result.version).toBe(HARNESS_VERSION)
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
