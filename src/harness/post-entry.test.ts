import type {OtlpSink, TlsSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {Buffer} from 'node:buffer'
import {spawn, spawnSync} from 'node:child_process'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {opensslAvailable, startOtlpSink, startTlsSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'

vi.setConfig({testTimeout: 60_000})

const hasBun = spawnSync('bun', ['--version']).status === 0

/**
 * The real post entry point (`src/post.ts`) as a process, the way the runner starts it: state in `STATE_*`, inputs in
 * `INPUT_*`. What only a process can show: that it ends within its bound however long the collector asks it to wait, and
 * that nothing the trace uses ever reaches its stdout or stderr outside the runner's own masking commands.
 */
const IDS = {traceId: 'd'.repeat(32), rootSpanId: 'e'.repeat(16), invocationId: 'f'.repeat(16)}
const USER = 'post-entry-user-0001'
const PASSWORD = 'post-entry-password-0002'
const ENCODED = Buffer.from(`${USER}:${PASSWORD}`).toString('base64')
const BASIC = `Basic ${ENCODED}`

interface EntryRun {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly elapsedMs: number
  readonly stdout: string
  readonly stderr: string
  /** Everything the process printed except the runner's `::add-mask::` commands (which carry the values on purpose). */
  readonly visible: string
}

async function runEntry(env: Record<string, string>, limitMs = 40_000): Promise<EntryRun> {
  const started = Date.now()
  const child = spawn('bun', [path.join(import.meta.dirname, '..', 'post.ts')], {
    env: {
      ...process.env,
      NODE_DEBUG: '',
      GITHUB_REPOSITORY: 'fro-bot/agent',
      GITHUB_RUN_ID: '77',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_JOB: 'triage',
      // The skip path: nothing here touches a cache, a store or the network but the collector.
      STATE_shouldSaveCache: 'false',
      STATE_lifecycleTrace: JSON.stringify(IDS),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const outcome = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, limitMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({code, signal})
    })
  })
  const visible = `${stdout}\n${stderr}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  return {...outcome, elapsedMs: Date.now() - started, stdout, stderr, visible}
}

describe.skipIf(!hasBun)('the post entry point as a process', () => {
  const sinks: (OtlpSink | TlsSink)[] = []
  afterEach(async () => {
    await Promise.all(sinks.splice(0).map(async sink => sink.stop()))
  })

  it('ends within its bound when the collector answers 503 with a Retry-After longer than that bound', async () => {
    // #given a collector that asks the SDK to come back in 9 s (the longest wait it honours, past the 6 s export bound)
    const sink = await startOtlpSink({
      respond: n => (n === 1 ? {status: 503, headers: {'Retry-After': '9'}} : {status: 200}),
    })
    sinks.push(sink)

    // #when the post step runs
    const result = await runEntry({'INPUT_TRACE-ENDPOINT': sink.url})

    // #then it ended cleanly at the export bound. The SDK's retry timer (a plain referenced `setTimeout`, nine seconds here)
    // would hold a process that waits for its event loop to drain until it fired; the entry point does not wait for it.
    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(sink.received()).toBe(1)
    expect(result.elapsedMs).toBeLessThan(8_000)
  })

  it('ends at once, with a span delivered, when the collector answers', async () => {
    // #given a healthy collector
    const sink = await startOtlpSink()
    sinks.push(sink)

    // #when
    const result = await runEntry({'INPUT_TRACE-ENDPOINT': sink.url})

    // #then
    expect(result.code).toBe(0)
    expect(sink.accepted()).toHaveLength(1)
    expect(sink.accepted()[0]?.text).toContain('"name":"post"')
  })

  it('ends as it always did, with nothing sent, when there is no trace record', async () => {
    // #given inputs but no state record
    const sink = await startOtlpSink()
    sinks.push(sink)

    // #when
    const result = await runEntry({'INPUT_TRACE-ENDPOINT': sink.url, STATE_lifecycleTrace: ''})

    // #then
    expect(result.code).toBe(0)
    expect(sink.received()).toBe(0)
    expect(result.visible).not.toContain('::warning::')
  })

  describe.each(['*', 'HT*'])('with NODE_DEBUG=%s', value => {
    it('sends nothing, says so once in fixed text, and prints neither the endpoint nor the credential', async () => {
      // #given a collector and Node's transport debug output switched on
      const sink = await startOtlpSink()
      sinks.push(sink)

      // #when
      const result = await runEntry({
        'INPUT_TRACE-ENDPOINT': sink.url,
        NODE_DEBUG: value,
      })

      // #then
      expect(result.code).toBe(0)
      expect(sink.received()).toBe(0)
      expect(result.visible.match(/NODE_DEBUG is set/g) ?? []).toHaveLength(1)
      expect(result.visible).not.toContain(sink.url)
      expect(result.visible).not.toContain(new URL(sink.url).host)
    })
  })

  it.skipIf(!opensslAvailable())(
    'sends the credential only as a header, never in the body, and prints no form of it',
    async () => {
      // #given a TLS collector the process is told to trust, and a session id that carries the credential's password
      const sink = await startTlsSink()
      sinks.push(sink)

      // #when
      const result = await runEntry({
        'INPUT_TRACE-ENDPOINT': sink.url,
        'INPUT_TRACE-HEADERS': `Authorization: ${BASIC}`,
        NODE_EXTRA_CA_CERTS: sink.certFile,
        STATE_lifecycleSession: `fro-bot/agent:${PASSWORD}`,
      })

      // #then the span arrived, with the credential in the Authorization header only
      expect(result.code).toBe(0)
      expect(sink.requests).toHaveLength(1)
      const request = sink.requests[0]
      expect(request?.headers.authorization).toBe(BASIC)
      const body = request?.text ?? ''
      for (const form of [BASIC, ENCODED, `${USER}:${PASSWORD}`, PASSWORD]) expect(body).not.toContain(form)
      // #and the session id that held the password was dropped, not sent redacted
      expect(body).not.toContain('langfuse.session.id')
      // #and nothing the process printed (apart from the runner's mask commands) carries the endpoint or any form of the credential
      for (const form of [sink.url, BASIC, ENCODED, `${USER}:${PASSWORD}`, PASSWORD]) {
        expect(result.visible).not.toContain(form)
      }
      // #and every form was handed to the runner's masking
      expect(result.stdout).toContain(`::add-mask::${PASSWORD}`)
    },
  )
})
