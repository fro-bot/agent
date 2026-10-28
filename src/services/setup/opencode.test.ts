import type {V2Pin} from './opencode.js'
import type {ExecAdapter, Logger, PlatformInfo, ToolCacheAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import path from 'node:path'
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
  isStockV2Pin,
  isV2Version,
  opencodeBinaryPath,
  RECORDED_V2_PIN,
  resolveStockV2Policy,
  toHarnessReleaseTag,
  toolCacheVersion,
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

function downloadedUrls(toolCache: ToolCacheAdapter): string[] {
  return (toolCache.downloadTool as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url))
}

function createGzipExec(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return createMockExecAdapter({
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'gzip compressed data', stderr: ''}),
    ...overrides,
  })
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

  describe('opencodeBinaryPath', () => {
    it('resolves the executable inside an install directory', () => {
      // #given the tool-cache directory installOpenCode returns
      const installDir = '/opt/hostedtoolcache/opencode/1.18.29-harness.88b6b5fb/x64'

      // #when the executable is resolved
      const binary = opencodeBinaryPath(installDir)

      // #then it names a file inside that directory, never the directory itself — spawning the
      // directory fails EACCES
      expect(binary).toBe(path.join(installDir, 'opencode'))
      expect(binary).not.toBe(installDir)
    })
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

    it('rejects Windows by name rather than 404ing three layers down', () => {
      // #given a win32 host
      Object.defineProperty(process, 'platform', {value: 'win32'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      // #then the platform is named as the problem here, not surfaced later as a download failure
      // for an asset the harness never publishes
      expect(() => getPlatformInfo()).toThrow(/Unsupported platform: win32\/x64/)
    })

    it('rejects any other unsupported platform', () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'freebsd'})
      Object.defineProperty(process, 'arch', {value: 'mips'})

      // #then — previously this silently became linux/x64 and downloaded a binary that could not run
      expect(() => getPlatformInfo()).toThrow(/Unsupported platform: freebsd\/mips/)
    })

    it('rejects an unsupported arch on a supported platform', () => {
      // #given a supported OS with an arch the harness does not publish
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'arm'})

      // #then — this previously resolved to the x64 asset and downloaded a binary that could not
      // execute. The error message promises x64/arm64, so the code has to enforce it.
      expect(() => getPlatformInfo()).toThrow(/Unsupported platform: linux\/arm\./)
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

    it('builds harness URL for linux-x64 with the hyphen release tag', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when
      const url = buildDownloadUrl('1.17.3+harness.abc12345', info)

      // #then — harness tags are NON-v-prefixed; stock tags keep their v-prefix
      expect(url).toBe(
        'https://github.com/fro-bot/agent/releases/download/1.17.3-harness.abc12345/opencode-linux-x64.tar.gz',
      )
    })

    it('builds harness URL for darwin-arm64 with the hyphen release tag', () => {
      // #given
      const info: PlatformInfo = {os: 'darwin', arch: 'arm64', ext: '.zip'}

      // #when
      const url = buildDownloadUrl('1.17.3+harness.abc12345', info)

      // #then — harness tags are NON-v-prefixed; stock tags keep their v-prefix
      expect(url).toBe(
        'https://github.com/fro-bot/agent/releases/download/1.17.3-harness.abc12345/opencode-darwin-arm64.zip',
      )
    })

    it('maps a +harness. VERSION input to a -harness. TAG in the download URL', () => {
      // #given
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when
      const url = buildDownloadUrl('1.17.3+harness.abc12345', info)

      // #then — the binary version identity stays in +harness. form, while its release tag uses -harness.
      expect(url).toContain('/releases/download/1.17.3-harness.abc12345/')
      expect(url).not.toContain('%2B')
    })

    it('stock download uses v-prefix; harness download does NOT — paths differ correctly', () => {
      // #given — regression guard: the two paths must diverge on the v-prefix
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      // #when
      const stockUrl = buildDownloadUrl('1.17.3', info)
      const harnessUrl = buildDownloadUrl('1.17.3+harness.abc12345', info)

      // #then — stock keeps v-prefix; harness has no v-prefix
      expect(stockUrl).toContain('/releases/download/v1.17.3/')
      expect(harnessUrl).toContain('/releases/download/1.17.3-harness.')
      expect(harnessUrl).not.toContain('/releases/download/v1.17.3-harness.')
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
    it('returns correct non-v hyphen-tagged SHA256SUMS URL for a harness version', () => {
      // #given / #when
      const url = buildChecksumsUrl('1.17.3+harness.abc12345')

      // #then — harness release tags are NON-v-prefixed
      expect(url).toBe('https://github.com/fro-bot/agent/releases/download/1.17.3-harness.abc12345/SHA256SUMS')
    })

    it('throws for a stock (non-harness) version', () => {
      // #given / #when / #then
      expect(() => buildChecksumsUrl('1.17.3')).toThrow(/requires a harness version/)
    })

    it('accepts the hyphen release-tag form when supplied as a version input', () => {
      // #given / #when
      const url = buildChecksumsUrl('1.17.3-harness.abc12345')

      // #then — the public release-tag form is already the canonical target.
      expect(url).toBe('https://github.com/fro-bot/agent/releases/download/1.17.3-harness.abc12345/SHA256SUMS')
    })

    it('maps a +harness. VERSION input to a -harness. TAG in the checksums URL', () => {
      // #given / #when
      const url = buildChecksumsUrl('1.17.3+harness.abc12345')

      // #then — both URL builders target the same hyphen-tagged release.
      expect(url).toBe('https://github.com/fro-bot/agent/releases/download/1.17.3-harness.abc12345/SHA256SUMS')
      expect(url).not.toContain('%2B')
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

    it('returns true for a hyphen-form version copied from the public release tag', () => {
      // #given / #when / #then
      expect(isHarnessVersion('1.17.3-harness.abc12345')).toBe(true)
    })

    it('returns false for latest', () => {
      // #given / #when / #then
      expect(isHarnessVersion('latest')).toBe(false)
    })
  })

  describe('toolCacheVersion', () => {
    it('converts +harness. build-metadata to -harness. prerelease form', () => {
      // #given / #when / #then
      expect(toolCacheVersion('1.17.3+harness.2c9cdbd2')).toBe('1.17.3-harness.2c9cdbd2')
    })

    it('leaves a plain stock version unchanged', () => {
      // #given / #when / #then
      expect(toolCacheVersion('1.17.3')).toBe('1.17.3')
    })

    it('leaves an already-prerelease hyphen form unchanged (no double-convert)', () => {
      // #given / #when / #then
      expect(toolCacheVersion('1.17.3-harness.x')).toBe('1.17.3-harness.x')
    })

    it('leaves "latest" unchanged', () => {
      // #given / #when / #then
      expect(toolCacheVersion('latest')).toBe('latest')
    })

    it('proves no collision: converted form is distinct from stock 1.17.3', () => {
      // #given
      const converted = toolCacheVersion('1.17.3+harness.2c9cdbd2')

      // #then — preserves the full harness identity (and is therefore distinct from stock 1.17.3)
      expect(converted).toBe('1.17.3-harness.2c9cdbd2')
    })
  })

  describe('toHarnessReleaseTag', () => {
    it('leaves an already-prerelease hyphen form unchanged', () => {
      // #given / #when / #then
      expect(toHarnessReleaseTag('1.17.3-harness.x')).toBe('1.17.3-harness.x')
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

    it('tool-cache collision guard: find is called with -harness. form for a harness version', async () => {
      // #given — harness version must use the prerelease form at the find call site
      // to avoid semver.clean() stripping build-metadata and colliding with stock 1.17.3
      const HARNESS_VERSION = '1.17.3+harness.2c9cdbd2'
      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue('/cached/opencode/harness'),
      })
      const mockExec = createMockExecAdapter()

      // #when
      const result = await installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)

      // #then — cache hit path; version in result keeps the raw +harness. form
      expect(result.cached).toBe(true)
      expect(result.version).toBe(HARNESS_VERSION)
      // find must have been called with the converted -harness. form
      expect(mockToolCache.find).toHaveBeenCalledWith('opencode', '1.17.3-harness.2c9cdbd2', expect.any(String))
      // download must NOT have been called (cache hit)
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

    it('rejects an unsupported platform before touching the cache or the network', async () => {
      // #given a win32 host
      Object.defineProperty(process, 'platform', {value: 'win32'})
      Object.defineProperty(process, 'arch', {value: 'x64'})
      const mockToolCache = createMockToolCache({find: vi.fn().mockReturnValue('')})
      const mockExec = createMockExecAdapter()

      // #when/#then the rejection propagates rather than being swallowed. Placement is the whole
      // mechanism: the gate runs before the tool-cache lookup and OUTSIDE the stock-fallback
      // `try`, so moving the call inside it would silently turn a hard platform failure back into
      // a fallback download attempt with every other test still green.
      await expect(installOpenCode('1.0.0', mockLogger, mockToolCache, mockExec)).rejects.toThrow(
        /Unsupported platform: win32\/x64/,
      )
      expect(mockToolCache.find).not.toHaveBeenCalled()
      expect(mockToolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('fails the install when the downloaded archive is not the expected type', async () => {
      // #given a darwin host and a `file` that reports something other than a zip — reachable now
      // that validateDownload has no platform escape hatch
      Object.defineProperty(process, 'platform', {value: 'darwin'})
      Object.defineProperty(process, 'arch', {value: 'arm64'})
      const mockToolCache = createMockToolCache({find: vi.fn().mockReturnValue('')})
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'HTML document text', stderr: ''}),
      })

      // #when/#then the magic-byte check rejects instead of caching a bad artifact
      await expect(installOpenCode('1.0.0', mockLogger, mockToolCache, mockExec)).rejects.toThrow(
        /Downloaded archive appears corrupted/,
      )
      expect(mockToolCache.cacheDir).not.toHaveBeenCalled()
    })

    it('uses extractZip for macOS', async () => {
      // #given
      Object.defineProperty(process, 'platform', {value: 'darwin'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        extractZip: vi.fn().mockResolvedValue('/tmp/extracted'),
      })
      // `file` must report a zip: validateDownload no longer has a platform escape hatch, so a
      // .zip archive is magic-byte checked on every supported platform
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'Zip archive data', stderr: ''}),
      })

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
      // A nonexistent 1.x stock version: major 2+ now takes the digest-verified V2 path instead
      const result = await installOpenCode('1.999.0', mockLogger, mockToolCache, mockExec)

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

    it('fail-closed: hyphen-form harness pin uses the harness URL and does not fall back to stock', async () => {
      // #given — users may copy the hyphen-form identity directly from the Releases page
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})

      const HARNESS_VERSION = '1.17.3-harness.abc12345'
      const mockToolCache = createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async (url: string) => {
          if (url.endsWith('SHA256SUMS')) throw new Error('HTTP 404: Not Found')
          return Promise.resolve('/tmp/opencode-linux-x64.tar.gz')
        }),
      })
      const mockExec = createMockExecAdapter()

      // #when / #then — the full install path must take the harness branch and fail closed
      await expect(installOpenCode(HARNESS_VERSION, mockLogger, mockToolCache, mockExec)).rejects.toThrow(
        /fail-closed|harness.*failed|404/i,
      )

      const calls = (mockToolCache.downloadTool as ReturnType<typeof vi.fn>).mock.calls as [string][]
      expect(calls[0]?.[0]).toContain('https://github.com/fro-bot/agent/releases/download/1.17.3-harness.abc12345/')
      expect(calls.some(([url]) => url.endsWith('SHA256SUMS'))).toBe(true)
      expect(calls.filter(([url]) => url.includes('anomalyco'))).toHaveLength(0)
      expect(mockLogger.warning).not.toHaveBeenCalled()
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
    it('is a harness build pinned to a base version plus an integration commit', () => {
      // Assert the SHAPE, not a specific commit: the self-update release workflow
      // bumps the integration SHA on every harness release, so pinning an exact
      // value here would break every legitimate bump. The invariant is the form
      // `<major.minor.patch>+harness.<short-sha>`.
      expect(DEFAULT_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+\+harness\.[0-9a-f]{7,}$/)
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
      // tool-cache collision guard: cacheDir must be called with the -harness. prerelease form,
      // NOT the raw +harness. build-metadata form (which semver.clean() would strip to '1.17.3')
      expect(mockToolCache.cacheDir).toHaveBeenCalledWith(
        expect.any(String),
        'opencode',
        '1.17.3-harness.abc12345',
        'x64',
      )
      // Download URL must use the hyphen release-tag form derived from the raw +harness. version.
      const downloadCalls = (mockToolCache.downloadTool as ReturnType<typeof vi.fn>).mock.calls as [string][]
      const archiveCall = downloadCalls.find(([url]) => !url.endsWith('SHA256SUMS'))
      expect(archiveCall?.[0]).toContain('-harness.')
      expect(archiveCall?.[0]).not.toContain('%2Bharness.')
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

  describe('isV2Version', () => {
    it('is true from major 2 upward, with or without a v prefix', () => {
      expect(isV2Version('2.2.0')).toBe(true)
      expect(isV2Version('v2.2.0')).toBe(true)
      expect(isV2Version('10.0.1')).toBe(true)
    })

    it('is false for major 0 and 1, including the current harness default', () => {
      expect(isV2Version('1.19.4')).toBe(false)
      expect(isV2Version('0.9.0')).toBe(false)
      expect(isV2Version(DEFAULT_OPENCODE_VERSION)).toBe(false)
    })

    it('is false for non-version input such as latest', () => {
      expect(isV2Version('latest')).toBe(false)
    })
  })

  describe('buildChecksumsUrl (stock V2)', () => {
    it('returns the anomalyco release SHA256SUMS URL for a V2 pin', () => {
      expect(buildChecksumsUrl('2.2.0')).toBe(
        'https://github.com/anomalyco/opencode/releases/download/v2.2.0/SHA256SUMS',
      )
    })
  })

  describe('RECORDED_V2_PIN', () => {
    it('pins a V2 version with a sha256 for every asset the Action and workspace use', () => {
      // #given the committed pin file
      // #then it is itself a V2 version and every digest is a lowercase sha256
      expect(isV2Version(RECORDED_V2_PIN.version)).toBe(true)
      expect(Object.keys(RECORDED_V2_PIN.assets).sort()).toEqual([
        'opencode-darwin-arm64.zip',
        'opencode-darwin-x64.zip',
        'opencode-linux-arm64-musl.tar.gz',
        'opencode-linux-arm64.tar.gz',
        'opencode-linux-x64-musl.tar.gz',
        'opencode-linux-x64.tar.gz',
      ])
      for (const digest of Object.values(RECORDED_V2_PIN.assets)) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
      }
    })
  })

  describe('stock V2 pin install', () => {
    const ARCHIVE_FILENAME = 'opencode-linux-x64.tar.gz'
    const ARCHIVE_PATH = '/tmp/opencode-linux-x64.tar.gz'
    const CHECKSUMS_PATH = '/tmp/SHA256SUMS'
    const V2_VERSION = '2.2.0'
    const archiveBytes = Buffer.from('genuine-v2-archive')
    const archiveHash = createHash('sha256').update(archiveBytes).digest('hex')
    const recordedPin: V2Pin = {version: V2_VERSION, assets: {[ARCHIVE_FILENAME]: archiveHash}}

    function createV2ToolCache(overrides: Partial<ToolCacheAdapter> = {}): ToolCacheAdapter {
      return createMockToolCache({
        find: vi.fn().mockReturnValue(''),
        downloadTool: vi.fn().mockImplementation(async (url: string) => {
          return Promise.resolve(url.endsWith('SHA256SUMS') ? CHECKSUMS_PATH : ARCHIVE_PATH)
        }),
        extractTar: vi.fn().mockResolvedValue('/tmp/extracted'),
        cacheDir: vi.fn().mockResolvedValue('/cached/opencode/2.2.0'),
        ...overrides,
      })
    }

    function serve(options: {readonly checksums: string; readonly archive?: Buffer}): void {
      fsState.readFileSyncImpl = (path: unknown) => (path === CHECKSUMS_PATH ? options.checksums : Buffer.alloc(0))
      fsState.createReadStreamImpl = () => options.archive ?? archiveBytes
    }

    beforeEach(() => {
      Object.defineProperty(process, 'platform', {value: 'linux'})
      Object.defineProperty(process, 'arch', {value: 'x64'})
    })

    it('happy path: installs when the archive matches the recorded digest and the SHA256SUMS line', async () => {
      // #given a release whose archive and SHA256SUMS line both equal the recorded digest
      serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
      const toolCache = createV2ToolCache()

      // #when
      const result = await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, recordedPin)

      // #then it installs from the stock release, with the checksums fetched from the same release
      expect(result).toEqual({path: '/cached/opencode/2.2.0', version: V2_VERSION, cached: false})
      expect(downloadedUrls(toolCache)).toEqual([
        `https://github.com/anomalyco/opencode/releases/download/v2.2.0/${ARCHIVE_FILENAME}`,
        'https://github.com/anomalyco/opencode/releases/download/v2.2.0/SHA256SUMS',
      ])
      expect(toolCache.extractTar).toHaveBeenCalledTimes(1)
      expect(toolCache.cacheDir).toHaveBeenCalledWith(
        '/tmp/extracted',
        'opencode',
        `${V2_VERSION}-sha256-${archiveHash.slice(0, 16)}`,
        'x64',
      )
    })

    it('returns the tool-cache hit without downloading', async () => {
      // #given a previously verified install in the tool cache
      const toolCache = createV2ToolCache({find: vi.fn().mockReturnValue('/cached/opencode/2.2.0')})

      // #when
      const result = await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, recordedPin)

      // #then
      expect(result.cached).toBe(true)
      expect(toolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('a tampered archive fails the install and is not retried against the fallback version', async () => {
      // #given SHA256SUMS and the recorded digest agree, but the archive bytes differ
      serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`, archive: Buffer.from('tampered-archive')})
      const toolCache = createV2ToolCache()

      // #when/#then
      await expect(
        installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, recordedPin),
      ).rejects.toThrow(/SHA256 mismatch/)

      // #then exactly one attempt: archive + SHA256SUMS, no second download, nothing extracted or cached
      expect(toolCache.downloadTool).toHaveBeenCalledTimes(2)
      expect(downloadedUrls(toolCache).some(url => url.includes(`v${FALLBACK_VERSION}`))).toBe(false)
      expect(toolCache.extractTar).not.toHaveBeenCalled()
      expect(toolCache.cacheDir).not.toHaveBeenCalled()
      expect(mockLogger.warning).not.toHaveBeenCalled()
    })

    it('a platform with no recorded digest fails before anything is downloaded', async () => {
      // #given a pin that records no digest for this platform's asset
      const pinWithoutPlatform: V2Pin = {version: V2_VERSION, assets: {'opencode-linux-arm64.tar.gz': archiveHash}}
      const toolCache = createV2ToolCache()

      // #when/#then
      await expect(
        installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, pinWithoutPlatform),
      ).rejects.toThrow(/no recorded digest for opencode-linux-x64\.tar\.gz/)
      expect(toolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('a version other than the recorded pin fails before anything is downloaded', async () => {
      // #given a V2 version the pin file has no digests for
      const toolCache = createV2ToolCache()

      // #when/#then
      await expect(
        installOpenCode('2.3.0', mockLogger, toolCache, createGzipExec(), undefined, recordedPin),
      ).rejects.toThrow(/2\.3\.0.*2\.2\.0/)
      expect(toolCache.find).not.toHaveBeenCalled()
      expect(toolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('fails when SHA256SUMS disagrees with the recorded digest, even if the archive matches SHA256SUMS', async () => {
      // #given a release whose archive and SHA256SUMS were replaced together
      const replaced = Buffer.from('replaced-archive')
      const replacedHash = createHash('sha256').update(replaced).digest('hex')
      serve({checksums: `${replacedHash}  ${ARCHIVE_FILENAME}\n`, archive: replaced})
      const toolCache = createV2ToolCache()

      // #when/#then the recorded digest is the anchor, so self-consistent upstream data is not enough
      await expect(
        installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, recordedPin),
      ).rejects.toThrow(/SHA256SUMS.*disagrees with the recorded digest/)
      expect(toolCache.extractTar).not.toHaveBeenCalled()
      expect(downloadedUrls(toolCache).some(url => url.includes(`v${FALLBACK_VERSION}`))).toBe(false)
    })

    it('fails when SHA256SUMS has no entry for the asset', async () => {
      // #given
      serve({checksums: `${archiveHash}  opencode-linux-arm64.tar.gz\n`})
      const toolCache = createV2ToolCache()

      // #when/#then
      await expect(
        installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, recordedPin),
      ).rejects.toThrow(/does not contain an entry for opencode-linux-x64\.tar\.gz/)
      expect(toolCache.extractTar).not.toHaveBeenCalled()
    })

    it('does not pass validation when the file command is unavailable', async () => {
      // #given a verified archive but no `file` binary to run the magic-byte check
      serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
      const toolCache = createV2ToolCache()
      const exec = createGzipExec({getExecOutput: vi.fn().mockRejectedValue(new Error('spawn file ENOENT'))})

      // #when/#then the V1 fail-open default does not apply to a V2 pin
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, exec, undefined, recordedPin)).rejects.toThrow(
        /file command unavailable/,
      )
      expect(toolCache.extractTar).not.toHaveBeenCalled()
      expect(toolCache.cacheDir).not.toHaveBeenCalled()
    })

    it('fails when file reports a different archive type', async () => {
      // #given a digest-verified archive that `file` does not recognise as gzip
      serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
      const toolCache = createV2ToolCache()
      const exec = createGzipExec({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'HTML document text', stderr: ''}),
      })

      // #when/#then
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, exec, undefined, recordedPin)).rejects.toThrow(
        /appears corrupted/,
      )
      expect(toolCache.extractTar).not.toHaveBeenCalled()
    })

    it('throws on a download failure and does not retry against the fallback version', async () => {
      // #given
      const toolCache = createV2ToolCache({downloadTool: vi.fn().mockRejectedValue(new Error('HTTP 503'))})

      // #when/#then
      await expect(
        installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, recordedPin),
      ).rejects.toThrow(/V2 OpenCode download\/verify failed for pin "2\.2\.0".*HTTP 503.*No fallback/)
      expect(toolCache.downloadTool).toHaveBeenCalledTimes(1)
      expect(mockLogger.warning).not.toHaveBeenCalled()
    })

    describe('cache identity', () => {
      const ID = `sha256-${archiveHash.slice(0, 16)}`
      const BOUND_VERSION = `${V2_VERSION}-${ID}`

      it('looks up and saves the tool cache under a digest-bound version, never the bare version', async () => {
        // #given a cold cache and a valid release
        serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
        const toolCache = createV2ToolCache()

        // #when
        await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, recordedPin)

        // #then
        expect(toolCache.find).toHaveBeenCalledWith('opencode', BOUND_VERSION, 'x64')
        expect(toolCache.cacheDir).toHaveBeenCalledWith('/tmp/extracted', 'opencode', BOUND_VERSION, 'x64')
      })

      it('does not reuse a legacy entry cached under the bare version before digests were recorded', async () => {
        // #given a warm cache that only holds the pre-change entry for 2.2.0
        serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
        const toolCache = createV2ToolCache({
          find: vi
            .fn()
            .mockImplementation((_name: string, version: string) => (version === V2_VERSION ? '/legacy/2.2.0' : '')),
        })

        // #when
        const result = await installOpenCode(
          V2_VERSION,
          mockLogger,
          toolCache,
          createGzipExec(),
          undefined,
          recordedPin,
        )

        // #then it re-downloads and verifies instead of trusting the unverified entry
        expect(result.cached).toBe(false)
        expect(result.path).not.toBe('/legacy/2.2.0')
        expect(toolCache.downloadTool).toHaveBeenCalledTimes(2)
      })

      it('reuses an entry bound to the recorded digest without downloading', async () => {
        // #given
        const toolCache = createV2ToolCache({
          find: vi
            .fn()
            .mockImplementation((_name: string, version: string) => (version === BOUND_VERSION ? '/bound' : '')),
        })

        // #when
        const result = await installOpenCode(
          V2_VERSION,
          mockLogger,
          toolCache,
          createGzipExec(),
          undefined,
          recordedPin,
        )

        // #then
        expect(result).toEqual({path: '/bound', version: V2_VERSION, cached: true})
        expect(toolCache.downloadTool).not.toHaveBeenCalled()
      })

      it('does not reuse an entry bound to a different digest', async () => {
        // #given a cache entry written for a previous digest of the same version
        serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
        const oldBound = `${V2_VERSION}-sha256-${'0'.repeat(16)}`
        const toolCache = createV2ToolCache({
          find: vi
            .fn()
            .mockImplementation((_name: string, version: string) => (version === oldBound ? '/old-digest' : '')),
        })

        // #when
        const result = await installOpenCode(
          V2_VERSION,
          mockLogger,
          toolCache,
          createGzipExec(),
          undefined,
          recordedPin,
        )

        // #then
        expect(result.cached).toBe(false)
        expect(toolCache.downloadTool).toHaveBeenCalledTimes(2)
      })

      it('consults no cache when the version is unpinned or the platform has no digest, even if one is warm', async () => {
        // #given a cache that would return a hit for any lookup
        const toolCache = createV2ToolCache({find: vi.fn().mockReturnValue('/warm')})
        const pinWithoutPlatform: V2Pin = {version: V2_VERSION, assets: {'opencode-linux-arm64.tar.gz': archiveHash}}

        // #when/#then
        await expect(
          installOpenCode('2.3.0', mockLogger, toolCache, createGzipExec(), undefined, recordedPin),
        ).rejects.toThrow(/2\.3\.0/)
        await expect(
          installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), undefined, pinWithoutPlatform),
        ).rejects.toThrow(/no recorded digest/)
        expect(toolCache.find).not.toHaveBeenCalled()
      })
    })

    describe('resolveStockV2Policy', () => {
      const info: PlatformInfo = {os: 'linux', arch: 'x64', ext: '.tar.gz'}

      it('derives a cache identity from the first 16 hex characters of the recorded digest', () => {
        expect(resolveStockV2Policy('2.2.0', info, recordedPin)).toEqual({
          recordedDigest: archiveHash,
          cacheId: `sha256-${archiveHash.slice(0, 16)}`,
          cacheVersion: `2.2.0-sha256-${archiveHash.slice(0, 16)}`,
        })
      })

      it('normalises a v prefix so both spellings share one identity', () => {
        expect(resolveStockV2Policy('v2.2.0', info, recordedPin).cacheVersion).toBe(
          resolveStockV2Policy('2.2.0', info, recordedPin).cacheVersion,
        )
      })

      it('changes the identity when the recorded digest changes', () => {
        const changed: V2Pin = {version: V2_VERSION, assets: {[ARCHIVE_FILENAME]: 'a'.repeat(64)}}
        expect(resolveStockV2Policy('2.2.0', info, changed).cacheVersion).not.toBe(
          resolveStockV2Policy('2.2.0', info, recordedPin).cacheVersion,
        )
        expect(resolveStockV2Policy('2.2.0', info, changed).cacheId).not.toBe(
          resolveStockV2Policy('2.2.0', info, recordedPin).cacheId,
        )
      })

      it('throws for an unpinned version and for a platform with no digest', () => {
        expect(() => resolveStockV2Policy('2.3.0', info, recordedPin)).toThrow(/2\.3\.0/)
        expect(() => resolveStockV2Policy('2.2.0', {...info, arch: 'arm64'}, recordedPin)).toThrow(/no recorded digest/)
      })

      it('produces a tool-cache version that semver accepts as a prerelease', () => {
        expect(resolveStockV2Policy('2.2.0', info, recordedPin).cacheVersion).toMatch(
          /^\d+\.\d+\.\d+-sha256-[0-9a-f]{16}$/,
        )
      })
    })

    describe('isStockV2Pin', () => {
      it('is true for stock major 2+, false for V1, harness builds and non-versions', () => {
        expect(isStockV2Pin('2.2.0')).toBe(true)
        expect(isStockV2Pin('1.19.4')).toBe(false)
        expect(isStockV2Pin('2.0.0+harness.abc12345')).toBe(false)
        expect(isStockV2Pin('latest')).toBe(false)
      })
    })

    it('a V1 pin still takes the V1 path: magic-byte check only, fail-open, fallback retry', async () => {
      // #given a stock 1.x pin whose first download fails and whose `file` command is missing
      let downloads = 0
      const toolCache = createV2ToolCache({
        downloadTool: vi.fn().mockImplementation(async () => {
          downloads++
          if (downloads === 1) throw new Error('Download failed')
          return Promise.resolve(ARCHIVE_PATH)
        }),
      })
      const exec = createGzipExec({getExecOutput: vi.fn().mockRejectedValue(new Error('spawn file ENOENT'))})

      // #when
      const result = await installOpenCode('1.17.3', mockLogger, toolCache, exec, undefined, recordedPin)

      // #then V1 retried with the fallback, never fetched SHA256SUMS, and passed validation without `file`
      expect(result.version).toBe(FALLBACK_VERSION)
      // and kept the plain, digest-free cache identity
      expect(toolCache.find).toHaveBeenCalledWith('opencode', '1.17.3', 'x64')
      expect(toolCache.cacheDir).toHaveBeenCalledWith('/tmp/extracted', 'opencode', FALLBACK_VERSION, 'x64')
      expect(downloadedUrls(toolCache).some(url => url.endsWith('SHA256SUMS'))).toBe(false)
      expect(mockLogger.warning).toHaveBeenCalled()
    })
  })
})
