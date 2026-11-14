import type {OpenCodeV2ServerHandle, OpenCodeV2ShutdownResult} from '@fro-bot/runtime'
import type {KeyProxyProbeResult} from './key-proxy-probe.js'
import type {KeyProxyProcess} from './key-proxy-process.js'
import type {SandboxLifecycle} from './sandbox-lifecycle.js'
import type {StartActionOpenCodeV2Deps, StartActionOpenCodeV2Options} from './v2-server.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {err} from '@bfra.me/es/result'
import {clearHeldClaims} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest'
import {pluginCacheDir, resolvePluginSpecsV2} from '../../services/setup/plugin-install-v2.js'
import {createRepoSkillsStagingRoot} from '../../services/setup/repo-skills.js'
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

function spawnedConfig(deps: Partial<StartActionOpenCodeV2Deps>): {mcp?: unknown} {
  const config = vi.mocked(deps.startServer as StartServer).mock.calls[0]?.[0].config
  return config as {mcp?: unknown}
}

function spawnedContent(deps: Partial<StartActionOpenCodeV2Deps>): Record<string, unknown> {
  return vi.mocked(deps.startServer as StartServer).mock.calls[0]?.[0].config as Record<string, unknown>
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
      credential: 'provision',
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

  it('produces the config and credential files it always did, and starts no proxy, when isolation is off', async () => {
    // #given two API keys and an operator config that sets a base URL, a timeout and a key reference
    const server = fakeServer()
    const startKeyProxy = vi.fn()
    const probeKeyProxy = vi.fn()
    const deps = recordingDeps(server, {startKeyProxy, probeKeyProxy})
    const opencodeConfig = JSON.stringify({
      provider: {
        anthropic: {options: {baseURL: 'https://gw.example/v1', timeout: 600_000}},
        openai: {options: {apiKey: '{env:OPENAI_API_KEY}'}},
      },
    })

    // #when started without a sandbox
    const result = await startActionOpenCodeV2(
      options({
        deps,
        opencodeConfig,
        authJson: JSON.stringify({anthropic: {type: 'api', key: CANARY}, openai: {type: 'api', key: `${CANARY}-oai`}}),
      }),
    )

    // #then the spawn options carry exactly the keys they always did
    expect(result.success).toBe(true)
    const startArgs = vi.mocked(deps.startServer as StartServer).mock.calls[0]?.[0]
    expect(Object.keys(startArgs ?? {}).sort()).toEqual([
      'binaryPath',
      'config',
      'directory',
      'env',
      'expectedPluginIds',
    ])

    // #then each provider keeps its operator settings and gains only a {file:} key reference; no baseURL is rewritten
    const content = startArgs?.config as Record<string, unknown>
    const credentialsDir = fs.readdirSync(runnerTemp).find(name => name.startsWith('fro-bot-credentials-')) ?? ''
    const reference = (name: string): string => `{file:${path.join(runnerTemp, credentialsDir, `${name}.key`)}}`
    expect(content.provider).toEqual({
      anthropic: {options: {baseURL: 'https://gw.example/v1', timeout: 600_000, apiKey: reference('anthropic')}},
      openai: {options: {apiKey: reference('openai')}},
    })
    expect(content).not.toHaveProperty('providers')
    expect(content.plugins).toEqual([...PLUGIN_SPECS])
    expect(Object.keys(content).sort()).toEqual(
      ['default_agent', 'experimental', 'permissions', 'plugins', 'provider', 'update'].sort(),
    )
    expect(content.update).toBe('disable')
    expect(content.default_agent).toBe('build')
    expect(content.experimental).toEqual({subagent_depth: 1})

    // #then the credential directory holds exactly the two 0600 key files, in a 0700 directory under RUNNER_TEMP
    const directory = path.join(runnerTemp, credentialsDir)
    expect(fs.readdirSync(runnerTemp).filter(name => name.startsWith('fro-bot-credentials-'))).toHaveLength(1)
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(directory).sort()).toEqual(['anthropic.key', 'openai.key'])
    expect(fs.readFileSync(path.join(directory, 'anthropic.key'), 'utf8')).toBe(CANARY)
    expect(fs.readFileSync(path.join(directory, 'openai.key'), 'utf8')).toBe(`${CANARY}-oai`)
    expect(fs.statSync(path.join(directory, 'anthropic.key')).mode & 0o777).toBe(0o600)

    // #then no proxy was involved
    expect(startKeyProxy).not.toHaveBeenCalled()
    expect(probeKeyProxy).not.toHaveBeenCalled()
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

  describe('bundled Systematic skills directory', () => {
    const SYSTEMATIC_SPEC = PLUGIN_SPECS[0] as string

    /** The installer's layout: `<cache>/opencode/npm/<spec>/<generation>/node_modules/<name>/skills`. */
    function installSkills(generation = '1800000000000'): string {
      const skills = path.join(
        pluginCacheDir(cacheHome, SYSTEMATIC_SPEC),
        generation,
        'node_modules',
        '@fro.bot',
        'systematic',
        'skills',
      )
      fs.mkdirSync(skills, {recursive: true})
      return skills
    }

    interface PermissionRule {
      action: string
      resource: string
      effect: string
    }
    function spawnedRules(deps: Partial<StartActionOpenCodeV2Deps>): PermissionRule[] {
      const config = vi.mocked(deps.startServer as StartServer).mock.calls[0]?.[0].config
      return (config?.permissions ?? []) as PermissionRule[]
    }

    it('allows the installed directory, denies the edit tools there, and the permission gate accepts it', async () => {
      // #given the plugin is cached with its skills
      const skills = installSkills()
      const deps = recordingDeps(fakeServer())

      // #when the run starts, through the real permission gate
      const result = await startActionOpenCodeV2(options({deps}))

      // #then the gate passed with the directory as an authorized exception
      expect(result.success).toBe(true)
      const rules = spawnedRules(deps)
      expect(rules).toEqual(
        expect.arrayContaining([
          {action: 'external_directory', resource: `${skills}/*`, effect: 'allow'},
          {action: 'edit', resource: `${skills}/*`, effect: 'deny'},
        ]),
      )
      // #then it is the only skills-shaped exception (plus its real path when the temp dir is behind a symlink): the
      // package and the cache stay behind the deny
      const skillsSpellings = new Set([`${skills}/*`, `${fs.realpathSync(skills)}/*`])
      const nodeModulesAllows = rules.filter(
        rule => rule.action === 'external_directory' && rule.resource.includes('/node_modules/'),
      )
      expect(nodeModulesAllows.length).toBeGreaterThan(0)
      expect(nodeModulesAllows.every(rule => rule.effect === 'allow' && skillsSpellings.has(rule.resource))).toBe(true)
    })

    it('uses the newest generation, the one the server loads', async () => {
      // #given two generations of the cached plugin
      installSkills('1700000000000')
      const newest = installSkills('1800000000000')
      const deps = recordingDeps(fakeServer())

      // #when
      await startActionOpenCodeV2(options({deps}))

      // #then
      const allowed = spawnedRules(deps).filter(rule => rule.action === 'external_directory' && rule.effect === 'allow')
      expect(allowed.map(rule => rule.resource)).toContain(`${newest}/*`)
      expect(allowed.map(rule => rule.resource).join()).not.toContain('1700000000000')
    })

    it('finds a directory the bounded installer has only just created', async () => {
      // #given an empty cache, so the installer runs before the config is built
      fs.rmSync(cacheHome, {recursive: true, force: true})
      let skills = ''
      const deps = recordingDeps(fakeServer(), {
        installPlugins: vi.fn<InstallPlugins>(async () => {
          populatePluginCache(cacheHome)
          skills = installSkills()
          return ok(undefined)
        }),
      })

      // #when
      const result = await startActionOpenCodeV2(options({deps}))

      // #then
      expect(result.success).toBe(true)
      expect(spawnedRules(deps)).toEqual(
        expect.arrayContaining([{action: 'external_directory', resource: `${skills}/*`, effect: 'allow'}]),
      )
    })

    it('warns and adds nothing when the directory is not there, without failing the run', async () => {
      // #given the default warm cache holds only package.json files
      const logger = createMockLogger()
      const deps = recordingDeps(fakeServer())

      // #when
      const result = await startActionOpenCodeV2(options({deps, logger}))

      // #then
      expect(result.success).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith(
        expect.stringContaining('Bundled Systematic skills directory not found'),
        expect.anything(),
      )
      expect(
        spawnedRules(deps).filter(rule => rule.effect === 'allow' && rule.action === 'external_directory'),
      ).toEqual(
        spawnedRules(deps).filter(
          rule =>
            rule.effect === 'allow' &&
            rule.action === 'external_directory' &&
            !rule.resource.includes('/node_modules/'),
        ),
      )
    })
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

  describe('caller MCP servers (fro-bot/agent#1931)', () => {
    const MCP = {
      docs: {type: 'local', command: ['node', 'echo.mjs']},
      wiki: {type: 'remote', url: 'https://mcp.example.com/mcp'},
    } as const

    it('spawns with every server on a provisioned run, and the permission gate accepts it', async () => {
      // #given
      const server = fakeServer()
      const deps = recordingDeps(server)

      // #when
      const result = await startActionOpenCodeV2(
        options({deps, credential: 'provision', opencodeConfig: JSON.stringify({mcp: MCP})}),
      )

      // #then
      expect(result.success).toBe(true)
      const config = spawnedConfig(deps)
      expect(config.mcp).toEqual(MCP)
    })

    it('spawns with only the static local server on a credential-withheld run', async () => {
      // #given
      const server = fakeServer()
      const deps = recordingDeps(server)

      // #when
      const result = await startActionOpenCodeV2(
        options({deps, credential: 'withhold', opencodeConfig: JSON.stringify({mcp: MCP})}),
      )

      // #then
      expect(result.success).toBe(true)
      expect(spawnedConfig(deps).mcp).toEqual({docs: MCP.docs})
    })

    it('spawns without any mcp on a credential-withheld run when no server is a static local one', async () => {
      // #given
      const server = fakeServer()
      const deps = recordingDeps(server)

      // #when
      const result = await startActionOpenCodeV2(
        options({deps, credential: 'withhold', opencodeConfig: JSON.stringify({mcp: {wiki: MCP.wiki}})}),
      )

      // #then
      expect(result.success).toBe(true)
      expect(spawnedConfig(deps)).not.toHaveProperty('mcp')
    })

    it('fails the config stage before any spawn on a {env:} reference on a credential-withheld run', async () => {
      // #given
      const server = fakeServer()
      const deps = recordingDeps(server)

      // #when
      const result = await startActionOpenCodeV2(
        options({deps, credential: 'withhold', opencodeConfig: JSON.stringify({share: '{env:SECRET_NAME_456}'})}),
      )

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'config'}})
      expect(JSON.stringify(result)).toContain('{env:}')
      expect(JSON.stringify(result)).not.toContain('SECRET_NAME_456')
      expect(deps.startServer).not.toHaveBeenCalled()
    })

    it('fails the config stage before any spawn when the mcp shape is bad, naming the server', async () => {
      // #given
      const server = fakeServer()
      const deps = recordingDeps(server)

      // #when
      const result = await startActionOpenCodeV2(
        options({deps, opencodeConfig: JSON.stringify({mcp: {docs: {type: 'local'}}})}),
      )

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'config'}})
      expect(JSON.stringify(result)).toContain(String.raw`server \"docs\"`)
      expect(deps.startServer).not.toHaveBeenCalled()
    })
  })

  describe('permission gate agent-list retry', () => {
    // Fast timing so the tests run the real loop on real timers; production values are 7 s / 500 ms / 30 s.
    const FAST = {attemptTimeoutMs: 50, retryDelayMs: 5, deadlineMs: 100}

    type AgentStep = 'ok' | 'status-503' | 'status-500' | 'malformed' | Error

    /** Scripts the answers to `GET /api/agent` in order; the last step repeats. Other routes behave as the fake does. */
    function scripted(steps: readonly AgentStep[]): FakeServer {
      const server = fakeServer()
      const real = server.fetch.getMockImplementation()
      if (real === undefined) throw new Error('fakeServer has no fetch implementation')
      let index = 0
      server.fetch.mockImplementation(async pathname => {
        if (pathname !== '/api/agent') return real(pathname)
        const step = steps[Math.min(index, steps.length - 1)] as AgentStep
        index += 1
        if (step instanceof Error) throw step
        if (step === 'status-503') return new Response('{}', {status: 503})
        if (step === 'status-500') return new Response('{}', {status: 500})
        if (step === 'malformed') return new Response('<html>not json', {status: 200})
        return real(pathname)
      })
      return server
    }

    const agentCalls = (server: FakeServer): number => server.fetch.mock.calls.filter(c => c[0] === '/api/agent').length
    const timeoutError = (): Error => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const abortError = (): Error => new DOMException('This operation was aborted', 'AbortError')

    it('passes after a 503 while plugins activate, logging the retry at debug', async () => {
      // #given
      const server = scripted(['status-503', 'ok'])
      const logger = createMockLogger()

      // #when
      const result = await startActionOpenCodeV2(
        options({logger, deps: {...recordingDeps(server), agentListRetry: FAST}}),
      )

      // #then
      expect(result.success).toBe(true)
      expect(agentCalls(server)).toBe(2)
      expect(server.shutdown).not.toHaveBeenCalled()
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('retrying'),
        expect.objectContaining({attempt: 1, cause: 'HTTP 503'}),
      )
    })

    it.each([
      ['a client timeout', timeoutError],
      ['an abort', abortError],
    ])('passes after %s on the first attempt', async (_label, makeError) => {
      // #given
      const server = scripted([makeError(), 'ok'])

      // #when
      const result = await startActionOpenCodeV2(options({deps: {...recordingDeps(server), agentListRetry: FAST}}))

      // #then
      expect(result.success).toBe(true)
      expect(agentCalls(server)).toBe(2)
    })

    it('fails after the deadline on a persistent 503, naming the retries, the last cause and the attempts', async () => {
      // #given
      const server = scripted(['status-503'])

      // #when
      const result = await startActionOpenCodeV2(options({deps: {...recordingDeps(server), agentListRetry: FAST}}))

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
      const attempts = agentCalls(server)
      expect(attempts).toBeGreaterThan(1)
      const message = unwrapErr(result).message
      expect(message).toContain('retried')
      expect(message).toContain('last cause: HTTP 503')
      expect(message).toContain(`after ${attempts} attempts`)
      expect(server.shutdown).toHaveBeenCalledTimes(1)
    })

    it('fails with the timeout as the last cause when every attempt times out', async () => {
      // #given
      const server = scripted([timeoutError()])

      // #when
      const result = await startActionOpenCodeV2(options({deps: {...recordingDeps(server), agentListRetry: FAST}}))

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
      expect(unwrapErr(result).message).toContain('last cause: timed out')
      expect(agentCalls(server)).toBeGreaterThan(1)
    })

    it('does not retry when no further attempt fits before the deadline', async () => {
      // #given
      const server = scripted(['status-503'])
      const agentListRetry = {attemptTimeoutMs: 50, retryDelayMs: 5, deadlineMs: 40}

      // #when
      const result = await startActionOpenCodeV2(options({deps: {...recordingDeps(server), agentListRetry}}))

      // #then
      expect(agentCalls(server)).toBe(1)
      expect(unwrapErr(result).message).toContain('after 1 attempt')
    })

    it('fails immediately, without a retry, on HTTP 500', async () => {
      // #given
      const server = scripted(['status-500', 'ok'])

      // #when
      const result = await startActionOpenCodeV2(options({deps: {...recordingDeps(server), agentListRetry: FAST}}))

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
      expect(unwrapErr(result).message).toContain('GET /api/agent answered HTTP 500')
      expect(unwrapErr(result).message).not.toContain('retried')
      expect(agentCalls(server)).toBe(1)
      expect(server.shutdown).toHaveBeenCalledTimes(1)
    })

    it('fails immediately, without a retry, on a malformed body', async () => {
      // #given
      const server = scripted(['malformed', 'ok'])

      // #when
      const result = await startActionOpenCodeV2(options({deps: {...recordingDeps(server), agentListRetry: FAST}}))

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
      expect(unwrapErr(result).message).not.toContain('retried')
      expect(agentCalls(server)).toBe(1)
    })

    it('fails immediately, without a retry, on a network error that is not a timeout', async () => {
      // #given
      const server = scripted([new TypeError('fetch failed'), 'ok'])

      // #when
      const result = await startActionOpenCodeV2(options({deps: {...recordingDeps(server), agentListRetry: FAST}}))

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
      expect(unwrapErr(result).message).toContain('fetch failed')
      expect(agentCalls(server)).toBe(1)
    })

    it('does not retry an abort the caller asked for', async () => {
      // #given
      const server = scripted([abortError(), 'ok'])
      const controller = new AbortController()
      controller.abort()

      // #when
      // A deadline too short for a retry: only the caller-abort guard keeps the message from claiming a retry.
      const agentListRetry = {attemptTimeoutMs: 50, retryDelayMs: 5, deadlineMs: 40}
      const result = await startActionOpenCodeV2(
        options({signal: controller.signal, deps: {...recordingDeps(server), agentListRetry}}),
      )

      // #then
      expect(result).toMatchObject({success: false, error: {stage: 'permission-gate'}})
      expect(unwrapErr(result).message).not.toContain('retried')
      expect(agentCalls(server)).toBe(1)
    })
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

  describe('repo skills (fro-bot/agent#2129)', () => {
    const SYSTEMATIC_PACKAGE = '@fro.bot/systematic'
    let sourceDir: string
    let stagingRoot: string

    function populateBundledSkills(): string {
      const version = unwrapOk(resolvePluginSpecsV2('latest')).systematicVersion
      const skillsDir = path.join(
        cacheHome,
        'opencode',
        'npm',
        `${SYSTEMATIC_PACKAGE}@${version}`,
        '1800000000000',
        'node_modules',
        SYSTEMATIC_PACKAGE,
        'skills',
      )
      fs.mkdirSync(path.join(skillsDir, 'ce-review'), {recursive: true})
      fs.writeFileSync(path.join(skillsDir, 'ce-review', 'SKILL.md'), '---\nname: ce:review\n---\nbundled\n')
      return fs.realpathSync(skillsDir)
    }

    function writeRepoSkill(id: string, body = 'REPO-SKILL-BODY-CANARY'): void {
      fs.mkdirSync(path.join(sourceDir, id, 'references'), {recursive: true})
      fs.writeFileSync(path.join(sourceDir, id, 'SKILL.md'), `---\nname: ${id}\ndescription: d\n---\n${body}\n`)
      fs.writeFileSync(path.join(sourceDir, id, 'references', 'r.md'), 'ref\n')
    }

    beforeEach(() => {
      sourceDir = path.join(root, 'checkout', '.agents', 'skills')
      fs.mkdirSync(sourceDir, {recursive: true})
      stagingRoot = unwrapOk(createRepoSkillsStagingRoot(runnerTemp))
    })

    it('copies admitted skills into the run-scoped directory and names it in skills.paths', async () => {
      // #given a trusted source with one skill, and the bundled skills installed
      const bundled = populateBundledSkills()
      writeRepoSkill('repo-probe')
      const server = fakeServer()
      const deps = recordingDeps(server)
      const logger = createMockLogger()

      // #when starting with repo skills
      const result = await startActionOpenCodeV2(
        options({deps, logger, repoSkills: {sourceDir, stagingRoot, symlinkedSkillIds: []}}),
      )

      // #then the server is told to scan the copy, and the real permission gate passed with it as an exception
      expect(result.success).toBe(true)
      const copy = path.join(stagingRoot, 'skills')
      const content = spawnedContent(deps)
      expect(content.skills).toEqual({paths: [copy]})
      expect(fs.readFileSync(path.join(copy, 'repo-probe', 'references', 'r.md'), 'utf8')).toBe('ref\n')
      const rules = content.permissions as {action: string; resource: string; effect: string}[]
      expect(rules).toContainEqual({action: 'external_directory', resource: `${copy}/*`, effect: 'allow'})
      expect(rules).toContainEqual({action: 'edit', resource: `${copy}/*`, effect: 'deny'})
      expect(rules).toContainEqual({action: 'external_directory', resource: `${bundled}/*`, effect: 'allow'})
      // #and it is outside the checkout, under RUNNER_TEMP
      expect(copy.startsWith(fs.realpathSync(runnerTemp))).toBe(true)
      // #and one info line reports the count and skipped ids, with no file content
      const infoLines = vi.mocked(logger.info).mock.calls.filter(call => String(call[0]).includes('Repository skills'))
      expect(infoLines).toHaveLength(1)
      expect(infoLines[0]?.[1]).toEqual({admitted: 1, skipped: []})
      expect(serializeLoggerCalls(logger)).not.toContain('REPO-SKILL-BODY-CANARY')
    })

    it('hands the symlinked skill ids from staging to admission, so a link-holding skill is rejected', async () => {
      // #given a clean-looking copy of a skill that staging reported as holding a symlink, and a sibling
      populateBundledSkills()
      writeRepoSkill('tainted')
      writeRepoSkill('clean')
      const deps = recordingDeps(fakeServer())
      const logger = createMockLogger()

      // #when starting with that report
      const result = await startActionOpenCodeV2(
        options({deps, logger, repoSkills: {sourceDir, stagingRoot, symlinkedSkillIds: ['tainted']}}),
      )

      // #then only the sibling is copied, and the log names the rejected id
      expect(result.success).toBe(true)
      expect(fs.readdirSync(path.join(stagingRoot, 'skills'))).toEqual(['clean'])
      const infoLine = vi.mocked(logger.info).mock.calls.find(call => String(call[0]).includes('Repository skills'))
      expect(infoLine?.[1]).toEqual({admitted: 1, skipped: ['tainted']})
    })

    it('skips a colliding skill, loads the rest and reports the skipped id', async () => {
      // #given a repo skill with a bundled skill's id and a normal one
      populateBundledSkills()
      writeRepoSkill('ce-review', 'SHADOW-BODY-CANARY')
      writeRepoSkill('ok')
      const deps = recordingDeps(fakeServer())
      const logger = createMockLogger()

      // #when starting
      const result = await startActionOpenCodeV2(
        options({deps, logger, repoSkills: {sourceDir, stagingRoot, symlinkedSkillIds: []}}),
      )

      // #then the shadowing skill never reaches the copy
      expect(result.success).toBe(true)
      const copy = path.join(stagingRoot, 'skills')
      expect(fs.readdirSync(copy)).toEqual(['ok'])
      const infoLine = vi.mocked(logger.info).mock.calls.find(call => String(call[0]).includes('Repository skills'))
      expect(infoLine?.[1]).toEqual({admitted: 1, skipped: ['ce-review']})
      expect(serializeLoggerCalls(logger)).not.toContain('SHADOW-BODY-CANARY')
    })

    it('adds no skills path and no exception when nothing is admitted', async () => {
      // #given a source whose only skill is refused
      populateBundledSkills()
      writeRepoSkill('ce-review')
      const deps = recordingDeps(fakeServer())

      // #when starting
      const result = await startActionOpenCodeV2(
        options({deps, repoSkills: {sourceDir, stagingRoot, symlinkedSkillIds: []}}),
      )

      // #then the config is the one a run without repo skills gets
      expect(result.success).toBe(true)
      const content = spawnedContent(deps)
      expect('skills' in content).toBe(false)
      expect(JSON.stringify(content.permissions)).not.toContain(stagingRoot)
      expect(fs.existsSync(path.join(stagingRoot, 'skills'))).toBe(false)
    })

    it('loads no repo skills, and still starts, when the bundled skills directory cannot be found', async () => {
      // #given no installed Systematic skills (collisions cannot be ruled out)
      writeRepoSkill('repo-probe')
      const deps = recordingDeps(fakeServer())
      const logger = createMockLogger()

      // #when starting
      const result = await startActionOpenCodeV2(
        options({deps, logger, repoSkills: {sourceDir, stagingRoot, symlinkedSkillIds: []}}),
      )

      // #then the run starts without them and says why
      expect(result.success).toBe(true)
      expect('skills' in spawnedContent(deps)).toBe(false)
      expect(
        vi
          .mocked(logger.warning)
          .mock.calls.map(call => String(call[0]))
          .join('\n'),
      ).toContain('Repository skills are not loaded')
    })

    it('starts with no repo skills, warns without a path and discards the partial staging when admission throws', async () => {
      // #given an admission that leaves a partial copy and then throws an error whose message holds a path
      populateBundledSkills()
      const admitRepoSkills = vi.fn(async () => {
        fs.mkdirSync(path.join(stagingRoot, 'skills', 'half'), {recursive: true})
        fs.mkdirSync(path.join(stagingRoot, 'source-tree', '.agents'), {recursive: true})
        throw Object.assign(new Error('EIO reading /secret/checkout/path'), {code: 'EIO'})
      })
      const deps = recordingDeps(fakeServer(), {admitRepoSkills})
      const logger = createMockLogger()

      // #when starting
      const result = await startActionOpenCodeV2(
        options({deps, logger, repoSkills: {sourceDir, stagingRoot, symlinkedSkillIds: []}}),
      )

      // #then the run starts as one without the input, and the partial staging is gone
      expect(result.success).toBe(true)
      expect(admitRepoSkills).toHaveBeenCalledTimes(1)
      expect('skills' in spawnedContent(deps)).toBe(false)
      expect(JSON.stringify(spawnedContent(deps).permissions)).not.toContain(stagingRoot)
      expect(fs.readdirSync(stagingRoot)).toEqual([])
      // #and the warning names the code, not the path
      const logged = serializeLoggerCalls(logger)
      expect(logged).toContain('admission failed unexpectedly')
      expect(logged).toContain('EIO')
      expect(logged).not.toContain('/secret/checkout/path')
    })

    it('emits nothing skill-related when repoSkills is not given', async () => {
      // #given bundled skills and a populated checkout, but a run that is not trusted or opted in
      populateBundledSkills()
      writeRepoSkill('repo-probe')
      const deps = recordingDeps(fakeServer())

      // #when starting without repoSkills
      const result = await startActionOpenCodeV2(options({deps}))

      // #then the checkout's skills are neither copied nor named
      expect(result.success).toBe(true)
      const content = spawnedContent(deps)
      expect('skills' in content).toBe(false)
      expect(fs.existsSync(path.join(stagingRoot, 'skills'))).toBe(false)
    })
  })
})

describe('startActionOpenCodeV2 with isolate-agent', () => {
  let root: string
  let runnerTemp: string
  let dbPath: string
  let authPath: string
  let cacheHome: string
  let order: string[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-server-sandbox-test-'))
    runnerTemp = path.join(root, 'runner-temp')
    fs.mkdirSync(runnerTemp)
    cacheHome = path.join(root, 'cache')
    populatePluginCache(cacheHome)
    const dataDir = path.join(root, 'data', 'opencode')
    fs.mkdirSync(dataDir, {recursive: true})
    dbPath = path.join(dataDir, 'opencode.db')
    authPath = path.join(dataDir, 'auth.json')
    order = []
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  const LAUNCH = {
    sudoPath: '/usr/bin/sudo',
    setprivPath: '/usr/bin/setpriv',
    envPath: '/usr/bin/env',
    account: {name: 'fro-bot-sandbox', uid: 998, gid: 997, home: '/home/fro-bot-sandbox'},
    path: '/usr/bin',
    tmpdir: '/home/fro-bot-sandbox/tmp',
    xdg: {data: '/d', config: '/c', cache: '/k', state: '/s'},
  } as const

  interface LaunchLog {
    readonly reports: {readonly value: unknown; readonly unconfirmed: boolean}[]
    readonly signals: AbortSignal[]
    readonly proxyReports: {readonly proxy: unknown; readonly unconfirmed: boolean}[]
  }

  const PROXY_PLACEHOLDER = 'placeholder-fake-0123456789abcdefghijklmnopqrstuv'

  function fakeKeyProxy() {
    const died = new AbortController()
    const stop = vi.fn(async () => ({outcome: 'stopped' as const, crashed: false}))
    const proxy: KeyProxyProcess = {
      pid: 7,
      port: 43_111,
      placeholder: PROXY_PLACEHOLDER,
      baseUrl: providerId => `http://127.0.0.1:43111/${providerId}`,
      died: died.signal,
      crashed: () => false,
      stop,
    }
    return {proxy, died, stop}
  }

  function fakeSandbox(
    prepare?: SandboxLifecycle['prepare'],
    refuseLaunch?: string,
    refuseProxy?: string,
  ): {
    readonly sandbox: SandboxLifecycle
    readonly prepare: ReturnType<typeof vi.fn>
    readonly release: ReturnType<typeof vi.fn>
    readonly launch: ReturnType<typeof vi.fn>
    readonly startKeyProxy: ReturnType<typeof vi.fn>
    readonly log: LaunchLog
    readonly abort: () => void
  } {
    const prepareMock = vi.fn(
      prepare ??
        (async () => {
          order.push('prepare')
          return ok(LAUNCH)
        }),
    )
    const release = vi.fn(async () => {
      order.push('release')
      return {stop: 'stopped' as const, restore: 'restored' as const}
    })
    const controller = new AbortController()
    const log: LaunchLog = {reports: [], signals: [], proxyReports: []}
    const startKeyProxy = vi.fn(async (start: Parameters<SandboxLifecycle['startKeyProxy']>[0]) => {
      if (refuseProxy !== undefined) return err(refuseProxy)
      order.push('proxy-start')
      const report = await start({signal: controller.signal})
      log.proxyReports.push(report)
      return ok(report.proxy)
    })
    const launch = vi.fn(async (spawn: Parameters<SandboxLifecycle['launch']>[0]) => {
      if (refuseLaunch !== undefined) return err(refuseLaunch)
      log.signals.push(controller.signal)
      const report = await spawn({spec: LAUNCH, signal: controller.signal, noteSpawn: () => undefined})
      log.reports.push(report)
      return ok(report.value)
    })
    return {
      sandbox: {prepare: prepareMock, release, launch, startKeyProxy} as unknown as SandboxLifecycle,
      prepare: prepareMock,
      release,
      launch,
      startKeyProxy,
      log,
      abort: () => controller.abort(),
    }
  }

  async function run(
    sandbox: SandboxLifecycle | null,
    deps: Partial<StartActionOpenCodeV2Deps>,
    env: NodeJS.ProcessEnv = {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
  ) {
    return startActionOpenCodeV2({
      binaryPath: '/opt/opencode',
      workspacePath: '/workspace',
      authJson: JSON.stringify({anthropic: {type: 'api', key: CANARY}}),
      opencodeConfig: null,
      credential: 'provision',
      systematicVersion: 'latest',
      model: 'anthropic/claude-sonnet',
      dbPath,
      authPath,
      env,
      runId: 42,
      runAttempt: 1,
      logger: createMockLogger(),
      sandbox,
      deps,
    })
  }

  let keyProxy: ReturnType<typeof fakeKeyProxy>

  function depsFor(server: FakeServer, overrides: Partial<StartActionOpenCodeV2Deps> = {}) {
    keyProxy = fakeKeyProxy()
    return {
      startKeyProxy: vi.fn<StartActionOpenCodeV2Deps['startKeyProxy']>(async () => ok(keyProxy.proxy)),
      probeKeyProxy: vi.fn<StartActionOpenCodeV2Deps['probeKeyProxy']>(async () => ({status: 'passed'})),
      startServer: vi.fn<StartServer>(async spawnOptions => {
        order.push('spawn')
        server.loadConfig(spawnOptions.config)
        return {success: true, data: server.handle}
      }),
      clearClaims: vi.fn<typeof clearHeldClaims>(async () => {
        order.push('clear-claims')
        return ok({status: 'no-database'})
      }),
      waitForImport: vi.fn(async () => ({success: true, data: undefined}) as const),
      readDatabaseFacts: () => ({bytes: null, sessions: null}),
      installPlugins: vi.fn<InstallPlugins>(async () => ok(undefined)),
      ...overrides,
    } satisfies Partial<StartActionOpenCodeV2Deps>
  }

  it('prepares the sandbox after the claim clear and before the spawn, and launches through it', async () => {
    // #given an isolated run
    const server = fakeServer()
    const deps = depsFor(server)
    const sandbox = fakeSandbox()

    // #when started
    const result = await run(sandbox.sandbox, deps)

    // #then the proxy starts first, the runner's last database write precedes the handoff, and the handoff precedes the spawn
    expect(result.success).toBe(true)
    expect(order).toEqual(['proxy-start', 'clear-claims', 'prepare', 'spawn'])
    const prepared = sandbox.prepare.mock.calls[0]?.[0] as {keyFilePaths: string[]; ghConfigDir: null; repoSkills: null}
    expect(prepared.keyFilePaths).toEqual([])
    expect(vi.mocked(deps.startServer).mock.calls[0]?.[0].sandbox).toEqual(LAUNCH)
    expect(sandbox.release).not.toHaveBeenCalled()
  })

  it('does not add a sandbox to the spawn when isolation is off', async () => {
    // #given no lifecycle
    const server = fakeServer()
    const deps = depsFor(server)

    // #when started
    await run(null, deps)

    // #then the spawn options are exactly the unisolated ones
    expect('sandbox' in (vi.mocked(deps.startServer).mock.calls[0]?.[0] ?? {})).toBe(false)
  })

  it('hands over only the provisioned gh config dir and drops an ambient one from the child env', async () => {
    // #given a provisioned gh-config dir and, separately, an ambient GH_CONFIG_DIR elsewhere
    const provisioned = path.join(runnerTemp, 'gh-config-abc123')
    const server = fakeServer()
    const deps = depsFor(server)
    const sandbox = fakeSandbox()

    // #when started with the provisioned one
    await run(sandbox.sandbox, deps, {
      RUNNER_TEMP: runnerTemp,
      PATH: '/usr/bin',
      XDG_CACHE_HOME: cacheHome,
      GH_CONFIG_DIR: provisioned,
    })

    // #then it is handed over and kept in the child env
    expect((sandbox.prepare.mock.calls[0]?.[0] as {ghConfigDir: string | null}).ghConfigDir).toBe(provisioned)
    expect(vi.mocked(deps.startServer).mock.calls[0]?.[0].env?.GH_CONFIG_DIR).toBe(provisioned)

    // #when started with an ambient one
    const ambientDeps = depsFor(fakeServer())
    const ambient = fakeSandbox()
    await run(ambient.sandbox, ambientDeps, {
      RUNNER_TEMP: runnerTemp,
      PATH: '/usr/bin',
      XDG_CACHE_HOME: cacheHome,
      GH_CONFIG_DIR: '/home/runner/.config/gh',
    })

    // #then it is neither handed over nor passed on
    expect((ambient.prepare.mock.calls[0]?.[0] as {ghConfigDir: string | null}).ghConfigDir).toBeNull()
    expect(vi.mocked(ambientDeps.startServer).mock.calls[0]?.[0].env?.GH_CONFIG_DIR).toBeUndefined()
  })

  it('fails at the sandbox stage without spawning when setup fails', async () => {
    // #given a handoff that fails
    const server = fakeServer()
    const deps = depsFor(server)
    const sandbox = fakeSandbox(async () => err('Sandbox handoff failed: checkout ACL failed'))

    // #when started
    const result = await run(sandbox.sandbox, deps)

    // #then no server was spawned and the stage names the cause
    const error = unwrapErr(result)
    expect(error.stage).toBe('sandbox')
    expect(error.message).toContain('checkout ACL failed')
    expect(deps.startServer).not.toHaveBeenCalled()
  })

  it('releases the sandbox when the spawn fails, so a failed start leaves no sandbox process', async () => {
    // #given a spawn that fails after the handoff
    const server = fakeServer()
    const deps = depsFor(server, {
      startServer: vi.fn<StartServer>(async () => ({
        success: false,
        error: {kind: 'exited-early', message: 'exited', cleanup: 'forced'},
      })),
    })
    const sandbox = fakeSandbox()

    // #when started
    const result = await run(sandbox.sandbox, deps)

    // #then it fails and the sandbox was stopped and restored
    expect(result.success).toBe(false)
    expect(sandbox.release).toHaveBeenCalledTimes(1)
  })

  it('shuts the server down, then releases the sandbox, when a gate fails after the spawn', async () => {
    // #given an import wait that fails after a healthy spawn
    const server = fakeServer()
    const deps = depsFor(server, {
      waitForImport: vi.fn(async () => ({success: false, error: {message: 'import stuck'}}) as never),
    })
    const sandbox = fakeSandbox()

    // #when started
    const result = await run(sandbox.sandbox, deps)

    // #then the order is shutdown, then release
    expect(result.success).toBe(false)
    expect(server.shutdown).toHaveBeenCalledTimes(1)
    expect(server.shutdown.mock.invocationCallOrder[0]).toBeLessThan(sandbox.release.mock.invocationCallOrder[0] ?? 0)
  })

  it('stops the server and releases the sandbox, then rethrows, when a post-spawn gate throws', async () => {
    // #given a healthy spawn and an import wait that throws instead of returning a failure
    const server = fakeServer()
    const deps = depsFor(server, {waitForImport: vi.fn(async () => Promise.reject(new Error('gate blew up')))})
    const sandbox = fakeSandbox()

    // #when / #then it surfaces the error, but only after the server is down and the sandbox is taken back
    await expect(run(sandbox.sandbox, deps)).rejects.toThrow('gate blew up')
    expect(server.shutdown).toHaveBeenCalledTimes(1)
    expect(sandbox.release).toHaveBeenCalledTimes(1)
    expect(server.shutdown.mock.invocationCallOrder[0]).toBeLessThan(sandbox.release.mock.invocationCallOrder[0] ?? 0)
  })

  it('stops the server when a post-spawn gate throws and isolation is off', async () => {
    // #given the same throw without a sandbox
    const server = fakeServer()
    const deps = depsFor(server, {waitForImport: vi.fn(async () => Promise.reject(new Error('gate blew up')))})

    // #when / #then the handle is never left running
    await expect(run(null, deps)).rejects.toThrow('gate blew up')
    expect(server.shutdown).toHaveBeenCalledTimes(1)
  })

  it('stops the server and releases the sandbox when the permission gate itself throws', async () => {
    // #given an agent listing that throws
    const server = fakeServer()
    server.fetch.mockImplementation(async () => Promise.reject(new Error('socket hang up')))
    const deps = depsFor(server)
    const sandbox = fakeSandbox()

    // #when
    const outcome = await run(sandbox.sandbox, deps).then(
      value => ({thrown: false as const, value}),
      () => ({thrown: true as const}),
    )

    // #then whether the gate converts the error into a failure or lets it throw, nothing is left running
    expect(outcome.thrown || !outcome.value.success).toBe(true)
    expect(server.shutdown).toHaveBeenCalledTimes(1)
    expect(sandbox.release).toHaveBeenCalledTimes(1)
  })

  it('releases the sandbox and rethrows when the spawn throws', async () => {
    // #given a spawn that throws
    const server = fakeServer()
    const deps = depsFor(server, {startServer: vi.fn<StartServer>(async () => Promise.reject(new Error('boom')))})
    const sandbox = fakeSandbox()

    // #when / #then
    await expect(run(sandbox.sandbox, deps)).rejects.toThrow('boom')
    expect(sandbox.release).toHaveBeenCalledTimes(1)
  })

  describe('the key proxy', () => {
    const OPENAI_CANARY = 'sk-oai-CANARY-v2-server-5678'

    it('configures each provider with the loopback URL and the placeholder, writes no key file and hands none over', async () => {
      // #given two keys and an operator config that sets a real upstream and a timeout
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()
      const logger = createMockLogger()

      // #when an isolated run starts
      const result = await startActionOpenCodeV2({
        binaryPath: '/opt/opencode',
        workspacePath: '/workspace',
        authJson: JSON.stringify({anthropic: {type: 'api', key: CANARY}, openai: {type: 'api', key: OPENAI_CANARY}}),
        opencodeConfig: JSON.stringify({
          provider: {anthropic: {options: {baseURL: 'https://gw.example/v1', timeout: 600_000}}},
        }),
        credential: 'provision',
        systematicVersion: 'latest',
        model: 'anthropic/claude-sonnet',
        dbPath,
        authPath,
        env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
        runId: 42,
        runAttempt: 1,
        logger,
        sandbox: sandbox.sandbox,
        deps,
      })

      // #then the server config points at the proxy with the placeholder and holds no key reference
      expect(result.success).toBe(true)
      const content = vi.mocked(deps.startServer).mock.calls[0]?.[0].config as Record<string, unknown>
      expect(content.provider).toEqual({
        anthropic: {
          options: {
            baseURL: 'http://127.0.0.1:43111/anthropic',
            timeout: 600_000,
            apiKey: PROXY_PLACEHOLDER,
          },
        },
        openai: {options: {baseURL: 'http://127.0.0.1:43111/openai', apiKey: PROXY_PLACEHOLDER}},
      })
      const serialized = JSON.stringify(content)
      expect(serialized).not.toContain('{file:')
      expect(serialized).not.toContain(CANARY)
      expect(serialized).not.toContain(OPENAI_CANARY)
      expect(serialized).not.toContain('gw.example')

      // #then no credential file or directory exists, and nothing is handed over
      expect(fs.readdirSync(runnerTemp).filter(name => name.startsWith('fro-bot-credentials-'))).toEqual([])
      expect((sandbox.prepare.mock.calls[0]?.[0] as {keyFilePaths: string[]}).keyFilePaths).toEqual([])

      // #then the real keys went only to the proxy starter, and no log line holds a key
      const starterOptions = vi.mocked(deps.startKeyProxy).mock.calls[0]?.[0]
      expect(starterOptions?.providers).toEqual([
        {providerId: 'anthropic', key: CANARY, baseUrl: 'https://gw.example/v1', protocols: ['anthropic-messages']},
        {
          providerId: 'openai',
          key: OPENAI_CANARY,
          baseUrl: null,
          protocols: ['openai-responses', 'openai-chat'],
        },
      ])
      expect(serializeLoggerCalls(logger)).not.toContain(CANARY)
      expect(serializeLoggerCalls(logger)).not.toContain(OPENAI_CANARY)
    })

    it('masks the placeholder in the Action log', async () => {
      const server = fakeServer()
      const deps = depsFor(server)
      const masked: string[] = []
      const sandbox = fakeSandbox()

      await startActionOpenCodeV2({
        binaryPath: '/opt/opencode',
        workspacePath: '/workspace',
        authJson: JSON.stringify({anthropic: {type: 'api', key: CANARY}}),
        opencodeConfig: null,
        credential: 'provision',
        systematicVersion: 'latest',
        model: 'anthropic/claude-sonnet',
        dbPath,
        authPath,
        env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
        runId: 42,
        runAttempt: 1,
        logger: createMockLogger(),
        sandbox: sandbox.sandbox,
        maskSecret: value => masked.push(value),
        deps,
      })

      expect(masked).toContain(PROXY_PLACEHOLDER)
    })

    it('fails at the key-proxy stage without spawning a server or preparing an account, and releases', async () => {
      // #given a proxy that cannot start
      const server = fakeServer()
      const deps = depsFor(server, {
        startKeyProxy: vi.fn<StartActionOpenCodeV2Deps['startKeyProxy']>(async () =>
          err({kind: 'ready-timeout', message: 'The key proxy did not become ready in time'}),
        ),
      })
      const sandbox = fakeSandbox()

      // #when
      const result = await run(sandbox.sandbox, deps)

      // #then the stage and the reason surface, no server or account exists, and the lifecycle was released
      const error = unwrapErr(result)
      expect(error.stage).toBe('key-proxy')
      expect(error.message).toContain('did not become ready')
      expect(deps.startServer).not.toHaveBeenCalled()
      expect(sandbox.prepare).not.toHaveBeenCalled()
      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('tells the lifecycle when a failed proxy start could not confirm its child is gone', async () => {
      const server = fakeServer()
      const deps = depsFor(server, {
        startKeyProxy: vi.fn<StartActionOpenCodeV2Deps['startKeyProxy']>(async () =>
          err({kind: 'ready-timeout', message: 'late', cleanup: 'unconfirmed'}),
        ),
      })
      const sandbox = fakeSandbox()

      await run(sandbox.sandbox, deps)

      expect(sandbox.log.proxyReports).toEqual([{proxy: null, unconfirmed: true}])
    })

    it('fails at the key-proxy stage when the lifecycle refuses the proxy, and releases', async () => {
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox(undefined, undefined, 'the teardown has begun')

      const result = await run(sandbox.sandbox, deps)

      expect(unwrapErr(result).stage).toBe('key-proxy')
      expect(deps.startKeyProxy).not.toHaveBeenCalled()
      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('releases, which stops the proxy, when the server launch fails after the proxy is up', async () => {
      // #given a spawn that fails
      const server = fakeServer()
      const deps = depsFor(server, {
        startServer: vi.fn<StartServer>(async () => ({
          success: false,
          error: {kind: 'exited-early', message: 'exited', cleanup: 'forced'},
        })),
      })
      const sandbox = fakeSandbox()

      // #when
      const result = await run(sandbox.sandbox, deps)

      // #then the lifecycle (which owns the proxy) was released
      expect(result.success).toBe(false)
      expect(sandbox.release).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['proxy-start', 'clear-claims', 'prepare', 'release'])
    })

    it('releases the lifecycle when the config builder rejects its inputs after the proxy is up', async () => {
      // #given a proxy that starts and a RUNNER_TEMP the config builder refuses
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()

      // #when
      const result = await run(sandbox.sandbox, deps, {
        RUNNER_TEMP: 'relative/runner-temp',
        PATH: '/usr/bin',
        XDG_CACHE_HOME: cacheHome,
      })

      // #then it failed at the config stage and the lifecycle (which owns the proxy) was released
      expect(unwrapErr(result).stage).toBe('config')
      expect(sandbox.release).toHaveBeenCalledTimes(1)
      expect(deps.startServer).not.toHaveBeenCalled()
    })

    it('releases the lifecycle when clearing held claims fails, after the proxy is up', async () => {
      const server = fakeServer()
      const deps = depsFor(server, {
        clearClaims: vi.fn<typeof clearHeldClaims>(async () => err(new Error('locked'))),
      })
      const sandbox = fakeSandbox()

      const result = await run(sandbox.sandbox, deps)

      expect(unwrapErr(result).stage).toBe('held-claims')
      expect(sandbox.release).toHaveBeenCalledTimes(1)
      expect(deps.startServer).not.toHaveBeenCalled()
    })

    it('releases the lifecycle and rethrows when something throws between the proxy start and the spawn', async () => {
      const server = fakeServer()
      const deps = depsFor(server, {
        clearClaims: vi.fn<typeof clearHeldClaims>(async () => Promise.reject(new Error('disk gone'))),
      })
      const sandbox = fakeSandbox()

      await expect(run(sandbox.sandbox, deps)).rejects.toThrow('disk gone')

      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('releases the lifecycle when the sandbox setup fails after the proxy is up', async () => {
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox(async () => err('Sandbox handoff failed: checkout ACL failed'))

      const result = await run(sandbox.sandbox, deps)

      expect(unwrapErr(result).stage).toBe('sandbox')
      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('aborts the server and the gates when the proxy dies', async () => {
      // #given a running isolated start
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()
      await run(sandbox.sandbox, deps)
      const spawnSignal = vi.mocked(deps.startServer).mock.calls[0]?.[0].signal
      expect(spawnSignal?.aborted).toBe(false)

      // #when the proxy exits on its own
      keyProxy.died.abort(new Error('exited'))

      // #then the server's lifetime signal is aborted
      expect(spawnSignal?.aborted).toBe(true)
    })

    it('refuses a config that would bypass the proxy before starting anything, naming the fix', async () => {
      // #given an operator provider that sets `endpoint`
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()

      // #when
      const result = await startActionOpenCodeV2({
        binaryPath: '/opt/opencode',
        workspacePath: '/workspace',
        authJson: JSON.stringify({anthropic: {type: 'api', key: CANARY}}),
        opencodeConfig: JSON.stringify({provider: {anthropic: {options: {endpoint: 'https://x.example'}}}}),
        credential: 'provision',
        systematicVersion: 'latest',
        model: 'anthropic/claude-sonnet',
        dbPath,
        authPath,
        env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
        runId: 42,
        runAttempt: 1,
        logger: createMockLogger(),
        sandbox: sandbox.sandbox,
        deps,
      })

      // #then nothing was started and the message names the provider and the fix
      const error = unwrapErr(result)
      expect(error.stage).toBe('config')
      expect(error.message).toContain('anthropic')
      expect(error.message).toContain('Fix:')
      expect(deps.startKeyProxy).not.toHaveBeenCalled()
      expect(sandbox.prepare).not.toHaveBeenCalled()
    })

    it('refuses a config that holds an auth-json key value before the hand-over, without printing it', async () => {
      // #given the real key written at the provider root of opencode-config, where the placeholder rewrite does not reach
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()

      // #when
      const result = await startActionOpenCodeV2({
        binaryPath: '/opt/opencode',
        workspacePath: '/workspace',
        authJson: JSON.stringify({anthropic: {type: 'api', key: CANARY}}),
        opencodeConfig: JSON.stringify({providers: {anthropic: {apiKey: CANARY}}}),
        credential: 'provision',
        systematicVersion: 'latest',
        model: 'anthropic/claude-sonnet',
        dbPath,
        authPath,
        env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
        runId: 42,
        runAttempt: 1,
        logger: createMockLogger(),
        sandbox: sandbox.sandbox,
        deps,
      })

      // #then the run stops at the config stage with a remedy, nothing was handed to the sandbox, and the lifecycle was released
      const error = unwrapErr(result)
      expect(error.stage).toBe('config')
      expect(error.message).toContain('anthropic')
      expect(error.message).toContain('Fix:')
      expect(error.message).not.toContain(CANARY)
      expect(sandbox.prepare).not.toHaveBeenCalled()
      expect(deps.startServer).not.toHaveBeenCalled()
      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('starts no proxy when there are no API keys', async () => {
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()

      const result = await startActionOpenCodeV2({
        binaryPath: '/opt/opencode',
        workspacePath: '/workspace',
        authJson: '{}',
        opencodeConfig: null,
        credential: 'provision',
        systematicVersion: 'latest',
        model: null,
        dbPath,
        authPath,
        env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
        runId: 42,
        runAttempt: 1,
        logger: createMockLogger(),
        sandbox: sandbox.sandbox,
        deps,
      })

      expect(result.success).toBe(true)
      expect(deps.startKeyProxy).not.toHaveBeenCalled()
      expect(sandbox.startKeyProxy).not.toHaveBeenCalled()
    })
  })

  describe('the start-up probe', () => {
    const TWO_KEYS = JSON.stringify({
      anthropic: {type: 'api', key: CANARY},
      openai: {type: 'api', key: `${CANARY}-oai`},
    })

    async function runWith(
      sandbox: SandboxLifecycle,
      deps: Partial<StartActionOpenCodeV2Deps>,
      overrides: {
        readonly model?: string | null
        readonly authJson?: string
        readonly logger?: ReturnType<typeof createMockLogger>
      } = {},
    ) {
      return startActionOpenCodeV2({
        binaryPath: '/opt/opencode',
        workspacePath: '/workspace',
        authJson: overrides.authJson ?? TWO_KEYS,
        opencodeConfig: null,
        credential: 'provision',
        systematicVersion: 'latest',
        model: overrides.model === undefined ? 'anthropic/claude-sonnet' : overrides.model,
        dbPath,
        authPath,
        env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
        runId: 42,
        runAttempt: 1,
        logger: overrides.logger ?? createMockLogger(),
        sandbox,
        deps,
      })
    }

    it('hands the probe the selected provider’s configured routing headers', async () => {
      // #given an operator-configured OpenAI organization on the selected provider
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()
      const logger = createMockLogger()

      // #when an isolated run starts
      const result = await startActionOpenCodeV2({
        binaryPath: '/opt/opencode',
        workspacePath: '/workspace',
        authJson: JSON.stringify({openai: {type: 'api', key: CANARY}}),
        opencodeConfig: JSON.stringify({provider: {openai: {options: {headers: {'OpenAI-Organization': 'org-team'}}}}}),
        credential: 'provision',
        systematicVersion: 'latest',
        model: 'openai/gpt-x',
        dbPath,
        authPath,
        env: {RUNNER_TEMP: runnerTemp, PATH: '/usr/bin', XDG_CACHE_HOME: cacheHome},
        runId: 42,
        runAttempt: 1,
        logger,
        sandbox: sandbox.sandbox,
        deps,
      })

      // #then the probe's plan carries it
      expect(result.success).toBe(true)
      expect(vi.mocked(deps.probeKeyProxy).mock.calls[0]?.[0].plan.routingHeaders).toEqual({
        'openai-organization': 'org-team',
      })
    })

    it('probes only the provider of the selected model, through the owned proxy', async () => {
      // #given two configured providers and a model on the first
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()

      // #when an isolated run starts
      const result = await runWith(sandbox.sandbox, deps)

      // #then one probe ran, for anthropic only, with the proxy's placeholder and the run's signal
      expect(result.success).toBe(true)
      expect(deps.probeKeyProxy).toHaveBeenCalledTimes(1)
      const probeOptions = vi.mocked(deps.probeKeyProxy).mock.calls[0]?.[0]
      expect(probeOptions?.plan.providerId).toBe('anthropic')
      expect(probeOptions?.proxy.placeholder).toBe(PROXY_PLACEHOLDER)
      expect(probeOptions?.proxy.baseUrl('anthropic')).toBe('http://127.0.0.1:43111/anthropic')
    })

    it('probes the other provider when the model is on it', async () => {
      const server = fakeServer()
      const deps = depsFor(server)

      await runWith(fakeSandbox().sandbox, deps, {model: 'openai/gpt-5'})

      expect(vi.mocked(deps.probeKeyProxy).mock.calls.map(call => call[0].plan.providerId)).toEqual(['openai'])
    })

    it('runs the probe after the permission gate and before the import wait', async () => {
      // #given the order of the gates
      const server = fakeServer()
      const callOrder: string[] = []
      const original = server.fetch.getMockImplementation()
      server.fetch.mockImplementation(async pathname => {
        if (pathname === '/api/agent') callOrder.push('permission-gate')
        return (await original?.(pathname)) ?? new Response('{}', {status: 404})
      })
      const deps = depsFor(server, {
        probeKeyProxy: vi.fn<StartActionOpenCodeV2Deps['probeKeyProxy']>(async () => {
          callOrder.push('probe')
          return {status: 'passed'}
        }),
        waitForImport: vi.fn(async () => {
          callOrder.push('import-wait')
          return {success: true, data: undefined} as const
        }),
      })

      // #when
      await runWith(fakeSandbox().sandbox, deps)

      // #then
      expect(callOrder.indexOf('permission-gate')).toBeLessThan(callOrder.indexOf('probe'))
      expect(callOrder.indexOf('probe')).toBeLessThan(callOrder.indexOf('import-wait'))
    })

    it('fails at the key-proxy stage on auth-rejected, stops the server first, and releases', async () => {
      // #given an upstream that rejects the key
      const server = fakeServer()
      const deps = depsFor(server, {
        probeKeyProxy: vi.fn<StartActionOpenCodeV2Deps['probeKeyProxy']>(
          async () =>
            ({
              status: 'failed',
              class: 'auth-rejected',
              message: 'Provider "anthropic" rejected its key at start-up (auth-rejected, HTTP 401).',
            }) satisfies KeyProxyProbeResult,
        ),
      })
      const sandbox = fakeSandbox()

      // #when
      const result = await runWith(sandbox.sandbox, deps)

      // #then it failed before the model could start: server stopped, then the sandbox released, and no import wait
      const error = unwrapErr(result)
      expect(error.stage).toBe('key-proxy')
      expect(error.message).toContain('auth-rejected')
      expect(error.message).toContain('anthropic')
      expect(server.shutdown).toHaveBeenCalledTimes(1)
      expect(sandbox.release).toHaveBeenCalledTimes(1)
      expect(server.shutdown.mock.invocationCallOrder[0]).toBeLessThan(sandbox.release.mock.invocationCallOrder[0] ?? 0)
      expect(deps.waitForImport).not.toHaveBeenCalled()
    })

    it.each(['forbidden', 'rate-limited', 'unreachable', 'unverifiable'] as const)(
      'continues the run on a %s warning',
      async warningClass => {
        const server = fakeServer()
        const deps = depsFor(server, {
          probeKeyProxy: vi.fn<StartActionOpenCodeV2Deps['probeKeyProxy']>(async () => ({
            status: 'warned',
            class: warningClass,
          })),
        })

        const result = await runWith(fakeSandbox().sandbox, deps)

        expect(result.success).toBe(true)
        expect(server.shutdown).not.toHaveBeenCalled()
        expect(deps.waitForImport).toHaveBeenCalledTimes(1)
      },
    )

    it('fails at the key-proxy stage when the run is aborted during the probe', async () => {
      const server = fakeServer()
      const deps = depsFor(server, {
        probeKeyProxy: vi.fn<StartActionOpenCodeV2Deps['probeKeyProxy']>(async () => ({
          status: 'aborted',
          message: 'Key proxy probe for provider "anthropic" was aborted with the run',
        })),
      })
      const sandbox = fakeSandbox()

      const result = await runWith(sandbox.sandbox, deps)

      expect(unwrapErr(result).stage).toBe('key-proxy')
      expect(server.shutdown).toHaveBeenCalledTimes(1)
      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('stops the server and releases when the probe throws', async () => {
      const server = fakeServer()
      const deps = depsFor(server, {
        probeKeyProxy: vi.fn<StartActionOpenCodeV2Deps['probeKeyProxy']>(async () =>
          Promise.reject(new Error('probe blew up')),
        ),
      })
      const sandbox = fakeSandbox()

      await expect(runWith(sandbox.sandbox, deps)).rejects.toThrow('probe blew up')

      expect(server.shutdown).toHaveBeenCalledTimes(1)
      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('skips the probe, with an info line, when no model is selected', async () => {
      const server = fakeServer()
      const deps = depsFor(server)
      const logger = createMockLogger()

      const result = await runWith(fakeSandbox().sandbox, deps, {model: null, logger})

      expect(result.success).toBe(true)
      expect(deps.probeKeyProxy).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('probe skipped'), expect.anything())
    })

    it('skips the probe when the selected model is on a provider the proxy does not serve', async () => {
      const server = fakeServer()
      const deps = depsFor(server)

      await runWith(fakeSandbox().sandbox, deps, {model: 'groq/llama'})

      // (the credential gate decides whether that provider is usable)
      expect(deps.probeKeyProxy).not.toHaveBeenCalled()
    })

    it('makes no probe when there are no API keys', async () => {
      const server = fakeServer()
      const deps = depsFor(server)

      await runWith(fakeSandbox().sandbox, deps, {authJson: '{}', model: null})

      expect(deps.probeKeyProxy).not.toHaveBeenCalled()
    })
  })

  describe('the sandbox launch', () => {
    it('spawns through the lifecycle, handing the server the launch spec and the lifecycle abort signal', async () => {
      // #given a prepared sandbox
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox()

      // #when the start runs
      const result = await run(sandbox.sandbox, deps)

      // #then the spawn happened inside launch, with the spec, and its signal reaches the server start
      expect(result.success).toBe(true)
      expect(sandbox.launch).toHaveBeenCalledTimes(1)
      const startOptions = vi.mocked(deps.startServer).mock.calls[0]?.[0]
      expect(startOptions?.sandbox).toBe(LAUNCH)
      expect(startOptions?.signal?.aborted).toBe(false)
      sandbox.abort()
      expect(startOptions?.signal?.aborted).toBe(true)
      expect(sandbox.log.reports.map(report => report.unconfirmed)).toEqual([false])
    })

    it('never spawns when the lifecycle refuses the launch (the teardown has begun), and releases', async () => {
      // #given a lifecycle that has closed admission
      const server = fakeServer()
      const deps = depsFor(server)
      const sandbox = fakeSandbox(undefined, 'the teardown has begun')

      // #when
      const result = await run(sandbox.sandbox, deps)

      // #then the start fails at the sandbox stage and no server was started
      expect(result.success).toBe(false)
      expect(!result.success && result.error.stage).toBe('sandbox')
      expect(deps.startServer).not.toHaveBeenCalled()
      expect(sandbox.release).toHaveBeenCalledTimes(1)
    })

    it('aborts a start that is in flight when the lifecycle aborts, and fails the start', async () => {
      // #given a server start that waits for its abort signal
      const server = fakeServer()
      const sandbox = fakeSandbox()
      const deps = depsFor(server, {
        startServer: vi.fn<StartServer>(async spawnOptions => {
          await new Promise<void>(resolve => spawnOptions.signal?.addEventListener('abort', () => resolve()))
          return {success: false, error: {kind: 'aborted', message: 'cancelled', cleanup: 'graceful'}}
        }),
      })

      // #when the start is running and the lifecycle aborts (the signal's teardown)
      const starting = run(sandbox.sandbox, deps)
      await vi.waitFor(() => {
        expect(deps.startServer).toHaveBeenCalled()
      })
      sandbox.abort()
      const result = await starting

      // #then
      expect(result.success).toBe(false)
      expect(sandbox.release).toHaveBeenCalled()
    })

    it.each([
      ['unconfirmed', true],
      ['graceful', false],
      ['forced', false],
    ] as const)('reports a failed start whose own cleanup was %s as unconfirmed=%s', async (cleanup, unconfirmed) => {
      // #given a start that fails with that cleanup outcome
      const server = fakeServer()
      const sandbox = fakeSandbox()
      const deps = depsFor(server, {
        startServer: vi.fn<StartServer>(async () => ({
          success: false,
          error: {kind: 'spawn-failed', message: 'nope', cleanup},
        })),
      })

      // #when
      await run(sandbox.sandbox, deps)

      // #then the lifecycle was told, so its release cannot report a clean stop
      expect(sandbox.log.reports.map(report => report.unconfirmed)).toEqual([unconfirmed])
    })
  })
})
