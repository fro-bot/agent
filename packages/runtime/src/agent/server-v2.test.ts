import type {Logger} from '../shared/logger.js'
import type {Fixture, FixtureConfig} from './server-v2-test-kit.js'
import type {
  OpenCodeV2ServerHandle,
  OpenCodeV2StartError,
  OpenCodeV2Timeouts,
  StartOpenCodeV2ServerOptions,
} from './server-v2.js'
import {Buffer} from 'node:buffer'
import {getEventListeners} from 'node:events'
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {afterEach, describe, expect, expectTypeOf, it, vi} from 'vitest'
import {err, ok} from '../shared/types.js'
import {buildOpencodeCliShimScript, OPENCODE_CLI_SHIM_FILE} from './cli-shim.js'
import {createFixture} from './server-v2-test-kit.js'
import {DEFAULT_OPENCODE_V2_TIMEOUTS, startOpenCodeV2Server} from './server-v2.js'
import {
  ACTION_TRACING_OFF,
  buildTracingLauncherValue,
  WORKSPACE_TRACING_HOST,
  type OpenCodeV2TracingDecision,
  type OpenCodeV2TracingHost,
  type OpenCodeV2TracingSetting,
} from './tracing-launcher.js'

const FAST: Partial<OpenCodeV2Timeouts> = {
  listenTimeoutMs: 3000,
  infoTimeoutMs: 3000,
  agentReadyTimeoutMs: 3000,
  pluginGateTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  pollIntervalMs: 20,
  interruptSettleTimeoutMs: 1500,
  exitTimeoutMs: 1500,
  killConfirmTimeoutMs: 1000,
}

interface CapturingLogger {
  readonly logger: Logger
  readonly serialized: () => string
}

function createCapturingLogger(): CapturingLogger {
  const calls: unknown[] = []
  const record =
    (level: string) =>
    (message: string, context?: Record<string, unknown>): void => {
      calls.push({level, message, context})
    }
  return {
    logger: {debug: record('debug'), info: record('info'), warning: record('warning'), error: record('error')},
    serialized: () => JSON.stringify(calls),
  }
}

function errorOf(result: Awaited<ReturnType<typeof startOpenCodeV2Server>>): OpenCodeV2StartError | undefined {
  return result.success ? undefined : result.error
}

function guardDirectories(parent: string): string[] {
  return readdirSync(parent).filter(name => name.startsWith('fro-bot-opencode-cli-'))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('startOpenCodeV2Server', () => {
  const fixtures: Fixture[] = []
  const handles: OpenCodeV2ServerHandle[] = []

  function fixture(config: FixtureConfig = {}): Fixture {
    const created = createFixture(config)
    fixtures.push(created)
    return created
  }

  function options(
    created: Fixture,
    overrides: Partial<StartOpenCodeV2ServerOptions> = {},
  ): StartOpenCodeV2ServerOptions {
    return {
      binaryPath: created.binaryPath,
      directory: created.dir,
      expectedPluginIds: [],
      timeouts: FAST,
      tracingHost: ACTION_TRACING_OFF,
      ...overrides,
    }
  }

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.shutdown()
    }
    for (const created of fixtures.splice(0)) {
      try {
        process.kill(created.readRecord().pid, 'SIGKILL')
      } catch {
        // already gone
      }
      created.cleanup()
    }
  })

  async function start(
    created: Fixture,
    overrides: Partial<StartOpenCodeV2ServerOptions> = {},
    logger: Logger = createCapturingLogger().logger,
  ) {
    const result = await startOpenCodeV2Server(options(created, overrides), logger)
    if (result.success) handles.push(result.data)
    return result
  }

  describe('spawn, auth and readiness', () => {
    it('spawns serve --stdio on an explicit loopback port and returns a working handle', async () => {
      // #given a fixture server
      const created = fixture()

      // #when started
      const result = await start(created)

      // #then the handle answers authenticated requests
      expect(result.success).toBe(true)
      if (!result.success) return
      const record = created.readRecord()
      expect(record.argv.slice(0, 2)).toEqual(['serve', '--stdio'])
      // An explicit port: without --port upstream binds 4096 and increments (P15).
      const portIndex = record.argv.indexOf('--port')
      expect(portIndex).toBeGreaterThan(0)
      expect(record.argv[record.argv.indexOf('--hostname') + 1]).toBe('127.0.0.1')
      expect(result.data.url).toBe(`http://127.0.0.1:${record.argv[portIndex + 1]}`)
      expect(result.data.pid).toBe(record.pid)
      const response = await result.data.fetch('/api/info')
      expect(response.status).toBe(200)
    })

    it('holds stdin open, so the server is still serving well after it would have exited on EOF', async () => {
      // #given a fixture that, like upstream, exits when stdin closes
      const created = fixture()
      const result = await start(created)
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when time passes (stdin 'ignore' makes upstream exit after about 150 ms, P15)
      await new Promise(resolve => setTimeout(resolve, 400))

      // #then the server is still up
      expect(created.readLog()).not.toContain('stdin-closed')
      const response = await result.data.fetch('/api/info')
      expect(response.status).toBe(200)
    })

    it('authenticates with Basic opencode:<password> and passes the password only through the child environment', async () => {
      // #given a fixture and a secret-registration callback
      const created = fixture()
      const maskSecret = vi.fn<(value: string) => void>()

      // #when started
      const result = await start(created, {maskSecret})

      // #then every request was authorised, with the same password that was registered for masking
      expect(result.success).toBe(true)
      const password = created.readRecord().env.OPENCODE_PASSWORD
      expect(typeof password).toBe('string')
      expect((password ?? '').length).toBeGreaterThanOrEqual(32)
      expect(maskSecret).toHaveBeenCalledTimes(1)
      expect(maskSecret).toHaveBeenCalledWith(password)
      const requests = created.readLog().filter(line => line.startsWith('req '))
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every(line => line.includes('auth=ok'))).toBe(true)
      expect(result.success ? result.data.authorizationHeader() : undefined).toBe(
        `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      )
    })

    it('registers the password for masking before the child is spawned', async () => {
      // #given a mask callback that records whether the child had already started
      const created = fixture()
      let childStartedBeforeMask: boolean | undefined
      const maskSecret = (): void => {
        childStartedBeforeMask = created.readLog().length > 0
      }

      // #when started
      await start(created, {maskSecret})

      // #then the callback ran first (the fixture logs its first line only after it is running)
      expect(childStartedBeforeMask).toBe(false)
    })

    it('does not start a child when secret registration throws', async () => {
      // #given a mask callback that fails
      const created = fixture()

      // #when started
      const result = await start(created, {
        maskSecret: () => {
          throw new Error('mask failed')
        },
      })

      // #then startup fails closed and nothing was spawned
      expect(result.success).toBe(false)
      expect(errorOf(result)?.kind).toBe('secret-registration-failed')
      expect(() => created.readRecord()).toThrow()
    })

    it('scrubs the password from a failure raised by the secret-registration callback itself', async () => {
      // #given a callback that fails with an error that echoes the value it was given
      const created = fixture()
      let seen = ''

      // #when started
      const result = await start(created, {
        maskSecret: value => {
          seen = value
          throw new Error(`cannot mask ${value}`)
        },
      })

      // #then the typed error does not repeat the password
      expect(seen.length).toBeGreaterThan(0)
      expect(result.success).toBe(false)
      expect(JSON.stringify(result)).not.toContain(seen)
    })

    it('builds the child environment from the scrubbed allowlist plus the spawn-owned values', async () => {
      // #given secrets and an operator-supplied config content in the parent environment
      const created = fixture()
      const env = {
        PATH: process.env.PATH,
        HOME: '/home/agent',
        GITHUB_TOKEN: 'ghs_should_not_pass',
        OPENCODE_SERVER_PASSWORD: 'operator-password-should-not-pass',
        OPENCODE_CONFIG_CONTENT: '{"operator":"value"}',
        OPENCODE_DB: '/data/opencode.db',
        OPENCODE_DISABLE_PROJECT_CONFIG: '0',
      }

      // #when started with an explicit config
      const result = await start(created, {env, config: {plugins: ['@fro.bot/systematic@3.26.4']}})

      // #then
      expect(result.success).toBe(true)
      const childEnv = created.readRecord().env
      expect(childEnv.GITHUB_TOKEN).toBeUndefined()
      expect(childEnv.OPENCODE_SERVER_PASSWORD).toBeUndefined()
      expect(childEnv.OPENCODE_DB).toBe('/data/opencode.db')
      // Project config is always disabled: a checked-out repo must not be able to re-allow a denied action (P4/P6).
      expect(childEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
      // The config content is the spawn's own, not an inherited value.
      expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({plugins: ['@fro.bot/systematic@3.26.4']})
      // A self-update would replace the digest-verified binary mid-run.
      expect(childEnv.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    })

    describe('the tracing launcher variable', () => {
      const ACTION_ON: OpenCodeV2TracingHost = {
        host: 'action',
        tracing: 'on',
        relayPort: 43_210,
        identity: {
          repository: 'fro-bot/agent',
          runId: '42',
          attempt: '3',
          job: 'review',
          trigger: 'pull_request',
        },
      }
      const LAUNCHER = 'OPENCODE_FROBOT_TRACING'

      it.each([
        ['Action off', ACTION_TRACING_OFF],
        ['Action on', ACTION_ON],
        ['the workspace', WORKSPACE_TRACING_HOST],
      ])('writes the document for %s into the child environment', async (_name, tracingHost) => {
        // #given a spawn that declares its host
        const created = fixture()

        // #when started
        const result = await start(created, {tracingHost})

        // #then the child holds exactly the launcher document for that host
        expect(result.success).toBe(true)
        expect(created.readRecord().env[LAUNCHER]).toBe(buildTracingLauncherValue(tracingHost))
      })

      it('replaces a value inherited from the job environment, whatever the host says', async () => {
        // #given a job environment that tries to turn tracing on for a host that says off
        const created = fixture()
        const inherited = '{"version":1,"host":"action","tracing":"on","relay":"http://127.0.0.1:1/v1/traces"}'
        const env = {PATH: process.env.PATH, [LAUNCHER]: inherited}

        // #when started with the Action's off host and with the workspace host
        const off = await start(created, {env, tracingHost: ACTION_TRACING_OFF})

        // #then the inherited value is gone and the spawn's own is there
        expect(off.success).toBe(true)
        expect(created.readRecord().env[LAUNCHER]).toBe('{"version":1,"host":"action","tracing":"off"}')
        expect(created.readRecord().env[LAUNCHER]).not.toContain('127.0.0.1')
      })

      it('replaces an inherited value for the workspace host too', async () => {
        const created = fixture()
        const env = {PATH: process.env.PATH, [LAUNCHER]: '{"version":1,"host":"action","tracing":"on"}'}

        const result = await start(created, {env, tracingHost: WORKSPACE_TRACING_HOST})

        expect(result.success).toBe(true)
        expect(created.readRecord().env[LAUNCHER]).toBe('{"version":1,"host":"workspace","tracing":"off"}')
      })

      it('never hands the server an OTEL_ variable from the job environment', async () => {
        // #given a job that points OpenCode's own exporter at a collector
        const created = fixture()
        const env = {
          PATH: process.env.PATH,
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic abc',
          OTEL_RESOURCE_ATTRIBUTES: 'a=b',
          OTEL_SDK_DISABLED: 'false',
        }

        // #when started with tracing on
        const result = await start(created, {env, tracingHost: ACTION_ON})

        // #then no OTEL_ name reaches the child
        expect(result.success).toBe(true)
        expect(Object.keys(created.readRecord().env).filter(name => name.startsWith('OTEL_'))).toEqual([])
      })

      it('puts no credential, header or collector host in the document, only the host declaration', async () => {
        // #given a launcher that knows nothing but a port and an identity
        const value = buildTracingLauncherValue(ACTION_ON)

        // #then
        expect(Object.keys(JSON.parse(value) as object).sort()).toEqual([
          'host',
          'identity',
          'relay',
          'tracing',
          'version',
        ])
        expect(value).toContain('http://127.0.0.1:43210/v1/traces')
      })

      it('requires a host setting: options without one are not assignable', () => {
        // #given the options a caller must supply
        type Required = StartOpenCodeV2ServerOptions
        type WithoutHost = Omit<Required, 'tracingHost'>

        // #then a call that leaves the host out does not compile (checked by the type checker, not at run time)
        expectTypeOf<WithoutHost>().not.toExtend<Required>()
        expectTypeOf<Required['tracingHost']>().toEqualTypeOf<OpenCodeV2TracingSetting>()
        // the plain host the workspace passes is one of the two forms, and so is a late resolver
        expectTypeOf<OpenCodeV2TracingHost>().toExtend<OpenCodeV2TracingSetting>()
        expectTypeOf<() => OpenCodeV2TracingDecision>().toExtend<OpenCodeV2TracingSetting>()
      })

      describe('a late decision', () => {
        const BASE_CONFIG = {plugins: ['systematic', 'fro-bot', 'op-one']}
        const ON_CONFIG = {plugins: ['systematic', 'op-one', 'fro-bot']}

        it('is taken after the port is allocated and once, so a relay that went down while the port was picked is not advertised', async () => {
          // #given a relay that goes down while the start is allocating its port: a microtask queued by the first call the
          // start makes (registering the password) runs when the start yields to the port allocation
          const created = fixture()
          const relay = {down: false}
          const decide = vi.fn((): OpenCodeV2TracingDecision =>
            relay.down ? {host: ACTION_TRACING_OFF} : {host: ACTION_ON, config: ON_CONFIG},
          )

          // #when
          const result = await start(created, {
            config: BASE_CONFIG,
            tracingHost: decide,
            maskSecret: () => {
              queueMicrotask(() => {
                relay.down = true
              })
            },
          })

          // #then the child was given the off document and the base config, byte for byte what an off start gives
          expect(result.success).toBe(true)
          expect(decide).toHaveBeenCalledTimes(1)
          expect(created.readRecord().env[LAUNCHER]).toBe(buildTracingLauncherValue(ACTION_TRACING_OFF))
          expect(created.readRecord().env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(BASE_CONFIG))
        })

        it('gives the child the decision’s document and config when the relay is still up at the spawn', async () => {
          // #given a relay that stays up
          const created = fixture()

          // #when
          const result = await start(created, {
            config: BASE_CONFIG,
            tracingHost: () => ({host: ACTION_ON, config: ON_CONFIG}),
          })

          // #then
          expect(result.success).toBe(true)
          expect(created.readRecord().env[LAUNCHER]).toBe(buildTracingLauncherValue(ACTION_ON))
          expect(created.readRecord().env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(ON_CONFIG))
        })

        it('keeps the base config when the decision carries none, and replaces an inherited launcher value', async () => {
          const created = fixture()
          const env = {PATH: process.env.PATH, [LAUNCHER]: '{"version":1,"host":"action","tracing":"on"}'}

          const result = await start(created, {
            config: BASE_CONFIG,
            env,
            tracingHost: () => ({host: ACTION_TRACING_OFF}),
          })

          expect(result.success).toBe(true)
          expect(created.readRecord().env[LAUNCHER]).toBe(buildTracingLauncherValue(ACTION_TRACING_OFF))
          expect(created.readRecord().env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(BASE_CONFIG))
        })
      })
    })

    it('gives the server gh auth only through GH_CONFIG_DIR, never a GH_TOKEN (#2156)', async () => {
      // #given the Action's own process env as provision mode leaves it: both set in-process by configureGhAuth
      const created = fixture()
      const env = {
        PATH: process.env.PATH,
        GH_TOKEN: 'ghs_should_not_pass',
        GH_CONFIG_DIR: '/tmp/gh-config-abc123',
      }

      // #when started
      const result = await start(created, {env})

      // #then the child authenticates through the config dir; the raw token stays out of its environment
      expect(result.success).toBe(true)
      const childEnv = created.readRecord().env
      expect(childEnv.GH_TOKEN).toBeUndefined()
      expect(childEnv.GH_CONFIG_DIR).toBe('/tmp/gh-config-abc123')
    })

    it('does not inherit an operator OPENCODE_CONFIG_CONTENT when no config is given', async () => {
      // #given
      const created = fixture()

      // #when
      const result = await start(created, {env: {PATH: process.env.PATH, OPENCODE_CONFIG_CONTENT: '{"operator":1}'}})

      // #then
      expect(result.success).toBe(true)
      expect(created.readRecord().env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    })

    it('does not spawn at all for a port outside the valid range', async () => {
      // #given
      const created = fixture()

      // #when
      const result = await start(created, {port: 70000})

      // #then
      expect(result.success).toBe(false)
      expect(() => created.readRecord()).toThrow()
    })

    it('waits through /api/agent 503 before checking plugins (readiness is not /api/info)', async () => {
      // #given /api/info answers at once but /api/agent is 503 for 300 ms
      const created = fixture({
        agentReadyAfterMs: 300,
        plugins: [{id: 'fro-bot', status: 'active'}],
      })
      const startedAt = Date.now()

      // #when started with an expected plugin
      const result = await start(created, {expectedPluginIds: ['fro-bot']})

      // #then it took at least the activation time, and the plugin list was read only after /api/agent turned 200
      expect(result.success).toBe(true)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(280)
      const log = created.readLog()
      const firstReady = log.indexOf('agent 200')
      const firstPluginRead = log.findIndex(line => line.startsWith('req GET /api/plugin'))
      expect(firstReady).toBeGreaterThan(-1)
      expect(firstPluginRead).toBeGreaterThan(firstReady)
    })

    it('targets the checkout location on the location-scoped gate requests', async () => {
      // #given
      const created = fixture({plugins: [{id: 'fro-bot', status: 'active'}]})

      // #when
      await start(created, {expectedPluginIds: ['fro-bot'], directory: created.dir})

      // #then
      const scoped = created
        .readLog()
        .filter(line => line.startsWith('req GET /api/agent') || line.startsWith('req GET /api/plugin'))
      expect(scoped.length).toBeGreaterThanOrEqual(2)
      expect(scoped.every(line => line.endsWith(`dir=${encodeURIComponent(created.dir)}`))).toBe(true)
    })

    it('fails with a typed not-ready error and kills the child when activation never finishes', async () => {
      // #given an activation that hangs forever (P10: no upstream timeout)
      const created = fixture({agentNeverReady: true})

      // #when started with a short readiness bound
      const result = await start(created, {timeouts: {...FAST, agentReadyTimeoutMs: 300}})

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.kind).toBe('not-ready')
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })

    it('bounds a request that never answers, so a hung /api/agent cannot hang startup', async () => {
      // #given
      const created = fixture({agentHang: true})
      const startedAt = Date.now()

      // #when
      const result = await start(created, {timeouts: {...FAST, agentReadyTimeoutMs: 400, requestTimeoutMs: 100}})

      // #then
      expect(result.success).toBe(false)
      expect(errorOf(result)?.kind).toBe('not-ready')
      expect(Date.now() - startedAt).toBeLessThan(2500)
    })

    it('fails with a typed error and kills the child when no listening line arrives in time', async () => {
      // #given a server that never prints its url
      const created = fixture({silent: true})

      // #when
      const result = await start(created, {timeouts: {...FAST, listenTimeoutMs: 300}})

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.kind).toBe('listen-timeout')
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })

    it('reports an early exit with its code instead of waiting out the listen bound', async () => {
      // #given a binary that exits at once
      const created = fixture({exitBeforeListen: 3})
      const startedAt = Date.now()

      // #when
      const result = await start(created, {timeouts: {...FAST, listenTimeoutMs: 5000}})

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.kind).toBe('exited-early')
      expect(result.error.exitCode).toBe(3)
      expect(Date.now() - startedAt).toBeLessThan(3000)
    })

    it('reports a missing binary as a spawn failure', async () => {
      // #given
      const created = fixture()

      // #when
      const result = await start(created, {binaryPath: `${created.dir}/does-not-exist`})

      // #then
      expect(result.success).toBe(false)
      expect(errorOf(result)?.kind).toBe('spawn-failed')
    })

    it('runs the child as the uid and gid it is given', async () => {
      // #given the current identity, which an unprivileged process may always switch to
      const created = fixture()
      const uid = process.getuid?.()
      const gid = process.getgid?.()
      if (uid === undefined || gid === undefined) return

      // #when started with that uid and gid
      const result = await start(created, {uid, gid})

      // #then the server runs
      expect(result.success).toBe(true)
    })

    it('refuses to start when the child cannot take the uid it was asked to drop to', async () => {
      // #given an unprivileged parent asked to run the child as a different uid. A start that silently ignored
      // the option would run the server as the caller, which is exactly what a privilege drop must never do.
      const uid = process.getuid?.()
      if (uid === undefined || uid === 0) return
      const created = fixture()

      // #when
      const result = await start(created, {uid: uid + 1, gid: process.getgid?.() ?? 0})

      // #then the spawn fails instead of falling back to the caller's identity
      expect(result.success).toBe(false)
      expect(errorOf(result)?.kind).toBe('spawn-failed')
    })

    it('rejects a uid without a gid, and a gid without a uid', async () => {
      // #given a half-specified identity
      const created = fixture()

      // #when
      const uidOnly = await start(created, {uid: 1234})
      const gidOnly = await start(created, {gid: 1234})

      // #then neither spawns
      expect(errorOf(uidOnly)?.kind).toBe('invalid-options')
      expect(errorOf(gidOnly)?.kind).toBe('invalid-options')
    })

    it('rejects a listening line that advertises a different port, and kills the child', async () => {
      // #given a server that advertises a port other than the one it was told to bind
      const created = fixture({advertisePort: 4096})

      // #when
      const result = await start(created)

      // #then
      expect(result.success).toBe(false)
      expect(errorOf(result)?.kind).toBe('url-mismatch')
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })

    it('kills the child and reports aborted when the caller aborts mid-startup', async () => {
      // #given activation that never finishes and an abort after 150 ms
      const created = fixture({agentNeverReady: true})
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)

      // #when
      const result = await start(created, {signal: controller.signal, timeouts: {...FAST, agentReadyTimeoutMs: 10_000}})

      // #then
      expect(result.success).toBe(false)
      expect(errorOf(result)?.kind).toBe('aborted')
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })
  })

  describe('the OpenCode CLI guard (#2369)', () => {
    const parents: string[] = []

    function guardParent(): string {
      const parent = mkdtempSync(path.join(os.tmpdir(), 'cli-guard-parent-'))
      parents.push(parent)
      return parent
    }

    afterEach(() => {
      for (const parent of parents.splice(0)) rmSync(parent, {recursive: true, force: true})
    })

    it('puts a guard directory first on the child PATH, ahead of the directory that holds the real binary', async () => {
      // #given a job PATH that lists the real OpenCode directory first
      const created = fixture()
      const parent = guardParent()
      const realDirectory = path.dirname(created.binaryPath)
      const env = {PATH: `${realDirectory}:/usr/local/bin:/usr/bin:/bin`}

      // #when started
      const result = await start(created, {env, cliShimParentDirectory: parent})

      // #then the child's PATH starts with one fresh directory under the parent, and the old PATH follows unchanged
      expect(result.success).toBe(true)
      const childPath = created.readRecord().env.PATH ?? ''
      const entries = childPath.split(':')
      const [guard] = entries
      expect(path.dirname(guard ?? '')).toBe(parent)
      expect(entries.slice(1)).toEqual([realDirectory, '/usr/local/bin', '/usr/bin', '/bin'])
      expect(entries.indexOf(guard ?? '')).toBeLessThan(entries.indexOf(realDirectory))
      expect(guardDirectories(parent)).toEqual([path.basename(guard ?? '')])
    })

    it('guards a child that was given no PATH at all', async () => {
      // #given an environment without PATH
      const created = fixture()
      const parent = guardParent()

      // #when started
      const result = await start(created, {env: {HOME: '/home/agent'}, cliShimParentDirectory: parent})

      // #then the PATH is the guard alone
      expect(result.success).toBe(true)
      const [guard] = guardDirectories(parent)
      expect(created.readRecord().env.PATH).toBe(path.join(parent, guard ?? ''))
    })

    it('holds one 0755 shim for the real binary, owned by the caller and not writable by anyone else', async () => {
      // #given a started server
      const created = fixture()
      const parent = guardParent()
      const result = await start(created, {env: {PATH: '/usr/bin'}, cliShimParentDirectory: parent})
      expect(result.success).toBe(true)

      // #when the guard directory is read
      const [directory] = guardDirectories(parent)
      const guard = path.join(parent, directory ?? '')
      const file = path.join(guard, OPENCODE_CLI_SHIM_FILE)

      // #then it holds exactly the shim, for exactly this binary, with exact modes and the caller as owner
      expect(readdirSync(guard)).toEqual([OPENCODE_CLI_SHIM_FILE])
      expect(readFileSync(file, 'utf8')).toBe(buildOpencodeCliShimScript(created.binaryPath))
      expect(statSync(guard).mode & 0o7777).toBe(0o755)
      expect(statSync(file).mode & 0o7777).toBe(0o755)
      expect(statSync(guard).uid).toBe(process.getuid?.())
      expect(statSync(file).uid).toBe(process.getuid?.())
    })

    it('removes the guard when the server shuts down', async () => {
      // #given a running server with a guard
      const created = fixture()
      const parent = guardParent()
      const result = await start(created, {env: {PATH: '/usr/bin'}, cliShimParentDirectory: parent})
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(guardDirectories(parent)).toHaveLength(1)

      // #when it shuts down
      await result.data.shutdown()
      await waitFor(() => guardDirectories(parent).length === 0)

      // #then the guard is gone
      expect(guardDirectories(parent)).toEqual([])
    })

    it('removes the guard when the server exits on its own', async () => {
      // #given a running server with a guard
      const created = fixture()
      const parent = guardParent()
      const result = await start(created, {env: {PATH: '/usr/bin'}, cliShimParentDirectory: parent})
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when the server process is killed from outside
      process.kill(result.data.pid, 'SIGKILL')
      await result.data.exited
      await waitFor(() => guardDirectories(parent).length === 0)

      // #then the guard is gone
      expect(guardDirectories(parent)).toEqual([])
    })

    it('removes the guard when the start fails after the spawn', async () => {
      // #given a server that exits before it listens
      const created = fixture({exitBeforeListen: 3})
      const parent = guardParent()

      // #when started
      const result = await start(created, {env: {PATH: '/usr/bin'}, cliShimParentDirectory: parent})

      // #then the start failed and left no guard
      expect(result.success).toBe(false)
      await waitFor(() => guardDirectories(parent).length === 0)
      expect(guardDirectories(parent)).toEqual([])
    })

    it('removes the guard when the binary cannot be spawned at all', async () => {
      // #given a binary that is not there
      const created = fixture()
      const parent = guardParent()

      // #when started
      const result = await start(created, {
        binaryPath: `${created.dir}/does-not-exist`,
        env: {PATH: '/usr/bin'},
        cliShimParentDirectory: parent,
      })

      // #then the spawn failed and no guard stays behind
      expect(errorOf(result)?.kind).toBe('spawn-failed')
      await waitFor(() => guardDirectories(parent).length === 0)
      expect(guardDirectories(parent)).toEqual([])
    })

    it('leaves the PATH as it was, warns once, and removes the guard when the launch identity cannot run it (noexec)', async () => {
      // #given a guard the probe reports as unrunnable, as on a noexec RUNNER_TEMP
      const created = fixture()
      const parent = guardParent()
      const warnings: string[] = []
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warning: message => {
          warnings.push(message)
        },
        error: () => undefined,
      }
      const probeCliShim = vi.fn(() => err('the shim exited 126, not as a refusal'))

      // #when started
      const result = await start(
        created,
        {env: {PATH: '/opt/real:/usr/bin'}, cliShimParentDirectory: parent, deps: {probeCliShim}},
        logger,
      )

      // #then it fails open: the server runs with the PATH it was given, and no guard is left behind
      expect(result.success).toBe(true)
      expect(probeCliShim).toHaveBeenCalledTimes(1)
      expect(created.readRecord().env.PATH).toBe('/opt/real:/usr/bin')
      expect(guardDirectories(parent)).toEqual([])
      // #and the operator is told once
      expect(warnings.filter(message => message.includes('CLI guard'))).toHaveLength(1)
    })

    it('probes the shim file it made, as the uid and gid the child is given', async () => {
      // #given the current identity, which an unprivileged process may always take
      const uid = process.getuid?.()
      const gid = process.getgid?.()
      if (uid === undefined || gid === undefined) return
      const created = fixture()
      const parent = guardParent()
      const probeCliShim = vi.fn((_file: string, _identity?: {readonly uid: number; readonly gid: number}) => ok(null))

      // #when started with that identity, and again without one
      await start(created, {env: {PATH: '/usr/bin'}, cliShimParentDirectory: parent, uid, gid, deps: {probeCliShim}})
      const bare = fixture()
      await start(bare, {env: {PATH: '/usr/bin'}, cliShimParentDirectory: parent, deps: {probeCliShim}})

      // #then the probe ran the made file, as the given identity first and as the caller (no identity) second
      expect(probeCliShim).toHaveBeenCalledTimes(2)
      const [first, second] = probeCliShim.mock.calls
      expect(path.basename(first?.[0] ?? '')).toBe(OPENCODE_CLI_SHIM_FILE)
      expect(path.dirname(path.dirname(first?.[0] ?? ''))).toBe(parent)
      expect(first?.[1]).toEqual({uid, gid})
      expect(second?.[1]).toBeUndefined()
    })

    it('does not start the server when the guard cannot be made, so an unguarded server never runs', async () => {
      // #given a parent directory that does not exist
      const created = fixture()
      const parent = path.join(guardParent(), 'missing')

      // #when started
      const result = await start(created, {env: {PATH: '/usr/bin'}, cliShimParentDirectory: parent})

      // #then the start fails closed and the server was never spawned
      expect(errorOf(result)?.kind).toBe('spawn-failed')
      expect(errorOf(result)?.message).toMatch(/CLI guard/)
      expect(existsSync(created.logPath)).toBe(false)
    })
  })

  describe('401 handling and secrecy', () => {
    it('reports a 401 as an auth failure, fast, and not as a server that is down', async () => {
      // #given a server that rejects every credential
      const created = fixture({rejectAllAuth: true})
      const startedAt = Date.now()

      // #when
      const result = await start(created, {timeouts: {...FAST, infoTimeoutMs: 5000}})

      // #then it is classified as auth and does not ride out the readiness bound
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.kind).toBe('auth-failed')
      expect(Date.now() - startedAt).toBeLessThan(2500)
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })

    it('never puts the password in a log line, an error message or the error object (401 path)', async () => {
      // #given
      const created = fixture({rejectAllAuth: true})
      const captured = createCapturingLogger()

      // #when
      const result = await start(created, {}, captured.logger)

      // #then
      const password = created.readRecord().env.OPENCODE_PASSWORD ?? ''
      expect(password.length).toBeGreaterThan(0)
      expect(captured.serialized()).not.toContain(password)
      expect(JSON.stringify(result)).not.toContain(password)
      expect(result.success).toBe(false)
      expect(errorOf(result)?.message ?? '').not.toContain(password)
    })

    it('never puts the password in a log line or the handle on the success path, including shutdown', async () => {
      // #given
      const created = fixture({activeSessions: ['ses_1'], plugins: [{id: 'fro-bot', status: 'active'}]})
      const captured = createCapturingLogger()
      const result = await start(created, {expectedPluginIds: ['fro-bot']}, captured.logger)
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when the whole lifecycle ran, including a shutdown
      const shutdown = await result.data.shutdown({ownedSessionIds: ['ses_1']})

      // #then no captured value carries the password
      const password = created.readRecord().env.OPENCODE_PASSWORD ?? ''
      expect(captured.serialized()).not.toContain(password)
      expect(JSON.stringify(shutdown)).not.toContain(password)
      expect(JSON.stringify(result.data)).not.toContain(password)
    })
  })

  describe('plugin gate', () => {
    it('passes when every expected plugin is listed active', async () => {
      // #given
      const created = fixture({
        plugins: [
          {id: 'systematic', status: 'active'},
          {id: 'fro-bot', status: 'active'},
          {id: 'builtin.thing', status: 'active'},
        ],
      })

      // #when
      const result = await start(created, {expectedPluginIds: ['systematic', 'fro-bot']})

      // #then
      expect(result.success).toBe(true)
    })

    it('does not read the plugin list when no plugin is expected', async () => {
      // #given
      const created = fixture({plugins: [{id: 'x', status: 'failed'}]})

      // #when
      const result = await start(created, {expectedPluginIds: []})

      // #then
      expect(result.success).toBe(true)
      expect(created.readLog().some(line => line.startsWith('req GET /api/plugin'))).toBe(false)
    })

    it('fails and names the plugin when an expected plugin is failed, without logging its error text', async () => {
      // #given a failed plugin whose error string carries a path and a stack (P13)
      const leak = '/home/runner/.cache/opencode/npm/leaky-path at Object.<anonymous> (/$bunfs/root/src/cli.js:1:2)'
      const created = fixture({
        plugins: [
          {id: 'systematic', status: 'active'},
          {id: 'fro-bot', status: 'failed', error: leak},
        ],
      })
      const captured = createCapturingLogger()
      const startedAt = Date.now()

      // #when the gate bound is long
      const result = await start(
        created,
        {expectedPluginIds: ['systematic', 'fro-bot'], timeouts: {...FAST, pluginGateTimeoutMs: 5000}},
        captured.logger,
      )

      // #then a listed failure is final: it fails at once instead of waiting out the bound
      expect(Date.now() - startedAt).toBeLessThan(2500)
      // #and it names the plugin and the status, and nothing carries the raw error
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.kind).toBe('plugin-gate')
      expect(result.error.plugins).toEqual([{id: 'fro-bot', status: 'failed'}])
      expect(result.error.message).toContain('fro-bot')
      expect(JSON.stringify(result)).not.toContain('leaky-path')
      expect(captured.serialized()).not.toContain('leaky-path')
      expect(captured.serialized()).not.toContain('bunfs')
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })

    it('fails and names the plugin when an expected plugin is still not listed at the bound', async () => {
      // #given a plugin that never shows up
      const created = fixture({plugins: [{id: 'systematic', status: 'active'}]})

      // #when
      const result = await start(created, {
        expectedPluginIds: ['systematic', 'fro-bot'],
        timeouts: {...FAST, pluginGateTimeoutMs: 300},
      })

      // #then
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.kind).toBe('plugin-gate')
      expect(result.error.plugins).toEqual([{id: 'fro-bot', status: 'absent'}])
      expect(result.error.message).toContain('fro-bot')
      expect(result.error.message).not.toContain('systematic')
    })

    it('waits for a plugin that appears late, within the bound', async () => {
      // #given a plugin listed only 200 ms after listening
      const created = fixture({plugins: [{id: 'fro-bot', status: 'active', appearAfterMs: 200}]})

      // #when
      const result = await start(created, {expectedPluginIds: ['fro-bot']})

      // #then
      expect(result.success).toBe(true)
    })

    it('bounds plugin activation by the gate alone for 60 s, because /api/agent no longer waits for plugins (2.2.7)', () => {
      // #given OpenCode 2.2.7 answers /api/agent 200 before any plugin is listed, so only this gate waits for activation
      // #when the default bound is read
      // #then it covers a cold runner's activation, as /api/agent's 120 s retry did on 2.2.6
      expect(DEFAULT_OPENCODE_V2_TIMEOUTS.pluginGateTimeoutMs).toBe(60_000)
    })

    it('waits for plugins that are listed only after /api/agent already answered 200 (2.2.7)', async () => {
      // #given /api/agent is ready at once and both plugins are listed 300 ms later
      const created = fixture({
        plugins: [
          {id: 'systematic', status: 'active', appearAfterMs: 300},
          {id: 'fro-bot', status: 'active', appearAfterMs: 300},
        ],
      })

      // #when
      const result = await start(created, {expectedPluginIds: ['systematic', 'fro-bot']})

      // #then the gate polled through the empty list instead of failing on it
      expect(result.success).toBe(true)
      const log = created.readLog()
      expect(log.filter(line => line.startsWith('req GET /api/plugin')).length).toBeGreaterThan(1)
    })

    it('treats an id-less failed entry as a non-match: the expected id is absent', async () => {
      // #given a plugin that failed before it could declare an id (P13: "must export a default definition")
      const created = fixture({plugins: [{status: 'failed', error: 'no id'}]})

      // #when
      const result = await start(created, {
        expectedPluginIds: ['fro-bot'],
        timeouts: {...FAST, pluginGateTimeoutMs: 200},
      })

      // #then
      expect(result.success).toBe(false)
      expect(errorOf(result)?.plugins).toEqual([{id: 'fro-bot', status: 'absent'}])
    })
  })

  describe('shutdown', () => {
    it('interrupts every owned session before closing stdin, waits for them to leave active, and confirms exit', async () => {
      // #given two active owned sessions that drop 150 ms after an interrupt
      const created = fixture({activeSessions: ['ses_a', 'ses_b'], dropDelayMs: 150})
      const result = await start(created)
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when shutting down
      const shutdown = await result.data.shutdown({ownedSessionIds: ['ses_a', 'ses_b']})

      // #then both were interrupted and had dropped before stdin closed
      const log = created.readLog().filter(line => !line.startsWith('req '))
      const stdinClosedAt = log.indexOf('stdin-closed')
      expect(stdinClosedAt).toBeGreaterThan(-1)
      for (const id of ['ses_a', 'ses_b']) {
        expect(log.indexOf(`interrupt ${id}`)).toBeGreaterThan(-1)
        expect(log.indexOf(`interrupt ${id}`)).toBeLessThan(stdinClosedAt)
        expect(log.indexOf(`dropped ${id}`)).toBeLessThan(stdinClosedAt)
      }
      expect(shutdown.interrupts).toEqual({stopped: ['ses_a', 'ses_b'], notRunning: [], unconfirmed: []})
      // #and exit is confirmed through the process exit event, code 0
      expect(shutdown.exit).toEqual({outcome: 'graceful', code: 0, signal: null})
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })

    it('reports a session that never leaves active as unconfirmed, and still closes stdin', async () => {
      // #given a session that acknowledges the interrupt but stays active
      const created = fixture({activeSessions: ['ses_a'], neverDrops: true})
      const result = await start(created, {timeouts: {...FAST, interruptSettleTimeoutMs: 300}})
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when
      const shutdown = await result.data.shutdown({ownedSessionIds: ['ses_a']})

      // #then the stop is not claimed, but the server is still stopped
      expect(shutdown.interrupts.unconfirmed).toEqual(['ses_a'])
      expect(shutdown.interrupts.stopped).toEqual([])
      expect(shutdown.exit.outcome).toBe('graceful')
    })

    it('re-sends the interrupt when the first reply was interrupted:false and the session is still active', async () => {
      // #given an unadmitted turn: the first two interrupts reply false and do nothing (P1)
      const created = fixture({activeSessions: ['ses_a'], interruptFalseFirst: 2})
      const result = await start(created)
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when
      const shutdown = await result.data.shutdown({ownedSessionIds: ['ses_a']})

      // #then it kept interrupting until the stop was real
      const interrupts = created.readLog().filter(line => line === 'interrupt ses_a')
      expect(interrupts.length).toBeGreaterThanOrEqual(3)
      expect(shutdown.interrupts.stopped).toEqual(['ses_a'])
    })

    it('does not count an interrupted:false reply plus absence as a stop', async () => {
      // #given an owned session that is not running at all
      const created = fixture({activeSessions: []})
      const result = await start(created)
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when
      const shutdown = await result.data.shutdown({ownedSessionIds: ['ses_idle']})

      // #then it is reported as not running, never as stopped
      expect(shutdown.interrupts).toEqual({stopped: [], notRunning: ['ses_idle'], unconfirmed: []})
    })

    it('sends no interrupt requests when there are no owned sessions', async () => {
      // #given
      const created = fixture({activeSessions: ['ses_other']})
      const result = await start(created)
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when
      const shutdown = await result.data.shutdown()

      // #then
      expect(created.readLog().some(line => line.startsWith('interrupt '))).toBe(false)
      expect(shutdown.interrupts).toEqual({stopped: [], notRunning: [], unconfirmed: []})
      expect(shutdown.exit.outcome).toBe('graceful')
    })

    it('kills a child that ignores the stdin close and reports the exit as forced', async () => {
      // #given a server that does not exit on EOF
      const created = fixture({ignoreStdinClose: true})
      const result = await start(created, {timeouts: {...FAST, exitTimeoutMs: 200}})
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when
      const shutdown = await result.data.shutdown()

      // #then
      expect(shutdown.exit.outcome).toBe('forced')
      expect(isAlive(created.readRecord().pid)).toBe(false)
    })

    it('reports the exit as unconfirmed when the child cannot be confirmed gone', async () => {
      // #given a server that ignores EOF and a kill that does not take effect
      const created = fixture({ignoreStdinClose: true})
      const killGroup = vi.fn<(pid: number, signal: NodeJS.Signals) => void>()
      const result = await start(created, {
        timeouts: {...FAST, exitTimeoutMs: 150, killConfirmTimeoutMs: 150},
        deps: {killGroup},
      })
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when
      const shutdown = await result.data.shutdown()

      // #then it does not claim the process is gone
      expect(shutdown.exit.outcome).toBe('unconfirmed')
      expect(killGroup).toHaveBeenCalledWith(result.data.pid, 'SIGKILL')
      // cleanup: the fake kill left it running
      process.kill(result.data.pid, 'SIGKILL')
      await waitFor(() => !isAlive(result.data.pid))
    })

    it('is idempotent: a second call returns the first result without another interrupt round', async () => {
      // #given
      const created = fixture({activeSessions: ['ses_a']})
      const result = await start(created)
      expect(result.success).toBe(true)
      if (!result.success) return
      const countInterrupts = (): number => created.readLog().filter(line => line === 'interrupt ses_a').length

      // #when called twice, the second time after the first has finished
      const first = await result.data.shutdown({ownedSessionIds: ['ses_a']})
      const interruptsAfterFirst = countInterrupts()
      const second = await result.data.shutdown({ownedSessionIds: ['ses_a']})

      // #then
      expect(second).toBe(first)
      expect(countInterrupts()).toBe(interruptsAfterFirst)
    })

    it('exposes the exit event, and skips the interrupt round if the server already died', async () => {
      // #given a running server that is killed from outside
      const created = fixture({activeSessions: ['ses_a']})
      const result = await start(created, {timeouts: {...FAST, interruptSettleTimeoutMs: 5000}})
      expect(result.success).toBe(true)
      if (!result.success) return
      process.kill(result.data.pid, 'SIGKILL')
      const exit = await result.data.exited

      // #when shutting down afterwards, with a long interrupt bound
      const startedAt = Date.now()
      const shutdown = await result.data.shutdown({ownedSessionIds: ['ses_a']})

      // #then it does not wait on a server that cannot answer
      expect(Date.now() - startedAt).toBeLessThan(1000)
      expect(exit.signal).toBe('SIGKILL')
      expect(shutdown.exit.outcome).toBe('already-exited')
      expect(shutdown.interrupts.unconfirmed).toEqual(['ses_a'])
      expect(created.readLog().some(line => line.startsWith('interrupt '))).toBe(false)
    })
  })

  describe('cancellation after readiness', () => {
    const eventLog = (created: Fixture): readonly string[] => created.readLog().filter(line => !line.startsWith('req '))

    it('stops the child within the cleanup bound when the caller aborts after the server is ready', async () => {
      // #given a ready server whose caller signal is still live
      const created = fixture()
      const controller = new AbortController()
      const result = await start(created, {signal: controller.signal})
      expect(result.success).toBe(true)
      if (!result.success) return

      // #when the caller aborts
      const abortedAt = Date.now()
      controller.abort()
      const exit = await Promise.race([
        result.data.exited,
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), FAST.exitTimeoutMs ?? 1500)),
      ])

      // #then the child exited on its own within the bound, from the stdin close
      expect(exit).not.toBe('timeout')
      expect(Date.now() - abortedAt).toBeLessThan(FAST.exitTimeoutMs ?? 1500)
      expect(isAlive(created.readRecord().pid)).toBe(false)
      expect(eventLog(created)).toContain('stdin-closed')
    })

    it('interrupts a registered session before stdin closes when the abort comes first, and confirms the stop', async () => {
      // #given a ready server with an active session registered as owned
      const created = fixture({activeSessions: ['ses_a'], dropDelayMs: 50})
      const controller = new AbortController()
      const result = await start(created, {signal: controller.signal})
      expect(result.success).toBe(true)
      if (!result.success) return
      result.data.registerOwnedSession('ses_a')

      // #when the caller aborts, and shutdown is requested afterwards
      controller.abort()
      const shutdown = await result.data.shutdown()

      // #then the interrupt reached the server on the cleanup signal and the stop is confirmed
      expect(shutdown.interrupts).toEqual({stopped: ['ses_a'], notRunning: [], unconfirmed: []})
      expect(shutdown.exit.outcome).toBe('graceful')
      const log = eventLog(created)
      expect(log.indexOf('interrupt ses_a')).toBeGreaterThan(-1)
      expect(log.indexOf('interrupt ses_a')).toBeLessThan(log.indexOf('stdin-closed'))
      expect(log.indexOf('dropped ses_a')).toBeLessThan(log.indexOf('stdin-closed'))
    })

    it('merges sessions passed to shutdown with the registered ones', async () => {
      // #given one registered and one passed session, both active
      const created = fixture({activeSessions: ['ses_a', 'ses_b']})
      const result = await start(created)
      expect(result.success).toBe(true)
      if (!result.success) return
      result.data.registerOwnedSession('ses_a')

      // #when
      const shutdown = await result.data.shutdown({ownedSessionIds: ['ses_b']})

      // #then both were stopped
      expect([...shutdown.interrupts.stopped].sort()).toEqual(['ses_a', 'ses_b'])
    })

    it('runs one interrupt sequence for an abort plus shutdown, and for concurrent shutdowns', async () => {
      // #given a ready server with one registered session that is not running, so a single round sends exactly one interrupt
      const created = fixture({activeSessions: []})
      const controller = new AbortController()
      const result = await start(created, {signal: controller.signal})
      expect(result.success).toBe(true)
      if (!result.success) return
      result.data.registerOwnedSession('ses_idle')

      // #when an abort and two shutdown calls race
      controller.abort()
      const [first, second] = await Promise.all([result.data.shutdown(), result.data.shutdown()])
      const third = await result.data.shutdown()

      // #then every caller got the same result object and the server saw a single sequence
      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(first.interrupts).toEqual({stopped: [], notRunning: ['ses_idle'], unconfirmed: []})
      const log = eventLog(created)
      expect(log.filter(line => line === 'interrupt ses_idle')).toHaveLength(1)
      expect(log.filter(line => line === 'stdin-closed')).toHaveLength(1)
    })

    it('removes its abort listener once the child has exited', async () => {
      // #given a ready server on a signal that never aborts
      const created = fixture()
      const controller = new AbortController()
      const result = await start(created, {signal: controller.signal})
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

      // #when shut down normally
      await result.data.shutdown()
      await result.data.exited

      // #then the signal holds no listener for the finished server
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    })
  })
})
