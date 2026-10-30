/**
 * The V2 supervised runner against the real stock OpenCode V2 binary. Skipped unless `FRO_BOT_OPENCODE_V2_BIN` names an
 * executable. The binary must be the pinned stock release, verified against `packages/runtime/src/shared/
 * opencode-v2-pin.json` before use (this test checks the version it reports; the digest check belongs to the download):
 *
 *   curl -fsSL -o oc.zip https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-darwin-arm64.zip
 *   shasum -a 256 oc.zip   # must equal assets["opencode-darwin-arm64.zip"] in opencode-v2-pin.json
 *   unzip oc.zip && FRO_BOT_OPENCODE_V2_BIN=$PWD/opencode bun run test apps/workspace-agent/src/opencode-server-v2.integration
 *
 * It needs the npm registry once: the two plugins are installed into a temporary home by the same script the image
 * build runs (`deploy/scripts/install-opencode-v2-plugins.sh`, about a minute each), and every server this test starts
 * is then given a registry that refuses connections, so a plugin that loads was found in the cache and installed
 * nothing at boot.
 *
 * What it proves that the fake-server tests cannot: with the plugins installed that way, the real runner passes both
 * the plugin gate and the permission gate; the proxy turns the gateway bearer into the live credential; a new spawn
 * starts on an empty database; and a shutdown with a turn in flight leaves no execution claim in the database.
 *
 * It also pins fro-bot/agent#1992. The provider credential reaches the model request only through the production path:
 * a root-only auth blob read by the supervisor and provisioned over `POST /api/credential`, with the config overlay
 * carrying a `baseURL` and no key. A fresh database never imports `auth.json`, so without provisioning the fake
 * Anthropic-compatible provider sees no `x-api-key`, and with no credential at all readiness never turns ready.
 */

import type {AddressInfo} from 'node:net'
import type {OpenCodeV2StartError, StartOpenCodeV2ServerOptions} from '@fro-bot/runtime/workspace-v2'
import type {Logger, SupervisedStatusRef} from './opencode-server.js'

import {execFileSync, spawnSync} from 'node:child_process'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'

import {
  DEFAULT_SYSTEMATIC_VERSION,
  FRO_BOT_PLUGIN_ID,
  FRO_BOT_PLUGIN_VERSION,
  startOpenCodeV2Server,
  SYSTEMATIC_V2_PLUGIN_ID,
} from '@fro-bot/runtime/workspace-v2'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'

import {createInstanceDisposerV2} from './opencode-instance-v2.js'
import {createOpencodeProxyV2} from './opencode-proxy-v2.js'
import {
  createUpstreamCredentials,
  prepareFreshDatabase,
  readEffectiveModelFromConfig,
  runSupervisedOpencodeV2,
  WORKSPACE_V2_PLUGIN_SPECS,
} from './opencode-server-v2.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const hasBinary = BINARY !== undefined && BINARY !== '' && existsSync(BINARY)
const PIN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../packages/runtime/src/shared/opencode-v2-pin.json', import.meta.url)),
    'utf8',
  ),
) as {version: string}
const INSTALL_SCRIPT = fileURLToPath(new URL('../../../deploy/scripts/install-opencode-v2-plugins.sh', import.meta.url))

const GATEWAY_BEARER = 'integration-gateway-bearer'
/** The provider key. It reaches the fake provider only through the supervisor's credential provisioning. */
const PROVIDER_KEY = 'sk-integration-FIXTURE-KEY-not-a-credential'
const MODEL = 'anthropic/claude-sonnet-4-6'
const RUNNER_TIMEOUT_MS = 180_000

const lines: string[] = []
const logger: Logger = {
  info: message => lines.push(`info ${message}`),
  warn: message => lines.push(`warn ${message}`),
  error: message => lines.push(`error ${message}`),
}

interface Sandbox {
  readonly root: string
  readonly home: string
  readonly reposRoot: string
  readonly repo: string
  readonly dbBase: string
  /** The root-only credential blob the supervisor reads (`WORKSPACE_OPENCODE_AUTH_FILE`). */
  readonly authFile: string
}

let box: Sandbox
let provider: FakeProvider | undefined

interface ProviderHit {
  readonly headers: http.IncomingHttpHeaders
  readonly authorized: boolean
}

interface FakeProvider {
  readonly baseURL: string
  /** Every model request, with the headers it carried. */
  readonly hits: () => readonly ProviderHit[]
  /** Model requests that carried the expected `x-api-key`. */
  readonly authorizedRequests: () => number
  /** When true, an authorized request gets its first frame and is then held open (a turn in flight). */
  readonly setHold: (hold: boolean) => void
  readonly stop: () => Promise<void>
}

/**
 * An Anthropic-compatible endpoint that records request headers. It answers 401 unless `x-api-key` equals the key, so a
 * request that carries no credential, or the wrong header shape, fails the turn instead of passing.
 */
async function startFakeProvider(expectedKey: string): Promise<FakeProvider> {
  const hits: ProviderHit[] = []
  let hold = false
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const authorized = req.headers['x-api-key'] === expectedKey
    hits.push({headers: req.headers, authorized})
    if (!authorized) {
      res.writeHead(401, {'content-type': 'application/json'})
      res.end(JSON.stringify({type: 'error', error: {type: 'authentication_error', message: 'invalid x-api-key'}}))
      return
    }
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
    const frame = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        usage: {input_tokens: 1, output_tokens: 1},
      },
    })
    if (hold) return
    frame('content_block_start', {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}})
    frame('content_block_delta', {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'pong'}})
    frame('content_block_stop', {type: 'content_block_stop', index: 0})
    frame('message_delta', {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 1}})
    frame('message_stop', {type: 'message_stop'})
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    hits: () => hits,
    authorizedRequests: () => hits.filter(hit => hit.authorized).length,
    setHold: next => {
      hold = next
    },
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workspace-v2-it-'))
  const home = path.join(root, 'home')
  // The layout the image has (identity.ts), which the install script also uses.
  for (const dir of ['.config/opencode', '.local/share', '.cache/tmp', '.local/state']) {
    mkdirSync(path.join(home, dir), {recursive: true})
  }
  const reposRoot = path.join(root, 'repos')
  const repo = path.join(reposRoot, 'acme', 'widget')
  mkdirSync(repo, {recursive: true})
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
      },
    })
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  const authFile = path.join(root, 'workspace_opencode_auth')
  writeFileSync(authFile, JSON.stringify({anthropic: {type: 'api', key: PROVIDER_KEY}}), {mode: 0o600})
  return {root, home, reposRoot, repo, dbBase: path.join(root, 'db'), authFile}
}

/** Installs both plugins exactly as the image build does, into the sandbox home. */
function installPlugins(sandbox: Sandbox): void {
  const bin = path.join(sandbox.root, 'bin')
  mkdirSync(bin)
  // The image has busybox `timeout`; this machine may not. The bound itself is pinned by the script's own tests.
  writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n')
  chmodSync(path.join(bin, 'timeout'), 0o755)
  const result = spawnSync('/bin/sh', [INSTALL_SCRIPT, ...WORKSPACE_V2_PLUGIN_SPECS], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_PATH: `${bin}:${process.env.PATH}`,
      OPENCODE_BIN: BINARY as string,
      AGENT_HOME: sandbox.home,
      DROP_PRIVILEGES: '',
    },
    timeout: 280_000,
  })
  if (result.status !== 0) throw new Error(`plugin install failed:\n${result.stderr}`)
  // The entrypoint's merged global config, as production writes it: the provider overlay carries a baseURL and NO key
  // (the key lives in the root-only blob the supervisor provisions), plus the model. No plugin entry (the config content
  // carries those).
  writeFileSync(
    path.join(sandbox.home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      provider: {anthropic: {options: {baseURL: provider?.baseURL}}},
      model: MODEL,
    }),
  )
}

/** The sandbox environment for a server: home and XDG in the sandbox, and a registry that refuses connections. */
function sandboxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const refused = 'http://127.0.0.1:9'
  return {
    ...base,
    HOME: box.home,
    XDG_CONFIG_HOME: path.join(box.home, '.config'),
    XDG_DATA_HOME: path.join(box.home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(box.home, '.cache'),
    XDG_STATE_HOME: path.join(box.home, '.local', 'state'),
    TMPDIR: path.join(box.home, '.cache', 'tmp'),
    HTTPS_PROXY: refused,
    HTTP_PROXY: refused,
    // The fake provider is on loopback; everything else (the registry included) is refused.
    NO_PROXY: '127.0.0.1,localhost',
    npm_config_registry: `${refused}/`,
  }
}

interface RunningWorkspace {
  readonly statusRef: SupervisedStatusRef
  /** Every status the supervisor wrote, in order. */
  readonly statuses: readonly SupervisedStatusRef['status'][]
  readonly credentials: ReturnType<typeof createUpstreamCredentials>
  readonly proxyUrl: string
  readonly upstreamUrl: string
  readonly databasePaths: string[]
  readonly startErrors: OpenCodeV2StartError[]
  readonly stop: () => Promise<void>
}

interface StartWorkspaceOptions {
  /** Provision the blob like production does. False leaves the model configured and no credential anywhere. */
  readonly withCredential?: boolean
  /** The outcome the caller expects: `ready` (default) or a supervisor that gave up without ever being ready. */
  readonly expect?: 'ready' | 'refused'
}

/** Runs the real supervisor and the real V2 proxy on loopback ports, against the real binary. */
async function startWorkspace(options: StartWorkspaceOptions = {}): Promise<RunningWorkspace> {
  const {withCredential = true, expect: outcome = 'ready'} = options
  // Records every transition, so a test can prove readiness was never reported, not merely absent at the end.
  const seen: SupervisedStatusRef['status'][] = []
  let current: SupervisedStatusRef['status'] = 'starting'
  const statusRef: SupervisedStatusRef = {
    get status() {
      return current
    },
    set status(value) {
      current = value
      seen.push(value)
    },
  }
  const credentials = createUpstreamCredentials()
  const controller = new AbortController()
  const databasePaths: string[] = []
  const startErrors: OpenCodeV2StartError[] = []
  const port = await freePort()

  const run = runSupervisedOpencodeV2({
    rootDir: box.reposRoot,
    logger,
    statusRef,
    credentials,
    signal: controller.signal,
    binaryPath: BINARY,
    port,
    readyTimeoutMs: 90_000,
    maxAttempts: 1,
    // What the service gets from compose: the model, and the path of the root-only credential blob.
    parentEnv: {
      WORKSPACE_OPENCODE_AUTH_FILE: withCredential
        ? box.authFile
        : path.join(box.root, 'absent-workspace_opencode_auth'),
    },
    deps: {
      // The model comes from the merged config the sandbox wrote (installPlugins), as in production.
      readEffectiveModel: () =>
        readEffectiveModelFromConfig(path.join(box.home, '.config', 'opencode', 'opencode.json')),
      prepareDatabase: async () => {
        const dbPath = await prepareFreshDatabase({
          baseDir: box.dbBase,
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
        })
        databasePaths.push(dbPath)
        return dbPath
      },
      // Everything else is the real thing; only the identity and the home are the sandbox's, because this process is
      // not root and the real home is not ours to touch.
      startServer: async (options: StartOpenCodeV2ServerOptions, log) => {
        // Drop the agent identity (not ours to take), keep everything else.
        const sandboxed: StartOpenCodeV2ServerOptions = {...options, env: sandboxEnv(options.env ?? {})}
        delete (sandboxed as {uid?: number}).uid
        delete (sandboxed as {gid?: number}).gid
        const started = await startOpenCodeV2Server(sandboxed, log)
        if (!started.success) startErrors.push(started.error)
        return started
      },
    },
  })

  const proxy = createOpencodeProxyV2({
    token: GATEWAY_BEARER,
    upstreamUrl: `http://127.0.0.1:${port}`,
    logger,
    credentials,
  })
  await proxy.listen(0, '127.0.0.1')
  const proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`

  await vi.waitFor(
    () => {
      if (outcome === 'refused') {
        expect(statusRef.status).toBe('degraded')
        return
      }
      if (statusRef.status === 'degraded') throw new Error(`supervisor degraded: ${JSON.stringify(startErrors)}`)
      expect(statusRef.status).toBe('ready')
    },
    {timeout: 120_000, interval: 250},
  )

  return {
    statusRef,
    statuses: seen,
    credentials,
    proxyUrl,
    upstreamUrl: `http://127.0.0.1:${port}`,
    databasePaths,
    startErrors,
    stop: async () => {
      controller.abort()
      await run
      proxy.server.closeAllConnections()
      await proxy.close()
    },
  }
}

async function viaProxy(workspace: RunningWorkspace, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${workspace.proxyUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${GATEWAY_BEARER}`,
      'x-opencode-directory': encodeURIComponent(box.repo),
      'content-type': 'application/json',
      ...init.headers,
    },
  })
}

interface SessionRow {
  readonly time_suspended: number | null
}

function readClaim(dbPath: string, id: string): number | null | undefined {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('SELECT time_suspended FROM session_v2 WHERE id = ?').get(id) as SessionRow | undefined
    return row === undefined ? undefined : row.time_suspended
  } finally {
    db.close()
  }
}

describe.skipIf(!hasBinary)('the workspace V2 runner against the real stock binary', () => {
  beforeAll(async () => {
    const reported = execFileSync(BINARY as string, ['--version'], {encoding: 'utf8'}).trim()
    if (!reported.includes(PIN.version)) {
      throw new Error(`FRO_BOT_OPENCODE_V2_BIN reports "${reported}", not the pinned ${PIN.version}`)
    }
    box = createSandbox()
    provider = await startFakeProvider(PROVIDER_KEY)
    installPlugins(box)
  }, 300_000)

  afterAll(async () => {
    await provider?.stop()
    if (box !== undefined) rmSync(box.root, {recursive: true, force: true})
  })

  it(
    'loads both cached plugins with no registry, passes both gates, and serves through the bearer proxy',
    {timeout: RUNNER_TIMEOUT_MS},
    async () => {
      // #given the plugins installed by the image's script and a registry that refuses connections
      const workspace = await startWorkspace()
      try {
        // #then the supervisor only reports ready after the plugin gate and the permission gate passed
        expect(workspace.statusRef.status).toBe('ready')
        expect(workspace.startErrors).toEqual([])
        expect(lines).not.toContain('error opencode-server-v2: permission gate failed')

        // #and both plugins are listed active under the ids the workspace expects
        // (plugins activate per location, so a location the gates did not ask about answers /api/agent 503 until its
        // own activation finishes; the supervisor's location is box.reposRoot)
        const listPlugins = async (): Promise<string[]> => {
          const response = await viaProxy(workspace, '/api/plugin', {
            headers: {'x-opencode-directory': encodeURIComponent(box.reposRoot)},
          })
          const body = (await response.json()) as {data: {id?: string; state: {status: string}}[]}
          return body.data.filter(entry => entry.state.status === 'active').map(entry => entry.id ?? '')
        }
        expect(await listPlugins()).toEqual(expect.arrayContaining([SYSTEMATIC_V2_PLUGIN_ID, FRO_BOT_PLUGIN_ID]))
        expect(WORKSPACE_V2_PLUGIN_SPECS).toEqual([
          `@fro.bot/systematic@${DEFAULT_SYSTEMATIC_VERSION}`,
          `@fro.bot/opencode-plugin@${FRO_BOT_PLUGIN_VERSION}`,
        ])

        // #and the bearer is the only door: no bearer is refused by the proxy, and the server itself refuses anonymous callers
        expect((await fetch(`${workspace.proxyUrl}/api/info`)).status).toBe(401)
        expect((await fetch(`${workspace.upstreamUrl}/api/info`)).status).toBe(401)
        const info = await viaProxy(workspace, '/api/info')
        expect(info.status).toBe(200)

        // #and the SSE stream opens through the proxy with the server.connected frame first
        const stream = await viaProxy(workspace, '/api/event', {headers: {accept: 'text/event-stream'}})
        expect(stream.headers.get('content-type')).toContain('text/event-stream')
        expect(stream.headers.get('content-encoding')).toBeNull()
        const reader = stream.body?.getReader()
        const first = await reader?.read()
        expect(new TextDecoder().decode(first?.value as Uint8Array | undefined)).toMatch(/heartbeat|server\.connected/)
        await reader?.cancel()

        // #and the evict endpoint accepts the narrow location call with the live credential
        const dispose = createInstanceDisposerV2({
          upstreamUrl: workspace.upstreamUrl,
          credentials: workspace.credentials,
        })
        expect(await dispose(box.repo)).toEqual({kind: 'disposed'})

        // #and the database is the fresh one the supervisor made
        expect(workspace.databasePaths).toHaveLength(1)
        expect(existsSync(workspace.databasePaths[0] as string)).toBe(true)
      } finally {
        await workspace.stop()
      }
    },
  )

  it(
    'starts the next spawn on an empty database, and leaves no claim after a shutdown with a turn in flight',
    {timeout: RUNNER_TIMEOUT_MS},
    async () => {
      // #given a first spawn with a session and a turn held at the provider
      provider?.setHold(true)
      const authorizedBefore = provider?.authorizedRequests() ?? 0
      const first = await startWorkspace()
      const firstDb = first.databasePaths[0] as string
      let sessionId: string
      try {
        const created = (await (
          await viaProxy(first, '/api/session', {
            method: 'POST',
            body: JSON.stringify({location: {directory: box.repo}}),
          })
        ).json()) as {data: {id: string}}
        sessionId = created.data.id
        const prompt = await viaProxy(first, `/api/session/${sessionId}/prompt`, {
          method: 'POST',
          body: JSON.stringify({text: 'go'}),
        })
        expect(prompt.status).toBeLessThan(300)
        await vi.waitFor(() => expect(provider?.authorizedRequests()).toBeGreaterThan(authorizedBefore), {
          timeout: 30_000,
          interval: 100,
        })
        await vi.waitFor(() => expect(readClaim(firstDb, sessionId)).not.toBeNull(), {timeout: 15_000, interval: 100})
      } finally {
        // #when the service stops: the supervisor interrupts the active session before it closes stdin
        await first.stop()
      }

      // #then the saved database holds no execution claim, so nothing is left for a later server to resume
      expect(readClaim(firstDb, sessionId)).toBeNull()

      // #when the next spawn starts
      const second = await startWorkspace()
      try {
        // #then it is on a different database, and the first spawn's session is not there
        const secondDb = second.databasePaths[0] as string
        expect(secondDb).not.toBe(firstDb)
        expect(existsSync(firstDb)).toBe(false)
        const old = await viaProxy(second, `/api/session/${sessionId}`)
        expect(old.status).toBe(404)
      } finally {
        await second.stop()
        provider?.setHold(false)
      }
    },
  )

  it(
    'provisions the key into a fresh database so the model request carries it (fro-bot/agent#1992)',
    {timeout: RUNNER_TIMEOUT_MS},
    async () => {
      // #given the production layout: an overlay with a baseURL and no key, a model, and a root-only blob
      provider?.setHold(false)
      const hitsBefore = provider?.hits().length ?? 0
      const workspace = await startWorkspace()
      try {
        // #then the spawn's credential store holds the provisioned credential (counted, never read)
        const dbPath = workspace.databasePaths[0] as string
        const db = new DatabaseSync(dbPath)
        try {
          const row = db.prepare('SELECT count(*) AS n FROM credential WHERE integration_id = ?').get('anthropic') as {
            n: number
          }
          expect(row.n).toBe(1)
        } finally {
          db.close()
        }

        // #and the read-back the gate relies on lists the connection and carries no secret
        const integration = await fetch(`${workspace.upstreamUrl}/api/integration/anthropic`, {
          headers: {
            authorization: workspace.credentials.authorization() as string,
            'x-opencode-directory': encodeURIComponent(box.reposRoot),
          },
        })
        const integrationText = await integration.text()
        expect(integration.status).toBe(200)
        expect(integrationText).not.toContain(PROVIDER_KEY)
        expect(JSON.parse(integrationText)).toMatchObject({data: {connections: [{type: 'credential', method: 'key'}]}})

        // #and provisioning works while the bearer proxy refuses the credential group: the supervisor stored the key
        // straight to loopback, the group answers there (control), and the gateway bearer gets a 404 for it
        const direct = await fetch(`${workspace.upstreamUrl}/api/credential`, {
          headers: {authorization: workspace.credentials.authorization() as string},
        })
        expect(direct.status).toBe(200)
        for (const spelling of ['/api/credential', '/api/CREDENTIAL', '/api/%63redential', '/api/credential/']) {
          const viaGateway = await viaProxy(workspace, spelling)
          expect(viaGateway.status).toBe(404)
          expect(await viaGateway.text()).not.toContain(PROVIDER_KEY)
        }

        // #when one prompt is sent
        const created = (await (
          await viaProxy(workspace, '/api/session', {
            method: 'POST',
            body: JSON.stringify({location: {directory: box.repo}}),
          })
        ).json()) as {data: {id: string}}
        const prompt = await viaProxy(workspace, `/api/session/${created.data.id}/prompt`, {
          method: 'POST',
          body: JSON.stringify({text: 'ping'}),
        })
        expect(prompt.status).toBeLessThan(300)
        await vi.waitFor(() => expect(provider?.hits().slice(hitsBefore).length).toBeGreaterThan(0), {
          timeout: 30_000,
          interval: 100,
        })

        // #then the request arrived with the key in x-api-key, the header V1 sent, and no authorization header
        const hits = provider?.hits().slice(hitsBefore) ?? []
        expect(hits.length).toBeGreaterThan(0)
        for (const hit of hits) {
          expect(hit.headers['x-api-key']).toBe(PROVIDER_KEY)
          expect(hit.headers.authorization).toBeUndefined()
        }

        // #and the key reached no log line
        expect(lines.join('\n')).not.toContain(PROVIDER_KEY)
      } finally {
        await workspace.stop()
      }
    },
  )

  it(
    'never turns ready when the model provider has no credential, and the provider sees no request',
    {timeout: RUNNER_TIMEOUT_MS},
    async () => {
      // #given a configured model and no credential blob
      provider?.setHold(false)
      const hitsBefore = provider?.hits().length ?? 0

      // #when the supervisor runs to its verdict
      const workspace = await startWorkspace({withCredential: false, expect: 'refused'})
      try {
        // #then readiness was never reported, the proxy holds no credential, and the failure is named in the log
        expect(workspace.statuses).not.toContain('ready')
        expect(workspace.statusRef.status).toBe('degraded')
        expect(workspace.credentials.authorization()).toBeUndefined()
        expect(lines).toContain('error opencode-server-v2: credential gate failed')
        expect(provider?.hits().length).toBe(hitsBefore)
      } finally {
        await workspace.stop()
      }
    },
  )
})
