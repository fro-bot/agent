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
  FRO_BOT_PLUGIN_ID,
  FRO_BOT_PLUGIN_VERSION,
  startOpenCodeV2Server,
  SYSTEMATIC_V2_PLUGIN_ID,
  SYSTEMATIC_V2_VERSION,
} from '@fro-bot/runtime/workspace-v2'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'

import {createInstanceDisposerV2} from './opencode-instance-v2.js'
import {createOpencodeProxyV2} from './opencode-proxy-v2.js'
import {
  createUpstreamCredentials,
  prepareFreshDatabase,
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
}

let box: Sandbox
let provider: HeldProvider | undefined

interface HeldProvider {
  readonly baseURL: string
  readonly requests: () => number
  readonly stop: () => Promise<void>
}

/** An OpenAI-compatible endpoint that answers every chat request with headers and then never finishes. */
async function startHeldProvider(): Promise<HeldProvider> {
  let requests = 0
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
      return
    }
    requests += 1
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
    res.write(
      `data: ${JSON.stringify({id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{index: 0, delta: {role: 'assistant', content: ''}, finish_reason: null}]})}\n\n`,
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
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
  return {root, home, reposRoot, repo, dbBase: path.join(root, 'db')}
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
  // The entrypoint's merged global config: provider and model only, no plugin entry (the config content carries those).
  writeFileSync(
    path.join(sandbox.home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      provider: {
        fake: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake',
          options: {baseURL: provider?.baseURL, apiKey: 'fake-integration-key-not-a-credential'},
          models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
        },
      },
      model: 'fake/fixture-model',
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
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  }
}

interface RunningWorkspace {
  readonly statusRef: SupervisedStatusRef
  readonly credentials: ReturnType<typeof createUpstreamCredentials>
  readonly proxyUrl: string
  readonly upstreamUrl: string
  readonly databasePaths: string[]
  readonly startErrors: OpenCodeV2StartError[]
  readonly stop: () => Promise<void>
}

/** Runs the real supervisor and the real V2 proxy on loopback ports, against the real binary. */
async function startWorkspace(): Promise<RunningWorkspace> {
  const statusRef: SupervisedStatusRef = {status: 'starting'}
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
    parentEnv: {},
    deps: {
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
      if (statusRef.status === 'degraded') throw new Error(`supervisor degraded: ${JSON.stringify(startErrors)}`)
      expect(statusRef.status).toBe('ready')
    },
    {timeout: 120_000, interval: 250},
  )

  return {
    statusRef,
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
    provider = await startHeldProvider()
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
          `@fro.bot/systematic@${SYSTEMATIC_V2_VERSION}`,
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
        await vi.waitFor(() => expect(provider?.requests()).toBeGreaterThan(0), {timeout: 30_000, interval: 100})
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
      }
    },
  )
})
