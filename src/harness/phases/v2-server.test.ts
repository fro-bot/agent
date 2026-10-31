import type {OpenCodeV2ServerHandle, OpenCodeV2ShutdownResult} from '@fro-bot/runtime'
import type {StartActionOpenCodeV2Deps, StartActionOpenCodeV2Options} from './v2-server.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {clearHeldClaims} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest'
import {pluginCacheDir, resolvePluginSpecsV2} from '../../services/setup/plugin-install-v2.js'
import {createMockLogger, serializeLoggerCalls, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'
import {startActionOpenCodeV2} from './v2-server.js'

const CANARY = 'sk-ant-CANARY-v2-server-1234'
const SYSTEMATIC = 'systematic'
const FRO_BOT = 'fro-bot.opencode-plugin'

type StartServer = StartActionOpenCodeV2Deps['startServer']

interface FakeServer {
  readonly handle: OpenCodeV2ServerHandle
  readonly shutdown: ReturnType<typeof vi.fn>
  readonly fetch: Mock<(pathname: string) => Promise<Response>>
  /** The server loads the permissions from the config it is spawned with, as the real one does. */
  readonly loadConfig: (config: Readonly<Record<string, unknown>> | undefined) => void
}

function fakeServer(options: {agents?: unknown; integration?: unknown; agentStatus?: number} = {}): FakeServer {
  let loaded: unknown[] = []
  const shutdown = vi.fn(async (): Promise<OpenCodeV2ShutdownResult> => ({
    interrupts: {stopped: [], notRunning: [], unconfirmed: []},
    exit: {outcome: 'graceful', code: 0, signal: null},
  }))
  const fetchMock = vi.fn<(pathname: string) => Promise<Response>>(async pathname => {
    if (pathname === '/api/agent') {
      const agents = options.agents ?? {location: {}, data: [{id: 'build', permissions: loaded}]}
      return new Response(JSON.stringify(agents), {status: options.agentStatus ?? 200})
    }
    if (pathname.startsWith('/api/integration/')) {
      return new Response(JSON.stringify(options.integration ?? {data: {connections: []}}), {status: 200})
    }
    return new Response('{}', {status: 404})
  })
  const handle: OpenCodeV2ServerHandle = {
    url: 'http://127.0.0.1:1',
    pid: 1,
    directory: '/workspace',
    fetch: fetchMock,
    authorizationHeader: () => 'Basic x',
    exited: new Promise(() => undefined),
    registerOwnedSession: () => undefined,
    shutdown,
  }
  return {
    handle,
    shutdown,
    fetch: fetchMock,
    loadConfig: config => {
      loaded = Array.isArray(config?.permissions) ? config.permissions : []
    },
  }
}

function realClearDeps(server: FakeServer): Partial<StartActionOpenCodeV2Deps> {
  return {
    startServer: vi.fn<StartServer>(async spawnOptions => {
      server.loadConfig(spawnOptions.config)
      return {success: true, data: server.handle}
    }),
    clearClaims: clearHeldClaims,
    waitForImport: vi.fn(async () => ({success: true, data: undefined}) as const),
    readDatabaseFacts: () => ({bytes: null, sessions: null}),
    installPlugins: vi.fn(async () => ({success: true, data: undefined}) as const),
  }
}

type InstallPlugins = StartActionOpenCodeV2Deps['installPlugins']

/** The two exact specs a default run installs, as the code under test resolves them. */
const PLUGIN_SPECS = unwrapOk(resolvePluginSpecsV2('latest')).specs

function populatePluginCache(cacheHome: string): void {
  for (const spec of PLUGIN_SPECS) {
    const dir = pluginCacheDir(cacheHome, spec)
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  }
}

describe('startActionOpenCodeV2', () => {
  let root: string
  let runnerTemp: string
  let dbPath: string
  let authPath: string
  let cacheHome: string
  let calls: string[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-server-test-'))
    runnerTemp = path.join(root, 'runner-temp')
    fs.mkdirSync(runnerTemp)
    // A warm plugin cache by default: a run with both plugins cached installs nothing.
    cacheHome = path.join(root, 'cache')
    populatePluginCache(cacheHome)
    const dataDir = path.join(root, 'data', 'opencode')
    fs.mkdirSync(dataDir, {recursive: true})
    dbPath = path.join(dataDir, 'opencode.db')
    authPath = path.join(dataDir, 'auth.json')
    calls = []
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  function options(
    overrides: Partial<StartActionOpenCodeV2Options> & {deps?: Partial<StartActionOpenCodeV2Deps>} = {},
  ): StartActionOpenCodeV2Options {
    return {
      binaryPath: '/opt/opencode',
      workspacePath: '/workspace',
      authJson: JSON.stringify({anthropic: {type: 'api', key: CANARY}}),
      opencodeConfig: null,
      systematicVersion: 'latest',
      model: 'anthropic/claude-sonnet',
      dbPath,
      authPath,
      env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
      runId: 42,
      runAttempt: 1,
      logger: createMockLogger(),
      ...overrides,
    }
  }

  /** Deps that record the order of the steps around the real filesystem work. */
  function recordingDeps(
    server: FakeServer,
    overrides: Partial<StartActionOpenCodeV2Deps> = {},
  ): Partial<StartActionOpenCodeV2Deps> {
    return {
      startServer: vi.fn<StartServer>(async spawnOptions => {
        calls.push('spawn')
        server.loadConfig(spawnOptions.config)
        return {success: true, data: server.handle}
      }),
      clearClaims: vi.fn<typeof clearHeldClaims>(async () => {
        calls.push('clear-claims')
        return ok({status: 'no-database'})
      }),
      waitForImport: vi.fn(async () => {
        calls.push('import-wait')
        return {success: true, data: undefined} as const
      }),
      readDatabaseFacts: () => ({bytes: 1234, sessions: 5}),
      installPlugins: vi.fn<InstallPlugins>(async () => {
        calls.push('install-plugins')
        return ok(undefined)
      }),
      ...overrides,
    }
  }

  it('writes the key to a 0600 file, references it from the config and spawns with both plugins expected', async () => {
    // #given
    const server = fakeServer()
    const deps = recordingDeps(server)

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then
    expect(result.success).toBe(true)
    const startArgs = vi.mocked(deps.startServer as StartServer).mock.calls[0]?.[0]
    expect(startArgs?.expectedPluginIds).toEqual([SYSTEMATIC, FRO_BOT])
    expect(startArgs?.binaryPath).toBe('/opt/opencode')
    expect(startArgs?.directory).toBe('/workspace')
    // the process environment goes in as-is: the spawn scrubs it itself, so it is not filtered twice
    expect(startArgs?.env).toEqual({RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome})

    const content = startArgs?.config as {provider: Record<string, {options: {apiKey: string}}>; plugins: string[]}
    const reference = content.provider.anthropic?.options.apiKey ?? ''
    expect(reference).toMatch(/^\{file:.+anthropic\.key\}$/)
    const keyFile = reference.slice('{file:'.length, -1)
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(CANARY)
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(path.dirname(path.dirname(keyFile))).toBe(runnerTemp)
    expect(content.plugins).toEqual([
      expect.stringMatching(/^@fro\.bot\/systematic@\d+\.\d+\.\d+$/),
      expect.stringMatching(/^@fro\.bot\/opencode-plugin@\d+\.\d+\.\d+$/),
    ])
    // the config JSON holds the reference, never the key
    expect(JSON.stringify(startArgs?.config)).not.toContain(CANARY)
  })

  it('installs the plugins under the bound before the spawn when a matching binary meets an empty plugin cache', async () => {
    // #given a binary that is already installed (so setup never ran its installer) and nothing in the plugin cache
    fs.rmSync(cacheHome, {recursive: true, force: true})
    const server = fakeServer()
    const deps = recordingDeps(server)

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then the bounded install ran first, for both exact specs, against the cache home the server will read
    expect(result.success).toBe(true)
    expect(calls).toEqual(['install-plugins', 'clear-claims', 'spawn', 'import-wait'])
    const installArgs = vi.mocked(deps.installPlugins as InstallPlugins).mock.calls[0]?.[0]
    expect(installArgs?.specs).toEqual(PLUGIN_SPECS)
    expect(installArgs?.opencodeBinaryPath).toBe('/opt/opencode')
    expect(installArgs?.cacheHome).toBe(cacheHome)
    expect(installArgs?.env).toMatchObject({XDG_CACHE_HOME: cacheHome})
  })

  it('installs nothing when the cache already holds both exact plugin versions', async () => {
    // #given the default warm cache
    const server = fakeServer()
    const deps = recordingDeps(server)

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then
    expect(result.success).toBe(true)
    expect(deps.installPlugins).not.toHaveBeenCalled()
    expect(calls).toEqual(['clear-claims', 'spawn', 'import-wait'])
  })

  it('installs when only one of the two plugins is cached', async () => {
    // #given a cache that lost the fro.bot plugin
    fs.rmSync(pluginCacheDir(cacheHome, PLUGIN_SPECS[1] as string), {recursive: true, force: true})
    const deps = recordingDeps(fakeServer())

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then
    expect(result.success).toBe(true)
    expect(deps.installPlugins).toHaveBeenCalledTimes(1)
  })

  it('fails the plugins stage before the claims are touched or anything is spawned when the install fails', async () => {
    // #given an empty cache and an install that times out
    fs.rmSync(cacheHome, {recursive: true, force: true})
    const deps = recordingDeps(fakeServer(), {
      installPlugins: vi.fn<InstallPlugins>(async () => ({
        success: false,
        error: {
          kind: 'install-timeout',
          spec: PLUGIN_SPECS[0] as string,
          message: 'Installing OpenCode plugin x exceeded 420s',
        },
      })),
    })

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then
    expect(result).toMatchObject({success: false, error: {stage: 'plugins'}})
    expect(unwrapErr(result).message).toContain('exceeded 420s')
    expect(deps.startServer).not.toHaveBeenCalled()
    expect(deps.clearClaims).not.toHaveBeenCalled()
  })

  it('deletes an auth.json that was restored or left behind, before the spawn', async () => {
    // #given
    fs.writeFileSync(authPath, JSON.stringify({anthropic: {type: 'api', key: 'OLD-RESTORED-KEY'}}))
    const server = fakeServer()
    const deps = recordingDeps(server, {
      startServer: vi.fn<StartServer>(async spawnOptions => {
        calls.push(fs.existsSync(authPath) ? 'spawn-with-auth-json' : 'spawn-without-auth-json')
        server.loadConfig(spawnOptions.config)
        return {success: true, data: server.handle}
      }),
    })

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then
    expect(result.success).toBe(true)
    expect(calls).toContain('spawn-without-auth-json')
    expect(fs.existsSync(authPath)).toBe(false)
  })

  it('clears held claims before the spawn and waits for the import after the gates', async () => {
    // #given
    const server = fakeServer()
    const deps = recordingDeps(server)

    // #when
    await startActionOpenCodeV2(options({deps}))

    // #then
    expect(calls).toEqual(['clear-claims', 'spawn', 'import-wait'])
    expect(vi.mocked(deps.clearClaims as typeof clearHeldClaims)).toHaveBeenCalledWith(dbPath, expect.anything())
    expect(
      vi.mocked(deps.waitForImport as StartActionOpenCodeV2Deps['waitForImport']).mock.calls[0]?.[0].facts,
    ).toEqual({
      bytes: 1234,
      sessions: 5,
    })
  })

  it('counts the {file:} reference as the credential: the gate passes without a stored connection', async () => {
    // #given an integration listing with no connections, as a server with no stored credential reports
    const server = fakeServer({integration: {data: {connections: []}}})

    // #when
    const result = await startActionOpenCodeV2(options({deps: recordingDeps(server)}))

    // #then the model provider is configured by its key file, so the integration route is never asked
    expect(result.success).toBe(true)
    expect(server.fetch.mock.calls.map(call => call[0])).not.toContain('/api/integration/anthropic')
  })

  it('fails the credential gate, and stops the server, when the model provider has no key', async () => {
    // #given a model whose provider has no auth-json entry and no connection
    const server = fakeServer()
    const deps = recordingDeps(server)

    // #when
    const result = await startActionOpenCodeV2(options({deps, model: 'openai/gpt-5'}))

    // #then
    expect(result).toMatchObject({success: false, error: {stage: 'credential-gate'}})
    expect(unwrapErr(result).message).toContain('openai')
    expect(server.shutdown).toHaveBeenCalledTimes(1)
    expect(calls).not.toContain('import-wait')
  })

  it('asks the gate about the provider of the config model when no model input is given', async () => {
    // #given
    const server = fakeServer()
    const opencodeConfig = JSON.stringify({model: 'google/gemini-pro'})

    // #when
    const result = await startActionOpenCodeV2(options({deps: recordingDeps(server), model: null, opencodeConfig}))

    // #then
    expect(result).toMatchObject({success: false, error: {stage: 'credential-gate'}})
    expect(unwrapErr(result).message).toContain('google')
  })

  it('checks the provider of every written key when no model is named at all', async () => {
    const server = fakeServer()

    const result = await startActionOpenCodeV2(options({deps: recordingDeps(server), model: null}))

    expect(result.success).toBe(true)
  })

  it('skips the credential gate when there is neither a model nor a key', async () => {
    const server = fakeServer()

    const result = await startActionOpenCodeV2(options({deps: recordingDeps(server), model: null, authJson: '{}'}))

    expect(result.success).toBe(true)
  })

  it('fails the permission gate, and stops the server, when an agent lacks the deny', async () => {
    // #given an agent list with no external_directory boundary
    const server = fakeServer({agents: {location: {}, data: [{id: 'build', permissions: []}]}})
    const deps = recordingDeps(server)

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then
    expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
    expect(server.shutdown).toHaveBeenCalledTimes(1)
    expect(calls).not.toContain('import-wait')
  })

  it('fails the permission gate when the agent list cannot be read', async () => {
    const server = fakeServer({agentStatus: 503})

    const result = await startActionOpenCodeV2(options({deps: recordingDeps(server)}))

    expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
    expect(server.shutdown).toHaveBeenCalledTimes(1)
  })

  it('fails with the plugin stage when the spawn reports a plugin that is not active', async () => {
    const deps = recordingDeps(fakeServer(), {
      startServer: vi.fn<StartServer>(async () => ({
        success: false,
        error: {kind: 'plugin-gate', message: 'Required OpenCode plugin(s) not active: systematic (failed)'},
      })),
    })

    const result = await startActionOpenCodeV2(options({deps}))

    expect(result).toMatchObject({success: false, error: {stage: 'plugins'}})
  })

  it('fails with the spawn stage when the server does not start', async () => {
    const deps = recordingDeps(fakeServer(), {
      startServer: vi.fn<StartServer>(async () => ({
        success: false,
        error: {kind: 'listen-timeout', message: 'no listening line'},
      })),
    })

    const result = await startActionOpenCodeV2(options({deps}))

    expect(result).toMatchObject({success: false, error: {stage: 'spawn'}})
  })

  it('stops the server and reports the import failure when the import wait fails', async () => {
    // #given
    const server = fakeServer()
    const deps = recordingDeps(server, {
      waitForImport: vi.fn(
        async () => ({success: false, error: {kind: 'stalled', message: 'no progress for 60s'}}) as const,
      ),
    })

    // #when
    const result = await startActionOpenCodeV2(options({deps}))

    // #then
    expect(result).toEqual({success: false, error: {stage: 'import-wait', message: 'no progress for 60s'}})
    expect(server.shutdown).toHaveBeenCalledTimes(1)
  })

  it('fails closed when held claims cannot be cleared, before any spawn', async () => {
    const server = fakeServer()
    const deps = recordingDeps(server, {
      clearClaims: vi.fn<typeof clearHeldClaims>(async () => ({
        success: false,
        error: new Error('database is locked at /x'),
      })),
    })

    const result = await startActionOpenCodeV2(options({deps}))

    expect(result).toMatchObject({success: false, error: {stage: 'held-claims'}})
    expect(deps.startServer).not.toHaveBeenCalled()
  })

  it.each([
    ['oauth', {type: 'oauth', refresh: 'REFRESH-CANARY', access: 'ACCESS-CANARY', expires: 1}],
    ['wellknown', {type: 'wellknown', key: 'WK-CANARY', token: 'TOKEN-CANARY'}],
  ])('fails startup before any spawn, naming the provider, for a %s entry', async (_label, entry) => {
    // #given
    const server = fakeServer()
    const deps = recordingDeps(server)
    const authJson = JSON.stringify({anthropic: {type: 'api', key: CANARY}, 'github-copilot': entry})

    // #when
    const result = await startActionOpenCodeV2(options({deps, authJson}))

    // #then
    expect(result).toMatchObject({success: false, error: {stage: 'credentials'}})
    if (result.success) return
    expect(result.error.message).toContain('github-copilot')
    expect(JSON.stringify(result.error)).not.toContain('CANARY')
    expect(deps.startServer).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    // and no key file was written for the valid entry either
    expect(fs.readdirSync(runnerTemp)).toEqual([])
  })

  it('rejects a Systematic version range before writing anything', async () => {
    const deps = recordingDeps(fakeServer())

    const result = await startActionOpenCodeV2(options({deps, systematicVersion: '^3.0.0'}))

    expect(result).toMatchObject({success: false, error: {stage: 'plugins'}})
    expect(fs.readdirSync(runnerTemp)).toEqual([])
  })

  it('does not echo malformed auth-json into the error', async () => {
    const deps = recordingDeps(fakeServer())

    const result = await startActionOpenCodeV2(options({deps, authJson: `{"anthropic": ${CANARY}`}))

    expect(result).toMatchObject({success: false, error: {stage: 'credentials'}})
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })

  it('keeps every key and every key path out of every log line and every result', async () => {
    // #given a successful start and each failure after the spawn
    const logger = createMockLogger()
    const server = fakeServer()
    const success = await startActionOpenCodeV2(options({logger, deps: recordingDeps(server)}))
    const gateFailure = await startActionOpenCodeV2(
      options({logger, model: 'openai/gpt-5', deps: recordingDeps(fakeServer())}),
    )

    // #then
    expect(success.success).toBe(true)
    expect(gateFailure.success).toBe(false)
    const logged = serializeLoggerCalls(logger)
    const keyDirs = fs.readdirSync(runnerTemp)
    expect(keyDirs.length).toBeGreaterThan(0)
    expect(logged).not.toContain(CANARY)
    expect(JSON.stringify(gateFailure)).not.toContain(CANARY)
    for (const dir of keyDirs) {
      expect(logged).not.toContain(dir)
      expect(JSON.stringify(gateFailure)).not.toContain(dir)
    }
  })

  describe('held claims on real databases, as a restored cache provides them', () => {
    it('starts on a restored V1 database, which has no claim tables, and leaves it untouched', async () => {
      // #given a V1-schema database
      const db = new DatabaseSync(dbPath)
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY)')
      db.exec("INSERT INTO session VALUES ('ses_1'), ('ses_2')")
      db.close()
      const logger = createMockLogger()

      // #when
      const result = await startActionOpenCodeV2(options({logger, deps: realClearDeps(fakeServer())}))

      // #then it did not fail, and the V1 rows are intact
      expect(result.success).toBe(true)
      expect(serializeLoggerCalls(logger)).toContain('"claims":0')
      const check = new DatabaseSync(dbPath, {readOnly: true})
      expect(check.prepare('SELECT COUNT(*) AS c FROM session').get()?.c).toBe(2)
      check.close()
    })

    it('starts when there is no database at all (a cache miss) and does not create one', async () => {
      // #when
      const result = await startActionOpenCodeV2(options({deps: realClearDeps(fakeServer())}))

      // #then
      expect(result.success).toBe(true)
      expect(fs.existsSync(dbPath)).toBe(false)
    })

    it('starts on an empty database file with no tables', async () => {
      // #given
      new DatabaseSync(dbPath).close()

      // #when
      const result = await startActionOpenCodeV2(options({deps: realClearDeps(fakeServer())}))

      // #then
      expect(result.success).toBe(true)
    })

    it('clears a held claim and a background-job record in a restored V2 database before the spawn', async () => {
      // #given a V2 database a killed run left a claim and a background job in
      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_suspended INTEGER, resume_attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO session_v2 VALUES ('ses_held', 1700000000000, 2), ('ses_idle', NULL, 0);
        INSERT INTO kv VALUES ('job.background/abc', '{"status":"running"}'), ('other/key', '1');
      `)
      db.close()
      const server = fakeServer()
      let claimsAtSpawn = -1
      let jobsAtSpawn = -1
      const deps = {
        ...realClearDeps(server),
        startServer: vi.fn<StartServer>(async spawnOptions => {
          server.loadConfig(spawnOptions.config)
          const probe = new DatabaseSync(dbPath, {readOnly: true})
          claimsAtSpawn = Number(
            probe.prepare('SELECT COUNT(*) AS c FROM session_v2 WHERE time_suspended IS NOT NULL').get()?.c,
          )
          jobsAtSpawn = Number(probe.prepare("SELECT COUNT(*) AS c FROM kv WHERE key LIKE 'job.background/%'").get()?.c)
          probe.close()
          return {success: true, data: server.handle}
        }),
      }

      // #when
      const result = await startActionOpenCodeV2(options({deps}))

      // #then nothing was held when the server started, and unrelated rows survive
      expect(result.success).toBe(true)
      expect(claimsAtSpawn).toBe(0)
      expect(jobsAtSpawn).toBe(0)
      const check = new DatabaseSync(dbPath, {readOnly: true})
      expect(check.prepare('SELECT COUNT(*) AS c FROM kv').get()?.c).toBe(1)
      expect(check.prepare('SELECT COUNT(*) AS c FROM session_v2').get()?.c).toBe(2)
      check.close()
    })
  })
})
