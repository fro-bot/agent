import type {OnSettings} from './index.js'
import type {ObserverHost} from './record-observations.js'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {startOtlpSink, type OtlpSink} from '../integration.fixture.js'
import {CLEANUP_BOUND_MS, startTracing} from './index.js'

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

  it('do not delay the hook with a large request: the snapshot costs a fraction of serializing it, under a fixed ceiling', async () => {
    // #given a request with a very large history (about 30 MB of text) and the hook as the host calls it
    const target = await sink()
    const fake = fakeObserverHost()
    const handle = await startTracing(fake.host, LOCAL(target.url), {env: {}, log: () => {}})
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

    // #when the handler's time is measured against the time it would take just to serialize the same payload
    const serialize = performance.now()
    const size = JSON.stringify(payload).length
    const serializeMs = performance.now() - serialize
    const started = performance.now()
    fake.call('session.context', payload)
    const handlerMs = performance.now() - started
    process.stdout.write(
      `[latency] hook handler ${handlerMs.toFixed(3)} ms for ${size} chars (serializing alone: ${serializeMs.toFixed(1)} ms)\n`,
    )

    // #then the handler, which takes the bounded hook-time snapshot (a walk over the newest few hundred messages, strings
    // shared), costs a fraction of serializing the payload and stays under an absolute ceiling nobody would feel
    expect(size).toBeGreaterThan(25_000_000)
    expect(handlerMs).toBeLessThan(serializeMs / 5)
    expect(handlerMs).toBeLessThan(15)
    await handle.stop()
    fake.end()
  }, 30_000)

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
    vi.doMock('./exporter.js', () => ({
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
    vi.doUnmock('./exporter.js')
    vi.resetModules()
    fake.end()
  })
})
