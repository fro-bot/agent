import type {
  OpenCodeV2ServerHandle,
  OpenCodeV2StartError,
  StartOpenCodeV2ServerOptions,
} from '@fro-bot/runtime/workspace-v2'
import type {SpawnConfig} from './opencode-credentials-v2.js'
import type {RunSupervisedOpencodeV2Options} from './opencode-server-v2.js'
import type {Logger, SupervisedStatusRef} from './opencode-server.js'

import {mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  DEFAULT_SYSTEMATIC_VERSION,
  FRO_BOT_PLUGIN_ID,
  SYSTEMATIC_V2_PLUGIN_ID,
  verifyPermissionRules,
} from '@fro-bot/runtime/workspace-v2'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {spawnConfigFromMergedConfig} from './opencode-credentials-v2.js'
import {
  buildOpencodeV2Env,
  createUpstreamCredentials,
  prepareFreshDatabase,
  readSpawnConfigFromFile,
  runSupervisedOpencodeV2,
} from './opencode-server-v2.js'

type StartResult = Awaited<ReturnType<NonNullable<NonNullable<RunSupervisedOpencodeV2Options['deps']>['startServer']>>>

interface CapturingLogger {
  readonly logger: Logger
  readonly serialized: () => string
}

function createCapturingLogger(): CapturingLogger {
  const calls: unknown[] = []
  const record =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({level, message, meta})
    }
  return {
    logger: {info: record('info'), warn: record('warn'), error: record('error')},
    serialized: () => JSON.stringify(calls),
  }
}

interface FakeHandle {
  readonly handle: OpenCodeV2ServerHandle
  readonly shutdown: ReturnType<typeof vi.fn>
  readonly exit: (code?: number) => void
  readonly fetchPaths: string[]
}

function createHandle(options: {
  authorization: string
  activeSessions?: readonly string[] | 'fail'
  agentsBody?: unknown
  /** Replaces the `/api/agent` answer, to stall the response headers or the body. */
  agentResponse?: () => Promise<Response>
  /** Answers any other path (the credential and integration routes); undefined falls through to 404. */
  routes?: (pathname: string, init?: RequestInit) => Response | Promise<Response | undefined> | undefined
}): FakeHandle {
  let resolveExit: (info: {code: number | null; signal: NodeJS.Signals | null}) => void = () => undefined
  const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
    resolveExit = resolve
  })
  const fetchPaths: string[] = []
  const shutdown = vi.fn(async (_options?: unknown) => {
    resolveExit({code: 0, signal: null})
    return {
      interrupts: {stopped: [], notRunning: [], unconfirmed: []},
      exit: {outcome: 'graceful' as const, code: 0, signal: null},
    }
  })
  const agentsBody = options.agentsBody ?? {
    data: [{id: 'build', permissions: [{action: 'external_directory', resource: '*', effect: 'ask'}]}],
  }
  const handle: OpenCodeV2ServerHandle = {
    url: 'http://127.0.0.1:54321',
    pid: 4242,
    directory: '/workspace/repos',
    fetch: async (pathname, init) => {
      fetchPaths.push(pathname)
      const routed = await options.routes?.(pathname, init)
      if (routed !== undefined) return routed
      if (pathname === '/api/session/active') {
        if (options.activeSessions === 'fail') throw new Error('unreachable')
        const active = options.activeSessions ?? []
        return new Response(JSON.stringify({data: Object.fromEntries(active.map(id => [id, {type: 'running'}]))}), {
          status: 200,
        })
      }
      if (pathname === '/api/agent') {
        return options.agentResponse === undefined
          ? new Response(JSON.stringify(agentsBody), {status: 200})
          : options.agentResponse()
      }
      return new Response('{}', {status: 404})
    },
    authorizationHeader: () => options.authorization,
    exited,
    registerOwnedSession: () => undefined,
    shutdown,
  }
  return {
    handle,
    shutdown,
    exit: (code = 1) => resolveExit({code, signal: null}),
    fetchPaths,
  }
}

type Mutable<T> = {-readonly [K in keyof T]: T[K]}

const OK_GATE = async () => ({success: true as const, data: {checkedAgents: ['build']}})

function scriptedStart(
  results: readonly (FakeHandle | OpenCodeV2StartError)[],
  startOptions: StartOpenCodeV2ServerOptions[],
): NonNullable<NonNullable<RunSupervisedOpencodeV2Options['deps']>['startServer']> {
  let call = 0
  return async (startOpts): Promise<StartResult> => {
    startOptions.push(startOpts)
    const next = results[Math.min(call, results.length - 1)]
    call += 1
    if (next === undefined) throw new Error('no scripted result')
    if ('handle' in next) return {success: true, data: next.handle}
    return {success: false, error: next}
  }
}

describe('buildOpencodeV2Env', () => {
  it('constructs the child environment from an allowlist, never from the parent', () => {
    // #given a service environment full of things the agent must never see
    const parent: NodeJS.ProcessEnv = {
      WORKSPACE_OPENCODE_TOKEN: 'bearer-secret',
      OPENCODE_PASSWORD: 'stale-password',
      OPENCODE_SERVER_PASSWORD: 'server-secret',
      OPENCODE_CONFIG_CONTENT: '{"leak":true}',
      GITHUB_TOKEN: 'ghs_secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NODE_OPTIONS: '--require /evil.js',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      HTTPS_PROXY: 'http://mitmproxy:8080',
      NO_PROXY: 'workspace',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
      LANG: 'en_US.UTF-8',
    }

    // #when
    const env = buildOpencodeV2Env(parent, '/var/lib/workspace-agent/opencode-v2-db/spawn-a/opencode.db')

    // #then only the named operational values arrive
    expect(env.HTTPS_PROXY).toBe('http://mitmproxy:8080')
    expect(env.NO_PROXY).toBe('workspace')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt')
    expect(env.LANG).toBe('en_US.UTF-8')
    for (const name of [
      'WORKSPACE_OPENCODE_TOKEN',
      'OPENCODE_PASSWORD',
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_CONFIG_CONTENT',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NODE_OPTIONS',
      'SSH_AUTH_SOCK',
    ]) {
      expect(env).not.toHaveProperty(name)
    }
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(env.HOME).toBe('/home/opencode')
  })

  it('points the database at the fresh path and leaves the file watcher at its default', () => {
    // #when
    const env = buildOpencodeV2Env({}, '/db/spawn-a/opencode.db')

    // #then
    expect(env.OPENCODE_DB).toBe('/db/spawn-a/opencode.db')
    expect(env).not.toHaveProperty('OPENCODE_DISABLE_FILEWATCHER')
    expect(env).not.toHaveProperty('OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER')
    expect(env).not.toHaveProperty('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS')
  })

  it('turns the models.dev catalog fetch off: the egress allowlist blocks it and the bundled snapshot is the floor', () => {
    // #when the parent asks for the opposite
    const env = buildOpencodeV2Env({OPENCODE_DISABLE_MODELS_FETCH: '0'}, '/db/opencode.db')

    // #then the workspace decides, not the parent
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1')
  })

  it('does not forward a parent file-watcher flag: it is not on the allowlist', () => {
    // #when
    const env = buildOpencodeV2Env({OPENCODE_DISABLE_FILEWATCHER: 'true'}, '/db/opencode.db')

    // #then
    expect(env).not.toHaveProperty('OPENCODE_DISABLE_FILEWATCHER')
  })
})

describe('readSpawnConfigFromFile', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})
  })
  function configDir(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ws-v2-model-'))
    roots.push(root)
    return root
  }

  it('reads the model the merged config names, including one that came only from the overlay', () => {
    // #given the merged file for WORKSPACE_OPENCODE_MODEL unset and an overlay that carries `model`
    const file = path.join(configDir(), 'opencode.json')
    writeFileSync(file, JSON.stringify({autoupdate: false, model: 'openai/gpt-5.4-mini', provider: {openai: {}}}))

    // #when / #then
    expect(readSpawnConfigFromFile(file)).toEqual({model: 'openai/gpt-5.4-mini', authenticatedProviders: []})
  })

  it('reads inline-authenticated providers as ids only', () => {
    const file = path.join(configDir(), 'opencode.json')
    writeFileSync(file, JSON.stringify({model: 'anthropic/m', provider: {anthropic: {options: {apiKey: 'sk-INLINE'}}}}))

    const config = readSpawnConfigFromFile(file)

    expect(config).toEqual({model: 'anthropic/m', authenticatedProviders: ['anthropic']})
    expect(JSON.stringify(config)).not.toContain('INLINE')
  })

  it('reads no model for an absent file or one without a model', () => {
    const dir = configDir()
    const file = path.join(dir, 'opencode.json')
    writeFileSync(file, JSON.stringify({autoupdate: false}))
    expect(readSpawnConfigFromFile(path.join(dir, 'missing.json'))).toEqual({authenticatedProviders: []})
    expect(readSpawnConfigFromFile(file)).toEqual({authenticatedProviders: []})
  })

  it('refuses a symlink, an oversized file and malformed JSON, without quoting the file', () => {
    const dir = configDir()
    const target = path.join(dir, 'target.json')
    writeFileSync(target, '{"model":"x/y"}')
    const link = path.join(dir, 'link.json')
    symlinkSync(target, link)
    const big = path.join(dir, 'big.json')
    writeFileSync(big, `${' '.repeat(600 * 1024)}{}`)
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{"provider":{"x":{"options":{"apiKey":"sk-SUPERSECRETKEY"')

    expect(() => readSpawnConfigFromFile(link)).toThrow(/symlink/)
    expect(() => readSpawnConfigFromFile(big)).toThrow(/too large/)
    expect(() => readSpawnConfigFromFile(bad)).toThrow(/not valid JSON/)
    const thrown = (): string => {
      try {
        readSpawnConfigFromFile(bad)
        return ''
      } catch (error) {
        return String(error)
      }
    }
    expect(thrown()).not.toContain('SUPERSECRET')
  })
})

describe('prepareFreshDatabase', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})
  })

  function baseDir(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ws-v2-db-'))
    roots.push(root)
    return path.join(root, 'opencode-v2-db')
  }

  it('hands each spawn its own empty directory and removes what the previous spawn left', async () => {
    // #given a previous spawn that left a database behind
    const dir = baseDir()
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    const first = await prepareFreshDatabase({baseDir: dir, uid, gid})
    writeFileSync(first, 'sessions from the first spawn')
    writeFileSync(`${first}-wal`, 'wal')

    // #when the next spawn is prepared
    const second = await prepareFreshDatabase({baseDir: dir, uid, gid})

    // #then nothing persists: a new path, an empty directory, and the old files are gone
    expect(second).not.toBe(first)
    expect(path.basename(second)).toBe('opencode.db')
    expect(readdirSync(path.dirname(second))).toEqual([])
    expect(readdirSync(dir)).toEqual([path.basename(path.dirname(second))])
  })

  it('makes the directory owned by the agent identity and unreadable by others', async () => {
    // #given
    const dir = baseDir()
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0

    // #when
    const dbPath = await prepareFreshDatabase({baseDir: dir, uid, gid})

    // #then the per-spawn directory is 0700 for the agent, and the root-owned parent can only be traversed
    const spawnStat = statSync(path.dirname(dbPath))
    expect(spawnStat.uid).toBe(uid)
    expect(spawnStat.mode & 0o777).toBe(0o700)
    expect(statSync(dir).mode & 0o777).toBe(0o711)
  })

  it('passes the agent uid and gid to chown', async () => {
    // #given an injected chown, because the test process may not own files as uid 10001
    const dir = baseDir()
    const chown = vi.fn(async () => undefined)

    // #when
    await prepareFreshDatabase({baseDir: dir, uid: 10_001, gid: 10_001, chown})

    // #then
    expect(chown).toHaveBeenCalledTimes(1)
    expect(chown).toHaveBeenCalledWith(expect.stringContaining(dir), 10_001, 10_001)
  })
})

describe('createUpstreamCredentials', () => {
  it('starts empty, serves the current value per call, and clears', () => {
    // #given
    const credentials = createUpstreamCredentials()
    expect(credentials.authorization()).toBeUndefined()

    // #when
    let current = 'Basic first'
    credentials.set(() => current)
    expect(credentials.authorization()).toBe('Basic first')
    current = 'Basic second'

    // #then the holder reads the provider each time, so a rotated value is picked up
    expect(credentials.authorization()).toBe('Basic second')
    credentials.clear()
    expect(credentials.authorization()).toBeUndefined()
  })

  it('does not expose the credential when the holder is serialised or logged', () => {
    // #given a holder with a credential
    const credentials = createUpstreamCredentials()
    credentials.set(() => 'Basic c2VjcmV0')

    // #then
    expect(JSON.stringify(credentials)).not.toContain('c2VjcmV0')
    expect(String(JSON.stringify({credentials}))).not.toContain('c2VjcmV0')
  })
})

function recordStatuses(): {statusRef: SupervisedStatusRef; seen: SupervisedStatusRef['status'][]} {
  const seen: SupervisedStatusRef['status'][] = []
  let status: SupervisedStatusRef['status'] = 'starting'
  return {
    seen,
    statusRef: {
      get status() {
        return status
      },
      set status(value) {
        status = value
        seen.push(value)
      },
    },
  }
}

function stalledBody(): Response {
  // Headers arrive; the body never produces a byte and never closes.
  return new Response(new ReadableStream<Uint8Array>({start: () => undefined}), {status: 200})
}

describe('runSupervisedOpencodeV2', () => {
  const NO_BACKOFF = {initialBackoffMs: 0, maxBackoffMs: 0}

  /**
   * `model` is the effective model the merged config names (absent: none configured). `spawnConfigs` replaces it with
   * one config per spawn, in order, the last repeating: the file is read fresh for every spawn.
   */
  function setup(
    overrides: Partial<RunSupervisedOpencodeV2Options> & {
      readonly model?: string
      readonly spawnConfigs?: readonly SpawnConfig[]
    } = {},
  ) {
    const {model, spawnConfigs, ...runOverrides} = overrides
    let spawnConfigReads = 0
    const capture = createCapturingLogger()
    const credentials = createUpstreamCredentials()
    const statusRef: SupervisedStatusRef = {status: 'starting'}
    const startOptions: StartOpenCodeV2ServerOptions[] = []
    const dbPaths: string[] = []
    let dbCounter = 0
    const options: Mutable<RunSupervisedOpencodeV2Options> = {
      rootDir: '/workspace/repos',
      logger: capture.logger,
      statusRef,
      credentials,
      parentEnv: {HTTPS_PROXY: 'http://mitmproxy:8080'},
      ...NO_BACKOFF,
      maxAttempts: 3,
      ...runOverrides,
      deps: {
        prepareDatabase: async () => {
          dbCounter += 1
          const dbPath = `/db/spawn-${dbCounter}/opencode.db`
          dbPaths.push(dbPath)
          return dbPath
        },
        verifyRules: OK_GATE,
        // Never the real secret path: the default reads /run/workspace-agent/secrets.
        readAuthBlob: () => null,
        readSpawnConfig: () => {
          const configs = spawnConfigs ?? [{...(model === undefined ? {} : {model}), authenticatedProviders: []}]
          const next = configs[Math.min(spawnConfigReads, configs.length - 1)] as SpawnConfig
          spawnConfigReads += 1
          return next
        },
        ...overrides.deps,
      },
    }
    return {options, capture, credentials, statusRef, startOptions, dbPaths}
  }

  it('spawns as the agent identity with V2 config, both plugin ids expected, and a fresh database', async () => {
    // #given a server that starts
    const fake = createHandle({authorization: 'Basic one'})
    const {options, startOptions, dbPaths, statusRef} = setup()
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}

    // #when the supervisor runs until it is stopped
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

    // #then the spawn carries everything the plan requires
    const [start] = startOptions
    expect(start?.uid).toBe(10_001)
    expect(start?.gid).toBe(10_001)
    expect(start?.binaryPath).toBe('/usr/local/bin/opencode')
    expect(start?.directory).toBe('/workspace/repos')
    expect(start?.port).toBe(54_321)
    expect(start?.expectedPluginIds).toEqual([SYSTEMATIC_V2_PLUGIN_ID, FRO_BOT_PLUGIN_ID])
    expect(start?.config?.plugins).toEqual([
      `@fro.bot/systematic@${DEFAULT_SYSTEMATIC_VERSION}`,
      '@fro.bot/opencode-plugin@0.1.0',
    ])
    expect(start?.config?.permissions).toEqual(
      expect.arrayContaining([{action: 'external_directory', resource: '*', effect: 'ask'}]),
    )
    expect(start?.env?.OPENCODE_DB).toBe(dbPaths[0])
    expect(start?.env?.HTTPS_PROXY).toBe('http://mitmproxy:8080')

    controller.abort()
    await done
  })

  it('stores the credential before readiness flips to ready', async () => {
    // #given a status ref that records what the proxy would see at the moment of each transition
    const fake = createHandle({authorization: 'Basic one'})
    const {options, startOptions, credentials} = setup()
    const seenAtReady: (string | undefined)[] = []
    let status: SupervisedStatusRef['status'] = 'starting'
    const statusRef: SupervisedStatusRef = {
      get status() {
        return status
      },
      set status(value) {
        status = value
        if (value === 'ready') seenAtReady.push(credentials.authorization())
      },
    }
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}

    // #when
    const done = runSupervisedOpencodeV2({...options, statusRef, signal: controller.signal})
    await vi.waitFor(() => expect(status).toBe('ready'))

    // #then a request admitted the instant /readyz says ready already has the credential
    expect(seenAtReady).toEqual(['Basic one'])
    controller.abort()
    await done
  })

  it('runs the permission gate against the effective rules before it reports ready', async () => {
    // #given a gate that refuses
    const fake = createHandle({authorization: 'Basic one'})
    const verifyRules = vi.fn(async () => ({
      success: false as const,
      error: {kind: 'rules-missing' as const, message: 'external_directory is allow', violations: []},
    }))
    const {options, startOptions, statusRef, credentials} = setup({maxAttempts: 1})
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions), verifyRules}

    // #when
    await runSupervisedOpencodeV2(options)

    // #then the server is stopped, never ready, and no credential was published for the proxy
    expect(verifyRules).toHaveBeenCalledTimes(1)
    expect(fake.shutdown).toHaveBeenCalledTimes(1)
    expect(statusRef.status).toBe('degraded')
    expect(credentials.authorization()).toBeUndefined()
  })

  it('reads the agent list from the spawned server', async () => {
    // #given a gate that calls the list source it is given
    const fake = createHandle({authorization: 'Basic one'})
    const verifyRules = vi.fn(async (source: {listAgents: () => Promise<unknown>}) => {
      await source.listAgents()
      return {success: true as const, data: {checkedAgents: ['build']}}
    })
    const {options, startOptions, statusRef} = setup()
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions), verifyRules}

    // #when
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

    // #then
    expect(fake.fetchPaths).toContain('/api/agent')
    controller.abort()
    await done
  })

  it('respawns after an unexpected exit with a new credential and an empty database', async () => {
    // #given two servers with different passwords
    const first = createHandle({authorization: 'Basic first'})
    const second = createHandle({authorization: 'Basic second'})
    const {options, startOptions, dbPaths, credentials, statusRef} = setup()
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([first, second], startOptions)}

    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(credentials.authorization()).toBe('Basic first'))
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

    // #when the first server dies
    first.exit(1)

    // #then readiness drops and the stale credential goes with it, then the new server's credential arrives
    await vi.waitFor(() => expect(credentials.authorization()).toBe('Basic second'))
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))
    expect(startOptions).toHaveLength(2)
    expect(dbPaths).toHaveLength(2)
    expect(new Set(dbPaths).size).toBe(2)
    expect(startOptions[1]?.env?.OPENCODE_DB).toBe(dbPaths[1])
    expect(startOptions[0]?.env?.OPENCODE_DB).not.toBe(startOptions[1]?.env?.OPENCODE_DB)

    controller.abort()
    await done
  })

  it('fails closed between a server dying and the next one being ready', async () => {
    // #given a backoff before the respawn, and a second start that never completes
    const first = createHandle({authorization: 'Basic first'})
    const {options, startOptions, credentials, statusRef} = setup({initialBackoffMs: 200, maxBackoffMs: 200})
    const controller = new AbortController()
    const never = new Promise<StartResult>(() => undefined)
    let call = 0
    options.deps = {
      ...options.deps,
      startServer: async startOpts => {
        startOptions.push(startOpts)
        call += 1
        return call === 1 ? {success: true, data: first.handle} : never
      },
    }
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))
    // The first server ran past the stable window, so the respawn is a normal one with a backoff.
    expect(credentials.authorization()).toBe('Basic first')

    // #when
    first.exit(1)

    // #then during the backoff, before any new spawn exists, no request can be forwarded with the dead password
    await vi.waitFor(() => expect(statusRef.status).toBe('starting'))
    expect(startOptions).toHaveLength(1)
    expect(credentials.authorization()).toBeUndefined()
    controller.abort()
    done.catch(() => undefined)
  })

  it('goes degraded when every attempt fails to start, with the failure kind logged and no credential ever set', async () => {
    // #given
    const failure: OpenCodeV2StartError = {kind: 'plugin-gate', message: 'Required OpenCode plugin(s) not active: x'}
    const {options, startOptions, statusRef, credentials, capture} = setup()
    options.deps = {...options.deps, startServer: scriptedStart([failure], startOptions)}

    // #when
    await runSupervisedOpencodeV2(options)

    // #then every attempt used a fresh database, and the supervisor stopped trying
    expect(startOptions).toHaveLength(3)
    expect(statusRef.status).toBe('degraded')
    expect(credentials.authorization()).toBeUndefined()
    expect(capture.serialized()).toContain('plugin-gate')
  })

  it('does not spawn at all when the config cannot be built', async () => {
    // #given an exception directory with a wildcard, which the config builder refuses
    const {options, startOptions, statusRef} = setup({allowedExternalDirectories: ['/srv/*']})
    options.deps = {
      ...options.deps,
      startServer: scriptedStart([createHandle({authorization: 'Basic x'})], startOptions),
    }

    // #when
    await runSupervisedOpencodeV2(options)

    // #then
    expect(startOptions).toHaveLength(0)
    expect(statusRef.status).toBe('degraded')
  })

  it('treats a database that cannot be prepared as a failed attempt', async () => {
    // #given
    const {options, startOptions, statusRef} = setup({maxAttempts: 2})
    options.deps = {
      ...options.deps,
      prepareDatabase: async () => {
        throw new Error('EACCES')
      },
      startServer: scriptedStart([createHandle({authorization: 'Basic x'})], startOptions),
    }

    // #when
    await runSupervisedOpencodeV2(options)

    // #then no server is ever started on a database the supervisor did not create
    expect(startOptions).toHaveLength(0)
    expect(statusRef.status).toBe('degraded')
  })

  it('does not spawn when the service aborts while the database is being prepared', async () => {
    // #given a database preparation that is still pending when the service aborts
    const {options, startOptions} = setup()
    const controller = new AbortController()
    let finishPreparing: (databasePath: string) => void = () => undefined
    const preparing = new Promise<string>(resolve => {
      finishPreparing = resolve
    })
    const startServer = vi.fn(scriptedStart([createHandle({authorization: 'Basic x'})], startOptions))
    options.deps = {...options.deps, prepareDatabase: async () => preparing, startServer}
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    controller.abort()

    // #when the preparation completes after the abort
    finishPreparing('/db/spawn-1/opencode.db')
    await done

    // #then the supervisor returned without starting a server during shutdown
    expect(startServer).not.toHaveBeenCalled()
  })

  describe('permission-gate request', () => {
    const REAL_GATE = {verifyRules: verifyPermissionRules}

    it('shuts the server down and never reports ready when the response headers stall', async () => {
      // #given an /api/agent response that never arrives
      const fake = createHandle({
        authorization: 'Basic one',
        agentResponse: async () => new Promise<Response>(() => {}),
      })
      const {options, startOptions, credentials, capture} = setup({maxAttempts: 1, requestTimeoutMs: 50})
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, ...REAL_GATE, startServer: scriptedStart([fake], startOptions)}

      // #when the supervisor runs
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then the request was bounded, the handle shut down, and nothing was ever published as ready
      expect(fake.shutdown).toHaveBeenCalledTimes(1)
      expect(seen).not.toContain('ready')
      expect(statusRef.status).toBe('degraded')
      expect(credentials.authorization()).toBeUndefined()
      expect(capture.serialized()).toContain('agent-list-unavailable')
    })

    it('shuts the server down and never reports ready when the response body stalls', async () => {
      // #given headers that arrive and a body that never completes
      const fake = createHandle({authorization: 'Basic one', agentResponse: async () => stalledBody()})
      const {options, startOptions, credentials} = setup({maxAttempts: 1, requestTimeoutMs: 50})
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, ...REAL_GATE, startServer: scriptedStart([fake], startOptions)}

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then the timeout stays in force through the body read
      expect(fake.shutdown).toHaveBeenCalledTimes(1)
      expect(seen).not.toContain('ready')
      expect(statusRef.status).toBe('degraded')
      expect(credentials.authorization()).toBeUndefined()
    })

    it('hands the request an abort signal so a real connection is released', async () => {
      // #given a handle that records the signal its /api/agent request carries
      let received: AbortSignal | undefined
      const fake = createHandle({authorization: 'Basic one'})
      const handle: OpenCodeV2ServerHandle = {
        ...fake.handle,
        fetch: async (pathname, init) => {
          if (pathname === '/api/agent') received = init?.signal ?? undefined
          return fake.handle.fetch(pathname, init)
        },
      }
      const {options, startOptions} = setup({maxAttempts: 1})
      const controller = new AbortController()
      options.deps = {...options.deps, ...REAL_GATE, startServer: scriptedStart([{...fake, handle}], startOptions)}
      const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
      await vi.waitFor(() => expect(received).toBeInstanceOf(AbortSignal))

      // #when / #then
      controller.abort()
      await done
    })

    it('shuts the server down when the service aborts during a stalled request', async () => {
      // #given a stalled request with a timeout far longer than the test
      const fake = createHandle({authorization: 'Basic one', agentResponse: async () => stalledBody()})
      const {options, startOptions, credentials} = setup({maxAttempts: 3, requestTimeoutMs: 60_000})
      const {statusRef, seen} = recordStatuses()
      const controller = new AbortController()
      options.deps = {...options.deps, ...REAL_GATE, startServer: scriptedStart([fake], startOptions)}
      const done = runSupervisedOpencodeV2({...options, statusRef, signal: controller.signal})
      await vi.waitFor(() => expect(fake.fetchPaths).toContain('/api/agent'))

      // #when the service aborts
      controller.abort()
      await done

      // #then the request was cancelled, the handle shut down once, and no second server was started
      expect(fake.shutdown).toHaveBeenCalledTimes(1)
      expect(startOptions).toHaveLength(1)
      expect(seen).not.toContain('ready')
      expect(credentials.authorization()).toBeUndefined()
    })
  })

  it('interrupts the sessions that are active, then shuts the server down, on abort', async () => {
    // #given a ready server with two running sessions
    const fake = createHandle({authorization: 'Basic one', activeSessions: ['ses_a', 'ses_b']})
    const {options, startOptions, statusRef, credentials} = setup()
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

    // #when the service aborts
    controller.abort()
    await done

    // #then every active session was handed to the shutdown for a user-reason interrupt, and the credential is gone
    expect(fake.shutdown).toHaveBeenCalledTimes(1)
    expect(fake.shutdown).toHaveBeenCalledWith({ownedSessionIds: ['ses_a', 'ses_b']})
    expect(credentials.authorization()).toBeUndefined()
  })

  it('does not abort the signal it gave the spawn once the server is running, so its own shutdown cannot pre-empt the interrupts', async () => {
    // #given a ready server. The runtime handle shuts itself down, with no sessions to interrupt, the moment the
    // signal it was started with aborts; that first shutdown is the one every later call returns.
    const fake = createHandle({authorization: 'Basic one', activeSessions: ['ses_a']})
    const {options, startOptions, statusRef} = setup()
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

    // #when the service aborts
    controller.abort()
    await done

    // #then the spawn's signal was left alone, and the interrupts went through the supervisor's own shutdown call
    expect(startOptions[0]?.signal?.aborted).toBe(false)
    expect(fake.shutdown).toHaveBeenCalledWith({ownedSessionIds: ['ses_a']})
  })

  it('still shuts down when the active sessions cannot be listed', async () => {
    // #given a server that does not answer the active list
    const fake = createHandle({authorization: 'Basic one', activeSessions: 'fail'})
    const {options, startOptions, statusRef} = setup()
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

    // #when
    controller.abort()
    await done

    // #then the process is still stopped, with nothing to interrupt
    expect(fake.shutdown).toHaveBeenCalledWith({ownedSessionIds: []})
  })

  it('stops a start that is still in flight when the service aborts', async () => {
    // #given a start that waits for the signal it was given
    const {options, startOptions} = setup()
    const controller = new AbortController()
    options.deps = {
      ...options.deps,
      startServer: async startOpts => {
        startOptions.push(startOpts)
        await new Promise<void>(resolve => startOpts.signal?.addEventListener('abort', () => resolve(), {once: true}))
        return {success: false, error: {kind: 'aborted', message: 'cancelled'}}
      },
    }
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(startOptions).toHaveLength(1))

    // #when
    controller.abort()
    await done

    // #then the supervisor did not retry
    expect(startOptions).toHaveLength(1)
  })

  it('does not start when the signal is already aborted', async () => {
    // #given
    const {options, startOptions} = setup()
    const controller = new AbortController()
    controller.abort()
    options.deps = {
      ...options.deps,
      startServer: scriptedStart([createHandle({authorization: 'Basic x'})], startOptions),
    }

    // #when
    await runSupervisedOpencodeV2({...options, signal: controller.signal})

    // #then
    expect(startOptions).toHaveLength(0)
  })

  it('restores the respawn budget after a stable run', async () => {
    // #given servers that each ran past the stable window before dying, and a budget of two attempts
    const handles = [1, 2, 3].map(n => createHandle({authorization: `Basic ${n}`}))
    const {options, startOptions, statusRef} = setup({maxAttempts: 2, stableReadyResetMs: 0})
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart(handles, startOptions)}
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})

    // #when each server dies in turn
    await vi.waitFor(() => expect(startOptions).toHaveLength(1))
    handles[0]?.exit()
    await vi.waitFor(() => expect(startOptions).toHaveLength(2))
    handles[1]?.exit()

    // #then a third spawn happens: the budget of two was reset by the stable runs
    await vi.waitFor(() => expect(startOptions).toHaveLength(3))
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))
    controller.abort()
    await done
  })

  it('never writes the server credential to a log line', async () => {
    // #given a credential that would be recognisable
    const fake = createHandle({authorization: 'Basic TOPSECRETCREDENTIAL'})
    const {options, startOptions, statusRef, capture} = setup()
    const controller = new AbortController()
    options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}
    const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
    await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

    // #when the whole lifecycle ran
    controller.abort()
    await done

    // #then
    expect(capture.serialized()).not.toContain('TOPSECRETCREDENTIAL')
  })
  describe('provider credentials', () => {
    const KEY = 'sk-ant-SUPERSECRETKEY-1234'
    const MODEL = 'anthropic/claude-sonnet-4-6'
    const BLOB = JSON.stringify({anthropic: {type: 'api', key: KEY}})

    interface CredentialStore {
      readonly posts: {readonly body: Record<string, unknown>; readonly method: string | undefined}[]
      readonly routes: NonNullable<Parameters<typeof createHandle>[0]['routes']>
    }

    /** The two routes the supervisor uses: create stores a connection, integration lists what is stored. */
    function credentialStore(options: {createStatus?: number} = {}): CredentialStore {
      const stored = new Set<string>()
      const posts: {body: Record<string, unknown>; method: string | undefined}[] = []
      return {
        posts,
        routes: (pathname, init) => {
          if (pathname === '/api/credential' && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            posts.push({body, method: init.method})
            const status = options.createStatus ?? 200
            if (status === 200) stored.add(String(body.integrationID))
            // The real route echoes the stored value, secret included.
            return new Response(JSON.stringify({data: {id: 'cred_1', value: body.value}}), {status})
          }
          const match = /^\/api\/integration\/([^/]+)$/.exec(pathname)
          if (match !== null) {
            const id = decodeURIComponent(match[1] as string)
            const connections = stored.has(id)
              ? [{type: 'credential', id: 'cred_1', label: 'workspace', method: 'key'}]
              : []
            return new Response(JSON.stringify({data: {id, name: id, methods: [], connections}}), {status: 200})
          }
          return undefined
        },
      }
    }

    it('posts one key credential per provider before the server reports ready, and keeps the key out of every channel', async () => {
      // #given a two-provider blob, a model, and a server that stores what it is given
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const blob = JSON.stringify({anthropic: {type: 'api', key: KEY}, openai: {type: 'api', key: `${KEY}-openai`}})
      const {options, startOptions, capture, credentials} = setup({
        parentEnv: {HTTPS_PROXY: 'http://mitmproxy:8080'},
        model: MODEL,
      })
      const seenAtReady: (string | undefined)[] = []
      let status: SupervisedStatusRef['status'] = 'starting'
      const statusRef: SupervisedStatusRef = {
        get status() {
          return status
        },
        set status(value) {
          status = value
          if (value === 'ready') seenAtReady.push(credentials.authorization())
        },
      }
      const controller = new AbortController()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => blob,
        startServer: scriptedStart([fake], startOptions),
      }

      // #when
      const done = runSupervisedOpencodeV2({...options, statusRef, signal: controller.signal})
      await vi.waitFor(() => expect(status).toBe('ready'))

      // #then each provider is posted exactly once with the key credential shape, and the gate read the model's provider back
      expect(store.posts.map(post => post.body)).toEqual([
        {integrationID: 'anthropic', label: 'workspace', value: {type: 'key', key: KEY}},
        {integrationID: 'openai', label: 'workspace', value: {type: 'key', key: `${KEY}-openai`}},
      ])
      expect(fake.fetchPaths.filter(p => p === '/api/credential')).toHaveLength(2)
      expect(fake.fetchPaths).toContain('/api/integration/anthropic')
      expect(fake.fetchPaths).not.toContain('/api/integration/openai')
      expect(seenAtReady).toEqual(['Basic one'])

      // #and the key is in no channel but the request body
      expect(JSON.stringify(startOptions)).not.toContain(KEY)
      expect(JSON.stringify(startOptions[0]?.env)).not.toContain('SUPERSECRETKEY')
      expect(JSON.stringify(startOptions[0]?.config)).not.toContain('SUPERSECRETKEY')
      controller.abort()
      await done
      expect(capture.serialized()).not.toContain('SUPERSECRETKEY')
      expect(capture.serialized()).toContain('provider credentials provisioned')
    })

    it('provisions again on every respawn, because each spawn has an empty database', async () => {
      // #given two servers with separate stores
      const firstStore = credentialStore()
      const secondStore = credentialStore()
      const first = createHandle({authorization: 'Basic first', routes: firstStore.routes})
      const second = createHandle({authorization: 'Basic second', routes: secondStore.routes})
      const {options, startOptions, credentials} = setup({model: MODEL})
      const controller = new AbortController()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => BLOB,
        startServer: scriptedStart([first, second], startOptions),
      }
      const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
      await vi.waitFor(() => expect(credentials.authorization()).toBe('Basic first'))

      // #when the first server dies
      first.exit(1)

      // #then the second one is provisioned too before it serves
      await vi.waitFor(() => expect(credentials.authorization()).toBe('Basic second'))
      expect(firstStore.posts).toHaveLength(1)
      expect(secondStore.posts).toHaveLength(1)
      controller.abort()
      await done
    })

    it('does not go ready, and stops the server, when the credential route refuses', async () => {
      // #given a server whose credential route answers 500
      const store = credentialStore({createStatus: 500})
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, capture, credentials} = setup({
        maxAttempts: 1,
        model: MODEL,
      })
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, readAuthBlob: () => BLOB, startServer: scriptedStart([fake], startOptions)}

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then it never turned ready, held no credential, shut the server down, and said why without the key
      expect(seen).not.toContain('ready')
      expect(statusRef.status).toBe('degraded')
      expect(credentials.authorization()).toBeUndefined()
      expect(fake.shutdown).toHaveBeenCalledTimes(1)
      expect(capture.serialized()).toContain('credential-provision-failed')
      expect(capture.serialized()).toContain('HTTP 500')
      expect(capture.serialized()).not.toContain('SUPERSECRETKEY')
    })

    it('does not go ready when the credential request throws, and the error text never carries the key', async () => {
      // #given a transport that fails with a message that quotes the request
      const fake = createHandle({
        authorization: 'Basic one',
        routes: (pathname, init) => {
          if (pathname === '/api/credential') throw new Error(`socket hang up while sending ${String(init?.body)}`)
          return undefined
        },
      })
      const {options, startOptions, capture} = setup({maxAttempts: 1, model: MODEL})
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, readAuthBlob: () => BLOB, startServer: scriptedStart([fake], startOptions)}

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then
      expect(seen).not.toContain('ready')
      expect(capture.serialized()).toContain('credential-provision-failed')
      expect(capture.serialized()).not.toContain('SUPERSECRETKEY')
    })

    it('refuses readiness when the configured model has no credential because the blob is absent', async () => {
      // #given a model is configured and no credential blob was provisioned
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, capture, credentials} = setup({
        maxAttempts: 2,
        model: MODEL,
      })
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, readAuthBlob: () => null, startServer: scriptedStart([fake], startOptions)}

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then the gate refuses on every attempt: never ready, nothing posted, no credential for the proxy
      expect(seen).not.toContain('ready')
      expect(statusRef.status).toBe('degraded')
      expect(store.posts).toHaveLength(0)
      expect(credentials.authorization()).toBeUndefined()
      expect(startOptions).toHaveLength(2)
      expect(capture.serialized()).toContain('credential-missing')
      expect(capture.serialized()).toContain('anthropic')
    })

    it('refuses readiness when the blob has credentials for other providers but not the model provider', async () => {
      // #given a blob for openai and a model on anthropic
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, capture} = setup({maxAttempts: 1, model: MODEL})
      const {statusRef, seen} = recordStatuses()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => JSON.stringify({openai: {type: 'api', key: KEY}}),
        startServer: scriptedStart([fake], startOptions),
      }

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then
      expect(seen).not.toContain('ready')
      expect(capture.serialized()).toContain('credential-missing')
      expect(capture.serialized()).not.toContain('SUPERSECRETKEY')
    })

    it('stays ready for a clone-only deployment: no model and no blob leaves nothing to check', async () => {
      // #given neither a model nor a credential blob
      const fake = createHandle({authorization: 'Basic one'})
      const {options, startOptions, statusRef, capture} = setup()
      const controller = new AbortController()
      options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}

      // #when
      const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
      await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

      // #then the credential routes were never touched
      expect(fake.fetchPaths.some(p => p.startsWith('/api/credential') || p.startsWith('/api/integration'))).toBe(false)
      expect(capture.serialized()).toContain('credential gate skipped')
      controller.abort()
      await done
    })

    it('checks the provisioned providers when a blob exists but no model is configured', async () => {
      // #given a blob and no model, on a server that stores nothing
      const fake = createHandle({
        authorization: 'Basic one',
        routes: pathname => {
          if (pathname === '/api/credential') return new Response('{}', {status: 200})
          if (pathname.startsWith('/api/integration/')) {
            return new Response(JSON.stringify({data: {id: 'anthropic', connections: []}}), {status: 200})
          }
          return undefined
        },
      })
      const {options, startOptions, capture} = setup({maxAttempts: 1})
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, readAuthBlob: () => BLOB, startServer: scriptedStart([fake], startOptions)}

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then the read-back refuses
      expect(seen).not.toContain('ready')
      expect(capture.serialized()).toContain('credential-missing')
    })

    it('does not spawn when the blob holds a credential type it cannot provision, naming only the provider', async () => {
      // #given an oauth entry that carries a token-looking string
      const {options, startOptions, statusRef, capture} = setup()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => JSON.stringify({anthropic: {type: 'oauth', access: 'SUPERSECRETACCESS', refresh: 'x'}}),
        startServer: scriptedStart([createHandle({authorization: 'Basic x'})], startOptions),
      }

      // #when
      await runSupervisedOpencodeV2(options)

      // #then
      expect(startOptions).toHaveLength(0)
      expect(statusRef.status).toBe('degraded')
      expect(capture.serialized()).toContain('credential-blob-invalid')
      expect(capture.serialized()).toContain('anthropic')
      expect(capture.serialized()).not.toContain('SUPERSECRETACCESS')
    })

    it('does not spawn when the blob is not JSON, and the parse error never quotes it', async () => {
      // #given
      const {options, startOptions, statusRef, capture} = setup()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => '{"anthropic": SUPERSECRETKEY',
        startServer: scriptedStart([createHandle({authorization: 'Basic x'})], startOptions),
      }

      // #when
      await runSupervisedOpencodeV2(options)

      // #then
      expect(startOptions).toHaveLength(0)
      expect(statusRef.status).toBe('degraded')
      expect(capture.serialized()).toContain('credential-blob-invalid')
      expect(capture.serialized()).not.toContain('SUPERSECRETKEY')
    })

    it('does not spawn when the secret file cannot be read', async () => {
      // #given a read that fails
      const {options, startOptions, statusRef, capture} = setup()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => {
          throw new Error('Secret path is not a regular file: /run/workspace-agent/secrets/workspace_opencode_auth')
        },
        startServer: scriptedStart([createHandle({authorization: 'Basic x'})], startOptions),
      }

      // #when
      await runSupervisedOpencodeV2(options)

      // #then
      expect(startOptions).toHaveLength(0)
      expect(statusRef.status).toBe('degraded')
      expect(capture.serialized()).toContain('cannot read the provider credential blob')
    })

    it('refuses readiness for an overlay-only model whose provider the blob does not cover', async () => {
      // #given the effective model came from the overlay (openai) and the blob holds only anthropic
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, capture} = setup({maxAttempts: 1, model: 'openai/gpt-5.4-mini'})
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, readAuthBlob: () => BLOB, startServer: scriptedStart([fake], startOptions)}

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then the gate looked at openai, found nothing, and the server never served
      expect(seen).not.toContain('ready')
      expect(fake.fetchPaths).toContain('/api/integration/openai')
      expect(capture.serialized()).toContain('credential-missing')
      expect(capture.serialized()).toContain('openai')
    })

    it('reaches ready for an overlay-only model whose provider the blob covers', async () => {
      // #given
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, statusRef} = setup({model: 'openai/gpt-5.4-mini'})
      const controller = new AbortController()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => JSON.stringify({openai: {type: 'api', key: KEY}}),
        startServer: scriptedStart([fake], startOptions),
      }

      // #when
      const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
      await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

      // #then
      expect(fake.fetchPaths).toContain('/api/integration/openai')
      expect(fake.fetchPaths).not.toContain('/api/integration/anthropic')
      controller.abort()
      await done
    })

    it('refuses readiness and stops the server when the merged config cannot be read after the spawn', async () => {
      // #given
      const fake = createHandle({authorization: 'Basic one'})
      const {options, startOptions, capture} = setup({maxAttempts: 1})
      const {statusRef, seen} = recordStatuses()
      options.deps = {
        ...options.deps,
        readSpawnConfig: () => {
          throw new Error('Secret path is not a regular file: /home/opencode/.config/opencode/opencode.json')
        },
        startServer: scriptedStart([fake], startOptions),
      }

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then it never turned ready, the server was stopped, and the failure kind is named
      expect(seen).not.toContain('ready')
      expect(statusRef.status).toBe('degraded')
      expect(fake.shutdown).toHaveBeenCalledTimes(1)
      expect(capture.serialized()).toContain('model-config-invalid')
      expect(capture.serialized()).toContain('Cannot read the effective model')
    })

    it('reaches ready for a provider authenticated by an inline key in the merged config, with no stored credential', async () => {
      // #given an overlay that carries the key inline, and no blob
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, statusRef, capture} = setup({
        spawnConfigs: [{model: MODEL, authenticatedProviders: ['anthropic']}],
      })
      const controller = new AbortController()
      options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}

      // #when
      const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
      await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

      // #then the gate accepted the inline key without a connection, and nothing was posted
      expect(store.posts).toHaveLength(0)
      expect(fake.fetchPaths).not.toContain('/api/integration/anthropic')
      expect(capture.serialized()).not.toContain('SUPERSECRETKEY')
      controller.abort()
      await done
    })

    it.each([
      ['a {file:} reference', '{file:/home/opencode/provider-key}'],
      ['an {env:} reference', '{env:ANTHROPIC_API_KEY}'],
    ])('reaches ready for a provider keyed only by %s in the merged config', async (_label, reference) => {
      // #given the real parser on a merged config whose only credential is a reference, and no blob
      const config = JSON.stringify({model: MODEL, provider: {anthropic: {options: {apiKey: reference}}}})
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, statusRef} = setup()
      const controller = new AbortController()
      options.deps = {
        ...options.deps,
        readSpawnConfig: () => {
          const parsed = spawnConfigFromMergedConfig(config)
          if (!parsed.success) throw new Error(parsed.error.message)
          return parsed.data
        },
        startServer: scriptedStart([fake], startOptions),
      }

      // #when
      const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
      await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

      // #then the reference satisfied the gate without a connection read, and nothing was posted
      expect(fake.fetchPaths).not.toContain('/api/integration/anthropic')
      expect(store.posts).toHaveLength(0)
      controller.abort()
      await done
    })

    it.each([
      ['an empty key', ''],
      ['a {file:} reference with an empty target', '{file:}'],
      ['an {env:} reference with an empty target', '{env:}'],
    ])('refuses readiness for a provider whose only configured key is %s', async (_label, value) => {
      // #given
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, capture} = setup({maxAttempts: 1})
      const {statusRef, seen} = recordStatuses()
      const config = JSON.stringify({model: MODEL, provider: {anthropic: {options: {apiKey: value}}}})
      options.deps = {
        ...options.deps,
        readSpawnConfig: () => {
          const parsed = spawnConfigFromMergedConfig(config)
          if (!parsed.success) throw new Error(parsed.error.message)
          return parsed.data
        },
        startServer: scriptedStart([fake], startOptions),
      }

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then
      expect(seen).not.toContain('ready')
      expect(capture.serialized()).toContain('credential-missing')
    })

    it('still refuses a provider with no inline key, no stored credential and no connection', async () => {
      // #given an inline key for openai only, and a model on anthropic
      const store = credentialStore()
      const fake = createHandle({authorization: 'Basic one', routes: store.routes})
      const {options, startOptions, capture} = setup({
        maxAttempts: 1,
        spawnConfigs: [{model: MODEL, authenticatedProviders: ['openai']}],
      })
      const {statusRef, seen} = recordStatuses()
      options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}

      // #when
      await runSupervisedOpencodeV2({...options, statusRef})

      // #then
      expect(seen).not.toContain('ready')
      expect(capture.serialized()).toContain('credential-missing')
    })

    it('reads the merged config fresh for every spawn and gates the provider the replacement server loaded', async () => {
      // #given the file names anthropic for the first spawn and openai for the second, and a blob that covers only anthropic
      const store = credentialStore()
      const first = createHandle({authorization: 'Basic first', routes: store.routes})
      const second = createHandle({authorization: 'Basic second', routes: store.routes})
      const {options, startOptions, credentials, capture} = setup({
        maxAttempts: 2,
        spawnConfigs: [
          {model: 'anthropic/claude-sonnet-4-6', authenticatedProviders: []},
          {model: 'openai/gpt-5.4-mini', authenticatedProviders: []},
        ],
      })
      const {statusRef, seen} = recordStatuses()
      options.deps = {
        ...options.deps,
        readAuthBlob: () => BLOB,
        startServer: scriptedStart([first, second], startOptions),
      }
      const done = runSupervisedOpencodeV2({...options, statusRef})
      await vi.waitFor(() => expect(credentials.authorization()).toBe('Basic first'))

      // #when the first server dies and the replacement loads a different model
      first.exit(1)
      await done

      // #then the replacement was gated on openai, found no credential, and never served
      expect(first.fetchPaths).toContain('/api/integration/anthropic')
      expect(second.fetchPaths).toContain('/api/integration/openai')
      expect(second.fetchPaths).not.toContain('/api/integration/anthropic')
      expect(seen.filter(status => status === 'ready')).toHaveLength(1)
      expect(statusRef.status).toBe('degraded')
      expect(capture.serialized()).toContain('credential-missing')
      expect(credentials.authorization()).toBeUndefined()
    })

    it.each([
      ['during provisioning', 'provision'],
      ['during the gate read-back', 'gate'],
    ] as const)(
      'stops cleanly when the service aborts %s: no gate-failure log and no degraded status',
      async (_label, phase) => {
        // #given a server whose credential route (or integration route) never answers
        let reached: () => void = () => undefined
        const inFlight = new Promise<void>(resolve => {
          reached = resolve
        })
        const store = credentialStore()
        const fake = createHandle({
          authorization: 'Basic one',
          routes: async (pathname, init) => {
            const stall =
              phase === 'provision' ? pathname === '/api/credential' : pathname.startsWith('/api/integration/')
            if (stall) {
              reached()
              return new Promise<Response>(() => undefined)
            }
            return store.routes(pathname, init)
          },
        })
        const {options, startOptions, capture} = setup({model: MODEL, requestTimeoutMs: 60_000, maxAttempts: 3})
        const {statusRef, seen} = recordStatuses()
        const controller = new AbortController()
        options.deps = {...options.deps, readAuthBlob: () => BLOB, startServer: scriptedStart([fake], startOptions)}
        const done = runSupervisedOpencodeV2({...options, statusRef, signal: controller.signal})
        await inFlight

        // #when the service stops while the request is in flight
        controller.abort()
        await done

        // #then the server was stopped once, nothing was retried, and the stop is not reported as a failure
        expect(fake.shutdown).toHaveBeenCalledTimes(1)
        expect(startOptions).toHaveLength(1)
        expect(seen).not.toContain('degraded')
        expect(seen).not.toContain('ready')
        expect(capture.serialized()).not.toContain('credential gate failed')
        expect(capture.serialized()).not.toContain('credential-provision-failed')
        expect(capture.serialized()).not.toContain('credential-missing')
      },
    )

    it('puts OPENCODE_DISABLE_MODELS_FETCH=1 in the spawn environment', async () => {
      // #given
      const fake = createHandle({authorization: 'Basic one'})
      const {options, startOptions, statusRef} = setup({parentEnv: {OPENCODE_DISABLE_MODELS_FETCH: '0'}})
      const controller = new AbortController()
      options.deps = {...options.deps, startServer: scriptedStart([fake], startOptions)}

      // #when
      const done = runSupervisedOpencodeV2({...options, signal: controller.signal})
      await vi.waitFor(() => expect(statusRef.status).toBe('ready'))

      // #then
      expect(startOptions[0]?.env?.OPENCODE_DISABLE_MODELS_FETCH).toBe('1')
      controller.abort()
      await done
    })
  })
})
