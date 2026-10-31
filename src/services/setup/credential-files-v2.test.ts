import type {AuthConfig} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger, serializeLoggerCalls, unwrapErr} from '../../shared/test-helpers.js'
import {buildCachePathsV1Sqlite, buildCachePathsV2} from '../cache/paths.js'
import {
  parseProviderKeysV2,
  removeStaleAuthJsonV2,
  resolveCredentialBaseDir,
  writeCredentialFilesV2,
} from './credential-files-v2.js'
import {buildCachePaths as buildToolsCachePaths} from './tools-cache.js'

const CANARY_A = 'sk-ant-CANARY-AAAA-1111'
const CANARY_B = 'sk-oai-CANARY-BBBB-2222'

function apiAuth(): AuthConfig {
  return {
    anthropic: {type: 'api', key: CANARY_A},
    openai: {type: 'api', key: CANARY_B},
  }
}

describe('credential-files-v2', () => {
  let base: string

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-files-test-'))
  })

  afterEach(async () => {
    await fs.rm(base, {recursive: true, force: true})
  })

  describe('parseProviderKeysV2', () => {
    it('returns one entry per api provider', () => {
      // #when
      const result = parseProviderKeysV2(apiAuth())

      // #then
      expect(result).toEqual({
        success: true,
        data: [
          {providerId: 'anthropic', key: CANARY_A},
          {providerId: 'openai', key: CANARY_B},
        ],
      })
    })

    it('accepts an empty auth-json', () => {
      expect(parseProviderKeysV2({})).toEqual({success: true, data: []})
    })

    it.each([
      ['oauth', {type: 'oauth', refresh: 'REFRESH-CANARY', access: 'ACCESS-CANARY', expires: 1}],
      ['wellknown', {type: 'wellknown', key: 'WK-CANARY', token: 'TOKEN-CANARY'}],
      ['an unknown type', {type: 'mystery', key: 'MYSTERY-CANARY'}],
    ])('fails with a named error for %s, carrying only the provider id', (_label, entry) => {
      // #given
      const auth = {anthropic: {type: 'api', key: CANARY_A}, 'github-copilot': entry} as unknown as AuthConfig

      // #when
      const result = parseProviderKeysV2(auth)

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.kind).toBe('unsupported-credential-type')
      expect(result.error.providerId).toBe('github-copilot')
      const serialized = JSON.stringify(result.error)
      expect(serialized).toContain('github-copilot')
      for (const canary of [CANARY_A, 'CANARY']) expect(serialized).not.toContain(canary)
      expect(serialized).not.toContain(entry.type)
    })

    it('fails when an api entry has no usable key, without echoing anything but the provider id', () => {
      const result = parseProviderKeysV2({anthropic: {type: 'api', key: '   '}})

      expect(result).toMatchObject({success: false, error: {kind: 'invalid-credential', providerId: 'anthropic'}})
    })

    it.each(['../escape', 'a/b', '..', '.', '.hidden', 'with space', 'new\nline', 'brace}'])(
      'rejects the provider id %j before it can name a file, without echoing it',
      providerId => {
        const result = parseProviderKeysV2({[providerId]: {type: 'api', key: CANARY_A}})

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.kind).toBe('invalid-provider-id')
        expect(result.error.providerId).toBeUndefined()
        expect(JSON.stringify(result.error)).not.toContain(providerId.trim() === '' ? '\u0000' : providerId)
        expect(JSON.stringify(result.error)).not.toContain(CANARY_A)
      },
    )
  })

  describe('writeCredentialFilesV2', () => {
    it('writes each key to its own 0600 file inside a 0700 run directory and maps the provider to the file', async () => {
      // #given
      const entries = [
        {providerId: 'anthropic', key: CANARY_A},
        {providerId: 'openai', key: CANARY_B},
      ]

      // #when
      const result = await writeCredentialFilesV2({entries, baseDir: base, logger: createMockLogger()})

      // #then
      expect(result.success).toBe(true)
      if (!result.success) return
      const {keyFiles} = result.data
      const directory = result.data.directory as string
      expect(path.dirname(directory)).toBe(base)
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
      expect(Object.keys(keyFiles).sort()).toEqual(['anthropic', 'openai'])
      expect(new Set(Object.values(keyFiles)).size).toBe(2)
      for (const [providerId, file] of Object.entries(keyFiles)) {
        expect(path.isAbsolute(file)).toBe(true)
        expect(path.dirname(file)).toBe(directory)
        const expected = providerId === 'anthropic' ? CANARY_A : CANARY_B
        const handle = await fs.open(file, 'r')
        try {
          expect((await handle.stat()).mode & 0o777).toBe(0o600)
          expect(await handle.readFile('utf8')).toBe(expected)
        } finally {
          await handle.close()
        }
      }
    })

    it('uses a fresh directory per call', async () => {
      const entries = [{providerId: 'anthropic', key: CANARY_A}]
      const first = await writeCredentialFilesV2({entries, baseDir: base, logger: createMockLogger()})
      const second = await writeCredentialFilesV2({entries, baseDir: base, logger: createMockLogger()})

      expect(first.success && second.success && first.data.directory !== second.data.directory).toBe(true)
    })

    it('writes nothing for an empty entry list', async () => {
      const result = await writeCredentialFilesV2({entries: [], baseDir: base, logger: createMockLogger()})

      expect(result).toEqual({success: true, data: {directory: null, keyFiles: {}}})
      expect(await fs.readdir(base)).toEqual([])
    })

    it('refuses a base directory whose path could break out of a {file:} reference', async () => {
      const entries = [{providerId: 'anthropic', key: CANARY_A}]

      for (const unsafe of ['relative/dir', path.join(base, 'a}b'), path.join(base, 'quo"te')]) {
        const result = await writeCredentialFilesV2({entries, baseDir: unsafe, logger: createMockLogger()})
        expect(result).toMatchObject({success: false, error: {kind: 'unsafe-directory'}})
        expect(JSON.stringify(unwrapErr(result))).not.toContain(CANARY_A)
      }
    })

    it('never puts a key or a key path in a log line or an error', async () => {
      // #given
      const logger = createMockLogger()
      const entries = [
        {providerId: 'anthropic', key: CANARY_A},
        {providerId: 'openai', key: CANARY_B},
      ]

      // #when
      const result = await writeCredentialFilesV2({entries, baseDir: base, logger})

      // #then
      expect(result.success).toBe(true)
      if (!result.success) return
      const logged = serializeLoggerCalls(logger)
      expect(logged).toContain('anthropic')
      for (const secret of [
        CANARY_A,
        CANARY_B,
        result.data.directory ?? '\u0000',
        ...Object.values(result.data.keyFiles),
      ]) {
        expect(logged).not.toContain(secret)
      }
    })

    it('fails with a named error that holds no key when the directory cannot be written', async () => {
      const blocker = path.join(base, 'blocker')
      await fs.writeFile(blocker, 'a file, not a directory')

      const result = await writeCredentialFilesV2({
        entries: [{providerId: 'anthropic', key: CANARY_A}],
        baseDir: path.join(blocker, 'child'),
        logger: createMockLogger(),
      })

      expect(result).toMatchObject({success: false, error: {kind: 'write-failed'}})
      expect(JSON.stringify(unwrapErr(result))).not.toContain(CANARY_A)
    })
  })

  describe('resolveCredentialBaseDir', () => {
    it('prefers RUNNER_TEMP and falls back to the OS temp directory', () => {
      expect(resolveCredentialBaseDir({RUNNER_TEMP: '/home/runner/work/_temp'})).toBe('/home/runner/work/_temp')
      expect(resolveCredentialBaseDir({RUNNER_TEMP: '  '})).toBe(os.tmpdir())
      expect(resolveCredentialBaseDir({})).toBe(os.tmpdir())
    })
  })

  describe('where the key files sit', () => {
    it('is outside every cached, saved and uploaded path of a run', async () => {
      // #given a run whose temp root, home and workspace look like a runner's
      const runnerTemp = await fs.mkdtemp(path.join(base, 'runner-temp-'))
      const home = path.join(base, 'home')
      const dataHome = path.join(home, '.local', 'share')
      const storagePath = path.join(dataHome, 'opencode', 'storage')
      const projectIdPath = path.join(base, 'workspace', '.git', 'opencode')
      const toolCachePath = path.join(base, 'hostedtoolcache', 'opencode')
      const opencodeCachePath = path.join(home, '.cache', 'opencode')

      const written = await writeCredentialFilesV2({
        entries: [{providerId: 'anthropic', key: CANARY_A}],
        baseDir: resolveCredentialBaseDir({RUNNER_TEMP: runnerTemp}),
        logger: createMockLogger(),
      })
      expect(written.success).toBe(true)
      if (!written.success) return
      const keyFile = written.data.keyFiles.anthropic as string

      // #when the path lists every save and upload uses are built
      const sessionPaths = [
        ...buildCachePathsV2(storagePath, projectIdPath),
        ...buildCachePathsV1Sqlite(storagePath, projectIdPath),
      ]
      const toolsPaths = buildToolsCachePaths({toolCachePath, opencodeCachePath})
      // The object-store sync transports only the database file; the log artifact uploads one log file.
      const dbDir = path.dirname(storagePath)
      const uploadedLog = path.join(dataHome, 'opencode', 'log', 'opencode.log')
      const everyPath = [...sessionPaths, ...toolsPaths, dbDir, uploadedLog, storagePath]

      // #then no cached or uploaded path equals the key file or contains it
      const inside = (file: string, root: string): boolean => {
        const relative = path.relative(root, file)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      }
      for (const root of everyPath) {
        expect(inside(keyFile, root), `${keyFile} must not be inside ${root}`).toBe(false)
      }
      // and the directory itself is not inside the home that the tools cache and storage live under
      expect(inside(written.data.directory ?? '', home)).toBe(false)
    })
  })

  describe('removeStaleAuthJsonV2', () => {
    it('deletes an auth.json that a restore or an earlier run left behind', async () => {
      const authPath = path.join(base, 'auth.json')
      await fs.writeFile(authPath, JSON.stringify({anthropic: {type: 'api', key: CANARY_A}}))
      const logger = createMockLogger()

      await removeStaleAuthJsonV2(authPath, logger)

      await expect(fs.stat(authPath)).rejects.toMatchObject({code: 'ENOENT'})
      expect(JSON.stringify((logger.info as unknown as {mock: {calls: unknown[]}}).mock.calls)).not.toContain(CANARY_A)
    })

    it('is a no-op when there is no auth.json', async () => {
      await expect(removeStaleAuthJsonV2(path.join(base, 'auth.json'), createMockLogger())).resolves.toBeUndefined()
    })
  })
})
