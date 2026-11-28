/** Records and the export call the #2403 attribute tests share: one place for the plain span a test then changes a field of. */

import type {ScrubbedSpan, Scrubber} from './content.js'
import type {AttributeOptions} from './genai-attributes.js'
import type {ChatRecord, InvokeRecord, SpanRecord, ToolRecord} from './turn-model.js'

import {createScrubber} from './content.js'
import {toExportSpan} from './genai-attributes.js'

export const scrubber = createScrubber()

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

export const chat = (overrides: Partial<ChatRecord> = {}): ChatRecord => ({
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

export const tool = (overrides: Partial<ToolRecord> = {}): ToolRecord => ({
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

export const invoke = (overrides: Partial<InvokeRecord> = {}): InvokeRecord => ({
  ...base,
  kind: 'invoke_agent',
  name: 'invoke_agent build',
  role: 'root',
  prompts: [{messageId: 'm1', at: 1_000, content: {text: 'please read it'}, midTurn: false}],
  ...overrides,
})

export const exported = (
  record: SpanRecord,
  options: AttributeOptions = {},
  using: Scrubber = scrubber,
): ScrubbedSpan => toExportSpan(record, options, using)

/** A scrubber that rewrites every string it sees, to show a value goes through the scrub and is exported as the scrubber made it. */
export const rewritingScrubber: Scrubber = {
  ...scrubber,
  scrub: (text: string) => ({ok: true, text: `[REDACTED:${text.length}]`, redactions: 1}) as const,
}
