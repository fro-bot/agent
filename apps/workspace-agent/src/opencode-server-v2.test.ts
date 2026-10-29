import type {
  OpenCodeV2ServerHandle,
  OpenCodeV2StartError,
  StartOpenCodeV2ServerOptions,
} from '@fro-bot/runtime/workspace-v2'
import type {RunSupervisedOpencodeV2Options} from './opencode-server-v2.js'
import type {Logger, SupervisedStatusRef} from './opencode-server.js'

import {mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {FRO_BOT_PLUGIN_ID, SYSTEMATIC_V2_PLUGIN_ID} from '@fro-bot/runtime/workspace-v2'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  buildOpencodeV2Env,
  createUpstreamCredentials,
  prepareFreshDatabase,
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
    fetch: async pathname => {
      fetchPaths.push(pathname)
      if (pathname === '/api/session/active') {
        if (options.activeSessions === 'fail') throw new Error('unreachable')
        const active = options.activeSessions ?? []
        return new Response(JSON.stringify({data: Object.fromEntries(active.map(id => [id, {type: 'running'}]))}), {
          status: 200,
        })
      }
      if (pathname === '/api/agent') return new Response(JSON.stringify(agentsBody), {status: 200})
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

  it('points the database at the fresh path and uses the V2 file-watcher flag, not the V1 spelling', () => {
    // #when
    const env = buildOpencodeV2Env({}, '/db/spawn-a/opencode.db')

    // #then
    expect(env.OPENCODE_DB).toBe('/db/spawn-a/opencode.db')
    expect(env.OPENCODE_DISABLE_FILEWATCHER).toBe('true')
    expect(env).not.toHaveProperty('OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER')
    expect(env).not.toHaveProperty('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS')
  })

  it('lets the deployer override the file-watcher flag, as V1 images allowed', () => {
    // #when
    const env = buildOpencodeV2Env({OPENCODE_DISABLE_FILEWATCHER: 'false'}, '/db/opencode.db')

    // #then
    expect(env.OPENCODE_DISABLE_FILEWATCHER).toBe('false')
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

describe('runSupervisedOpencodeV2', () => {
  const NO_BACKOFF = {initialBackoffMs: 0, maxBackoffMs: 0}

  function setup(overrides: Partial<RunSupervisedOpencodeV2Options> = {}) {
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
      ...overrides,
      deps: {
        prepareDatabase: async () => {
          dbCounter += 1
          const dbPath = `/db/spawn-${dbCounter}/opencode.db`
          dbPaths.push(dbPath)
          return dbPath
        },
        verifyRules: OK_GATE,
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
    expect(start?.config?.plugins).toEqual(['@fro.bot/systematic@3.27.0', '@fro.bot/opencode-plugin@0.1.0'])
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
})
