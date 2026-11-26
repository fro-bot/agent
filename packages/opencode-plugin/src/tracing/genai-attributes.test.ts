import type {ScrubbedSpan} from './content.js'
import type {ChatRecord, InvokeRecord, SpanRecord, ToolRecord} from './turn-model.js'

import {describe, expect, it} from 'vitest'

import {CONTENT_ATTRIBUTE_NAMES, createScrubber, MARKER} from './content.js'
import {GENAI_SEMCONV_REVISION, toExportSpan, toPendingSpan} from './genai-attributes.js'
import {omittedContent, snapshotPrompt, snapshotRequest, snapshotToolArguments, snapshotToolResult} from './snapshot.js'
import {recordedFixtures} from './turn-model.fixtures.js'
import {replay} from './turn-model.testing.js'

const scrubber = createScrubber()
const IDENTITY = {repository: 'fro-bot/agent', runId: '4242', attempt: '2', job: 'fro-bot', trigger: 'issue_comment'}

const base = {
  traceId: 'trace-1',
  spanId: 'span-1',
  parentSpanId: undefined,
  start: 1_000,
  end: 1_500,
  status: 'ok' as const,
  sessionId: 'ses_child',
  rootSessionId: 'ses_root',
  agent: 'build',
  gaps: [] as string[],
  marks: [] as string[],
}

const chat = (overrides: Partial<ChatRecord> = {}): ChatRecord => ({
  ...base,
  kind: 'chat',
  name: 'chat m',
  requestKind: 'primary',
  provider: 'openai',
  model: 'gpt-x',
  attempt: 1,
  texts: ['answer'],
  reasoning: [],
  toolCalls: [],
  finishReason: 'stop',
  rawFinishReason: 'stop',
  usage: {input: 70, output: 13, reasoning: 7, cacheRead: 30, cacheWrite: 0},
  cost: 0.5,
  followOnOf: [],
  attemptCountUnknown: false,
  ...overrides,
})

const tool = (overrides: Partial<ToolRecord> = {}): ToolRecord => ({
  ...base,
  kind: 'execute_tool',
  name: 'execute_tool read',
  tool: 'read',
  callId: 'call_1',
  outcome: 'success',
  input: {path: 'README.md'},
  result: {content: [{type: 'text', text: 'file body'}], metadata: {truncated: false}},
  providerExecuted: false,
  discarded: [],
  ...overrides,
})

const invoke = (overrides: Partial<InvokeRecord> = {}): InvokeRecord => ({
  ...base,
  kind: 'invoke_agent',
  name: 'invoke_agent build',
  role: 'root',
  prompts: [{messageId: 'm1', at: 1_000, content: {text: 'please read it'}, midTurn: false}],
  ...overrides,
})

const exported = (record: SpanRecord, identity?: typeof IDENTITY): ScrubbedSpan =>
  toExportSpan(record, identity === undefined ? {} : {identity}, scrubber)

const parse = (span: ScrubbedSpan, name: string): unknown => JSON.parse(String(span.attributes[name]))

const HISTORY = [
  {id: 'msg_1', role: 'user', content: [{type: 'text', text: 'K-HIST earlier work'}]},
  {id: 'msg_2', role: 'assistant', content: [{type: 'text', text: 'history answer'}]},
  {id: 'msg_3', role: 'user', content: [{type: 'text', text: 'new turn on a restored session'}]},
]

describe('model spans', () => {
  it('map to the convention names with provider, model, agent and content that parses back to the input', () => {
    // #given a request snapshot and a finished response
    const request = {
      system: [{type: 'text', text: 'You are Fro Bot.', metadata: {experimental: {instructions: []}}}],
      messages: HISTORY,
      tools: {read: {description: 'Read a file', input: {type: 'object'}}},
      options: {maxTokens: 8000},
    }
    const span = exported(
      chat({
        request,
        texts: ['answer'],
        reasoning: ['hmm'],
        toolCalls: [{callId: 'call_1', tool: 'read', input: {path: 'a'}}],
      }),
    )

    // #then the names follow the pinned convention
    expect(span.name).toBe('chat gpt-x')
    expect(span.kind).toBe('client')
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-x',
      'gen_ai.agent.name': 'build',
      'gen_ai.response.finish_reasons': ['stop'],
      'fro_bot.request.kind': 'primary',
      'fro_bot.request.attempt': 1,
      'fro_bot.content.view': 'hook-time',
    })

    // #and content is JSON that parses to the extracted shapes
    expect(parse(span, 'gen_ai.system_instructions')).toEqual([{type: 'text', content: 'You are Fro Bot.'}])
    expect(parse(span, 'gen_ai.tool.definitions')).toEqual([
      {type: 'function', name: 'read', description: 'Read a file', parameters: {type: 'object'}},
    ])
    expect(parse(span, 'gen_ai.input.messages')).toEqual([
      {role: 'user', parts: [{type: 'text', content: 'K-HIST earlier work'}]},
      {role: 'assistant', parts: [{type: 'text', content: 'history answer'}]},
      {role: 'user', parts: [{type: 'text', content: 'new turn on a restored session'}]},
    ])
    expect(parse(span, 'gen_ai.output.messages')).toEqual([
      {
        role: 'assistant',
        parts: [
          {type: 'reasoning', content: 'hmm'},
          {type: 'text', content: 'answer'},
          {type: 'tool_call', id: 'call_1', name: 'read', arguments: {path: 'a'}},
        ],
      },
    ])
  })

  it("carries a restored session's history in the input messages", () => {
    // #given a primary request on a restored session: the history predates this process
    const span = exported(chat({request: {system: [], messages: HISTORY, tools: {}}}))

    // #then all three messages, restored ones included, are in the span
    expect(parse(span, 'gen_ai.input.messages')).toHaveLength(3)
  })

  it('sums OpenCode’s split token counts into the convention’s totals', () => {
    // #given input 70 + cache read 30, and output 13 + reasoning 7
    const span = exported(chat())

    // #then input and output are the totals, cache and reasoning are the included parts
    expect(span.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 30,
      'gen_ai.usage.reasoning.output_tokens': 7,
      'fro_bot.usage.cost_usd': 0.5,
    })
    expect(span.attributes['gen_ai.usage.cache_write.input_tokens']).toBeUndefined()
  })

  it('sets no attribute for a field that was not captured', () => {
    // #given a title-like request with no finish reason, usage, cost, provider or model
    const span = exported(
      chat({
        requestKind: 'title',
        provider: undefined,
        model: undefined,
        finishReason: undefined,
        rawFinishReason: undefined,
        usage: undefined,
        cost: undefined,
        texts: [],
        gaps: ['finishReason', 'usage'],
      }),
    )

    // #then none of them is an attribute; the gaps are named instead
    for (const name of [
      'gen_ai.response.finish_reasons',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
      'fro_bot.usage.cost_usd',
      'gen_ai.provider.name',
      'gen_ai.request.model',
      'gen_ai.input.messages',
      'gen_ai.output.messages',
      'gen_ai.system_instructions',
      'gen_ai.tool.definitions',
      'fro_bot.request.attempt',
    ]) {
      expect({name, present: name in span.attributes}).toEqual({name, present: false})
    }
    expect(span.attributes['fro_bot.span.gaps']).toEqual(['finishReason', 'usage'])
    expect(span.name).toBe('chat title')
  })

  it('reports the provider finish reason, and error or interrupted only when none came and the call did not succeed', () => {
    // #given the four situations
    const reported = exported(chat({rawFinishReason: 'tool_calls', finishReason: 'tool-calls'}))
    const failed = exported(
      chat({
        status: 'error',
        finishReason: undefined,
        rawFinishReason: undefined,
        error: {type: 'provider.internal', message: 'down', status: 503},
      }),
    )
    const cut = exported(chat({status: 'interrupted', finishReason: undefined, rawFinishReason: undefined}))
    const ok = exported(chat({finishReason: undefined, rawFinishReason: undefined}))

    // #then
    expect(reported.attributes['gen_ai.response.finish_reasons']).toEqual(['tool_calls'])
    expect(failed.attributes['gen_ai.response.finish_reasons']).toEqual(['error'])
    expect(cut.attributes['gen_ai.response.finish_reasons']).toEqual(['interrupted'])
    expect(ok.attributes['gen_ai.response.finish_reasons']).toBeUndefined()
  })

  it('reports no finish reason, not an interrupted one, for a span whose step data was withheld because binding was uncertain', () => {
    // #given an uncertain chat: interrupted and incomplete, with the gap, and no finish reason
    const span = exported(
      chat({
        status: 'interrupted',
        gaps: ['step-binding-uncertain'],
        marks: ['incomplete'],
        finishReason: undefined,
        rawFinishReason: undefined,
        usage: undefined,
      }),
    )

    // #then the response's finish reason is unknown, not "interrupted"
    expect(span.attributes['gen_ai.response.finish_reasons']).toBeUndefined()
    expect(span.attributes['fro_bot.span.gaps']).toEqual(['step-binding-uncertain'])
    expect(span.attributes['gen_ai.usage.input_tokens']).toBeUndefined()
  })

  it('carries a failed call as an error status, an error type and an exception event', () => {
    // #given
    const span = exported(
      chat({status: 'error', error: {type: 'provider.internal', message: 'scripted 503', status: 503}}),
    )

    // #then
    expect(span.status).toEqual({code: 'error', message: 'scripted 503'})
    expect(span.attributes['error.type']).toBe('provider.internal')
    expect(span.events).toEqual([
      {
        name: 'exception',
        timeMs: 1_500,
        attributes: {'exception.type': 'provider.internal', 'exception.message': 'scripted 503'},
      },
    ])
  })

  it('never lets a request’s options object, headers or attachments reach an attribute', () => {
    // #given a request whose options hold a provider key, plus headers and a media part
    const key = ['sk-', 'Q9x8W7e6R5t4Y3u2I1o0P9a8S7d6'].join('')
    const request = {
      system: [{type: 'text', text: 'sys'}],
      messages: [
        {
          role: 'user',
          content: [
            {type: 'text', text: 'hi'},
            {type: 'media', media: {source: {type: 'base64', data: 'QkFTRTY0'}}},
          ],
        },
      ],
      tools: {},
      options: {apiKey: key, providerOptions: {openai: {apiKey: key}}},
      headers: {authorization: `Bearer ${key}`},
      baseURL: 'https://internal.example',
    }

    // #when exported with a scrubber that knows nothing of the key (so only extraction can keep it out)
    const span = toExportSpan(chat({request}), {}, createScrubber({patterns: []}))

    // #then no string of the span holds the key, the header, the base URL or the attachment data
    const text = JSON.stringify(span)
    for (const needle of ['Q9x8W7e6R5', 'internal.example', 'QkFTRTY0', 'apiKey', 'authorization'])
      expect(text).not.toContain(needle)
    expect(span.attributes['fro_bot.content.parts_omitted']).toBe(1)
  })

  it('names the follow-on traces a response served', () => {
    // #given a response that carried another turn's subagent report
    const span = exported(chat({followOnOf: ['trace-0']}))

    // #then
    expect(span.attributes['fro_bot.turn.follow_on_of']).toEqual(['trace-0'])
  })

  it('drops the oldest history first when over budget, and says how many', () => {
    // #given a history far over the input-messages bound
    const messages = Array.from({length: 40}, (_, index) => ({
      role: 'user',
      content: [{type: 'text', text: `m${index}-${'z'.repeat(20_000)}`}],
    }))

    // #when
    const span = exported(chat({request: {system: [], messages, tools: {}}}))

    // #then the newest message is kept, the oldest are gone, the count is a marker, and the value is valid JSON within its bound
    const raw = String(span.attributes['gen_ai.input.messages'])
    const kept = JSON.parse(raw) as {parts: {content: string}[]}[]
    expect(raw.length).toBeLessThanOrEqual(512 * 1024)
    expect(kept.at(-1)?.parts[0]?.content.startsWith('m39-')).toBe(true)
    expect(Number(span.attributes[MARKER.dropped('gen_ai.input.messages')])).toBe(40 - kept.length)
  })
})

describe('tool spans', () => {
  it('carry tool name, call id, arguments and result', () => {
    // #given a finished tool call
    const span = exported(tool())

    // #then
    expect(span.name).toBe('execute_tool read')
    expect(span.kind).toBe('internal')
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'read',
      'gen_ai.tool.call.id': 'call_1',
      'gen_ai.tool.type': 'function',
      'fro_bot.tool.outcome': 'success',
    })
    expect(parse(span, 'gen_ai.tool.call.arguments')).toEqual({path: 'README.md'})
    expect(parse(span, 'gen_ai.tool.call.result')).toEqual({content: [{type: 'text', text: 'file body'}]})
    expect(span.attributes['fro_bot.tool.output_truncated']).toBeUndefined()
  })

  it('says when the tool cut its own output, apart from any other truncation', () => {
    // #given a tool whose own output was truncated, by the event and by its result metadata
    const byEvent = exported(tool({toolTruncated: true}))
    const byResult = exported(tool({result: {content: 'x', metadata: {truncated: true}}}))

    // #then both carry the marker, and neither claims this plugin truncated anything
    expect(byEvent.attributes['fro_bot.tool.output_truncated']).toBe(true)
    expect(byResult.attributes['fro_bot.tool.output_truncated']).toBe(true)
    expect(MARKER.truncated in byResult.attributes).toBe(false)
  })

  it('sets no result for a rejected or interrupted call, and carries the outcome and error', () => {
    // #given
    const rejected = exported(
      tool({
        outcome: 'rejected',
        status: 'error',
        errorType: 'permission.rejected',
        error: {type: 'permission.rejected', message: 'Permission denied: shell'},
        result: undefined,
      }),
    )
    const interrupted = exported(
      tool({outcome: 'interrupted', status: 'interrupted', errorType: 'aborted', result: undefined}),
    )

    // #then
    expect(rejected.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(rejected.attributes).toMatchObject({
      'fro_bot.tool.outcome': 'rejected',
      'fro_bot.tool.error_type': 'permission.rejected',
      'error.type': 'permission.rejected',
    })
    expect(rejected.status).toEqual({code: 'error', message: 'Permission denied: shell'})
    expect(interrupted.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(interrupted.status).toEqual({code: 'unset'})
    expect(interrupted.attributes['fro_bot.outcome']).toBe('interrupted')
  })

  it('names the child session a subagent dispatch started', () => {
    // #given
    const span = exported(tool({tool: 'subagent', childSessionId: 'ses_kid'}))

    // #then
    expect(span.attributes['fro_bot.subagent.session_id']).toBe('ses_kid')
  })
})

describe('agent spans', () => {
  it('carry the prompt as an input message, and mark prompts that arrived mid-turn', () => {
    // #given a root with two prompts, one mid-turn
    const span = exported(
      invoke({
        prompts: [
          {messageId: 'm1', at: 1, content: {text: 'first'}, midTurn: false},
          {messageId: 'm2', at: 2, content: {text: 'second', files: [{uri: 'file:///x'}]}, midTurn: true},
        ],
      }),
    )

    // #then
    expect(span.name).toBe('invoke_agent build')
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'fro_bot.prompt.count': 2,
      'fro_bot.prompt.mid_turn': true,
    })
    expect(parse(span, 'gen_ai.input.messages')).toEqual([
      {role: 'user', parts: [{type: 'text', content: 'first'}]},
      {role: 'user', parts: [{type: 'text', content: 'second'}]},
    ])
    expect(JSON.stringify(span)).not.toContain('file:///x')
  })

  it('carry the turn’s marks, continuation and where its report went', () => {
    // #given a continuation trace and a turn whose report was consumed elsewhere
    const continuation = exported(invoke({prompts: [], marks: ['continuation'], continuationOf: 'trace-0'}))
    const delivered = exported(
      invoke({
        reportDeliveredInTrace: 'trace-9',
        standalone: 'compaction',
        status: 'interrupted',
        marks: ['incomplete'],
      }),
    )

    // #then
    expect(continuation.attributes).toMatchObject({
      'fro_bot.span.marks': ['continuation'],
      'fro_bot.turn.continuation_of': 'trace-0',
    })
    expect(continuation.attributes['gen_ai.input.messages']).toBeUndefined()
    expect(delivered.attributes).toMatchObject({
      'fro_bot.turn.report_delivered_in': 'trace-9',
      'fro_bot.turn.standalone': 'compaction',
      'fro_bot.outcome': 'interrupted',
    })
  })
})

describe('the content attribute list', () => {
  it('names exactly the content attributes the spans set', () => {
    // #given a model span and a tool span with every kind of content
    const secretFree = (text: string): string => text
    const spans = [
      exported(
        chat({
          texts: [secretFree('answer')],
          request: {
            system: [{text: 'system'}],
            messages: [{role: 'user', parts: [{type: 'text', text: 'hi'}]}],
            tools: {read: {description: 'reads', parameters: {type: 'object'}}},
          },
        }),
      ),
      exported(tool({input: {path: 'a'}, result: {content: 'body'}})),
    ]

    // #then every `gen_ai.*` content attribute they set is in the list, and every one in the list was set by one of them (the agent span sets only the prompt, the same input attribute)
    const contentLike = new Set(
      spans.flatMap(span =>
        Object.keys(span.attributes).filter(name =>
          /^gen_ai\.(?:input\.messages|output\.messages|system_instructions|tool\.definitions|tool\.call\.(?:arguments|result))$/.test(
            name,
          ),
        ),
      ),
    )
    expect([...contentLike].toSorted()).toEqual([...CONTENT_ATTRIBUTE_NAMES].toSorted())
  })
})

describe('identity', () => {
  it('puts the session id, the root session id and the agent on every span of a subagent', () => {
    // #given the three record kinds of a child session
    const records: SpanRecord[] = [chat(), tool(), invoke({role: 'child'})]

    // #then each carries its own session id and the root's
    for (const record of records) {
      const span = exported(record)
      expect(span.attributes).toMatchObject({
        'session.id': 'ses_child',
        'gen_ai.conversation.id': 'ses_child',
        'fro_bot.root_session.id': 'ses_root',
        'langfuse.session.id': 'ses_root',
        'gen_ai.agent.name': 'build',
      })
    }
  })

  it('groups a whole subagent tree under the root session id for Langfuse, and keeps session.id as each span’s own', () => {
    // #given the nested-subagent fixture: a root session, a child and a child of that child
    const {records} = replay(recordedFixtures['subagent-nested']?.observations ?? [])

    // #when every record is mapped
    const spans = records.map(record => exported(record))

    // #then every span of every session carries the ROOT id in `langfuse.session.id` (the attribute Langfuse's OTLP ingestion
    // reads first for its session, ahead of `session.id`), while `session.id` stays the span's own session
    expect(new Set(spans.map(span => span.attributes['langfuse.session.id']))).toEqual(new Set(['ses_1']))
    expect(new Set(spans.map(span => span.attributes['session.id']))).toEqual(new Set(['ses_1', 'ses_2', 'ses_3']))
    for (const span of spans)
      expect(span.attributes['langfuse.session.id']).toBe(span.attributes['fro_bot.root_session.id'])
  })

  it('gives a session that is not linked to a root its own id, on every kind of span', () => {
    // #given records of a session that is its own root (a standalone request, or a child whose link never came)
    const records: SpanRecord[] = [
      chat({sessionId: 'ses_alone', rootSessionId: 'ses_alone'}),
      tool({sessionId: 'ses_alone', rootSessionId: 'ses_alone'}),
      invoke({sessionId: 'ses_alone', rootSessionId: 'ses_alone', role: 'root'}),
    ]

    // #then
    for (const record of records) {
      expect(exported(record).attributes).toMatchObject({
        'langfuse.session.id': 'ses_alone',
        'session.id': 'ses_alone',
        'fro_bot.root_session.id': 'ses_alone',
      })
    }
  })

  it('scrubs the id like every other string attribute', () => {
    // #given a root id that contains a secret shape (the inbox already drops an identifier over 512 characters, so the id is
    // bounded before it reaches a record; this is the guard on the way out)
    const secret = ['ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')
    const span = exported(chat({sessionId: 'ses_child', rootSessionId: `ses-${secret}`}))

    // #then the Langfuse session attribute goes through the same scrubber as `fro_bot.root_session.id`
    expect(JSON.stringify(span.attributes)).not.toContain(secret)
    expect(span.attributes['langfuse.session.id']).toBe(span.attributes['fro_bot.root_session.id'])
  })

  it('puts repository and run identity on every span in Action mode, and on none in local mode', () => {
    // #given
    const records: SpanRecord[] = [chat(), tool(), invoke()]

    // #then Action mode carries all five; local mode carries none of them
    for (const record of records) {
      expect(exported(record, IDENTITY).attributes).toMatchObject({
        'fro_bot.repository': 'fro-bot/agent',
        'fro_bot.run.id': '4242',
        'fro_bot.run.attempt': '2',
        'fro_bot.job': 'fro-bot',
        'fro_bot.trigger': 'issue_comment',
      })
      const local = Object.keys(exported(record).attributes)
      expect(local.filter(name => /^fro_bot\.(?:repository|run\.|job|trigger)/.test(name))).toEqual([])
    }
  })

  it('mirrors the run identity into Langfuse trace metadata on every span in Action mode, with the same values', () => {
    // #given the three record kinds
    const records: SpanRecord[] = [chat(), tool(), invoke()]

    // #then each carries the five short keys (strings, as Langfuse keeps a string metadata value as sent), equal to their twins
    for (const record of records) {
      const {attributes} = exported(record, IDENTITY)
      expect(attributes).toMatchObject({
        'langfuse.trace.metadata.repository': 'fro-bot/agent',
        'langfuse.trace.metadata.run_id': '4242',
        'langfuse.trace.metadata.run_attempt': '2',
        'langfuse.trace.metadata.job': 'fro-bot',
        'langfuse.trace.metadata.trigger': 'issue_comment',
      })
      expect(attributes['langfuse.trace.metadata.repository']).toBe(attributes['fro_bot.repository'])
      expect(attributes['langfuse.trace.metadata.run_id']).toBe(attributes['fro_bot.run.id'])
      expect(attributes['langfuse.trace.metadata.run_attempt']).toBe(attributes['fro_bot.run.attempt'])
      expect(attributes['langfuse.trace.metadata.job']).toBe(attributes['fro_bot.job'])
      expect(attributes['langfuse.trace.metadata.trigger']).toBe(attributes['fro_bot.trigger'])
    }
  })

  it('sets no Langfuse trace metadata in local mode, where there is no run identity', () => {
    for (const record of [chat(), tool(), invoke()]) {
      const names = Object.keys(exported(record).attributes)
      expect(names.filter(name => name.startsWith('langfuse.trace.metadata'))).toEqual([])
    }
  })

  it('scrubs the mirrored values like every other string, and bounds nothing the twins do not', () => {
    // #given an identity whose job carries a secret shape
    const secret = ['ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')
    const span = exported(chat(), {...IDENTITY, job: `job-${secret}`})

    // #then neither the twin nor the mirror holds it, and the two agree
    expect(JSON.stringify(span.attributes)).not.toContain(secret)
    expect(span.attributes['langfuse.trace.metadata.job']).toBe(span.attributes['fro_bot.job'])
  })

  it('records every span of a replayed fixture without losing the grouping key', () => {
    // #given the nested-subagent fixture
    const observations = recordedFixtures['subagent-nested']?.observations ?? []
    const {records} = replay(observations)

    // #when every record is mapped and scrubbed
    const spans = records.map(record => exported(record))

    // #then each span names its own session and the one root
    expect(spans.length).toBe(records.length)
    expect(new Set(spans.map(span => span.attributes['fro_bot.root_session.id']))).toEqual(new Set(['ses_1']))
    expect(new Set(spans.map(span => span.attributes['session.id']))).toEqual(new Set(['ses_1', 'ses_2', 'ses_3']))
  })
})

describe('the run link', () => {
  const ROOT_SPAN = {traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331'}
  const SESSION_ID = 'fro-bot/agent:issue-42'
  const INVOCATION_ID = '3f2a9c1e-7b4d-4e8a-9d6c-1a2b3c4d5e6f'
  const LINKED = {identity: IDENTITY, rootSpan: ROOT_SPAN, sessionId: SESSION_ID, invocationId: INVOCATION_ID}
  const linked = (record: SpanRecord): ScrubbedSpan => toExportSpan(record, LINKED, scrubber)

  it('uses the launcher’s session id verbatim as the Langfuse session on every span, and keeps the OpenCode session ids', () => {
    // #given a child span of a tree and the session id the Action computed
    for (const record of [chat(), tool(), invoke(), invoke({role: 'child'})]) {
      // #when mapped with the launcher's fields
      const span = linked(record)

      // #then the Langfuse session is that string, not the OpenCode root; the standard session attributes are unchanged
      expect(span.attributes['langfuse.session.id']).toBe(SESSION_ID)
      expect(span.attributes).toMatchObject({
        'session.id': 'ses_child',
        'gen_ai.conversation.id': 'ses_child',
        'fro_bot.root_session.id': 'ses_root',
      })
    }
  })

  it('carries the invocation id on every span, and mirrors it into Langfuse trace metadata', () => {
    for (const record of [chat(), tool(), invoke()]) {
      expect(linked(record).attributes).toMatchObject({
        'fro_bot.invocation.id': INVOCATION_ID,
        'langfuse.trace.metadata.invocation_id': INVOCATION_ID,
      })
    }
  })

  it('links each turn root span to the run’s root span, and no other span', () => {
    // #given
    const root = linked(invoke({role: 'root'}))
    const standalone = linked(invoke({role: 'root', standalone: 'compaction'}))
    const others = [linked(invoke({role: 'child'})), linked(chat()), linked(tool())]

    // #then
    expect(root.links).toEqual([ROOT_SPAN])
    expect(standalone.links).toEqual([ROOT_SPAN])
    for (const span of others) expect(span.links).toBeUndefined()
  })

  it('uses what the launcher carries and nothing else: a lone field changes only its own attribute', () => {
    // #given each field alone
    const onlySession = toExportSpan(invoke(), {identity: IDENTITY, sessionId: SESSION_ID}, scrubber)
    const onlyInvocation = toExportSpan(invoke(), {identity: IDENTITY, invocationId: INVOCATION_ID}, scrubber)
    const onlyRoot = toExportSpan(invoke(), {identity: IDENTITY, rootSpan: ROOT_SPAN}, scrubber)

    // #then
    expect(onlySession.attributes['langfuse.session.id']).toBe(SESSION_ID)
    expect(onlySession.attributes['fro_bot.invocation.id']).toBeUndefined()
    expect(onlySession.links).toBeUndefined()
    expect(onlyInvocation.attributes['langfuse.session.id']).toBe('ses_root')
    expect(onlyInvocation.attributes['fro_bot.invocation.id']).toBe(INVOCATION_ID)
    expect(onlyInvocation.links).toBeUndefined()
    expect(onlyRoot.attributes['langfuse.session.id']).toBe('ses_root')
    expect(onlyRoot.attributes['fro_bot.invocation.id']).toBeUndefined()
    expect(onlyRoot.links).toEqual([ROOT_SPAN])
  })

  it('behaves exactly as before for an Action launcher without the fields', () => {
    // #given the options the plugin builds from today's launcher
    for (const record of [chat(), tool(), invoke()]) {
      const span = exported(record, IDENTITY)

      // #then the Langfuse session is the OpenCode root session, and no invocation attribute or link exists
      expect(span.attributes['langfuse.session.id']).toBe('ses_root')
      expect(Object.keys(span.attributes).filter(name => name.includes('invocation'))).toEqual([])
      expect(span.links).toBeUndefined()
    }
  })

  it('keeps the OpenCode root session in a local session, which has no launcher', () => {
    for (const record of [chat(), tool(), invoke()]) {
      const span = exported(record)
      expect(span.attributes['langfuse.session.id']).toBe('ses_root')
      expect(Object.keys(span.attributes).filter(name => name.includes('invocation'))).toEqual([])
      expect(span.links).toBeUndefined()
    }
  })

  it('falls back to the OpenCode root session, never a redacted value, when scrubbing would change the session id', () => {
    // #given a session id the scrubber reads as a name and value (`password…:`), as the Action could compute for such a repository
    const raw = 'acme/password-manager:issue-42'
    expect(scrubber.scrub(raw)).not.toMatchObject({text: raw})

    // #when every kind of span is exported with it
    for (const record of [chat(), tool(), invoke(), invoke({role: 'child'})]) {
      const span = toExportSpan(record, {identity: IDENTITY, sessionId: raw}, scrubber)

      // #then the Langfuse session is the OpenCode root, and no `[REDACTED]` stands in for the id
      expect(span.attributes['langfuse.session.id']).toBe('ses_root')
      expect(String(span.attributes['langfuse.session.id'])).not.toContain('[REDACTED]')
    }
  })

  it('falls back when the scrubber withholds the session id, even when the id is literally the withheld marker', () => {
    // #given an id that is exactly the text a withheld value is replaced with, and a scrubber that cannot process that text
    const base = createScrubber()
    const failing = {
      ...base,
      scrub: (text: string) =>
        text === '[omitted]' ? ({ok: false, reason: 'scrub-failed'} as const) : base.scrub(text),
    }

    // #when every kind of span is exported with it
    for (const record of [chat(), tool(), invoke(), invoke({role: 'child'})]) {
      const span = toExportSpan(record, {identity: IDENTITY, sessionId: '[omitted]'}, failing)

      // #then the value equality alone would have passed (`[omitted]` is `[omitted]`); the omission status sends it to the root
      expect(span.attributes['langfuse.session.id']).toBe('ses_root')
    }
  })

  it('falls back when the safety net withholds the session id', () => {
    // #given a scrubber whose scrub leaves the text but whose safety net says a literal survived in the id
    const base = createScrubber()
    const net = {...base, survived: (text: string) => text === SESSION_ID}

    // #then the id is withheld by `scrubSpan` and the span falls back to the root session
    expect(toExportSpan(chat(), LINKED, net).attributes['langfuse.session.id']).toBe('ses_root')
  })

  it('falls back when a literal added after the span was recorded matches the session id', () => {
    // #given a scrubber that did not know the id when it was built, and a record made before it learns it
    const late = createScrubber()
    const record = chat()
    expect(toExportSpan(record, LINKED, late).attributes['langfuse.session.id']).toBe(SESSION_ID)

    // #when a literal matching it arrives
    late.addLiterals?.([SESSION_ID])

    // #then the same record exports under the root session, not a redacted id, and the other attributes still scrub
    const span = toExportSpan(record, LINKED, late)
    expect(span.attributes['langfuse.session.id']).toBe('ses_root')
    expect(span.attributes['session.id']).toBe('ses_child')
  })

  it('exports a session id the scrubber leaves alone verbatim, hashed ids included', () => {
    // #given an id in the helper's hashed form
    const hashed = 'sha256:0123456789abcdef0123456789abcdef'

    // #then it is exported as given
    expect(
      toExportSpan(chat(), {identity: IDENTITY, sessionId: hashed}, scrubber).attributes['langfuse.session.id'],
    ).toBe(hashed)
  })

  it('scrubs the session id and the invocation id like every other string attribute', () => {
    // #given ids carrying a secret shape
    const secret = ['ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')
    const span = toExportSpan(
      chat(),
      {identity: IDENTITY, sessionId: `o/r:${secret}`, invocationId: `inv-${secret}`},
      scrubber,
    )

    // #then neither the session, the invocation id nor its Langfuse mirror holds it
    expect(JSON.stringify(span.attributes)).not.toContain(secret)
  })
})

describe('the exported payload', () => {
  it('holds no fixture secret anywhere, in any string, after a recursive walk', () => {
    // #given records whose every string field carries a secret shape
    const secret = ['ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')
    const text = `leaked ${secret} here`
    const records: SpanRecord[] = [
      chat({
        model: `gpt-${secret}`,
        request: {
          system: [{type: 'text', text}],
          messages: [{role: 'user', content: [{type: 'text', text}]}],
          tools: {x: {description: text, input: {type: 'object', description: text}}},
        },
        texts: [text],
        reasoning: [text],
        toolCalls: [{callId: 'c', tool: 'read', input: {a: text}}],
        status: 'error',
        error: {type: 'provider.internal', message: text},
      }),
      tool({
        tool: `read-${secret}`,
        input: {a: text},
        result: {content: text},
        status: 'error',
        error: {type: 'tool.execution', message: text},
      }),
      invoke({prompts: [{messageId: 'm', at: 1, content: {text}, midTurn: false}]}),
    ]

    // #when
    const spans = records.map(record => exported(record))

    // #then
    for (const span of spans) {
      const found = JSON.stringify(span).includes('aB3dE5fG7hJ9')
      expect(found).toBe(false)
      expect(Number(span.attributes[MARKER.redactions])).toBeGreaterThan(0)
    }
  })

  it('keeps every bounded content value parseable', () => {
    // #given a long, tool-heavy record
    const huge = 'q'.repeat(2_000_000)
    const span = exported(
      chat({
        request: {
          system: [{type: 'text', text: huge}],
          messages: [
            {
              role: 'tool',
              content: [{type: 'tool-result', id: 'c', name: 'read', result: {type: 'text', value: huge}}],
            },
          ],
          tools: {read: {description: huge, input: {}}},
        },
        texts: [huge],
      }),
    )

    // #then every content attribute parses and the span's content stays within its budget
    let total = 0
    for (const name of [
      'gen_ai.system_instructions',
      'gen_ai.tool.definitions',
      'gen_ai.output.messages',
      'gen_ai.input.messages',
    ]) {
      const raw = String(span.attributes[name])
      expect(() => {
        JSON.parse(raw)
      }).not.toThrow()
      total += raw.length
    }
    expect(total).toBeLessThanOrEqual(1024 * 1024)
  })

  it('pins the convention revision', () => {
    // #given / #when / #then
    expect(GENAI_SEMCONV_REVISION).toBe('open-telemetry/semantic-conventions-genai@76e0c19')
    expect(toPendingSpan(chat()).attributes['gen_ai.operation.name']).toBe('chat')
  })
})

describe('what a hook-time snapshot could not take', () => {
  it('names each omitted request field on the span, with the reason, and sets no attribute for it', () => {
    // #given a request whose snapshot found no room, and one whose system text was over its ceiling
    const noRoom = snapshotRequest(
      {system: [{text: 's'}], messages: [], tools: {}},
      {
        ledger: {
          room: () => undefined,
          hold: () => {},
          retain: () => {},
          release: () => {},
          refuse: () => {},
          stats: () => ({pending: 0, pendingChars: 0, refused: 0}),
        },
      },
    )
    const bigSystem = snapshotRequest(
      {system: [{text: 'S'.repeat(100)}], messages: [{role: 'user', content: 'hi'}]},
      {limits: {systemChars: 10}},
    )

    // #when
    const first = exported(chat({request: noRoom}))
    const second = exported(chat({request: bigSystem}))

    // #then the structure is intact, the content attributes are absent, and the markers say what and why
    expect(first.attributes['gen_ai.operation.name']).toBe('chat')
    expect(first.attributes['gen_ai.input.messages']).toBeUndefined()
    expect(first.attributes[MARKER.omitted]).toEqual([
      'gen_ai.system_instructions:pending-bound',
      'gen_ai.tool.definitions:pending-bound',
      'gen_ai.input.messages:pending-bound',
    ])
    expect(second.attributes['gen_ai.system_instructions']).toBeUndefined()
    expect(second.attributes[MARKER.omitted]).toEqual(['gen_ai.system_instructions:snapshot-bound'])
    expect(parse(second, 'gen_ai.input.messages')).toEqual([{role: 'user', parts: [{type: 'text', content: 'hi'}]}])
  })

  it('states how many of the oldest messages the snapshot left out, added to any the bound drops later', () => {
    // #given a snapshot that dropped six messages for its ceiling
    const messages = Array.from({length: 10}, (_, index) => ({
      role: 'user',
      content: [{type: 'text', text: `m${index}:${'z'.repeat(96)}`}],
    }))
    const snapshot = snapshotRequest({messages}, {limits: {requestChars: 430}})

    // #when
    const span = exported(chat({request: snapshot}))

    // #then
    expect(span.attributes[MARKER.dropped('gen_ai.input.messages')]).toBe(6)
    expect((parse(span, 'gen_ai.input.messages') as unknown[]).length).toBe(4)
  })

  it('marks an omitted tool argument and result, and a prompt that was over its ceiling', () => {
    // #given snapshots that were omitted
    const args = snapshotToolArguments({a: 'x'.repeat(100)}, {limits: {valueChars: 10}})
    const result = snapshotToolResult({content: 'x'.repeat(100)}, {limits: {valueChars: 10}})
    const prompt = snapshotPrompt({text: 'x'.repeat(100)}, {limits: {valueChars: 10}})

    // #when
    const toolSpan = exported(tool({input: args, result}))
    const invokeSpan = exported(invoke({prompts: [{messageId: 'm', at: 1, content: prompt, midTurn: false}]}))

    // #then
    expect(toolSpan.attributes['gen_ai.tool.call.arguments']).toBeUndefined()
    expect(toolSpan.attributes['gen_ai.tool.call.result']).toBeUndefined()
    expect(toolSpan.attributes[MARKER.omitted]).toEqual([
      'gen_ai.tool.call.arguments:snapshot-bound',
      'gen_ai.tool.call.result:snapshot-bound',
    ])
    expect(invokeSpan.attributes['gen_ai.input.messages']).toBeUndefined()
    expect(invokeSpan.attributes[MARKER.omitted]).toEqual(['gen_ai.input.messages:snapshot-bound'])
    expect(omittedContent('unreadable').reason).toBe('unreadable')
  })

  it('exports a snapshot’s content exactly as it exported the raw input', () => {
    // #given the same request as a raw hook input and as a snapshot of it
    const raw = {
      system: [{text: 'sys'}],
      messages: [
        {role: 'user', content: [{type: 'text', text: 'hi'}]},
        {role: 'assistant', content: [{type: 'tool-call', id: 'c', name: 'read', input: {path: 'a'}}]},
      ],
      tools: {read: {description: 'd', input: {type: 'object'}}},
    }

    // #when
    const fromRaw = exported(chat({request: raw}))
    const fromSnapshot = exported(chat({request: snapshotRequest(raw)}))

    // #then
    for (const name of ['gen_ai.system_instructions', 'gen_ai.tool.definitions', 'gen_ai.input.messages']) {
      expect(fromSnapshot.attributes[name]).toBe(fromRaw.attributes[name])
    }
  })
})

describe('what the tool lifecycle and unobservable retries add to a span', () => {
  it('marks a provider-executed tool, and a rejected one, and sets nothing for an ordinary call', () => {
    // #given
    const hosted = exported(tool({providerExecuted: true}))
    const rejected = exported(tool({outcome: 'rejected', status: 'error', errorType: 'plugin.reuse-guard'}))
    const ordinary = exported(tool())

    // #then
    expect(hosted.attributes['fro_bot.tool.provider_executed']).toBe(true)
    expect(rejected.attributes['fro_bot.tool.outcome']).toBe('rejected')
    expect(rejected.attributes['fro_bot.tool.error_type']).toBe('plugin.reuse-guard')
    expect(ordinary.attributes['fro_bot.tool.provider_executed']).toBeUndefined()
  })

  it.each(['title', 'compaction', 'generate'] as const)(
    'marks a %s request’s attempt count as unknown, and sets no attempt number',
    requestKind => {
      // #given
      const span = exported(chat({requestKind, attemptCountUnknown: true}))

      // #then
      expect(span.attributes['fro_bot.request.attempt_count_unknown']).toBe(true)
      expect(span.attributes['fro_bot.request.attempt']).toBeUndefined()
    },
  )

  it('sets no unknown-attempts marker on a session model step, which has a retry hook and an attempt number', () => {
    // #given / #then
    const span = exported(chat({attempt: 2}))
    expect(span.attributes['fro_bot.request.attempt_count_unknown']).toBeUndefined()
    expect(span.attributes['fro_bot.request.attempt']).toBe(2)
  })
})

describe('the Langfuse trace name', () => {
  const TRACE_NAME = 'langfuse.trace.name'

  it('names the trace on a root invoke_agent span, with a fixed string that carries no content', () => {
    // #given a turn's root span, whose prompt and agent are content
    const span = exported(
      invoke({prompts: [{messageId: 'm1', at: 1_000, content: {text: 'K-PROMPT'}, midTurn: false}]}),
    )

    // #then the trace is named by the literal and nothing the turn holds
    expect(span.attributes[TRACE_NAME]).toBe('fro-bot run')
  })

  it('names the root of a continuation trace the same as its source', () => {
    // #given the root of a trace that continues a closed one
    const source = exported(invoke())
    const continuation = exported(invoke({prompts: [], marks: ['continuation'], continuationOf: 'trace-0'}))

    // #then the continuation carries the same name, and it still says what it continues
    expect(source.attributes[TRACE_NAME]).toBe('fro-bot run')
    expect(continuation.attributes[TRACE_NAME]).toBe(source.attributes[TRACE_NAME])
    expect(continuation.attributes['fro_bot.turn.continuation_of']).toBe('trace-0')
  })

  it('does not name the trace on a span that has a parent', () => {
    // #given each kind of span inside an existing trace, a child session's invoke_agent included
    const records: SpanRecord[] = [
      chat({parentSpanId: 'span-parent'}),
      tool({parentSpanId: 'span-parent'}),
      invoke({role: 'child', parentSpanId: 'span-parent'}),
    ]

    // #then none carries the name
    for (const record of records) expect(exported(record).attributes[TRACE_NAME]).toBeUndefined()
  })

  it('names exactly the root of every replayed trace, a subagent tree included', () => {
    // #given the nested-subagent fixture: a root and two child sessions in one trace
    const {records} = replay(recordedFixtures['subagent-nested']?.observations ?? [])

    // #when every record is exported
    const spans = records.map(record => exported(record))

    // #then each trace has one named span, and it is the one without a parent
    const named = spans.filter(span => span.attributes[TRACE_NAME] !== undefined)
    expect(named.length).toBeGreaterThan(0)
    expect(named.every(span => span.parentSpanId === undefined)).toBe(true)
    expect(spans.filter(span => span.parentSpanId === undefined)).toEqual(named)
    for (const traceId of new Set(spans.map(span => span.traceId)))
      expect(named.filter(span => span.traceId === traceId)).toHaveLength(1)
  })

  it('exports the literal whole even when the scrubber would rewrite it, and when the session id falls back', () => {
    // #given a scrubber that rewrites every string it sees, and a session id it will not leave alone
    const base = createScrubber()
    const rewriting = {
      ...base,
      scrub: (text: string) => ({ok: true, text: `[REDACTED:${text.length}]`, redactions: 1}) as const,
    }

    // #when a root and a child are exported
    const root = toExportSpan(invoke(), {identity: IDENTITY, sessionId: 'o/r:key'}, rewriting)
    const child = toExportSpan(chat({parentSpanId: 'span-parent'}), {sessionId: 'o/r:key'}, rewriting)

    // #then the root's name is the literal, and the child still has none
    expect(root.attributes[TRACE_NAME]).toBe('fro-bot run')
    expect(child.attributes[TRACE_NAME]).toBeUndefined()
  })
})
