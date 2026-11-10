import type {V2Pin} from './opencode.js'
import type {ExecAdapter, Logger, PlatformInfo, ToolCacheAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import path from 'node:path'
import {selectOpenCodeGeneration} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_OPENCODE_VERSION} from '../../shared/constants.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  buildChecksumsUrl,
  buildDownloadUrl,
  getPlatformInfo,
  installOpenCode,
  opencodeBinaryPath,
  RECORDED_V2_PIN,
  resolveRequestedVersion,
  resolveStockV2Policy,
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
      const installDir = '/opt/hostedtoolcache/opencode/2.2.6-sha256-0123456789abcdef/x64'

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

  describe('resolveRequestedVersion', () => {
    it('resolves "latest" to the recorded V2 pin without any network lookup', () => {
      // #given a network that would answer with an unverified stock V1 as upstream's releases/latest
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({tag_name: 'v1.19.5'}), {status: 200}))

      // #when
      const resolved = resolveRequestedVersion('latest')

      // #then the pin wins and upstream is never asked
      expect(resolved).toBe(RECORDED_V2_PIN.version)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('resolves "latest" against an explicit pin', () => {
      // #given/#when/#then
      expect(resolveRequestedVersion('latest', {version: '2.9.0', assets: {}})).toBe('2.9.0')
    })

    it.each(['1.19.4+harness.5bde2635', '1.19.4-harness.5bde2635', '1.19.4', '2.2.5', '2.9.9'])(
      'passes the explicit version %s through unchanged',
      version => {
        // #given/#when/#then
        expect(resolveRequestedVersion(version)).toBe(version)
      },
    )
  })

  describe('DEFAULT_OPENCODE_VERSION', () => {
    it('is the recorded stock V2 pin: one source of truth, opencode-v2-pin.json', () => {
      expect(DEFAULT_OPENCODE_VERSION).toBe(RECORDED_V2_PIN.version)
    })

    it('is a stock V2 pin with no harness build metadata', () => {
      expect(selectOpenCodeGeneration(DEFAULT_OPENCODE_VERSION)).toEqual({success: true, data: 'v2'})
      expect(DEFAULT_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
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
      expect(selectOpenCodeGeneration(RECORDED_V2_PIN.version)).toEqual({success: true, data: 'v2'})
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
      const result = await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)

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
      const result = await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)

      // #then
      expect(result.cached).toBe(true)
      expect(toolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('a tampered archive fails the install and is not retried', async () => {
      // #given SHA256SUMS and the recorded digest agree, but the archive bytes differ
      serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`, archive: Buffer.from('tampered-archive')})
      const toolCache = createV2ToolCache()

      // #when/#then
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
        /SHA256 mismatch/,
      )

      // #then exactly one attempt: archive + SHA256SUMS, no second download, nothing extracted or cached
      expect(toolCache.downloadTool).toHaveBeenCalledTimes(2)
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
        installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), pinWithoutPlatform),
      ).rejects.toThrow(/no recorded digest for opencode-linux-x64\.tar\.gz/)
      expect(toolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('fails when SHA256SUMS disagrees with the recorded digest, even if the archive matches SHA256SUMS', async () => {
      // #given a release whose archive and SHA256SUMS were replaced together
      const replaced = Buffer.from('replaced-archive')
      const replacedHash = createHash('sha256').update(replaced).digest('hex')
      serve({checksums: `${replacedHash}  ${ARCHIVE_FILENAME}\n`, archive: replaced})
      const toolCache = createV2ToolCache()

      // #when/#then the recorded digest is the anchor, so self-consistent upstream data is not enough
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
        /SHA256SUMS.*disagrees with the recorded digest/,
      )
      expect(toolCache.extractTar).not.toHaveBeenCalled()
      expect(toolCache.downloadTool).toHaveBeenCalledTimes(2)
    })

    it('fails when SHA256SUMS has no entry for the asset', async () => {
      // #given
      serve({checksums: `${archiveHash}  opencode-linux-arm64.tar.gz\n`})
      const toolCache = createV2ToolCache()

      // #when/#then
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
        /does not contain an entry for opencode-linux-x64\.tar\.gz/,
      )
      expect(toolCache.extractTar).not.toHaveBeenCalled()
    })

    it('does not pass validation when the file command is unavailable', async () => {
      // #given a verified archive but no `file` binary to run the magic-byte check
      serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
      const toolCache = createV2ToolCache()
      const exec = createGzipExec({getExecOutput: vi.fn().mockRejectedValue(new Error('spawn file ENOENT'))})

      // #when/#then the V1 fail-open default does not apply to a V2 pin
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, exec, recordedPin)).rejects.toThrow(
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
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, exec, recordedPin)).rejects.toThrow(
        /appears corrupted/,
      )
      expect(toolCache.extractTar).not.toHaveBeenCalled()
    })

    it('a failed pin request throws and is not retried', async () => {
      // #given
      const toolCache = createV2ToolCache({downloadTool: vi.fn().mockRejectedValue(new Error('HTTP 503'))})

      // #when/#then
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
        /V2 OpenCode download\/verify failed for pin "2\.2\.0".*HTTP 503.*No fallback/,
      )
      expect(toolCache.downloadTool).toHaveBeenCalledTimes(1)
      expect(mockLogger.warning).not.toHaveBeenCalled()
    })

    it.each(['1.19.5', '1.19.4', 'v1.19.4', '0.9.0', '1.19.5+harness.bf7f7dfe', '1.19.5-harness.bf7f7dfe'])(
      'rejects the V1 version %s before any cache lookup or download',
      async version => {
        // #given a warm tool cache and an archive that would verify
        serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
        const toolCache = createV2ToolCache({find: vi.fn().mockReturnValue('/warm')})

        // #when/#then the pin policy refuses it and names the only pinned version
        await expect(installOpenCode(version, mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
          /only 2\.2\.0 is pinned/,
        )
        expect(toolCache.find).not.toHaveBeenCalled()
        expect(toolCache.downloadTool).not.toHaveBeenCalled()
        expect(toolCache.cacheDir).not.toHaveBeenCalled()
      },
    )

    it('rejects an unsupported platform before touching the cache or the network', async () => {
      // #given a win32 host
      Object.defineProperty(process, 'platform', {value: 'win32'})
      Object.defineProperty(process, 'arch', {value: 'x64'})
      const toolCache = createV2ToolCache()

      // #when/#then the rejection propagates before the cache lookup, not as a download attempt
      await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
        /Unsupported platform: win32\/x64/,
      )
      expect(toolCache.find).not.toHaveBeenCalled()
      expect(toolCache.downloadTool).not.toHaveBeenCalled()
    })

    it('extracts a macOS archive with extractZip', async () => {
      // #given a darwin host whose recorded asset is a zip that `file` recognises
      Object.defineProperty(process, 'platform', {value: 'darwin'})
      Object.defineProperty(process, 'arch', {value: 'arm64'})
      const zipFilename = 'opencode-darwin-arm64.zip'
      const zipPin: V2Pin = {version: V2_VERSION, assets: {[zipFilename]: archiveHash}}
      serve({checksums: `${archiveHash}  ${zipFilename}\n`})
      const toolCache = createV2ToolCache({extractZip: vi.fn().mockResolvedValue('/tmp/extracted')})
      const exec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'Zip archive data', stderr: ''}),
      })

      // #when
      await installOpenCode(V2_VERSION, mockLogger, toolCache, exec, zipPin)

      // #then
      expect(toolCache.extractZip).toHaveBeenCalledTimes(1)
      expect(toolCache.extractTar).not.toHaveBeenCalled()
    })

    describe('cache identity', () => {
      const ID = `sha256-${archiveHash.slice(0, 16)}`
      const BOUND_VERSION = `${V2_VERSION}-${ID}`

      it('looks up and saves the tool cache under a digest-bound version, never the bare version', async () => {
        // #given a cold cache and a valid release
        serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
        const toolCache = createV2ToolCache()

        // #when
        await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)

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
        const result = await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)

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
        const result = await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)

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
        const result = await installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)

        // #then
        expect(result.cached).toBe(false)
        expect(toolCache.downloadTool).toHaveBeenCalledTimes(2)
      })

      it('consults no cache when the platform has no digest, even if one is warm', async () => {
        // #given a cache that would return a hit for any lookup
        const toolCache = createV2ToolCache({find: vi.fn().mockReturnValue('/warm')})
        const pinWithoutPlatform: V2Pin = {version: V2_VERSION, assets: {'opencode-linux-arm64.tar.gz': archiveHash}}

        // #when/#then
        await expect(
          installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), pinWithoutPlatform),
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

    describe('a failed install never falls back', () => {
      it('a V2 version with no recorded digest fails before any cache or download, with no fallback to the pin', async () => {
        // #given a V2 request the pin file has no digests for, next to a genuine pin archive and a warm cache
        serve({checksums: `${archiveHash}  ${ARCHIVE_FILENAME}\n`})
        const toolCache = createV2ToolCache({find: vi.fn().mockReturnValue('/warm')})

        // #when/#then it names the request and the recorded pin, and installs nothing
        await expect(installOpenCode('2.3.0', mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
          /2\.3\.0.*2\.2\.0/,
        )
        expect(toolCache.find).not.toHaveBeenCalled()
        expect(toolCache.downloadTool).not.toHaveBeenCalled()
        expect(toolCache.cacheDir).not.toHaveBeenCalled()
      })

      it('a failed pin request fails and does not retry', async () => {
        // #given the pin itself cannot be downloaded
        const toolCache = createV2ToolCache({downloadTool: vi.fn().mockRejectedValue(new Error('HTTP 503'))})

        // #when/#then one attempt, then the failure
        await expect(installOpenCode(V2_VERSION, mockLogger, toolCache, createGzipExec(), recordedPin)).rejects.toThrow(
          /V2 OpenCode download\/verify failed for pin "2\.2\.0".*HTTP 503/,
        )
        expect(toolCache.downloadTool).toHaveBeenCalledTimes(1)
        expect(mockLogger.warning).not.toHaveBeenCalled()
      })

      it('a "v"-prefixed pin request is the pin: it fails without a second attempt', async () => {
        // #given the pin spelled with a v prefix and an unreachable release
        const toolCache = createV2ToolCache({downloadTool: vi.fn().mockRejectedValue(new Error('HTTP 503'))})

        // #when/#then
        await expect(
          installOpenCode(`v${V2_VERSION}`, mockLogger, toolCache, createGzipExec(), recordedPin),
        ).rejects.toThrow(/HTTP 503/)
        expect(toolCache.downloadTool).toHaveBeenCalledTimes(1)
      })
    })
  })
})
