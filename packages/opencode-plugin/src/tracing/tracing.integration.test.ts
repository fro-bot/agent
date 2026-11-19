/**
 * Tracing end to end, in a real OpenCode V2 server with the built plugin, against loopback OTLP sinks and a scripted
 * provider. Skipped unless `FRO_BOT_OPENCODE_V2_BIN` points at a binary and `dist/index.mjs` exists.
 *
 * The exporter sends OTLP/HTTP with a JSON body (the SDK's `JsonTraceSerializer`), so the sinks decode it directly.
 */

import type {FakeStep, OtlpSink, OtlpSinkOptions, RunningServer, SandboxPaths} from '../integration.fixture.js'
import type {DecodedSpan} from './tracing.integration.fixture.js'

import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {
  makeSandbox,
  removeSandbox,
  startFakeProvider,
  startOpenCodeServer,
  startOtlpSink,
  startTlsSink,
} from '../integration.fixture.js'
import {TRACING_LAUNCHER_ENV, userSettingsFilePath} from './settings.js'
import {
  allStrings,
  createSession,
  decodeSpans,
  FIXTURE_SECRETS,
  idleMessages,
  outline,
  prompt,
  secretLines,
  secretNeedles,
  sleep,
  waitUntil,
} from './tracing.integration.fixture.js'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const binary = process.env.FRO_BOT_OPENCODE_V2_BIN
const runnable =
  binary != null && binary.length > 0 && existsSync(binary) && existsSync(path.join(packageDir, 'dist/index.mjs'))
const OUTLINE_DIR = process.env.FRO_BOT_TRACE_OUTLINE_DIR

const NOT_TOOL = '"role":"tool"'
const IDENTITY = {repository: 'fro-bot/agent', runId: '77', attempt: '1', job: 'it', trigger: 'workflow_dispatch'}

const readTool = (file: string): {name: string; args: unknown} => ({name: 'read', args: {path: file}})
const subagentTool = (description: string, text: string): {name: string; args: unknown} => ({
  name: 'subagent',
  args: {agent: 'general', description, prompt: text},
})

const launcherOn = (relay: string): Record<string, string> => ({
  [TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'action', tracing: 'on', relay, identity: IDENTITY}),
})

interface Harness {
  readonly sandbox: SandboxPaths
  readonly sink: OtlpSink
  readonly requests: () => string
  readonly server: RunningServer
  readonly api: RunningServer['api']
  readonly stop: () => Promise<void>
  /** Starts a session in the sandbox repo. */
  readonly session: () => Promise<string>
  readonly spans: () => DecodedSpan[]
}

interface HarnessOptions {
  readonly steps: readonly FakeStep[]
  /** Environment for the server; default is an Action launcher pointing at the sink. */
  readonly env?: (sinkUrl: string, sandbox: SandboxPaths) => Record<string, string>
  readonly sink?: OtlpSinkOptions
  /** Use this URL instead of the sink's (for a refused connection). */
  readonly localMode?: boolean
  /** Plain `opencode serve`, not `--stdio`. */
  readonly plain?: boolean
  readonly beforeStart?: (sandbox: SandboxPaths, sink: OtlpSink) => void
  readonly config?: Record<string, unknown>
}

const started: Harness[] = []

async function harness(options: HarnessOptions): Promise<Harness> {
  const sandbox = makeSandbox()
  const provider = await startFakeProvider()
  provider.script(options.steps)
  const sink = await startOtlpSink(options.sink)
  options.beforeStart?.(sandbox, sink)
  const server = await startOpenCodeServer({
    binary: binary ?? '',
    sandbox,
    pluginDir: packageDir,
    providerBaseURL: provider.baseURL,
    env: options.env?.(sink.url, sandbox) ?? launcherOn(sink.url),
    ...(options.localMode === true ? {localMode: true} : {}),
    ...(options.plain === true ? {plain: true} : {}),
    ...(options.config === undefined ? {} : {config: options.config}),
  })
  let stopped = false
  const made: Harness = {
    sandbox,
    sink,
    server,
    requests: () =>
      provider.requests
        .map(
          request =>
            `tools=${request.toolNames.length} msgs=${request.messages.map(message => message.role).join(',')} L-THREE=${request.body.includes('L-THREE')} roleTool=${request.body.includes(NOT_TOOL)}`,
        )
        .join('\n'),
    api: server.api,
    stop: async () => {
      if (stopped) return
      stopped = true
      await server.stop()
      await provider.stop()
      await sink.stop()
      removeSandbox(sandbox)
    },
    session: async () => {
      // The server boots a location, and so loads the plugin, on the first API call.
      await server.api('GET', '/api/plugin')
      return createSession(server.api, sandbox.repo)
    },
    spans: () => decodeSpans(sink.accepted()),
  }
  started.push(made)
  return made
}

const saveOutline = (name: string, spans: readonly DecodedSpan[]): void => {
  if (OUTLINE_DIR === undefined) return
  mkdirSync(OUTLINE_DIR, {recursive: true})
  writeFileSync(path.join(OUTLINE_DIR, `${name}.txt`), `${outline(spans)}\n`)
}

const isRoot = (span: DecodedSpan): boolean => span.name.startsWith('invoke_agent') && span.parentSpanId === undefined

describe.skipIf(!runnable)('tracing in a real opencode V2', () => {
  // Every test cleans up its own server, provider and sink, even when it fails.
  const run = async (options: HarnessOptions, body: (h: Harness) => Promise<void>): Promise<void> => {
    const h = await harness(options)
    try {
      await body(h)
    } finally {
      await h.stop()
    }
  }

  it('exports a turn with a tool and a background subagent as one trace with the expected tree and content', async () => {
    // #given a turn that reads a file holding secrets, dispatches a subagent, and gets its report afterwards
    const steps: FakeStep[] = [
      {all: ['REPORT-KID-T1'], text: 'parent follow-on after the report'},
      {
        all: ['T1-PARENT'],
        none: [NOT_TOOL, 'KID-T1'],
        tools: [readTool('secrets.txt'), subagentTool('a kid', `KID-T1 do the task ${FIXTURE_SECRETS.github.value}`)],
      },
      {
        all: ['T1-PARENT', NOT_TOOL],
        none: ['REPORT-KID-T1'],
        text: `dispatched; the key is ${FIXTURE_SECRETS.openai.value}`,
      },
      {all: ['KID-T1'], text: 'REPORT-KID-T1 done', delayMs: 300},
    ]
    await run({steps}, async h => {
      writeFileSync(path.join(h.sandbox.repo, 'secrets.txt'), `${secretLines()}\n`)
      const session = await h.session()

      // #when the prompt carrying a secret runs and the server stops
      await prompt(h.api, session, `T1-PARENT read secrets.txt and dispatch. ${FIXTURE_SECRETS.pair.value}`)
      await waitUntil('the root span', () => h.spans().some(isRoot), 60_000)
      await sleep(500)
      await h.stop()

      // #then everything is in one trace, with the tree the turn had
      const spans = h.spans()
      saveOutline('one-tool-one-subagent', spans)
      expect(new Set(spans.map(span => span.traceId)).size).toBe(1)
      const root = spans.find(isRoot)
      const byName = (name: string): DecodedSpan[] => spans.filter(span => span.name === name)
      const readSpan = byName('execute_tool read')[0]
      const dispatch = byName('execute_tool subagent')[0]
      const child = spans.find(
        span => span.name.startsWith('invoke_agent') && span.attrs['fro_bot.agent.role'] === 'child',
      )
      expect(readSpan?.parentSpanId).toBe(root?.spanId)
      expect(dispatch?.parentSpanId).toBe(root?.spanId)
      expect(child?.parentSpanId).toBe(dispatch?.spanId)
      // The child's span starts at or before its dispatching tool span ended, and ends after it: a background job.
      expect(child?.endMs).toBeGreaterThan(dispatch?.endMs ?? Number.POSITIVE_INFINITY)
      const chats = spans.filter(span => span.attrs['gen_ai.operation.name'] === 'chat')
      const parentChats = chats.filter(
        span => span.parentSpanId === root?.spanId && span.attrs['fro_bot.request.kind'] === 'primary',
      )
      expect(parentChats).toHaveLength(3)
      expect(chats.some(span => span.parentSpanId === child?.spanId)).toBe(true)
      expect(chats.some(span => span.attrs['fro_bot.request.kind'] === 'title')).toBe(true)

      // #and the content is the turn's: system instructions, tool definitions, history, output, tool arguments and result
      const first = parentChats[0] as DecodedSpan
      expect(first.attrs['fro_bot.content.view']).toBe('hook-time')
      expect(first.attrs['gen_ai.provider.name']).toBe('fake')
      expect(first.attrs['gen_ai.request.model']).toBe('fixture-model')
      expect(first.attrs['gen_ai.agent.name']).toBe('build')
      for (const name of [
        'gen_ai.system_instructions',
        'gen_ai.tool.definitions',
        'gen_ai.input.messages',
        'gen_ai.output.messages',
      ]) {
        expect(typeof JSON.parse(String(first.attrs[name]))).toBe('object')
      }
      expect(String(first.attrs['gen_ai.input.messages'])).toContain('T1-PARENT')
      const output = JSON.parse(String(first.attrs['gen_ai.output.messages'])) as {
        role: string
        parts: {type: string; name?: string; arguments?: unknown}[]
      }[]
      expect(output[0]?.role).toBe('assistant')
      expect(
        output[0]?.parts.filter(part => part.type === 'tool_call').map(part => [part.name, part.arguments]),
      ).toEqual([
        ['read', {path: 'secrets.txt'}],
        ['subagent', expect.anything()],
      ])
      expect(first.attrs['gen_ai.usage.input_tokens']).toBeGreaterThan(0)
      expect(JSON.parse(String(readSpan?.attrs['gen_ai.tool.call.arguments']))).toEqual({path: 'secrets.txt'})
      expect(String(readSpan?.attrs['gen_ai.tool.call.result'])).toContain('database_password')
      expect(String(readSpan?.attrs['gen_ai.tool.call.result'])).toContain('[REDACTED]')
      expect(root?.attrs['gen_ai.input.messages']).toBeDefined()

      // #and identity: every span names itself and the root session, and carries the run identity (Action mode)
      const rootSession = root?.attrs['session.id']
      for (const span of spans) {
        expect(span.attrs['fro_bot.root_session.id']).toBe(rootSession)
        expect(span.attrs['fro_bot.repository']).toBe('fro-bot/agent')
        expect(span.attrs['fro_bot.run.id']).toBe('77')
        expect(typeof span.attrs['session.id']).toBe('string')
      }
      expect(child?.attrs['session.id']).not.toBe(rootSession)

      // #and no fixture secret is in any string of any request the sink received
      const needles = secretNeedles()
      const leaked = h.sink.requests
        .flatMap(request => allStrings(request.body))
        .filter(text => needles.some(needle => text.includes(needle)))
      expect(leaked).toEqual([])
      expect(h.sink.requests.map(request => request.text).join('\n')).not.toMatch(new RegExp(needles.join('|')))
    })
  }, 180_000)

  it('exports every span of a long session, and each span that lost content says so', async () => {
    // #given a session with a retried model call, large tool results, a background subagent and a manual compaction
    const SUMMARY =
      '## Objective\n- J\n\n## Requirements\n- (none)\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- (none)\n\n### Active\n- (none)\n\n### Blocked\n- (none)\n\n## Next Move\n1. (none)\n\n## Relevant Files\n- (none)\n\n## Important Context\n- (none)'
    const steps: FakeStep[] = [
      {all: ['REPORT-LONG-KID'], text: 'follow-on after the long kid'},
      {all: ['L-ONE'], status: 503},
      {all: ['L-ONE'], text: 'one answered after a retry'},
      {
        all: ['L-TWO'],
        none: [NOT_TOOL, 'L-THREE'],
        tools: [readTool('big-1.txt'), readTool('big-2.txt'), readTool('README.md')],
      },
      {all: ['L-TWO', NOT_TOOL], none: ['L-THREE'], text: 'two answered after tools'},
      // The history already holds the earlier turn's tool results, so these two steps tell the turn's requests apart by
      // whether the dispatch is in the history yet, not by the presence of a tool message.
      {all: ['L-THREE'], none: ['LONG-KID'], tools: [subagentTool('long kid', 'LONG-KID work')]},
      {all: ['L-THREE', 'LONG-KID'], none: ['REPORT-LONG-KID'], text: 'three dispatched'},
      {all: ['LONG-KID'], text: 'REPORT-LONG-KID done', delayMs: 1500},
      {text: SUMMARY},
    ]
    await run({steps}, async h => {
      writeFileSync(
        path.join(h.sandbox.repo, 'big-1.txt'),
        `${'line of text that is fairly long, about eighty characters in all, to fill\n'.repeat(20_000)}`,
      )
      writeFileSync(
        path.join(h.sandbox.repo, 'big-2.txt'),
        `${'another line, this one also long enough to matter once there are many of them\n'.repeat(20_000)}`,
      )
      const session = await h.session()
      // A turn is over when its root span has been exported: the root closes at the end of the execution.
      const turnDone = async (text: string, marker: string): Promise<void> => {
        const before = h.spans().filter(isRoot).length
        await prompt(h.api, session, text)
        await waitUntil(
          `the ${marker} turn's root span`,
          () => h.spans().filter(isRoot).length > before,
          60_000,
          () => `spans so far:\n${outline(h.spans())}\nserver stderr:\n${h.server.stderr().slice(-1_500)}`,
        )
      }

      // #when the turns run, then a manual compaction, then the server stops
      await turnDone('L-ONE first', 'L-ONE')
      await turnDone('L-TWO read the big files', 'L-TWO')
      await prompt(h.api, session, 'L-THREE dispatch the long kid')
      await waitUntil(
        'the third turn and its subagent',
        () => h.spans().some(span => span.name === 'invoke_agent general'),
        60_000,
        () => `provider requests:\n${h.requests()}\nspans so far:\n${outline(h.spans())}`,
      )
      await sleep(4_000)
      await h.api('POST', `/api/session/${session}/compact`, {body: {}})
      await waitUntil(
        'the compaction span',
        () => h.spans().some(span => span.attrs['fro_bot.request.kind'] === 'compaction'),
        60_000,
      )
      await sleep(1_000)
      await h.stop()

      // #then every span is there
      const spans = h.spans()
      saveOutline('long-session', spans)
      const chats = spans.filter(span => span.attrs['gen_ai.operation.name'] === 'chat')
      const kind = (value: string): DecodedSpan[] => chats.filter(span => span.attrs['fro_bot.request.kind'] === value)
      const reads = spans.filter(span => span.name === 'execute_tool read')
      expect(reads).toHaveLength(3)
      expect(spans.filter(span => span.name === 'execute_tool subagent')).toHaveLength(1)
      expect(spans.filter(span => span.attrs['fro_bot.agent.role'] === 'child')).toHaveLength(1)
      expect(kind('compaction')).toHaveLength(1)
      expect(kind('title').length).toBeGreaterThanOrEqual(1)

      // #and the retry shows as two model spans, the first failed
      const attempts = kind('primary').filter(
        span =>
          JSON.stringify(span.attrs['gen_ai.input.messages']).includes('L-ONE') &&
          !JSON.stringify(span.attrs['gen_ai.input.messages']).includes('L-TWO'),
      )
      expect(attempts.map(span => [span.attrs['fro_bot.request.attempt'], span.status.code])).toEqual([
        [1, 2],
        [2, 0],
      ])
      expect(attempts[0]?.attrs['fro_bot.span.gaps']).toEqual(expect.arrayContaining(['output']))
      expect(attempts[0]?.attrs['gen_ai.response.finish_reasons']).toEqual(['error'])

      // #and title and compaction requests have no finish reason and say so
      for (const span of [...kind('title'), ...kind('compaction')]) {
        expect(span.attrs['gen_ai.response.finish_reasons']).toBeUndefined()
        expect(span.attrs['fro_bot.span.gaps']).toEqual(expect.arrayContaining(['finishReason']))
      }

      // #and a span that lost content says so: whatever the plugin cut or omitted is named on the span
      for (const span of spans) {
        for (const marker of ['fro_bot.content.truncated', 'fro_bot.content.omitted']) {
          const named = span.attrs[marker]
          if (named === undefined) continue
          expect(Array.isArray(named) && named.every(item => typeof item === 'string' && item.length > 0)).toBe(true)
        }
      }
      // A model span with no input history must name why.
      const silent = spans.filter(
        span =>
          span.attrs['fro_bot.request.kind'] !== undefined &&
          span.attrs['gen_ai.input.messages'] === undefined &&
          span.attrs['fro_bot.span.gaps'] === undefined &&
          span.attrs['fro_bot.content.omitted'] === undefined,
      )
      expect(silent).toEqual([])
      const cut = reads.filter(
        span =>
          span.attrs['fro_bot.tool.output_truncated'] === true || span.attrs['fro_bot.content.truncated'] !== undefined,
      )
      process.stdout.write(
        `[long-session] reads that lost content: ${cut.length} of ${reads.length}; spans ${spans.length}\n`,
      )
      for (const span of reads) {
        process.stdout.write(
          `[long-session] ${span.name} result chars ${String(span.attrs['gen_ai.tool.call.result']).length} own-truncated=${String(span.attrs['fro_bot.tool.output_truncated'])} cut=${JSON.stringify(span.attrs['fro_bot.content.truncated'])}\n`,
        )
      }
    })
  }, 300_000)

  /** A simple turn: one prompt, one answer. Returns once the root span is at the sink, or the stop has run. */
  const simpleSteps: FakeStep[] = [{all: ['S-ONE'], text: 'simple answer'}]

  it('completes the session and reports dropped spans when the destination refuses every connection', async () => {
    // #given an Action launcher whose relay address has nothing listening
    const closed = await startOtlpSink()
    const refusedUrl = closed.url
    await closed.stop()
    await run({steps: simpleSteps, env: () => launcherOn(refusedUrl)}, async h => {
      const session = await h.session()

      // #when a turn runs and the server stops
      await prompt(h.api, session, 'S-ONE hello')
      await sleep(4_000)
      await sleep(1_000)
      const answered = JSON.stringify(await idleMessages(h.api, session))
      await h.stop()

      // #then the session was answered, the plugin stayed active, and the log says spans were dropped, no values
      expect(answered).toContain('simple answer')
      const line = h.server
        .stderr()
        .split('\n')
        .find(text => text.includes('tracing stopped'))
      expect(line).toMatch(/^\[fro-bot\/opencode-plugin\] tracing stopped, exported 0 spans, dropped [1-9]\d*/)
      expect(h.server.stderr()).not.toMatch(/127\.0\.0\.1:\d+/)
    })
  }, 90_000)

  it('is not changed by OTEL_* variables in the server environment', async () => {
    // #given decoy collectors named by the standard variables, and the real relay in the launcher variable
    const decoy = await startOtlpSink()
    try {
      await run(
        {
          steps: simpleSteps,
          env: url => ({
            ...launcherOn(url),
            OTEL_EXPORTER_OTLP_ENDPOINT: decoy.url.replace('/v1/traces', ''),
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: decoy.url,
            OTEL_EXPORTER_OTLP_HEADERS: 'x-decoy=1',
            OTEL_RESOURCE_ATTRIBUTES: 'decoy.attr=1',
            OTEL_TRACES_SAMPLER: 'always_off',
          }),
        },
        async h => {
          const session = await h.session()
          await prompt(h.api, session, 'S-ONE hello')
          await waitUntil('the root span', () => h.spans().some(isRoot), 30_000)
          await h.stop()

          // #then spans reached the real sink, with no decoy header or attribute, and the decoy heard nothing
          expect(h.spans().length).toBeGreaterThan(0)
          expect(h.sink.requests.some(request => request.headers['x-decoy'] !== undefined)).toBe(false)
          expect(h.sink.requests.map(request => request.text).join('')).not.toContain('decoy')
          // OpenCode's own exporter honours OTEL_EXPORTER_OTLP_ENDPOINT and may well post there. The plugin's spans must not.
          const decoyText = decoy.requests.map(request => request.text).join('')
          expect(decoyText).not.toContain('"stringValue":"fro-bot-opencode-plugin"')
          expect(decoyText).not.toContain('fro_bot.')
        },
      )
    } finally {
      await decoy.stop()
    }
  }, 90_000)

  it('exports a tool span, outcome rejected, for a call this plugin’s own reuse guard refused', async () => {
    // #given a model that tries to resume a subagent session, which the built plugin's guard refuses in the before hook
    const steps: FakeStep[] = [
      {
        all: ['G-ONE'],
        none: [NOT_TOOL],
        tools: [
          {
            name: 'subagent',
            args: {
              agent: 'general',
              description: 'resume',
              prompt: 'G-CHILD again',
              sessionID: 'ses_00000000000000000000000000',
            },
          },
        ],
      },
      {all: ['G-ONE', NOT_TOOL], text: 'guard handled'},
    ]
    await run({steps}, async h => {
      const session = await h.session()

      // #when the turn runs and the server stops
      await prompt(h.api, session, 'G-ONE resume a session')
      await waitUntil('the root span', () => h.spans().some(isRoot), 30_000)
      await h.stop()

      // #then the call is one tool span, rejected, with the guard's error type, and it started no child
      const calls = h.spans().filter(span => span.name === 'execute_tool subagent')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.attrs['fro_bot.tool.outcome']).toBe('rejected')
      expect(calls[0]?.attrs['fro_bot.tool.error_type']).toBe('plugin.reuse-guard')
      expect(h.spans().filter(span => span.name === 'invoke_agent general')).toHaveLength(0)
    })
  }, 90_000)

  it('exports the final batch, spans still open marked interrupted, when stdin closes, before the server is killed', async () => {
    // #given a turn whose model response stalls, so the root and the model request are still open, and nothing exported yet
    const steps: FakeStep[] = [{all: ['H-ONE'], text: 'partial answer', hangMs: 60_000}]
    await run({steps}, async h => {
      const session = await h.session()
      await prompt(h.api, session, 'H-ONE hang')
      await waitUntil('the model request to arrive', () => h.requests().split('\n').filter(Boolean).length >= 2, 30_000)
      await sleep(1_500)
      expect(h.spans().some(isRoot)).toBe(false)

      // #when the server is stopped the way the Action stops it: stdin closes, and nothing kills it unless it lingers
      const stopped = await h.server.stop()

      // #then it left on its own, well inside the Action's 5 s window, and the final batch is at the sink
      expect(stopped.exitedOnItsOwn).toBe(true)
      expect(stopped.ms).toBeLessThan(5_000 + 3_000)
      const spans = h.spans()
      const root = spans.find(isRoot)
      expect(root).toBeDefined()
      // #and the spans that were open are exported as interrupted and incomplete, none left out
      expect(root?.attrs['fro_bot.outcome']).toBe('interrupted')
      expect(root?.attrs['fro_bot.span.marks']).toContain('incomplete')
      const chats = spans.filter(span => span.attrs['gen_ai.operation.name'] === 'chat')
      expect(chats.some(span => span.attrs['fro_bot.outcome'] === 'interrupted')).toBe(true)
      expect(h.server.stderr()).toMatch(/tracing stopped, exported [1-9]\d* spans/)
    })
  }, 90_000)

  it.each([
    ['a collector that accepts the connection and never answers', {respond: () => ({status: 200, delayMs: 120_000})}],
    ['a collector that keeps answering 503', {respond: () => ({status: 503})}],
  ] as const)(
    'stops inside the Action’s 5 s window when stdin closes against %s, and cleanup stays inside its own bound',
    async (label, sinkOptions) => {
      // #given a finished turn whose spans are being exported to a collector that will not take them
      await run({steps: [{all: ['W-ONE'], text: 'answer'}], sink: sinkOptions}, async h => {
        const session = await h.session()
        await prompt(h.api, session, 'W-ONE hello')
        await sleep(4_000)

        // #when the server is stopped the way the Action stops it
        const stopped = await h.server.stop()
        if (process.env.FRO_BOT_TIMING === '1') process.stdout.write(`STOP-TIMING ${label}: ${String(stopped.ms)} ms\n`)

        // #then it left on its own inside the Action's window (the assertion is at 5 s, not the fixture's 8 s), the plugin
        // reported what it could not deliver, and a stalled or failing collector never kept the process alive
        expect(stopped.exitedOnItsOwn).toBe(true)
        expect(stopped.ms).toBeLessThan(5_000)
        expect(h.server.stderr()).toMatch(/tracing stopped, exported 0 spans, dropped [1-9]/)
      })
    },
    90_000,
  )

  it('refuses an untrusted https certificate in the compiled host, with certificate validation switched off in the environment', async () => {
    // #given a collector over https with a self-signed certificate, a local-mode file pointing at it, and the process-wide switch off
    const tls = await startTlsSink()
    if (tls === undefined) return
    try {
      await run(
        {
          steps: [{all: ['V-ONE'], text: 'tls answer'}],
          // Plain serve: `serve --stdio` is treated as embedded, so a local file would not apply there.
          plain: true,
          env: () => ({NODE_TLS_REJECT_UNAUTHORIZED: '0'}),
          beforeStart: sandbox => {
            const file = userSettingsFilePath({XDG_CONFIG_HOME: path.join(sandbox.home, 'config')})
            mkdirSync(path.dirname(file), {recursive: true})
            writeFileSync(
              file,
              JSON.stringify({
                version: 1,
                endpoint: tls.url,
                hosts: [os.hostname()],
                headers: {authorization: 'Basic never-sent'},
              }),
              {mode: 0o600},
            )
          },
        },
        async h => {
          const session = await h.session()

          // #when a turn runs and the server stops
          await prompt(h.api, session, 'V-ONE hello')
          await sleep(4_000)
          await h.server.stop()

          // #then no request, no header and no body reached the collector, no handshake completed, and the spans were counted dropped
          expect(tls.requests).toEqual([])
          expect(tls.handshakes()).toBe(0)
          expect(h.server.stderr()).toMatch(/tracing stopped, exported 0 spans, dropped [1-9]/)
        },
      )
    } finally {
      await tls.stop()
    }
  }, 120_000)

  describe('the user file in a plain `opencode serve`', () => {
    const writeFor = (hosts: string[]) => (sandbox: SandboxPaths, sink: OtlpSink) => {
      const file = userSettingsFilePath({XDG_CONFIG_HOME: path.join(sandbox.home, 'config')})
      mkdirSync(path.dirname(file), {recursive: true})
      writeFileSync(file, JSON.stringify({version: 1, endpoint: sink.url, hosts}), {mode: 0o600})
    }

    it('exports a traced turn when the file names this machine, with no launcher variable and no headless marker', async () => {
      // #given a user a file naming this machine, a plain serve (not stdio), and nothing that marks it headless
      await run(
        {
          steps: [{all: ['P-ONE'], text: 'plain answer'}],
          plain: true,
          env: () => ({}),
          beforeStart: writeFor([os.hostname()]),
        },
        async h => {
          const session = await h.session()

          // #when a turn runs
          await prompt(h.api, session, 'P-ONE hello')
          await waitUntil('the root span', () => h.spans().some(isRoot), 60_000)
          const stopped = await h.server.stop()

          // #then the trace reached the sink and the server left on SIGTERM
          const spans = h.spans()
          expect(spans.some(isRoot)).toBe(true)
          expect(spans.some(span => span.attrs['gen_ai.operation.name'] === 'chat')).toBe(true)
          expect(spans.every(span => span.attrs['fro_bot.repository'] === undefined)).toBe(true)
          expect(stopped.exitedOnItsOwn).toBe(true)
        },
      )
    }, 120_000)

    it('sends nothing when the file names another machine, and logs nothing about it', async () => {
      // #given the same, naming a machine that is not this one
      await run(
        {
          steps: [{all: ['P-TWO'], text: 'plain answer'}],
          plain: true,
          env: () => ({}),
          beforeStart: writeFor(['some-other-machine.invalid']),
        },
        async h => {
          const session = await h.session()

          // #when a turn runs to its end
          await prompt(h.api, session, 'P-TWO hello')
          // The same wait the other cases use: long enough for the turn to finish and for any export to have happened.
          await sleep(5_000)
          const answered = JSON.stringify(await idleMessages(h.api, session))
          await h.server.stop()
          expect(answered).toContain('plain answer')

          // #then nothing reached the sink, and the plugin said nothing about tracing
          expect(h.sink.requests).toEqual([])
          expect(h.server.stderr()).not.toMatch(/tracing/)
        },
      )
    }, 120_000)
  })

  it('stays off in a server started with `serve` that shows no headless marker, whatever a user file says', async () => {
    // #given a server whose plugin sees neither OPENCODE_PASSWORD nor OPENCODE_CONFIG_CONTENT (the stdio server deletes
    // the password before plugins load), no launcher variable, and a valid user file naming this machine
    await run(
      {
        steps: simpleSteps,
        localMode: true,
        env: () => ({}),
        beforeStart: (sandbox, sink) => {
          const file = userSettingsFilePath({XDG_CONFIG_HOME: path.join(sandbox.home, 'config')})
          mkdirSync(path.dirname(file), {recursive: true})
          writeFileSync(file, JSON.stringify({version: 1, endpoint: sink.url, hosts: [os.hostname()]}), {mode: 0o600})
        },
      },
      async h => {
        const session = await h.session()

        // #when a turn runs and the server stops
        await prompt(h.api, session, 'S-ONE hello')
        await sleep(3_000)
        await h.stop()

        // #then nothing was sent, and the plugin said why with a fixed reason
        expect(h.sink.requests).toHaveLength(0)
        expect(h.server.stderr()).toContain('[fro-bot/opencode-plugin] tracing off (headless-host)')
      },
    )
  }, 90_000)
})
