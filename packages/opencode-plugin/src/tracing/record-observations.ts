/**
 * From OpenCode hook payloads and bus events to the turn model's observations, and the recorder that registers every
 * hook and event the model needs. The recorder is what produced `turn-model.fixtures.ts` from a real binary; the same
 * normalizers feed the model in production.
 *
 * Payload shapes are the ones the pinned 2.3.2 binary sends. A field that is absent or of another type yields no
 * observation or an observation without that field: a drifted shape shows up as a gap, never as a throw.
 */

import type {ErrorInfo, Observation, RequestKind, Usage} from './observation.js'
import type {SnapshotContext} from './snapshot.js'

import {snapshotPrompt, snapshotRequest, snapshotToolArguments, snapshotToolResult} from './snapshot.js'

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const asRecord = (value: unknown): Json | undefined => (isRecord(value) ? value : undefined)
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function modelOf(value: unknown): {model: string | undefined; provider: string | undefined} {
  const model = asRecord(value)
  return {model: asString(model?.id), provider: asString(model?.providerID)}
}

function errorOf(value: unknown): ErrorInfo {
  const error = asRecord(value)
  return {type: asString(error?.type) ?? 'unknown', message: asString(error?.message), status: asNumber(error?.status)}
}

function usageOf(value: unknown): Usage | undefined {
  const tokens = asRecord(value)
  if (tokens === undefined) return undefined
  const cache = asRecord(tokens.cache)
  const input = asNumber(tokens.input)
  const output = asNumber(tokens.output)
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    reasoning: asNumber(tokens.reasoning) ?? 0,
    cacheRead: asNumber(cache?.read) ?? 0,
    cacheWrite: asNumber(cache?.write) ?? 0,
  }
}

const REQUEST_HOOKS: Readonly<Record<string, RequestKind>> = {
  context: 'primary',
  compaction: 'compaction',
  title: 'title',
  generate: 'generate',
}

/** The child session a `subagent` tool call started, from the metadata its result and its success event carry. */
function childOfSubagent(tool: string, metadata: unknown): string | undefined {
  return tool === 'subagent' ? asString(asRecord(metadata)?.sessionID) : undefined
}

/**
 * One hook call as an observation. `name` is `session.<hook>` or `tool.<hook>`.
 *
 * Nothing of the payload is kept. What the span will carry (request, prompt, tool arguments and result) is taken here, as
 * an immutable bounded snapshot of the named fields (`snapshot.ts`), so a later edit to the hook's input by the host or by
 * another plugin cannot change the hook-time view. Everything else is read into primitives. The work is a walk over the
 * named fields: strings are shared, never copied or serialized.
 */
export function observeHook(
  name: string,
  payload: unknown,
  at: number,
  snapshot: SnapshotContext = {},
): Observation | undefined {
  const event = asRecord(payload)
  if (event === undefined) return undefined
  const sessionId = asString(event.sessionID)
  if (sessionId === undefined) return undefined

  if (name === 'session.prompt') {
    const messageId = asString(event.messageID)
    if (messageId === undefined) return undefined
    const content = snapshotPrompt(event.prompt, snapshot)
    return {kind: 'prompt', at, sessionId, messageId, delivery: asString(event.delivery), content, bytes: content.size}
  }

  const requestKind = name.startsWith('session.') ? REQUEST_HOOKS[name.slice('session.'.length)] : undefined
  if (requestKind !== undefined) {
    const {model, provider} = modelOf(event.model)
    const content = snapshotRequest({system: event.system, messages: event.messages, tools: event.tools}, snapshot)
    return {
      kind: 'request',
      at,
      sessionId,
      requestKind,
      agent: asString(event.agent),
      model,
      provider,
      content,
      bytes: content.size,
    }
  }

  if (name === 'session.retry') {
    const decision = asRecord(event.decision)
    return {
      kind: 'retry',
      at,
      sessionId,
      attempt: asNumber(event.attempt) ?? 0,
      willRetry: decision?.retry === true,
      error: errorOf(event.error),
    }
  }

  if (name === 'tool.execute.before') {
    const callId = asString(event.id)
    const tool = asString(event.tool)
    if (callId === undefined || tool === undefined) return undefined
    return {
      kind: 'tool.before',
      at,
      sessionId,
      callId,
      tool,
      messageId: asString(event.messageID),
      agent: asString(event.agent),
      input: snapshotToolArguments(event.input, snapshot),
    }
  }

  if (name === 'tool.execute.after') {
    const callId = asString(event.id)
    const tool = asString(event.tool)
    if (callId === undefined || tool === undefined) return undefined
    const failed = event.status === 'error'
    const result = asRecord(event.result)
    const error = asRecord(event.error)
    return {
      kind: 'tool.after',
      at,
      sessionId,
      callId,
      tool,
      status: failed ? 'error' : 'completed',
      result: failed ? undefined : snapshotToolResult(event.result, snapshot),
      error: failed ? errorOf(event.error) : undefined,
      interrupted: asRecord(error?.metadata)?.interrupted === true,
      childSessionId: childOfSubagent(tool, result?.metadata),
    }
  }

  return undefined
}

/** How far into a report's text the `<subagent …>` header is looked for. */
const REPORT_HEADER_WINDOW = 400

/**
 * The state a subagent report carries. The report's own header is the truth (`<subagent … state="running" …>`): the
 * item's `metadata.state` says `completed` even on the interim report a parent gets while the child's own background work
 * still runs. Reads only the head of the text, by `indexOf`, so cost does not grow with a report's size.
 */
export function reportStateOf(text: unknown, metadata: Json | undefined): string | undefined {
  if (typeof text === 'string') {
    const head = text.slice(0, REPORT_HEADER_WINDOW)
    const close = head.indexOf('>')
    const marker = head.indexOf(' state="')
    if (head.startsWith('<subagent ') && marker !== -1 && (close === -1 || marker < close)) {
      const from = marker + ' state="'.length
      const to = head.indexOf('"', from)
      if (to !== -1) return head.slice(from, to)
    }
  }
  return asString(metadata?.state)
}

function itemKind(item: Json | undefined): 'user' | 'synthetic' | 'compaction' | 'other' {
  const type = asString(item?.type)
  return type === 'user' || type === 'synthetic' || type === 'compaction' ? type : 'other'
}

/** One bus event as an observation. Events the model does not read (deltas, config updates, usage detail) yield none. */
export function observeEvent(raw: unknown): Observation | undefined {
  const event = asRecord(raw)
  const type = asString(event?.type)
  const data = asRecord(event?.data)
  const at = asNumber(event?.created)
  if (event === undefined || type === undefined || data === undefined || at === undefined) return undefined
  const sessionId = asString(data.sessionID)
  if (sessionId === undefined) return undefined
  const messageId = asString(data.assistantMessageID)

  switch (type) {
    case 'session.created':
      return {
        kind: 'session.created',
        at,
        sessionId,
        parentSessionId: asString(data.parentID),
        agent: asString(data.agent),
      }
    case 'session.inbox.enqueued': {
      const inboxId = asString(data.inboxID)
      if (inboxId === undefined) return undefined
      const item = asRecord(data.item)
      const payload = asRecord(item?.payload)
      const metadata = asRecord(payload?.metadata)
      const report = asString(metadata?.source) === 'subagent'
      return {
        kind: 'inbox.enqueued',
        at,
        sessionId,
        inboxId,
        item: itemKind(item),
        childSessionId: report ? asString(metadata?.childID) : undefined,
        reportState: report ? reportStateOf(payload?.text, metadata) : undefined,
      }
    }
    case 'session.inbox.delivered': {
      const inboxId = asString(data.inboxID)
      return inboxId === undefined ? undefined : {kind: 'inbox.delivered', at, sessionId, inboxId}
    }
    case 'session.execution.started':
      return {kind: 'execution.started', at, sessionId}
    case 'session.execution.succeeded':
      return {kind: 'execution.ended', at, sessionId, outcome: 'succeeded'}
    case 'session.execution.failed':
      return {kind: 'execution.ended', at, sessionId, outcome: 'failed', error: errorOf(data.error)}
    case 'session.execution.interrupted':
      return {kind: 'execution.ended', at, sessionId, outcome: 'interrupted', reason: asString(data.reason)}
    case 'session.step.started': {
      if (messageId === undefined) return undefined
      const {model, provider} = modelOf(data.model)
      return {kind: 'step.started', at, sessionId, messageId, agent: asString(data.agent), model, provider}
    }
    case 'session.step.ended':
      return messageId === undefined
        ? undefined
        : {
            kind: 'step.ended',
            at,
            sessionId,
            messageId,
            finish: asString(data.finish),
            rawFinish: asString(data.rawFinish),
            usage: usageOf(data.tokens),
            cost: asNumber(data.cost),
          }
    case 'session.step.failed':
      return messageId === undefined
        ? undefined
        : {kind: 'step.failed', at, sessionId, messageId, error: errorOf(data.error), usage: usageOf(data.tokens)}
    case 'session.text.ended':
    case 'session.reasoning.ended': {
      const text = asString(data.text)
      if (messageId === undefined || text === undefined) return undefined
      return {
        kind: 'output',
        at,
        sessionId,
        messageId,
        part: type === 'session.text.ended' ? 'text' : 'reasoning',
        text,
        bytes: text.length,
      }
    }
    case 'session.tool.success':
    case 'session.tool.failed': {
      const callId = asString(data.id)
      if (callId === undefined) return undefined
      const metadata = asRecord(data.metadata)
      const error = asRecord(data.error)
      return {
        kind: 'tool.ended',
        at,
        sessionId,
        callId,
        succeeded: type === 'session.tool.success',
        errorType: asString(error?.type),
        message: asString(error?.message),
        truncated: typeof metadata?.truncated === 'boolean' ? metadata.truncated : undefined,
        // Only the stock `subagent` tool puts a child session id here; the model checks the tool when it links.
        childSessionId: asString(metadata?.sessionID),
      }
    }
    case 'session.compaction.started':
      return {kind: 'compaction.started', at, sessionId, reason: asString(data.reason), inputId: asString(data.inputID)}
    case 'session.compaction.ended':
      return {
        kind: 'compaction.ended',
        at,
        sessionId,
        ok: true,
        text: asString(data.text),
        usage: usageOf(data.tokens),
        cost: asNumber(data.cost),
      }
    case 'session.compaction.failed':
      return {kind: 'compaction.ended', at, sessionId, ok: false, error: errorOf(data.error)}
    case 'session.renamed': {
      const title = asString(data.title)
      return title === undefined ? undefined : {kind: 'title', at, sessionId, title}
    }
    case 'session.usage.updated':
      return {kind: 'usage', at, sessionId}
    default:
      return undefined
  }
}

export type SessionHookName = 'prompt' | 'context' | 'compaction' | 'generate' | 'title' | 'retry'

/**
 * The slice of the plugin context the observers register on. Structural, so a fake host can stand in and the real
 * `Plugin.Context` still fits.
 */
export interface ObserverHost {
  readonly session: {
    hook: (name: SessionHookName, callback: (event: unknown) => void) => Promise<unknown>
  }
  readonly tool: {
    hook: (name: 'execute.before' | 'execute.after', callback: (event: unknown) => void) => Promise<unknown>
  }
  readonly event: {
    subscribe: () => AsyncIterable<unknown>
  }
}

/**
 * Registers every hook and the bus subscription the model reads, and passes each observation to `emit`. Handlers read and
 * return; they never touch the hook's arguments, and a throwing `emit` or normalizer never reaches the host.
 * Returns a stop function for the event subscription.
 */
export async function registerObservers(
  host: ObserverHost,
  emit: (observation: Observation) => void,
  now: () => number = Date.now,
  snapshot: SnapshotContext = {},
): Promise<() => void> {
  const deliver = (observation: Observation | undefined): void => {
    if (observation === undefined) return
    try {
      emit(observation)
    } catch {
      // Observation must never fail a session.
    }
  }
  const sessionHook = async (name: SessionHookName): Promise<void> => {
    await host.session.hook(name, event => {
      try {
        deliver(observeHook(`session.${name}`, event, now(), snapshot))
      } catch {
        // See above.
      }
    })
  }
  for (const name of ['prompt', 'context', 'compaction', 'generate', 'title', 'retry'] as const) await sessionHook(name)
  for (const name of ['execute.before', 'execute.after'] as const) {
    await host.tool.hook(name, event => {
      try {
        deliver(observeHook(`tool.${name}`, event, now(), snapshot))
      } catch {
        // See above.
      }
    })
  }

  let stopped = false
  const pump = async (): Promise<void> => {
    try {
      for await (const event of host.event.subscribe()) {
        if (stopped) break
        try {
          deliver(observeEvent(event))
        } catch {
          // See above.
        }
      }
    } catch {
      // A closed subscription ends the stream.
    }
  }
  pump().catch(() => {})
  return () => {
    stopped = true
  }
}
