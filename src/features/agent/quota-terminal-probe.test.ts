/**
 * Cross-version terminal-error evidence gate for quota exhaustion.
 *
 * Gate: OPENCODE_QUOTA_PROBE=1 (skipped in normal CI, like live-probe-1.17.20.test.ts).
 * Fixture A: non-retryable 402 insufficient_quota — positive control for OpenCode's terminal contract.
 * Fixture B: retryable 429 GoUsageLimitError (retry-after: 64560s) — the exact production shape.
 *
 * Run: OPENCODE_QUOTA_PROBE=1 bunx vitest run src/features/agent/quota-terminal-probe.test.ts
 */
import type {Event} from '@opencode-ai/sdk'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {createOpencode} from '@opencode-ai/sdk'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

const PROBE_ENABLED = process.env.OPENCODE_QUOTA_PROBE === '1'
const PROBE_TIMEOUT_MS = 45_000
const RETRY_GRACE_MS = 3_000

const WEEKLY_LIMIT_MESSAGE =
  'Weekly usage limit reached. Resets in 17hr 56min. To continue using this model now, enable usage from your available balance.'

const QUOTA_402_FIXTURE_BODY = JSON.stringify({
  error: {
    message: WEEKLY_LIMIT_MESSAGE,
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  },
})

const GO_USAGE_LIMIT_RETRY_AFTER_SECONDS = '64560'

const GO_USAGE_LIMIT_FIXTURE_BODY = JSON.stringify({
  error: {
    message: 'Subscription quota exceeded. You can continue using free models.',
    type: 'GoUsageLimitError',
  },
  metadata: {
    workspace: 'wrk_fixture',
    limitName: 'Weekly',
  },
})

interface QuotaFixtureServer {
  readonly baseURL: string
  readonly close: () => Promise<void>
}

async function startFixtureServer(
  status: number,
  headers: Record<string, string>,
  body: string,
): Promise<QuotaFixtureServer> {
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(status, {'content-type': 'application/json', ...headers})
      res.end(body)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address == null || typeof address === 'string') {
        reject(new Error('Fixture server failed to bind to a TCP port'))
        return
      }
      resolve({
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        close: async () =>
          new Promise<void>(res => {
            server.close(() => res())
          }),
      })
    })
  })
}

interface IsolatedEnv {
  readonly home: string
  readonly binDir: string
  readonly opencodeBin: string
  readonly originalEnv: Record<string, string | undefined>
}

/** `npmSpec` is the exact `bun x` target, e.g. "opencode-ai@1.17.20" or "@fro.bot/harness@1.17.20-harness.b78cc9e1". */
function createIsolatedEnv(suffix: string, npmSpec: string): IsolatedEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `oc-quota-probe-${suffix}-`))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, {recursive: true})

  const opencodeBin = path.join(binDir, 'opencode')
  fs.writeFileSync(
    opencodeBin,
    `#!/bin/sh
exec bun x ${npmSpec} "$@"
`,
    {mode: 0o755},
  )

  const originalEnv: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  }

  process.env.HOME = home
  process.env.PATH = `${binDir}:${originalEnv.PATH ?? ''}`
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share')
  process.env.XDG_CACHE_HOME = path.join(home, '.cache')

  return {home, binDir, opencodeBin, originalEnv}
}

function restoreEnv(originalEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function cleanupIsolatedEnv(env: IsolatedEnv): void {
  restoreEnv(env.originalEnv)
  try {
    fs.rmSync(env.home, {recursive: true, force: true})
  } catch {
    // best-effort cleanup
  }
}

function getProp(value: unknown, key: string): unknown {
  if (value == null || typeof value !== 'object') return null
  return Object.getOwnPropertyDescriptor(value, key)?.value ?? null
}

interface ArtifactSpec {
  readonly label: string
  readonly npmSpec: string
  readonly expectedVersionSubstring: string
}

const ARTIFACTS: readonly ArtifactSpec[] = [
  {
    label: 'production-era (@fro.bot/harness@1.17.18-harness.4ec05a47)',
    npmSpec: '@fro.bot/harness@1.17.18-harness.4ec05a47',
    expectedVersionSubstring: '1.17.18',
  },
  {
    label: 'current stock (opencode-ai@1.17.20)',
    npmSpec: 'opencode-ai@1.17.20',
    expectedVersionSubstring: '1.17.20',
  },
  {
    label: 'current harness (@fro.bot/harness@1.17.20-harness.b78cc9e1)',
    npmSpec: '@fro.bot/harness@1.17.20-harness.b78cc9e1',
    expectedVersionSubstring: '1.17.20',
  },
] as const

async function startIsolatedServer(
  spec: ArtifactSpec,
  fixtureBaseURL: string,
  suffix: string,
): Promise<{
  env: IsolatedEnv
  opencode: Awaited<ReturnType<typeof createOpencode>>
  abortController: AbortController
  sessionId: string
  eventStream: AsyncIterable<Event>
}> {
  const env = createIsolatedEnv(suffix, spec.npmSpec)
  const abortController = new AbortController()

  const versionOutput = childProcess
    .execSync(`"${env.opencodeBin}" --version`, {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']})
    .trim()
  expect(versionOutput).toContain(spec.expectedVersionSubstring)

  const opencode = await createOpencode({
    signal: abortController.signal,
    timeout: 30_000,
    port: 0,
    config: {
      permission: {bash: 'allow', edit: 'allow'},
      provider: {
        'quota-fixture': {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: fixtureBaseURL,
            apiKey: 'fake-probe-key-not-a-credential',
          },
          models: {
            'fixture-model': {name: 'Quota Fixture Model'},
          },
        },
      },
      model: 'quota-fixture/fixture-model',
    },
  })

  const {client} = opencode
  const sessionResponse = await client.session.create()
  expect(sessionResponse.data).toBeDefined()
  const sessionId = sessionResponse.data?.id
  if (sessionId == null) throw new Error('session.create() returned no id')

  const eventSubscription = await client.event.subscribe()
  const eventStream = eventSubscription.stream as AsyncIterable<Event>

  await client.session.promptAsync({
    path: {id: sessionId},
    body: {
      parts: [{type: 'text', text: 'Say hello.'}],
      model: {providerID: 'quota-fixture', modelID: 'fixture-model'},
    },
    query: {directory: process.cwd()},
  })

  return {env, opencode, abortController, sessionId, eventStream}
}

interface TerminalMatrix {
  readonly observedEventTypes: string[]
  sessionErrorObserved: boolean
  sessionErrorPayload: unknown
  sessionIdleObserved: boolean
  processCompleted: boolean
  elapsedMs: number
}

async function captureTerminalMatrix(
  eventStream: AsyncIterable<Event>,
  sessionId: string,
  boundMs: number,
): Promise<TerminalMatrix> {
  const matrix: TerminalMatrix = {
    observedEventTypes: [],
    sessionErrorObserved: false,
    sessionErrorPayload: null,
    sessionIdleObserved: false,
    processCompleted: false,
    elapsedMs: 0,
  }
  const start = Date.now()
  let settled = false

  const consume = (async () => {
    for await (const event of eventStream) {
      const eventType = String(getProp(event, 'type') ?? 'unknown')
      matrix.observedEventTypes.push(eventType)
      const properties = getProp(event, 'properties') ?? getProp(event, 'data')

      if (eventType === 'session.error') {
        const sid = getProp(properties, 'sessionID')
        if (sid === sessionId || sid == null) {
          matrix.sessionErrorObserved = true
          matrix.sessionErrorPayload = getProp(properties, 'error')
        }
      }

      if (eventType === 'session.idle') {
        const sid = getProp(properties, 'sessionID')
        if (sid === sessionId || sid == null) {
          matrix.sessionIdleObserved = true
          settled = true
          break
        }
      }
    }
  })()

  await Promise.race([consume, new Promise<void>(resolve => setTimeout(resolve, boundMs))])
  matrix.processCompleted = settled
  matrix.elapsedMs = Date.now() - start
  return matrix
}

async function probePositiveControl(spec: ArtifactSpec, fixtureBaseURL: string): Promise<TerminalMatrix> {
  const {env, opencode, abortController, sessionId, eventStream} = await startIsolatedServer(
    spec,
    fixtureBaseURL,
    `${spec.expectedVersionSubstring}-a`,
  )
  try {
    return await captureTerminalMatrix(eventStream, sessionId, PROBE_TIMEOUT_MS)
  } finally {
    abortController.abort()
    opencode.server.close()
    cleanupIsolatedEnv(env)
  }
}

interface RetryMatrix {
  readonly observedEventTypes: string[]
  retryStatusObserved: boolean
  retryActionReason: string | null
  retryNext: number | null
  retryCapturedAtMs: number | null
  prematureSessionError: boolean
  prematureSessionIdle: boolean
  elapsedMs: number
}

/**
 * Stops exactly `RETRY_GRACE_MS` after the retry part is observed — via a timer, not the next
 * SSE event — so a quiet stream after the retry part doesn't fall through to `boundMs`.
 */
async function captureRetryMatrix(
  eventStream: AsyncIterable<Event>,
  sessionId: string,
  boundMs: number,
): Promise<RetryMatrix> {
  const matrix: RetryMatrix = {
    observedEventTypes: [],
    retryStatusObserved: false,
    retryActionReason: null,
    retryNext: null,
    retryCapturedAtMs: null,
    prematureSessionError: false,
    prematureSessionIdle: false,
    elapsedMs: 0,
  }
  const start = Date.now()
  const iterator = eventStream[Symbol.asyncIterator]()

  let stop: () => void = () => {}
  const stopped = new Promise<void>(resolve => {
    stop = resolve
  })
  const overallTimer = setTimeout(stop, boundMs)
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  try {
    for (;;) {
      const outcome = await Promise.race([
        iterator.next().then(
          result => ({kind: 'event' as const, result}),
          () => ({kind: 'stop' as const}),
        ),
        stopped.then(() => ({kind: 'stop' as const})),
      ])
      if (outcome.kind === 'stop' || outcome.result.done === true) break

      const event = outcome.result.value
      const eventType = String(getProp(event, 'type') ?? 'unknown')
      matrix.observedEventTypes.push(eventType)
      const properties = getProp(event, 'properties') ?? getProp(event, 'data')
      const sid = getProp(properties, 'sessionID')
      const sessionMatches = sid === sessionId || sid == null

      if (eventType === 'session.status' && sessionMatches) {
        const status = getProp(properties, 'status')
        if (getProp(status, 'type') === 'retry') {
          matrix.retryStatusObserved = true
          matrix.retryCapturedAtMs = Date.now() - start
          const action = getProp(status, 'action')
          matrix.retryActionReason = action == null ? null : String(getProp(action, 'reason'))
          const next = getProp(status, 'next')
          matrix.retryNext = typeof next === 'number' ? next : null
          graceTimer ??= setTimeout(stop, RETRY_GRACE_MS)
        }
      }

      if (eventType === 'session.error' && sessionMatches) matrix.prematureSessionError = true
      if (eventType === 'session.idle' && sessionMatches) matrix.prematureSessionIdle = true
      if (matrix.prematureSessionError || matrix.prematureSessionIdle) break
    }
  } finally {
    clearTimeout(overallTimer)
    if (graceTimer != null) clearTimeout(graceTimer)
    try {
      await iterator.return?.()
    } catch {
      // stream already closed by caller's abort
    }
  }

  matrix.elapsedMs = Date.now() - start
  return matrix
}

async function probeProductionContract(spec: ArtifactSpec, fixtureBaseURL: string): Promise<RetryMatrix> {
  const {env, opencode, abortController, sessionId, eventStream} = await startIsolatedServer(
    spec,
    fixtureBaseURL,
    `${spec.expectedVersionSubstring}-b`,
  )
  try {
    return await captureRetryMatrix(eventStream, sessionId, PROBE_TIMEOUT_MS)
  } finally {
    abortController.abort()
    opencode.server.close()
    cleanupIsolatedEnv(env)
  }
}

describe.skipIf(PROBE_ENABLED === false)(
  'Cross-version terminal-error evidence gate (quota exhaustion)',
  {timeout: PROBE_TIMEOUT_MS * ARTIFACTS.length * 2 + 30_000},
  () => {
    let fixtureA: QuotaFixtureServer
    let fixtureB: QuotaFixtureServer

    beforeAll(async () => {
      fixtureA = await startFixtureServer(402, {}, QUOTA_402_FIXTURE_BODY)
      fixtureB = await startFixtureServer(
        429,
        {'retry-after': GO_USAGE_LIMIT_RETRY_AFTER_SECONDS},
        GO_USAGE_LIMIT_FIXTURE_BODY,
      )
    })

    afterAll(async () => {
      await fixtureA.close()
      await fixtureB.close()
    })

    for (const spec of ARTIFACTS) {
      it(
        `(A) positive control — non-retryable 402 insufficient_quota terminates cleanly — ${spec.label}`,
        {timeout: PROBE_TIMEOUT_MS + 15_000},
        async () => {
          const matrix = await probePositiveControl(spec, fixtureA.baseURL)

          expect(matrix.processCompleted, `${spec.label} must reach session.idle within ${PROBE_TIMEOUT_MS}ms`).toBe(
            true,
          )
          expect(matrix.sessionErrorObserved, `${spec.label} must surface a structured session.error`).toBe(true)
          expect(matrix.sessionIdleObserved, `${spec.label} must reach session.idle`).toBe(true)
        },
      )

      it(
        `(B) characterization — exact production GoUsageLimitError contract yields a retry part, not a terminal error — ${spec.label}`,
        {timeout: PROBE_TIMEOUT_MS + 15_000},
        async () => {
          const matrix = await probeProductionContract(spec, fixtureB.baseURL)

          expect(matrix.retryStatusObserved, `${spec.label} must emit a session.status retry part`).toBe(true)
          expect(matrix.retryActionReason, `${spec.label} retry action.reason`).toBe('account_rate_limit')
          expect(matrix.retryNext, `${spec.label} retry.next must be a timestamp`).not.toBeNull()
          // retry-after: 64560s = 17h56m — bound tight enough to prove header-derived delay, loose enough for test slop.
          const deltaMs = (matrix.retryNext ?? 0) - Date.now()
          expect(deltaMs, `${spec.label} retry.next must be ~17-19h out (retry-after: 64560s)`).toBeGreaterThan(
            17 * 60 * 60 * 1000,
          )
          expect(deltaMs, `${spec.label} retry.next must be ~17-19h out (retry-after: 64560s)`).toBeLessThan(
            19 * 60 * 60 * 1000,
          )
          expect(
            matrix.prematureSessionError,
            `${spec.label} must NOT surface session.error before the intentionally short observation bound`,
          ).toBe(false)
          expect(
            matrix.prematureSessionIdle,
            `${spec.label} must NOT surface session.idle before the intentionally short observation bound`,
          ).toBe(false)
        },
      )
    }
  },
)
