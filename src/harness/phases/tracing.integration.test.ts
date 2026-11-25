/**
 * Action tracing end to end against the real OpenCode V2 binary: the inputs' relay config, a real relay child, the real server
 * start (`startActionOpenCodeV2`, so the CI config, both gates and the launcher variable are the production ones), the locally
 * built plugin, and a recording HTTPS upstream standing in for the collector.
 *
 * Runs only when `FRO_BOT_OPENCODE_V2_BIN` points at the pinned binary (2.3.2; the plan's pin lives in
 * `packages/runtime/src/shared/opencode-v2-pin.json`, and `execute-v2.integration.test.ts` shows how to fetch and verify it)
 * AND the plugin has been built locally (`bun run --filter @fro.bot/opencode-plugin build`, which writes
 * `packages/opencode-plugin/dist`). It never installs from npm.
 *
 * How the local plugin build is loaded. The Action's config lists the plugin as `@fro.bot/opencode-plugin@<pin>`, which the
 * Action installs from the registry at run time. The one seam here is the `startServer` dep that `startActionOpenCodeV2`
 * already has for tests: it receives the exact spawn options the Action built, and this test swaps each npm spec for a local
 * directory (the built plugin, and a stub standing in for Systematic) in the same list position, then calls the real
 * `startOpenCodeV2Server`. `installPlugins` is stubbed so nothing touches the network. Everything else is production code,
 * including the plugin order `buildCIConfigV2` chose, which the test records before the swap and asserts.
 *
 * The relay is the built `dist/trace-relay.js` run by the real supervisor, through `env NODE_EXTRA_CA_CERTS=...`: the child's
 * own environment is empty by design, and `env` is the one way to give a test CA to it without a production seam. The
 * credential still reaches the child only on its stdin.
 */

import type {OpenCodeV2ServerHandle, TracingRunLink} from '@fro-bot/runtime'
import type {FakeProvider, FakeStep, SinkRequest} from '../../../packages/opencode-plugin/src/integration.fixture.js'
import type {
  RecordedRequest as RecordedUpstreamRequest,
  TlsUpstream,
} from '../../../packages/runtime/src/agent/key-proxy-test-kit.js'
import type {TraceRelayLauncher, TraceRelayProcess, TraceRelayStopResult} from './trace-relay-process.js'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {ok} from '@bfra.me/es/result'
import {startOpenCodeV2Server} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {startFakeProvider} from '../../../packages/opencode-plugin/src/integration.fixture.js'
import {
  decodeSpans,
  sleep,
  waitUntil,
} from '../../../packages/opencode-plugin/src/tracing/tracing.integration.fixture.js'
import {startTlsUpstream} from '../../../packages/runtime/src/agent/key-proxy-test-kit.js'
import {startOtlpSink} from '../../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {
  buildActionTracingHost,
  buildTraceSessionId,
  buildTracingRunIdentity,
  buildTracingRunLink,
  relayRequestFromInputs,
} from '../../services/setup/tracing.js'
import {createLifecycleTracer, createRegistryScrubber} from '../../shared/lifecycle-tracer.js'
import {createSecretRegistry} from '../../shared/secret-registry.js'
import {createMockLogger, serializeLoggerCalls, unwrapOk} from '../../shared/test-helpers.js'
import {parseTraceInputs} from '../config/trace-inputs.js'
import {startTraceRelayProcess} from './trace-relay-process.js'
import {startActionOpenCodeV2, type StartActionOpenCodeV2Options} from './v2-server.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const ROOT = path.resolve(import.meta.dirname, '../../..')
const PLUGIN_DIR = path.join(ROOT, 'packages/opencode-plugin')
const RELAY_BUNDLE = path.join(ROOT, 'dist/trace-relay.js')

/** `node`, never `bun`: the relay is a Node ESM bundle and `NODE_EXTRA_CA_CERTS` is Node's. */
function findNode(): string | null {
  if (path.basename(process.execPath).startsWith('node')) return process.execPath
  try {
    return execFileSync('which', ['node'], {encoding: 'utf8'}).trim() || null
  } catch {
    return null
  }
}
const NODE = findNode()

const enabled =
  BINARY !== undefined &&
  BINARY !== '' &&
  existsSync(BINARY) &&
  existsSync(path.join(PLUGIN_DIR, 'dist/index.mjs')) &&
  existsSync(RELAY_BUNDLE) &&
  existsSync('/usr/bin/env') &&
  NODE !== null

// A credential no other test or fixture uses, so finding any form of it anywhere is a leak.
const CREDENTIAL_USER = 'pk-trace-canary-user-0001'
const CREDENTIAL_PASSWORD = 'sk-trace-canary-secret-9f3a'
const CREDENTIAL = `Basic ${Buffer.from(`${CREDENTIAL_USER}:${CREDENTIAL_PASSWORD}`).toString('base64')}`
const PROJECT_HEADER = 'x-trace-canary-project'
const PROJECT_VALUE = 'canary-project-1'
// Every form the credential and the headers could take: nothing the run logs, writes, exports or hands the agent may hold one.
const CREDENTIAL_FORMS = [
  `Authorization: ${CREDENTIAL}`,
  `${PROJECT_HEADER}: ${PROJECT_VALUE}`,
  CREDENTIAL,
  CREDENTIAL.slice('Basic '.length),
  `${CREDENTIAL_USER}:${CREDENTIAL_PASSWORD}`,
  CREDENTIAL_USER,
  CREDENTIAL_PASSWORD,
  PROJECT_VALUE,
] as const

const MODEL = 'fake/fixture-model'
const NOT_TOOL = '"role":"tool"'
const SIMPLE: FakeStep[] = [{all: ['S-ONE'], text: 'simple answer'}]
const ENV_DUMP: FakeStep[] = [
  {all: ['S-ENV'], none: [NOT_TOOL], tools: [{name: 'shell', args: {command: 'env'}}]},
  {all: ['S-ENV', NOT_TOOL], text: 'env dumped'},
]

interface Box {
  readonly root: string
  readonly repo: string
  readonly home: string
  readonly dbPath: string
  readonly authPath: string
  readonly env: NodeJS.ProcessEnv
}

function makeBox(): Box {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fro-bot-trace-it-'))
  const dirs = {
    home: path.join(root, 'home'),
    repo: path.join(root, 'repo'),
    config: path.join(root, 'home/config'),
    data: path.join(root, 'home/data'),
    cache: path.join(root, 'home/cache'),
    state: path.join(root, 'home/state'),
    tmp: path.join(root, 'tmp'),
    runnerTemp: path.join(root, 'runner-temp'),
    opencodeData: path.join(root, 'home/data/opencode'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, {recursive: true})
  writeFileSync(path.join(dirs.repo, 'README.md'), 'tracing integration project\n')
  return {
    root,
    repo: dirs.repo,
    home: dirs.home,
    dbPath: path.join(dirs.opencodeData, 'opencode.db'),
    authPath: path.join(dirs.opencodeData, 'auth.json'),
    env: {
      PATH: process.env.PATH,
      HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
      TMPDIR: dirs.tmp,
      RUNNER_TEMP: dirs.runnerTemp,
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    },
  }
}

/** A plugin the server loads from a directory: just an id, no behaviour. */
function writeStubPlugin(dir: string, id: string): string {
  mkdirSync(dir, {recursive: true})
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({name: `stub-${id}`, version: '0.0.0', type: 'module', exports: {'.': './index.mjs'}}),
  )
  writeFileSync(
    path.join(dir, 'index.mjs'),
    `import {Plugin} from '@opencode/plugin'\nexport default Plugin.define({id: ${JSON.stringify(id)}, setup: async () => undefined})\n`,
  )
  return dir
}

const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024

/** The file's bytes through one handle (opened without following a link), or null for anything that is not a small regular file. */
function readSmallFile(file: string): Buffer | null {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    // The size and the read are both of the open handle, so nothing can be swapped in between them.
    const stat = fstatSync(fd)
    return stat.isFile() && stat.size <= MAX_SCANNED_FILE_BYTES ? readFileSync(fd) : null
  } finally {
    closeSync(fd)
  }
}

/** Every file under `root` (up to 8 MB each) that holds `needle`, as paths relative to it. */
function filesHolding(root: string, needle: string): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && readSmallFile(full)?.includes(needle) === true) hits.push(path.relative(root, full))
    }
  }
  walk(root)
  return hits
}

/**
 * The environment and command line of a LIVE process, read now. Linux only: it throws when they cannot be read, so a
 * platform that shows them can never pass by failing to look. Elsewhere (macOS has no /proc) it returns null, and the test
 * says so in its assertions: nothing about the relay's process is checked there.
 */
function liveProcessText(pid: number): string | null {
  if (process.platform !== 'linux') return null
  return [`/proc/${pid}/environ`, `/proc/${pid}/cmdline`]
    .map(file => readFileSync(file, 'utf8').replaceAll('\u{0}', '\n'))
    .join('\n')
}

/** A recording plain-HTTP OTLP-ish sink: anything it receives is a leak in the scenarios that use it. */
async function startPlainSink(): Promise<{url: string; requests: string[]; stop: () => Promise<void>}> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    req.resume()
    res.writeHead(200, {'content-type': 'application/json'})
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('plain sink did not bind')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

interface TurnOptions {
  readonly tracing: 'off' | 'on'
  /** For tracing on: the collector answers (`up`), or nothing listens at its address (`refused`). */
  readonly upstream?: 'refused' | 'up'
  readonly steps: readonly FakeStep[]
  readonly prompt: string
  /** What the turn's final assistant text must contain before the run stops the server. */
  readonly finalText: string
  /** Extra variables in the Action process environment, as a job could set them. */
  readonly jobEnv?: Readonly<Record<string, string>>
  /** Called with the box before the server starts, to plant files. */
  readonly plant?: (box: Box) => void
  /** What the Action tells the plugin about the run it belongs to: the root span, the session and the invocation id. */
  readonly link?: TracingRunLink
}

interface TurnResult {
  readonly box: Box
  readonly started: Awaited<ReturnType<typeof startActionOpenCodeV2>>
  /** The plugin list `buildCIConfigV2` wrote, before the local build was swapped in. */
  readonly configuredPlugins: readonly string[]
  readonly spawnConfigJson: string
  /** The relay's environment and command line, read while it was alive (Linux), else null. */
  readonly relayProcessText: string | null
  /** The whole session as the server returned it, which includes the output of the `shell` call. */
  readonly session: string
  readonly relay: TraceRelayProcess | null
  readonly relayStop: TraceRelayStopResult | null
  readonly shutdown: string
  readonly relayLog: ReturnType<typeof createMockLogger>
  readonly runLog: ReturnType<typeof createMockLogger>
  readonly upstream: TlsUpstream | null
  readonly spans: ReturnType<typeof decodeSpans>
}

const isRoot = (span: {name: string; parentSpanId?: string | undefined}): boolean =>
  span.name.startsWith('invoke_agent') && span.parentSpanId === undefined

/** The recorded upstream requests in the decoder's shape. */
function toSinkRequests(received: readonly RecordedUpstreamRequest[]): SinkRequest[] {
  return received.map(recorded => ({
    method: recorded.method,
    path: recorded.url,
    contentType: String(recorded.headers['content-type'] ?? ''),
    headers: recorded.headers,
    body: (() => {
      try {
        return JSON.parse(recorded.body.toString('utf8')) as unknown
      } catch {
        return recorded.body.toString('utf8')
      }
    })(),
    text: recorded.body.toString('utf8'),
    status: 200,
  }))
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** One run of the Action's tracing path: relay, server start, one turn, server stop, relay stop. */
async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const box = makeBox()
  cleanups.push(() => rmSync(box.root, {recursive: true, force: true}))
  const provider: FakeProvider = await startFakeProvider()
  cleanups.push(async () => provider.stop())
  provider.script(options.steps)

  const stubSystematic = writeStubPlugin(path.join(box.root, 'stub-systematic'), 'systematic')
  const stubOperator = writeStubPlugin(path.join(box.root, 'stub-operator'), 'test.operator-stub')
  options.plant?.(box)

  const upstream =
    options.tracing === 'on'
      ? await startTlsUpstream((_request, res) => {
          res.writeHead(200, {'content-type': 'application/json'})
          res.end('{}')
        })
      : null
  const upstreamOrigin = upstream?.origin ?? ''
  if (upstream !== null && options.upstream === 'refused') await upstream.close()
  else if (upstream !== null) cleanups.push(async () => upstream.close())

  const runLog = createMockLogger()
  const relayLog = createMockLogger()

  // The inputs, through the real parser, so the relay config is what a workflow's two inputs produce.
  const parsed = parseTraceInputs(
    {
      endpoint: upstream === null ? '' : `${upstreamOrigin}/api/public/otel/v1/traces`,
      headers: `Authorization: ${CREDENTIAL}\n${PROJECT_HEADER}: ${PROJECT_VALUE}`,
    },
    {warning: () => undefined, notice: () => undefined, info: () => undefined, mask: () => undefined},
  )
  const request = relayRequestFromInputs(parsed)

  let relay: TraceRelayProcess | null = null
  if (request !== null && upstream !== null) {
    const caFile = path.join(box.root, 'collector-ca.pem')
    writeFileSync(caFile, upstream.ca)
    const launcher: TraceRelayLauncher = {
      command: '/usr/bin/env',
      args: [`NODE_EXTRA_CA_CERTS=${caFile}`, NODE as string, RELAY_BUNDLE],
    }
    const relayStart = await startTraceRelayProcess({
      config: request,
      logger: relayLog,
      launcher,
      timeouts: {readyMs: 15_000, exitGraceMs: 4_000, killConfirmMs: 2_000},
    })
    relay = relayStart.success ? relayStart.data : null
    // Registered as soon as the relay is up, so an assertion that fails later still stops it. Cleanups run in reverse: the
    // server's (pushed later) goes first and the relay second, the order `run.ts` uses.
    cleanups.push(async () => {
      await relay?.stop()
    })
    expect(relayStart.success).toBe(true)
  }
  const identity = unwrapOk(
    buildTracingRunIdentity({
      repository: 'owner/repo',
      runId: '4242',
      attempt: 3,
      job: 'review',
      trigger: 'pull_request',
    }),
  )
  const tracing = buildActionTracingHost(relay?.port ?? null, identity, options.link)

  let configuredPlugins: readonly string[] = []
  let spawnConfigJson = ''
  let relayProcessText: string | null = null
  const startOptions: StartActionOpenCodeV2Options = {
    binaryPath: BINARY as string,
    workspacePath: box.repo,
    authJson: JSON.stringify({fake: {type: 'api', key: 'fake-key-not-a-credential'}}),
    opencodeConfig: JSON.stringify({
      share: 'disabled',
      model: MODEL,
      plugins: [stubOperator],
      provider: {
        fake: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake',
          options: {baseURL: provider.baseURL},
          models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
        },
      },
    }),
    credential: 'provision',
    systematicVersion: 'latest',
    model: MODEL,
    dbPath: box.dbPath,
    authPath: box.authPath,
    env: {...box.env, ...options.jobEnv},
    runId: 4242,
    runAttempt: 3,
    tracing,
    logger: runLog,
    deps: {
      installPlugins: async () => ok(undefined),
      startServer: async (spawnOptions, spawnLogger) => {
        // The Action's tracing decision is taken by the runtime start right before the spawn. This wraps it: it takes the
        // decision as made, records the config and plugin order that decision gave, and swaps each npm spec for its local
        // directory in the same position, so what the child receives is the production decision on a local build.
        const decide = spawnOptions.tracingHost
        return startOpenCodeV2Server(
          {
            ...spawnOptions,
            tracingHost: () => {
              const decision = typeof decide === 'function' ? decide() : {host: decide}
              const config = (decision.config ?? spawnOptions.config) as {plugins: string[]} & Record<string, unknown>
              configuredPlugins = [...config.plugins]
              spawnConfigJson = JSON.stringify(config)
              const local = config.plugins.map(spec => {
                if (spec.startsWith('@fro.bot/systematic@')) return stubSystematic
                if (spec.startsWith('@fro.bot/opencode-plugin@')) return PLUGIN_DIR
                return spec
              })
              return {host: decision.host, config: {...config, plugins: local}}
            },
            timeouts: {agentReadyTimeoutMs: 90_000},
          },
          spawnLogger,
        )
      },
    },
  }

  const started = await startActionOpenCodeV2(startOptions)
  let session = ''
  let shutdown = 'not started'
  let handle: OpenCodeV2ServerHandle | null = null
  if (started.success) {
    handle = started.data
    cleanups.push(async () => {
      await handle?.shutdown()
    })
    const api = async (method: string, pathname: string, body?: unknown): Promise<{status: number; data: unknown}> => {
      const response = await (handle as OpenCodeV2ServerHandle).fetch(pathname, {
        method,
        headers: {'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      })
      const text = await response.text()
      try {
        return {status: response.status, data: JSON.parse(text)}
      } catch {
        return {status: response.status, data: text}
      }
    }
    const created = await api('POST', '/api/session', {location: {directory: box.repo}})
    const sessionId = (created.data as {data?: {id?: string}}).data?.id
    if (typeof sessionId !== 'string') throw new Error(`session create failed: ${created.status}`)
    const sent = await api('POST', `/api/session/${sessionId}/prompt`, {text: options.prompt})
    expect(sent.status).toBe(200)
    // Poll the session until the final text shows.
    const deadline = Date.now() + 90_000
    while (!session.includes(options.finalText) && Date.now() < deadline) {
      session = JSON.stringify((await api('GET', `/api/session/${sessionId}/message`)).data)
      if (!session.includes(options.finalText)) await sleep(200)
    }
    expect(session).toContain(options.finalText)
    // Wait for what the turn must have produced, not for a time: the root span ends with the turn, so once the collector holds
    // it every span of the turn has been exported (children end first). Then stop as the Action does: interrupt, close stdin,
    // wait for the exit. A refused collector never receives anything, and the stop's final flush is what that scenario tests.
    if (upstream !== null && options.upstream === 'up') {
      await waitUntil(
        'the turn’s root span at the collector',
        () => decodeSpans(toSinkRequests(upstream.requests)).some(isRoot),
        60_000,
        () =>
          `received ${upstream.requests.length} requests; spans: ${decodeSpans(toSinkRequests(upstream.requests))
            .map(span => span.name)
            .join(', ')}`,
      )
    }
    // The relay is alive here (it stops after the server): read its process now, not after it has gone.
    relayProcessText = relay === null ? null : liveProcessText(relay.pid)
    const stopped = await handle.shutdown()
    shutdown = stopped.exit.outcome
  }
  const relayStop = relay === null ? null : await relay.stop({serverKilled: shutdown !== 'graceful'})
  const requests = toSinkRequests(upstream?.requests ?? [])
  return {
    box,
    started,
    configuredPlugins,
    spawnConfigJson,
    relayProcessText,
    session,
    relay,
    relayStop,
    shutdown,
    relayLog,
    runLog,
    upstream,
    spans: decodeSpans(requests),
  }
}

describe('the credential scan used by the real-binary test', () => {
  it('finds a form in a file, follows no link, and skips what is not a small regular file', () => {
    // #given a tree with the form in one file, a link to it, a clean file, and a directory
    const root = mkdtempSync(path.join(os.tmpdir(), 'fro-bot-trace-scan-'))
    cleanups.push(() => rmSync(root, {recursive: true, force: true}))
    mkdirSync(path.join(root, 'nested'))
    writeFileSync(path.join(root, 'nested', 'holds.txt'), `before ${CREDENTIAL_PASSWORD} after`)
    writeFileSync(path.join(root, 'clean.txt'), 'nothing here')
    symlinkSync(path.join(root, 'nested', 'holds.txt'), path.join(root, 'link.txt'))

    // #then only the real file is reported (a clean scan is not a scan that looked at nothing)
    expect(filesHolding(root, CREDENTIAL_PASSWORD)).toEqual([path.join('nested', 'holds.txt')])
    expect(filesHolding(root, 'absent-needle')).toEqual([])
  })
})

describe.skipIf(!enabled)('Action tracing against the real OpenCode V2 binary and the built plugin', () => {
  it('delivers a turn through the relay with the configured header and the Action identity, and keeps the credential out of the server', async () => {
    // #given a workflow with both inputs, a job that sets OpenTelemetry variables, and an operator plugin
    const otel = await startPlainSink()
    cleanups.push(otel.stop)

    // #when one turn runs (it dumps the server's environment) and the run stops
    const turn = await runTurn({
      tracing: 'on',
      upstream: 'up',
      steps: ENV_DUMP,
      prompt: 'S-ENV print your environment',
      finalText: 'env dumped',
      jobEnv: {
        OTEL_EXPORTER_OTLP_ENDPOINT: otel.url,
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic b3RlbDpvdGVs',
        OTEL_TRACES_EXPORTER: 'otlp',
      },
    })

    // #then the server started: both gates passed with the Fro Bot plugin listed after the operator's
    expect(turn.started.success).toBe(true)
    expect(turn.configuredPlugins).toEqual([
      expect.stringMatching(/^@fro\.bot\/systematic@/),
      expect.stringContaining('stub-operator'),
      expect.stringMatching(/^@fro\.bot\/opencode-plugin@/),
    ])
    expect(turn.shutdown).toBe('graceful')

    // #and the collector received the turn's spans with the configured headers, and the Action's identity on every span
    expect(turn.upstream?.requests.length).toBeGreaterThan(0)
    for (const received of turn.upstream?.requests ?? []) {
      expect(received.headers.authorization).toBe(CREDENTIAL)
      expect(received.headers[PROJECT_HEADER]).toBe(PROJECT_VALUE)
      expect(received.url).toBe('/api/public/otel/v1/traces')
    }
    const root = turn.spans.find(isRoot)
    expect(root).toBeDefined()
    expect(turn.spans.some(span => span.name.startsWith('execute_tool shell'))).toBe(true)
    for (const span of turn.spans) {
      expect(span.attrs['fro_bot.repository']).toBe('owner/repo')
      expect(span.attrs['fro_bot.run.id']).toBe('4242')
    }
    expect(root?.attrs['fro_bot.run.attempt']).toBe('3')
    expect(root?.attrs['fro_bot.job']).toBe('review')
    expect(root?.attrs['fro_bot.trigger']).toBe('pull_request')

    // #and the stop line says the batches were acknowledged by the collector
    const stopLine = vi.mocked(turn.relayLog.info).mock.calls.find(call => call[0] === 'Trace relay stopped')
    expect(stopLine?.[1]).toMatchObject({retry: 0, dropped: 0})
    expect((stopLine?.[1] as {acknowledged: number}).acknowledged).toBeGreaterThan(0)

    // #and the credential is not in the server's environment, as the agent sees it, nor in its config, nor on disk
    expect(turn.session).toContain('OPENCODE_FROBOT_TRACING=')
    expect(turn.session).toContain(`127.0.0.1:${turn.relay?.port}/v1/traces`)
    // every form is checked, not only the decoded password: the whole header line, the encoded part, the decoded pair
    for (const form of CREDENTIAL_FORMS) {
      expect(turn.session).not.toContain(form)
      expect(turn.spawnConfigJson).not.toContain(form)
      expect(filesHolding(turn.box.root, form)).toEqual([])
    }
    expect(turn.spawnConfigJson).not.toContain(turn.upstream?.origin ?? 'no-origin')
    // the relay's own environment and arguments, read while it was alive. On Linux they must be readable (a read that fails
    // fails the test) and must show the command that was run; on macOS they are not inspected at all, because it has no /proc.
    expect(turn.relayProcessText !== null || process.platform !== 'linux').toBe(true)
    expect(turn.relayProcessText === null || turn.relayProcessText.includes('trace-relay.js')).toBe(true)
    for (const form of CREDENTIAL_FORMS) expect(turn.relayProcessText?.includes(form) ?? false).toBe(false)

    // #and no OTEL_ variable reached the server, and OpenCode's own exporter sent nothing to the job's endpoint
    expect(turn.session).not.toMatch(/OTEL_/)
    expect(otel.requests).toEqual([])

    // #and nothing the run logged holds any form of the credential, or the collector address
    const logged = `${serializeLoggerCalls(turn.runLog)}\n${serializeLoggerCalls(turn.relayLog)}`
    const exported = JSON.stringify((turn.upstream?.requests ?? []).map(received => received.body.toString('utf8')))
    for (const form of CREDENTIAL_FORMS) {
      expect(logged).not.toContain(form)
      // and the spans the collector received do not hold one either
      expect(exported).not.toContain(form)
    }
    expect(logged).not.toContain(turn.upstream?.origin ?? 'no-origin')
  }, 180_000)

  it('completes the run, and logs the batches as not acknowledged, when the collector refuses connections', async () => {
    // #given a collector address with nothing listening, and a run that sends its one final batch at stop
    const turn = await runTurn({
      tracing: 'on',
      upstream: 'refused',
      steps: SIMPLE,
      prompt: 'S-ONE hello',
      finalText: 'simple answer',
    })

    // #then the run succeeded and the server left on its own
    expect(turn.started.success).toBe(true)
    expect(turn.session).toContain('simple answer')
    expect(turn.shutdown).toBe('graceful')

    // #and the relay's stop line reports nothing acknowledged, the batches as retry or dropped, and no value
    expect(turn.relayStop?.counts).not.toBe('incomplete')
    const counts = turn.relayStop?.counts
    if (counts === undefined || counts === 'incomplete') throw new Error('the relay did not report its counts')
    expect(counts.delivered).toBe(0)
    expect(counts.retry + counts.dropped).toBeGreaterThan(0)
    const stopLine = vi.mocked(turn.relayLog.info).mock.calls.find(call => call[0] === 'Trace relay stopped')
    expect(stopLine?.[1]).toMatchObject({acknowledged: 0})
    for (const form of CREDENTIAL_FORMS) expect(serializeLoggerCalls(turn.relayLog)).not.toContain(form)
  }, 180_000)

  it('sends nothing, and starts no relay, for a checkout and a restored session directory that name a tracing endpoint, with tracing off', async () => {
    // #given tracing off, and an endpoint named in the checkout, in the restored data and state, and in a user settings file
    // that a local session would honour, all pointing at a recording sink; plus OTEL_* in the job
    const sink = await startPlainSink()
    cleanups.push(sink.stop)
    const settings = JSON.stringify({version: 1, endpoint: sink.url, hosts: [os.hostname()]})
    const planted = (box: Box): void => {
      writeFileSync(path.join(box.repo, '.fro-bot-tracing.json'), settings)
      writeFileSync(
        path.join(box.repo, 'opencode.json'),
        JSON.stringify({plugins: [['@fro.bot/opencode-plugin', {tracing: {endpoint: sink.url}}]]}),
      )
      for (const dir of ['home/data/opencode', 'home/state', 'home/state/opencode']) {
        mkdirSync(path.join(box.root, dir), {recursive: true})
        writeFileSync(path.join(box.root, dir, 'tracing.json'), settings)
      }
      const userDir = path.join(box.home, 'config/fro-bot/opencode-plugin')
      mkdirSync(userDir, {recursive: true})
      writeFileSync(path.join(userDir, 'tracing.json'), settings, {mode: 0o600})
    }

    // #when a turn runs with the Action's launcher saying off
    const turn = await runTurn({
      tracing: 'off',
      steps: SIMPLE,
      prompt: 'S-ONE hello',
      finalText: 'simple answer',
      plant: planted,
      jobEnv: {OTEL_EXPORTER_OTLP_ENDPOINT: sink.url, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${sink.url}/v1/traces`},
    })
    // #then the run worked as it does today and nothing reached the sink; the server has left, so nothing can still be on its way
    expect(turn.started.success).toBe(true)
    expect(turn.shutdown).toBe('graceful')
    expect(turn.session).toContain('simple answer')
    expect(turn.relay).toBeNull()
    expect(sink.requests).toEqual([])
    // and the plugin order is the one it has today: this plugin before the operator's
    expect(turn.configuredPlugins).toEqual([
      expect.stringMatching(/^@fro\.bot\/systematic@/),
      expect.stringMatching(/^@fro\.bot\/opencode-plugin@/),
      expect.stringContaining('stub-operator'),
    ])
  }, 180_000)
})

/**
 * One Action run's two traces against the real binary: the lifecycle tracer (real, exporting to its own loopback collector: the
 * test process does not trust the turn collector's certificate, and the lifecycle exporter verifies TLS), and one turn with the
 * link the Action computes and sends (`buildTraceSessionId` and `buildTracingRunLink`, as `run()` uses them).
 */
async function linkedRun(repository: {readonly owner: string; readonly repo: string}) {
  const lifecycleSink = await startOtlpSink()
  cleanups.push(lifecycleSink.stop)
  const registry = createSecretRegistry(() => undefined)
  const tracer = createLifecycleTracer({
    inputs: {enabled: true, url: lifecycleSink.url, headers: []},
    logger: createMockLogger(),
    registry,
    env: {},
    identity: {
      repository: `${repository.owner}/${repository.repo}`,
      runId: '4242',
      attempt: '3',
      job: 'review',
      trigger: 'issue_comment',
    },
  })
  expect(tracer.enabled).toBe(true)
  const sessionId = buildTraceSessionId(repository.owner, repository.repo, 'issue-42', createRegistryScrubber(registry))
  if (sessionId !== undefined) tracer.setSessionId(sessionId)
  const phase = tracer.startSpan('execution')

  const turn = await runTurn({
    tracing: 'on',
    upstream: 'up',
    steps: SIMPLE,
    prompt: 'S-ONE hello',
    finalText: 'simple answer',
    link: buildTracingRunLink(tracer.ids, sessionId),
  })
  phase.end({outcome: 'succeeded'})
  tracer.root.end({outcome: 'succeeded'})
  await tracer.flush()
  return {sessionId, tracer, turn, lifecycle: decodeSpans(lifecycleSink.accepted())}
}

describe.skipIf(!enabled)(
  'the lifecycle trace and the turn trace of one run, against the real binary and the built plugin',
  () => {
    it('give every span the same session and invocation id, and link the turn root to the lifecycle root span', async () => {
      // #given / #when one run's lifecycle trace and its turn
      const {sessionId, tracer, turn, lifecycle} = await linkedRun({owner: 'owner', repo: 'repo'})

      // #then both traces were delivered
      expect(sessionId).toBe('owner/repo:issue-42')
      expect(turn.started.success).toBe(true)
      expect(lifecycle.map(span => span.name).toSorted()).toEqual(['action.main', 'execution'])
      expect(turn.spans.length).toBeGreaterThan(0)

      // #and every span of both carries the identical Langfuse session and invocation id
      const root = lifecycle.find(span => span.name === 'action.main')
      expect(root?.traceId).toBe(tracer.ids?.traceId)
      expect(root?.spanId).toBe(tracer.ids?.rootSpanId)
      for (const span of [...lifecycle, ...turn.spans]) {
        expect(span.attrs['langfuse.session.id']).toBe('owner/repo:issue-42')
        expect(span.attrs['fro_bot.invocation.id']).toBe(tracer.ids?.invocationId)
      }

      // #and the turn is its own trace, whose root links to the lifecycle root span and whose other spans link to nothing
      const turnRoot = turn.spans.find(isRoot)
      expect(turnRoot).toBeDefined()
      expect(turnRoot?.traceId).not.toBe(root?.traceId)
      expect(turnRoot?.links).toEqual([{traceId: root?.traceId, spanId: root?.spanId}])
      for (const span of turn.spans.filter(span => !isRoot(span))) expect(span.links).toEqual([])
      // #and the OpenCode session is still each turn span's own `session.id`, apart from the shared Langfuse session
      for (const span of turn.spans) expect(span.attrs['session.id']).not.toBe('owner/repo:issue-42')
    }, 180_000)

    it('gives two repositories on the same issue number one session each, shared by that repository’s two traces, and different from each other', async () => {
      // #given two runs, one per repository, both on issue 42
      const first = await linkedRun({owner: 'fro-bot', repo: 'agent'})
      const second = await linkedRun({owner: 'fro-bot', repo: 'other'})

      // #when each run's spans are grouped by session
      const sessionsOf = (run: typeof first): Set<unknown> =>
        new Set([...run.lifecycle, ...run.turn.spans].map(span => span.attrs['langfuse.session.id']))

      // #then each repository's lifecycle and turn spans share exactly one session, and the two differ
      expect(sessionsOf(first)).toEqual(new Set(['fro-bot/agent:issue-42']))
      expect(sessionsOf(second)).toEqual(new Set(['fro-bot/other:issue-42']))
      expect(first.sessionId).not.toBe(second.sessionId)
      // #and the runs are separate traces, each turn root linking to its own run's root
      expect(first.tracer.ids?.traceId).not.toBe(second.tracer.ids?.traceId)
      expect(first.turn.spans.find(isRoot)?.links).toEqual([
        {traceId: first.tracer.ids?.traceId, spanId: first.tracer.ids?.rootSpanId},
      ])
      expect(second.turn.spans.find(isRoot)?.links).toEqual([
        {traceId: second.tracer.ids?.traceId, spanId: second.tracer.ids?.rootSpanId},
      ])
    }, 360_000)

    it('keeps the OpenCode session, and links nothing, when the Action sends no session id', async () => {
      // #given a link with the root span and invocation id but no session (no scrub-safe id existed)
      const link: TracingRunLink = {
        rootSpan: {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)},
        invocationId: 'c'.repeat(16),
      }

      // #when
      const turn = await runTurn({
        tracing: 'on',
        upstream: 'up',
        steps: SIMPLE,
        prompt: 'S-ONE hello',
        finalText: 'simple answer',
        link,
      })

      // #then the Langfuse session is OpenCode's own on every span, and the link and invocation id are still there
      expect(turn.started.success).toBe(true)
      for (const span of turn.spans) {
        expect(span.attrs['langfuse.session.id']).toBe(span.attrs['session.id'])
        expect(span.attrs['fro_bot.invocation.id']).toBe(link.invocationId)
      }
      expect(turn.spans.find(isRoot)?.links).toEqual([{traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}])
    }, 180_000)
  },
)
