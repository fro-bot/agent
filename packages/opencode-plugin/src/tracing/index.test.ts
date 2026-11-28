import type {OnSettings} from './index.js'
import type {ObserverHost} from './record-observations.js'

import {readFileSync} from 'node:fs'

import {scrubSafeSessionId} from '@fro-bot/runtime/tracing/session-id'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {startOtlpSink, type OtlpSink} from '../integration.fixture.js'
import {createScrubber} from './content.js'
import {CLEANUP_BOUND_MS, DRAIN_BOUND_MS, startTracing} from './index.js'
import {cpuMs, minCpuMs} from './timing.testing.js'

/** A fake host: records every registered hook and exposes a pushable event stream. */
function fakeObserverHost() {
  const hooks = new Map<string, (event: unknown) => void>()
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let ended = false
  const host: ObserverHost = {
    session: {
      hook: async (name, callback) => {
        hooks.set(`session.${name}`, callback)
        return {}
      },
    },
    tool: {
      hook: async (name, callback) => {
        hooks.set(`tool.${name}`, callback)
        return {}
      },
    },
    event: {
      subscribe: () =>
        (async function* () {
          for (;;) {
            if (ended) return
            const next = queue.shift()
            if (next === undefined) {
              await new Promise<void>(resolve => {
                wake = resolve
              })
              continue
            }
            yield next
          }
        })(),
    },
  }
  return {
    host,
    hooks,
    emit: (event: unknown) => {
      queue.push(event)
      wake?.()
    },
    end: () => {
      ended = true
      wake?.()
    },
    call: (name: string, payload: unknown) => hooks.get(name)?.(payload),
  }
}

const sinks: OtlpSink[] = []
const sink = async (): Promise<OtlpSink> => {
  const started = await startOtlpSink()
  sinks.push(started)
  return started
}
afterEach(async () => {
  for (const started of sinks.splice(0)) await started.stop()
})

const LOCAL = (url: string, headers: Record<string, string> = {}): OnSettings => ({
  mode: 'on',
  host: 'local',
  endpoint: url,
  headers,
})
const ACTION = (url: string): OnSettings => ({
  mode: 'on',
  host: 'action',
  endpoint: url,
  identity: {repository: 'fro-bot/agent', runId: '9', attempt: '1', job: 'j', trigger: 'push'},
})

const SES = 'ses_root'
/** The plugin's own version, read here the way the test expects the plugin to: from the manifest, not from a constant. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {version: string}
).version
const resourceOf = (attributes: {key: string; value: {stringValue?: string}}[]): Record<string, string | undefined> =>
  Object.fromEntries(attributes.map(item => [item.key, item.value.stringValue]))
/** The snapshot's CPU time over the CPU time of `JSON.stringify` on the same request. A real snapshot is a small fraction of it; a deep copy is about 1 or more. */
const SNAPSHOT_RATIO_LIMIT = 0.2
const event = (type: string, data: Record<string, unknown>, created: number): unknown => ({type, created, data})

/** One text turn, as the hooks and events arrive: prompt hook, enqueue, start, request, step, output, end. */
function textTurn(host: ReturnType<typeof fakeObserverHost>, secret = 'plain text') {
  const t = 1_700_000_000_000
  host.call('session.prompt', {
    sessionID: SES,
    messageID: 'msg_1',
    delivery: 'steer',
    prompt: {text: `hello ${secret}`},
  })
  host.emit(event('session.inbox.enqueued', {sessionID: SES, inboxID: 'msg_1', item: {type: 'user'}}, t))
  host.emit(event('session.execution.started', {sessionID: SES}, t + 1))
  host.emit(event('session.inbox.delivered', {sessionID: SES, inboxID: 'msg_1'}, t + 2))
  host.call('session.context', {
    sessionID: SES,
    agent: 'build',
    model: {id: 'm', providerID: 'p'},
    system: [{type: 'text', text: 'system prompt'}],
    messages: [{id: 'msg_1', role: 'user', content: [{type: 'text', text: `hello ${secret}`}]}],
    tools: {},
    options: {apiKey: 'sk-never-exported-value-0123456789'},
  })
  host.emit(
    event(
      'session.step.started',
      {sessionID: SES, assistantMessageID: 'msg_2', agent: 'build', model: {id: 'm', providerID: 'p'}},
      t + 3,
    ),
  )
  host.emit(event('session.text.ended', {sessionID: SES, assistantMessageID: 'msg_2', text: 'answer'}, t + 4))
  host.emit(
    event(
      'session.step.ended',
      {
        sessionID: SES,
        assistantMessageID: 'msg_2',
        finish: 'stop',
        rawFinish: 'stop',
        tokens: {input: 70, output: 13, reasoning: 7, cache: {read: 30, write: 0}},
        cost: 0,
      },
      t + 5,
    ),
  )
  host.emit(event('session.execution.succeeded', {sessionID: SES}, t + 6))
}

describe('startTracing', () => {
  it('registers the hooks and the event stream, exports a turn on stop and logs the counts without content', async () => {
    // #given a local session with a headered collector
    const target = await sink()
    const fake = fakeObserverHost()
    const lines: string[] = []
    const handle = await startTracing(fake.host, LOCAL(target.url, {authorization: 'Basic abc123'}), {
      env: {},
      log: line => lines.push(line),
    })

    // #then every observed hook is registered
    expect([...fake.hooks.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'session.compaction',
      'session.context',
      'session.generate',
      'session.prompt',
      'session.retry',
      'session.title',
      'tool.execute.after',
      'tool.execute.before',
    ])

    // #when a turn happens and the server shuts down
    textTurn(fake)
    await vi.waitFor(() => {
      expect(fake.hooks.size).toBeGreaterThan(0)
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    await handle.stop()
    fake.end()

    // #then one root and one model span arrived, nothing identifying the Action, and one counts line with no content
    const [request] = target.accepted()
    const spans = (request?.body as {resourceSpans: {scopeSpans: {spans: {name: string}[]}[]}[]}).resourceSpans.flatMap(
      resource => resource.scopeSpans.flatMap(scope => scope.spans),
    )
    expect(spans.map(span => span.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'chat m',
      'invoke_agent build',
    ])
    expect(request?.headers['x-frobot-trace-counts']).toBeUndefined()
    expect(request?.text).not.toContain('fro_bot.repository')
    expect(request?.text).not.toContain('sk-never-exported')
    expect(lines).toEqual(['tracing stopped, exported 2 spans, dropped 0'])

    // #and the sender is named as the plugin, on the resource and on the instrumentation scope
    const exported = (
      request?.body as {
        resourceSpans: {
          resource: {attributes: {key: string; value: {stringValue?: string}}[]}
          scopeSpans: {scope: {name: string}}[]
        }[]
      }
    ).resourceSpans
    expect(exported.map(resource => resourceOf(resource.resource.attributes))).toEqual([
      {
        'service.name': 'fro-bot-opencode-plugin',
        'service.version': PACKAGE_VERSION,
        'langfuse.release': PACKAGE_VERSION,
      },
    ])
    expect(exported.flatMap(resource => resource.scopeSpans.map(scope => scope.scope.name))).toEqual([
      'fro-bot-opencode-plugin',
    ])
  })

  it('says how many values the safety net withheld, as a number, and exports none of them', async () => {
    // #given a scrubber whose matchers miss a known literal (the safety net's own check is the real one), and a turn that holds it
    const secret = 'literal-that-slipped-0123456789'
    const real = createScrubber({env: {DB_PASSWORD: secret}})
    const blind = {...real, scrub: (text: string) => ({ok: true as const, text, redactions: 0})}
    const target = await sink()
    const fake = fakeObserverHost()
    const lines: string[] = []
    const handle = await startTracing(fake.host, LOCAL(target.url), {
      env: {},
      log: line => lines.push(line),
      scrubber: blind,
    })

    // #when the turn runs and the server stops
    textTurn(fake, secret)
    await vi.waitFor(() => {
      expect(fake.hooks.size).toBeGreaterThan(0)
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    await handle.stop()
    fake.end()

    // #then the literal was exported nowhere, and the log line carries the count (never the value)
    expect(target.requests.map(request => request.text).join('')).not.toContain(secret)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^tracing stopped, exported \d+ spans, dropped 0, [1-9]\d* values withheld \(literal survived\)$/,
    )
    expect(lines[0]).not.toContain(secret)
  })

  it('sends the counts header and the run identity in Action mode, and never a header of its own choosing', async () => {
    // #given an Action launcher pointing at a loopback relay
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, ACTION(target.url), {env: {}, log: () => {}})

    // #when a turn is exported
    textTurn(fake)
    await new Promise(resolve => setTimeout(resolve, 50))
    await handle.stop()
    fake.end()

    // #then the header is present and well formed, and every span carries the identity
    const [request] = target.accepted()
    expect(request?.headers['x-frobot-trace-counts']).toMatch(/^exported=\d{1,12};dropped=\d{1,12}$/)
    expect(request?.headers.authorization).toBeUndefined()
    expect(request?.text).toContain('fro_bot.repository')
    expect(request?.text).toContain('fro-bot/agent')
  })

  describe('the versions on the resource and the root span', () => {
    interface Wire {
      readonly resourceSpans: {
        readonly resource: {readonly attributes: {key: string; value: {stringValue?: string}}[]}
        readonly scopeSpans: {
          readonly spans: {
            readonly name: string
            readonly parentSpanId?: string
            readonly attributes?: {key: string; value: {stringValue?: string}}[]
          }[]
        }[]
      }[]
    }

    async function exportTurn(options: Partial<Parameters<typeof startTracing>[2]> = {}) {
      const target = await sink()
      const fake = fakeObserverHost()
      const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}, ...options})
      textTurn(fake)
      await new Promise(resolve => setTimeout(resolve, 50))
      await handle.stop()
      fake.end()
      const body = (target.accepted()[0]?.body ?? {resourceSpans: []}) as Wire
      const spans = body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
      return {
        resource: resourceOf(body.resourceSpans[0]?.resource.attributes ?? []),
        spans: spans.map(span => ({
          name: span.name,
          root: span.parentSpanId === undefined,
          attributes: resourceOf(span.attributes ?? []),
        })),
      }
    }

    it('carries the plugin version as service.version, and the host’s OpenCode version', async () => {
      // #when a turn is exported by a host that says its version
      const {resource} = await exportTurn({opencodeVersion: '2.4.2'})

      // #then the resource names both
      expect(resource).toEqual({
        'service.name': 'fro-bot-opencode-plugin',
        'service.version': PACKAGE_VERSION,
        'langfuse.release': PACKAGE_VERSION,
        'fro_bot.opencode.version': '2.4.2',
      })
    })

    it('puts the plugin version on the resource as langfuse.release, so every span has it, and sets it on no span itself', async () => {
      // #when
      const {resource, spans} = await exportTurn({readVersion: () => '1.4.2'})

      // #then Langfuse reads it from the resource for the root and the child alike
      expect(resource['langfuse.release']).toBe('1.4.2')
      expect(resource['service.version']).toBe('1.4.2')
      expect(spans.map(span => span.name).toSorted()).toEqual(['chat m', 'invoke_agent build'])
      expect(spans.every(span => span.attributes['langfuse.release'] === undefined)).toBe(true)
    })

    it('leaves both unset, and still exports, when the version cannot be read', async () => {
      // #given a reader that finds nothing, and one that throws
      for (const readVersion of [
        () => undefined,
        () => {
          throw new Error('EACCES: /secret/path')
        },
      ]) {
        // #when a turn is exported
        const {resource, spans} = await exportTurn({readVersion})

        // #then no version anywhere, and the spans arrived
        expect(resource).toEqual({'service.name': 'fro-bot-opencode-plugin'})
        expect(spans).toHaveLength(2)
        expect(spans.every(span => span.attributes['langfuse.release'] === undefined)).toBe(true)
      }
    })

    it.each([
      ['an empty string', ''],
      ['a string with spaces', '2.4 2'],
      ['a string over 64 characters', `2.${'4'.repeat(70)}`],
      ['a URL', 'https://evil.example/2.4.2'],
    ])('leaves the OpenCode version unset for %s', async (_label, opencodeVersion) => {
      // #when
      const {resource} = await exportTurn({opencodeVersion})

      // #then
      expect(resource['fro_bot.opencode.version']).toBeUndefined()
    })

    it('sends neither version when the scrubber would change it, never an altered one', async () => {
      // #given a scrubber that rewrites every string it sees
      const rewriting = {
        ...createScrubber(),
        scrub: (text: string) => ({ok: true, text: `[REDACTED:${text.length}]`, redactions: 1}) as const,
      }

      // #when
      const {resource, spans} = await exportTurn({
        scrubber: rewriting,
        opencodeVersion: '2.4.2',
        readVersion: () => '1.4.2',
      })

      // #then the resource holds neither version nor release, and no span carries a release
      expect(resource).toEqual({'service.name': 'fro-bot-opencode-plugin'})
      expect(spans.every(span => span.attributes['langfuse.release'] === undefined)).toBe(true)
    })

    it('sends neither version when the scrubber cannot scrub it', async () => {
      // #given a scrubber that refuses every string
      const refusing = {...createScrubber(), scrub: () => ({ok: false, reason: 'scrub-failed'}) as const}

      // #when
      const {resource} = await exportTurn({scrubber: refusing, opencodeVersion: '2.4.2', readVersion: () => '1.4.2'})

      // #then
      expect(resource).toEqual({'service.name': 'fro-bot-opencode-plugin'})
    })

    it('sends neither version when it is a registered secret literal', async () => {
      // #given an environment secret that happens to be the version text, which the safety net knows
      const scrubber = createScrubber({env: {DEPLOY_TOKEN: '1.4.2-secret-literal'}})

      // #when
      const {resource} = await exportTurn({scrubber, readVersion: () => '1.4.2-secret-literal'})

      // #then
      expect(resource['service.version']).toBeUndefined()
    })
  })

  describe('the run link from the launcher', () => {
    const ROOT_SPAN = {traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331'}
    const SESSION_ID = 'fro-bot/agent:issue-42'
    const INVOCATION_ID = '3f2a9c1e-7b4d-4e8a-9d6c-1a2b3c4d5e6f'

    interface WireSpan {
      readonly name: string
      readonly parentSpanId?: string
      readonly attributes?: readonly {readonly key: string; readonly value: {readonly stringValue?: string}}[]
      readonly links?: readonly {readonly traceId: string; readonly spanId: string}[]
    }
    const wireSpans = (body: unknown): WireSpan[] =>
      (body as {resourceSpans: {scopeSpans: {spans: WireSpan[]}[]}[]}).resourceSpans.flatMap(resource =>
        resource.scopeSpans.flatMap(scope => scope.spans),
      )
    const attribute = (span: WireSpan, key: string): string | undefined =>
      span.attributes?.find(entry => entry.key === key)?.value.stringValue

    interface Exported {
      readonly spans: WireSpan[]
      /** Every request body the sink accepted, as sent. */
      readonly text: string
    }

    async function exportTurn(
      settings: OnSettings,
      scrubber: ReturnType<typeof createScrubber> | undefined = undefined,
    ): Promise<Exported> {
      const target = await sink()
      const fake = fakeObserverHost()
      const handle = await startTracing(
        fake.host,
        {...settings, endpoint: target.url},
        {env: {}, log: () => {}, ...(scrubber === undefined ? {} : {scrubber})},
      )
      textTurn(fake)
      await new Promise(resolve => setTimeout(resolve, 50))
      await handle.stop()
      fake.end()
      return {
        spans: target.accepted().flatMap(request => wireSpans(request.body)),
        text: target
          .accepted()
          .map(request => request.text)
          .join('\n'),
      }
    }

    const launched = (sessionId: string): OnSettings =>
      ({...ACTION('http://unused'), rootSpan: ROOT_SPAN, sessionId}) as OnSettings

    it('puts the launcher’s session id, the invocation id and a link to the run root on the exported turn', async () => {
      // #given an Action launcher carrying all three fields
      const {spans} = await exportTurn({
        ...ACTION('http://unused'),
        rootSpan: ROOT_SPAN,
        sessionId: SESSION_ID,
        invocationId: INVOCATION_ID,
      } as OnSettings)

      // #then the turn's root span links to the run root, and every span has the session and the invocation id
      const root = spans.find(span => span.name.startsWith('invoke_agent') && span.parentSpanId === undefined)
      expect(root?.links).toEqual([expect.objectContaining(ROOT_SPAN)])
      expect(spans.length).toBeGreaterThan(1)
      for (const span of spans) {
        expect(attribute(span, 'langfuse.session.id')).toBe(SESSION_ID)
        expect(attribute(span, 'fro_bot.invocation.id')).toBe(INVOCATION_ID)
      }
    })

    it('exports exactly what it did before when the launcher has none of them', async () => {
      // #given today's Action launcher
      const {spans} = await exportTurn(ACTION('http://unused'))

      // #then the Langfuse session is the OpenCode session, and no span has a link or an invocation id
      expect(spans.length).toBeGreaterThan(1)
      for (const span of spans) {
        expect(attribute(span, 'langfuse.session.id')).toBe(SES)
        expect(attribute(span, 'fro_bot.invocation.id')).toBeUndefined()
        expect(span.links ?? []).toEqual([])
      }
    })

    it('keeps the OpenCode session in a local session', async () => {
      const {spans} = await exportTurn(LOCAL('http://unused'))

      // #then spans arrived (an empty export would pass the loop below), and none has a link
      expect(spans.length).toBeGreaterThan(1)
      for (const span of spans) {
        expect(attribute(span, 'langfuse.session.id')).toBe(SES)
        expect(span.links ?? []).toEqual([])
      }
    })

    it('exports two conversations whose ids would redact alike as two sessions, when the ids come from the helper', async () => {
      // #given two logical keys in a repository the scrubber reads as a name and value, each passed through the shared helper
      const helperScrubber = createScrubber()
      const first = scrubSafeSessionId('acme/password-manager:issue-42', helperScrubber)
      const second = scrubSafeSessionId('acme/password-manager:issue-43', helperScrubber)
      expect(first).toBeDefined()
      expect(second).toBeDefined()

      // #when each conversation's turn is exported
      const one = await exportTurn(launched(first ?? ''))
      const two = await exportTurn(launched(second ?? ''))

      // #then the sessions are the two distinct ids, exactly as given, and no redaction marker stands in for either
      expect(one.spans.length).toBeGreaterThan(1)
      expect(two.spans.length).toBeGreaterThan(1)
      expect(new Set(one.spans.map(span => attribute(span, 'langfuse.session.id')))).toEqual(new Set([first]))
      expect(new Set(two.spans.map(span => attribute(span, 'langfuse.session.id')))).toEqual(new Set([second]))
      expect(first).not.toBe(second)
      expect(one.text).not.toContain('REDACTED')
      expect(two.text).not.toContain('REDACTED')
    })

    it('exports the OpenCode root session, never `[REDACTED]`, for a session id that scrubbing would change', async () => {
      // #given a launcher that carries the raw id, not the helper's
      const {spans, text} = await exportTurn(launched('acme/password-manager:issue-42'))

      // #then every span falls back to the OpenCode root session
      expect(spans.length).toBeGreaterThan(1)
      for (const span of spans) expect(attribute(span, 'langfuse.session.id')).toBe(SES)
      expect(text).not.toContain('REDACTED')
    })

    it('exports the OpenCode root session when a literal added after the run started matches the session id', async () => {
      // #given a scrubber that learns the id as a secret once the run has begun
      const scrubber = createScrubber()
      scrubber.addLiterals?.([SESSION_ID])

      // #when the turn is exported
      const {spans, text} = await exportTurn(launched(SESSION_ID), scrubber)

      // #then the session is the OpenCode root, and the id itself is nowhere in the payload
      expect(spans.length).toBeGreaterThan(1)
      for (const span of spans) expect(attribute(span, 'langfuse.session.id')).toBe(SES)
      expect(text).not.toContain(SESSION_ID)
      expect(text).not.toContain('REDACTED')
    })
  })

  it('closes spans still open at stop as interrupted and incomplete', async () => {
    // #given a turn that has started and not finished
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}})
    const t = 1_700_000_000_000
    fake.call('session.prompt', {sessionID: SES, messageID: 'msg_1', delivery: 'steer', prompt: {text: 'hi'}})
    fake.emit(event('session.inbox.enqueued', {sessionID: SES, inboxID: 'msg_1', item: {type: 'user'}}, t))
    fake.emit(event('session.execution.started', {sessionID: SES}, t + 1))
    fake.emit(event('session.inbox.delivered', {sessionID: SES, inboxID: 'msg_1'}, t + 2))
    fake.call('session.context', {
      sessionID: SES,
      agent: 'build',
      model: {id: 'm', providerID: 'p'},
      system: [],
      messages: [],
      tools: {},
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    // #when the server stops
    await handle.stop()
    fake.end()

    // #then the root and the request were exported, marked interrupted and incomplete
    const text = target.accepted()[0]?.text ?? ''
    expect(text).toContain('"incomplete"')
    expect(text).toContain('fro_bot.outcome')
    expect(text).toMatch(/interrupted/)
  })

  it('stays inside the cleanup bound when the destination never answers, and counts the spans dropped', async () => {
    // #given a collector that hangs
    const hanging = await startOtlpSink({respond: () => ({status: 200, delayMs: 20_000})})
    sinks.push(hanging)
    const fake = fakeObserverHost()
    const lines: string[] = []
    const handle = await startTracing(fake.host, LOCAL(hanging.url), {env: {}, log: line => lines.push(line)})
    textTurn(fake)
    await new Promise(resolve => setTimeout(resolve, 50))

    // #when stop runs
    const started = Date.now()
    await handle.stop()
    fake.end()

    // #then it returned within the bound plus slack, with every span counted as dropped
    expect(Date.now() - started).toBeLessThan(CLEANUP_BOUND_MS + 1_500)
    expect(lines).toEqual(['tracing stopped, exported 0 spans, dropped 2'])
  }, 15_000)

  it('spends at most its drain share on the backlog, and reports what it could not do', async () => {
    // #given a turn waiting to be processed and a drain share of nothing
    const target = await sink()
    const fake = fakeObserverHost()
    const lines: string[] = []
    const handle = await startTracing(fake.host, LOCAL(target.url), {
      env: {},
      log: line => lines.push(line),
      drainBoundMs: 0,
    })
    textTurn(fake)

    // #when stop runs at once
    const started = Date.now()
    await handle.stop()
    fake.end()

    // #then it did not wait for the backlog, exported nothing, said so, and left the exporter its time
    expect(Date.now() - started).toBeLessThan(500)
    expect(target.accepted()).toHaveLength(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^tracing stopped, exported 0 spans, dropped 0, \d+ observations lost$/)
  })

  it('gives the pipeline a minority of the cleanup bound, so the exporter keeps the rest', () => {
    // #given / #when / #then
    expect(DRAIN_BOUND_MS).toBeGreaterThan(0)
    expect(DRAIN_BOUND_MS).toBeLessThanOrEqual(CLEANUP_BOUND_MS / 2)
  })

  it('keeps the cleanup bound shorter than the Action’s 5 s kill window', () => {
    // #given / #when / #then
    expect(CLEANUP_BOUND_MS).toBeLessThan(5_000)
    expect(CLEANUP_BOUND_MS).toBeGreaterThanOrEqual(2_000)
  })

  it('is idempotent: stopping twice exports once and logs once', async () => {
    // #given
    const target = await sink()
    const fake = fakeObserverHost()
    const lines: string[] = []
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: line => lines.push(line)})
    textTurn(fake)
    await new Promise(resolve => setTimeout(resolve, 50))

    // #when
    await handle.stop()
    await handle.stop()
    fake.end()

    // #then
    expect(target.accepted()).toHaveLength(1)
    expect(lines).toHaveLength(1)
  })

  it('removes the collector credential and secret-named environment values from everything it exports', async () => {
    // #given a credential in the headers, a secret in the environment, and both echoed back in a prompt
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url, {authorization: 'Basic Y29sbGVjdG9yLWNyZWQ'}), {
      env: {SERVICE_ADMIN_TOKEN: 'plainly-ordinary-words'},
      log: () => {},
    })

    // #when the turn's text names both
    textTurn(fake, 'Basic Y29sbGVjdG9yLWNyZWQ and plainly-ordinary-words')
    await new Promise(resolve => setTimeout(resolve, 50))
    await handle.stop()
    fake.end()

    // #then neither value is in any byte of the payload
    const text = target.accepted()[0]?.text ?? ''
    expect(text).not.toContain('Y29sbGVjdG9yLWNyZWQ')
    expect(text).not.toContain('plainly-ordinary-words')
    expect(text).toContain('[REDACTED]')
  })
})

/** A turn with a tool call, driven through mutable hook inputs that the test keeps and edits after each hook returns. */
function mutableTurn(host: ReturnType<typeof fakeObserverHost>, session: string, label: string) {
  const t = 1_700_000_000_000
  const inputs = {
    prompt: {text: `${label} ORIGINAL PROMPT`},
    request: {
      sessionID: session,
      agent: 'build',
      model: {id: 'm', providerID: 'p'},
      system: [{type: 'text', text: `${label} ORIGINAL SYSTEM`}],
      messages: [{role: 'user', content: [{type: 'text', text: `${label} ORIGINAL USER`}]}],
      tools: {read: {description: `${label} ORIGINAL TOOL DESCRIPTION`, input: {type: 'object'}}},
      options: {},
    },
    toolBefore: {
      sessionID: session,
      id: `call_${label}`,
      tool: 'read',
      agent: 'build',
      input: {path: `${label} ORIGINAL PATH`},
    },
    toolAfter: {
      sessionID: session,
      id: `call_${label}`,
      tool: 'read',
      status: 'completed',
      result: {content: [{type: 'text', text: `${label} ORIGINAL RESULT`}]},
    },
  }
  const mutate = (): void => {
    inputs.prompt.text = 'EDITED PROMPT'
    ;(inputs.request.system[0] as {text: string}).text = 'EDITED SYSTEM'
    ;(inputs.request.messages[0]?.content[0] as {text: string}).text = 'EDITED USER'
    inputs.request.messages.push({role: 'user', content: [{type: 'text', text: 'EDITED APPENDED'}]})
    inputs.request.tools.read.description = 'EDITED TOOL DESCRIPTION'
    inputs.toolBefore.input.path = 'EDITED PATH'
    ;(inputs.toolAfter.result.content[0] as {text: string}).text = 'EDITED RESULT'
  }
  host.call('session.prompt', {sessionID: session, messageID: `msg_${label}`, delivery: 'steer', prompt: inputs.prompt})
  host.emit(event('session.inbox.enqueued', {sessionID: session, inboxID: `msg_${label}`, item: {type: 'user'}}, t))
  host.emit(event('session.execution.started', {sessionID: session}, t + 1))
  host.emit(event('session.inbox.delivered', {sessionID: session, inboxID: `msg_${label}`}, t + 2))
  host.call('session.context', inputs.request)
  host.emit(
    event(
      'session.step.started',
      {sessionID: session, assistantMessageID: `a_${label}`, agent: 'build', model: {id: 'm', providerID: 'p'}},
      t + 3,
    ),
  )
  host.call('tool.execute.before', inputs.toolBefore)
  host.call('tool.execute.after', inputs.toolAfter)
  host.emit(event('session.tool.success', {sessionID: session, id: `call_${label}`, metadata: {}}, t + 4))
  host.emit(
    event(
      'session.step.ended',
      {
        sessionID: session,
        assistantMessageID: `a_${label}`,
        finish: 'tool-calls',
        rawFinish: 'tool_calls',
        tokens: {input: 5, output: 2, reasoning: 0, cache: {read: 0, write: 0}},
        cost: 0,
      },
      t + 5,
    ),
  )
  host.emit(event('session.execution.succeeded', {sessionID: session}, t + 6))
  return {mutate}
}

describe('the hook-time snapshot', () => {
  it('exports what the hooks carried when they fired, not what the host edited afterwards', async () => {
    // #given a turn whose every hook input is a live object the test still holds
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}})
    const turn = mutableTurn(fake, 'ses_mut', 'T')

    // #when the host (or another plugin) edits every one of them right after its hook returned, before anything ran
    turn.mutate()
    await new Promise(resolve => setTimeout(resolve, 60))
    await handle.stop()
    fake.end()

    // #then the exported content is the pre-mutation value, and none of the edits is in any byte sent
    const text = target
      .accepted()
      .map(request => request.text)
      .join('\n')
    for (const original of [
      'T ORIGINAL PROMPT',
      'T ORIGINAL SYSTEM',
      'T ORIGINAL USER',
      'T ORIGINAL TOOL DESCRIPTION',
      'T ORIGINAL PATH',
      'T ORIGINAL RESULT',
    ]) {
      expect(text).toContain(original)
    }
    expect(text).not.toContain('EDITED')
  })

  it('keeps the span’s structure and marks the content omitted when too many snapshots are pending', async () => {
    // #given room for one pending snapshot, and two sessions whose hooks fire before anything has been exported
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url), {
      env: {},
      log: () => {},
      pending: {maxPending: 1},
    })

    // #when both turns run
    mutableTurn(fake, 'ses_a', 'A')
    mutableTurn(fake, 'ses_b', 'B')
    await new Promise(resolve => setTimeout(resolve, 80))
    await handle.stop()
    fake.end()

    // #then every span of both turns is exported, and the ones that found no room say so in a marker
    const spans = target
      .accepted()
      .flatMap(
        request =>
          (
            request.body as {
              resourceSpans: {
                scopeSpans: {
                  spans: {
                    name: string
                    attributes: {
                      key: string
                      value: {stringValue?: string; arrayValue?: {values: {stringValue: string}[]}}
                    }[]
                  }[]
                }[]
              }[]
            }
          ).resourceSpans,
      )
      .flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
    const names = spans.map(span => span.name).toSorted((a, b) => a.localeCompare(b))
    expect(names).toEqual([
      'chat m',
      'chat m',
      'execute_tool read',
      'execute_tool read',
      'invoke_agent build',
      'invoke_agent build',
    ])
    const omitted = spans.flatMap(span =>
      span.attributes
        .filter(attribute => attribute.key === 'fro_bot.content.omitted')
        .flatMap(attribute => attribute.value.arrayValue?.values.map(value => value.stringValue) ?? []),
    )
    expect(omitted.length).toBeGreaterThan(0)
    expect(omitted.every(entry => entry.endsWith(':pending-bound'))).toBe(true)
    expect(omitted).toContain('gen_ai.input.messages:pending-bound')
  })
})

describe('a hostile tool result', () => {
  /** The class that made the JWT pattern quadratic: `eyJ-` repeated, a megabyte of it. */
  const HOSTILE = 'eyJ-'.repeat(256 * 1024)

  it('does not delay the hook, the next request or the event loop beyond a stated bound, and the span is exported', async () => {
    // #given a turn with one tool call whose result is 1 MiB of `eyJ-`, and a timer that records the longest the event loop stalls
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}})
    const t = 1_700_000_000_000
    fake.call('session.prompt', {sessionID: SES, messageID: 'msg_1', delivery: 'steer', prompt: {text: 'run it'}})
    fake.emit(event('session.inbox.enqueued', {sessionID: SES, inboxID: 'msg_1', item: {type: 'user'}}, t))
    fake.emit(event('session.execution.started', {sessionID: SES}, t + 1))
    fake.emit(event('session.inbox.delivered', {sessionID: SES, inboxID: 'msg_1'}, t + 2))
    const request = (): Record<string, unknown> => ({
      sessionID: SES,
      agent: 'build',
      model: {id: 'm', providerID: 'p'},
      system: [{type: 'text', text: 'sys'}],
      messages: [{role: 'user', content: [{type: 'text', text: 'run it'}]}],
      tools: {},
      options: {},
    })
    fake.call('session.context', request())
    fake.emit(
      event(
        'session.step.started',
        {sessionID: SES, assistantMessageID: 'msg_2', agent: 'build', model: {id: 'm', providerID: 'p'}},
        t + 3,
      ),
    )
    fake.emit(
      event(
        'session.tool.input.started',
        {sessionID: SES, assistantMessageID: 'msg_2', id: 'call_1', name: 'read'},
        t + 4,
      ),
    )
    fake.emit(
      event(
        'session.tool.called',
        {sessionID: SES, assistantMessageID: 'msg_2', id: 'call_1', input: {path: 'x'}, executed: false},
        t + 5,
      ),
    )
    fake.call('tool.execute.before', {sessionID: SES, id: 'call_1', tool: 'read', agent: 'build', input: {path: 'x'}})
    let worst = 0
    let last = performance.now()
    const watcher = setInterval(() => {
      const nowMs = performance.now()
      worst = Math.max(worst, nowMs - last)
      last = nowMs
    }, 5)

    // #when the after hook carries the hostile result, and the next model request follows at once
    const hookStarted = performance.now()
    fake.call('tool.execute.after', {
      sessionID: SES,
      id: 'call_1',
      tool: 'read',
      status: 'completed',
      result: {content: [{type: 'text', text: HOSTILE}]},
    })
    const hookMs = performance.now() - hookStarted
    fake.emit(
      event(
        'session.tool.success',
        {
          sessionID: SES,
          assistantMessageID: 'msg_2',
          id: 'call_1',
          content: [{type: 'text', text: 'ok'}],
          executed: false,
        },
        t + 6,
      ),
    )
    const nextStarted = performance.now()
    fake.call('session.context', request())
    const nextMs = performance.now() - nextStarted
    fake.emit(
      event(
        'session.step.ended',
        {
          sessionID: SES,
          assistantMessageID: 'msg_2',
          finish: 'tool-calls',
          tokens: {input: 1, output: 1, reasoning: 0, cache: {read: 0, write: 0}},
          cost: 0,
        },
        t + 7,
      ),
    )
    fake.emit(event('session.execution.succeeded', {sessionID: SES}, t + 8))
    await new Promise(resolve => setTimeout(resolve, 600))
    clearInterval(watcher)
    await handle.stop()
    fake.end()

    // #then the hook and the next request returned in a few milliseconds, the loop never stalled for more than a slice and
    // one string's scrub, and the tool span reached the sink, with its content either scrubbed or marked omitted
    expect(hookMs).toBeLessThan(50)
    expect(nextMs).toBeLessThan(50)
    expect(worst).toBeLessThan(250)
    const text = target
      .accepted()
      .map(request => request.text)
      .join('')
    expect(text).toContain('execute_tool read')
    expect(text.length).toBeLessThan(2 * 1024 * 1024)
  })
})

describe('the handlers', () => {
  it('return at once and never change a hook’s arguments', async () => {
    // #given a deep-frozen request payload, and the hook as the host calls it
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}})
    const payload = {
      sessionID: SES,
      agent: 'build',
      model: {id: 'm', providerID: 'p'},
      system: [{type: 'text', text: 'sys'}],
      messages: [{role: 'user', content: [{type: 'text', text: 'hi'}]}],
      tools: {read: {description: 'd', input: {}}},
      options: {maxTokens: 8000},
    }
    const before = JSON.stringify(payload)
    const frozen = structuredClone(payload)
    const freeze = (value: unknown): void => {
      if (typeof value === 'object' && value !== null) {
        Object.freeze(value)
        for (const child of Object.values(value)) freeze(child)
      }
    }
    freeze(frozen)

    // #when the context hook fires with the frozen payload (a write would throw in strict mode)
    const result = fake.call('session.context', frozen)
    await new Promise(resolve => setTimeout(resolve, 30))

    // #then the handler returned undefined and the payload is unchanged
    expect(result).toBeUndefined()
    expect(JSON.stringify(frozen)).toBe(before)
    await handle.stop()
    fake.end()
  })

  it('do not delay the hook with a large request: the snapshot costs a small fraction of serializing it, in CPU time', async () => {
    // #given a request with a very large history (about 30 MB of text) and the hook as the host calls it
    const messages = Array.from({length: 3_000}, (_, index) => ({
      id: `msg_${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{type: 'text', text: `line ${index} ${'x'.repeat(10_000)}`}],
    }))
    const payload = {
      sessionID: SES,
      agent: 'build',
      model: {id: 'm', providerID: 'p'},
      system: [{type: 'text', text: 's'.repeat(50_000)}],
      messages,
      tools: {},
      options: {},
    }
    const size = JSON.stringify(payload).length

    // One hook call on its own fresh tracing handle, so on an empty snapshot ledger: the ledger is bounded, and a handle that
    // already held snapshots would omit or truncate content and make a costly snapshot look cheap. Starting and stopping the
    // handle are outside the measurement; only the hook call is timed.
    const hookCpuMs = async (): Promise<number> => {
      const target = await sink()
      const fake = fakeObserverHost()
      const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}})
      const used = cpuMs(() => {
        fake.call('session.context', payload)
      })
      await handle.stop()
      fake.end()
      return used
    }
    // An untimed warm-up on its own handle, then the least of `attempts` timed calls, each on a fresh handle.
    const handlerCpuMs = async (attempts: number): Promise<number> => {
      await hookCpuMs()
      let best = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < attempts; attempt += 1) best = Math.min(best, await hookCpuMs())
      return best
    }
    const serializeCpuMs = (attempts: number): number =>
      minCpuMs(() => {
        JSON.stringify(payload)
      }, attempts)

    // #when the handler's CPU time is measured against the CPU time it takes just to serialize the same payload (the least of a
    // few runs after a warm-up, so neither load nor compilation counts); a ratio over the limit is measured again with more
    // runs, and only the least of all of them counts
    let serializeMs = serializeCpuMs(3)
    let handlerMs = await handlerCpuMs(3)
    if (handlerMs / serializeMs > SNAPSHOT_RATIO_LIMIT) {
      serializeMs = Math.min(serializeMs, serializeCpuMs(5))
      handlerMs = Math.min(handlerMs, await handlerCpuMs(4))
    }
    process.stdout.write(
      `[latency] hook handler ${handlerMs.toFixed(3)} ms CPU for ${size} chars (serializing alone: ${serializeMs.toFixed(1)} ms CPU, ratio ${(handlerMs / serializeMs).toFixed(4)})\n`,
    )

    // #then the handler, which takes the bounded hook-time snapshot (a walk over the newest few hundred messages, strings
    // shared), costs a small fraction of serializing the payload; the generous absolute bound only catches a runaway, and CPU
    // time is not inflated by load
    expect(size).toBeGreaterThan(25_000_000)
    expect(handlerMs / serializeMs).toBeLessThan(SNAPSHOT_RATIO_LIMIT)
    expect(handlerMs).toBeLessThan(200)
  }, 60_000)

  it('swallow a handler failure: a hook payload that throws when read does not reach the host', async () => {
    // #given payloads that throw on any property read
    const target = await sink()
    const fake = fakeObserverHost()
    const lines: string[] = []
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: line => lines.push(line)})
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom')
        },
      },
    )

    // #when every hook fires with it
    for (const name of fake.hooks.keys()) {
      expect(() => fake.call(name, hostile)).not.toThrow()
    }

    // #and the event stream carries it too
    fake.emit(hostile)
    await new Promise(resolve => setTimeout(resolve, 30))
    await handle.stop()
    fake.end()

    // #then nothing was exported and only the counts line was logged
    expect(target.requests).toHaveLength(0)
    expect(lines).toEqual(['tracing stopped, exported 0 spans, dropped 0'])
  })

  it('stop being observed after stop: a late hook adds nothing', async () => {
    // #given a stopped tracer
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}})
    await handle.stop()

    // #when a turn arrives afterwards
    textTurn(fake)
    await new Promise(resolve => setTimeout(resolve, 80))
    fake.end()

    // #then nothing was exported
    expect(target.requests).toHaveLength(0)
  })
})

describe('failure of the parts', () => {
  it('rejects when hook registration throws, so the caller can leave the plugin as it was', async () => {
    // #given a host whose session hook refuses
    const target = await sink()
    const fake = fakeObserverHost()
    const refusing: ObserverHost = {
      ...fake.host,
      session: {
        hook: async () => {
          throw new Error('registration refused')
        },
      },
    }

    // #when / #then
    await expect(startTracing(refusing, LOCAL(target.url), {env: {}, log: () => {}})).rejects.toThrow(
      'registration refused',
    )
    fake.end()
  })

  it('rejects when the SDK exporter cannot be constructed', async () => {
    // #given an exporter module that throws on construction
    vi.resetModules()
    vi.doMock('@fro-bot/runtime/tracing/exporter', () => ({
      createSpanExporter: () => {
        throw new TypeError('sdk construction failed')
      },
    }))
    const {startTracing: fresh} = await import('./index.js')
    const fake = fakeObserverHost()

    // #when / #then
    await expect(
      fresh(
        fake.host,
        {mode: 'on', host: 'local', endpoint: 'http://127.0.0.1:1/v1/traces', headers: {}},
        {env: {}, log: () => {}},
      ),
    ).rejects.toThrow('sdk construction failed')
    vi.doUnmock('@fro-bot/runtime/tracing/exporter')
    vi.resetModules()
    fake.end()
  })
})
