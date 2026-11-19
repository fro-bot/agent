/**
 * The turn model: normalized observations in, span records out. Pure: no SDK, no I/O, no clock of its own (time comes in
 * on observations as epoch milliseconds, and a `tick` observation lets the caller's timer advance it), no ids of its own
 * (they come from the injected `IdSource`).
 *
 * What it encodes, each fact observed on the pinned OpenCode 2.3.2 binary (see `turn-model.fixtures.ts`):
 * - Every subagent is a background job. The `subagent` tool returns in milliseconds with the child session id, so a
 *   child's spans arrive after the tool span that started it has ended. The link is `tool.after` / `tool.success`
 *   metadata `sessionID`, keyed by the tool call.
 * - The child's first `prompt` hook can arrive BEFORE that link, so observations of an unknown session are buffered
 *   while a dispatch is unresolved.
 * - A parent's execution can end while its child still runs. The child's report is a synthetic inbox item that starts a
 *   new parent execution with no prompt, or is delivered into an execution already running. A child that itself has
 *   background work reports `state="running"` first and `completed` later.
 * - A hook for a model request can arrive before the `execution.started` event of the execution it belongs to, and
 *   before the `inbox.delivered` event that consumed its trigger. Executions are therefore begun from pending inbox
 *   items, not from the event.
 * - A request hook carries no message id. A primary request is joined to its `step.started` by order within the session.
 *   A failed attempt shows as a `retry` hook BEFORE its `step.started`.
 */

import type {ErrorInfo, InboxItemKind, Observation, RequestKind, Usage} from './observation.js'

export type {ErrorInfo, ExecutionOutcome, InboxItemKind, Observation, RequestKind, Usage} from './observation.js'

export type ToolOutcome = 'success' | 'error' | 'rejected' | 'interrupted'

export type SpanKind = 'invoke_agent' | 'chat' | 'execute_tool'
export type SpanStatus = 'ok' | 'error' | 'interrupted'

export interface PromptRecord {
  readonly messageId: string
  readonly at: number
  readonly content?: unknown
  readonly delivery?: string | undefined
  /** Arrived while the turn's execution was already running. */
  readonly midTurn: boolean
}

interface RecordBase {
  readonly spanId: string
  readonly traceId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly start: number
  readonly end: number
  readonly status: SpanStatus
  readonly error?: ErrorInfo | undefined
  readonly sessionId: string
  /** The session whose turn this trace is: the grouping key for a whole tree. */
  readonly rootSessionId: string
  readonly agent: string | undefined
  /** Fields that were not captured, by name. Absent means not captured, never empty. */
  readonly gaps: readonly string[]
  /** `incomplete`, `unattributed`, `continuation`. */
  readonly marks: readonly string[]
}

export interface InvokeRecord extends RecordBase {
  readonly kind: 'invoke_agent'
  readonly role: 'root' | 'child'
  readonly prompts: readonly PromptRecord[]
  /** Set when this trace continues a closed one: a report that arrived after the trace ended. */
  readonly continuationOf?: string | undefined
  /** Set when this turn's subagent report was consumed by another turn's execution. */
  readonly reportDeliveredInTrace?: string | undefined
  readonly standalone?: 'compaction' | 'generate' | undefined
}

export interface ChatRecord extends RecordBase {
  readonly kind: 'chat'
  readonly requestKind: RequestKind
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly attempt: number
  readonly messageId?: string | undefined
  /** The hook-time request, as the observation carried it. */
  readonly request?: unknown
  readonly texts: readonly string[]
  readonly reasoning: readonly string[]
  /** Tool calls this response asked for, in order: the response's output alongside its text. */
  readonly toolCalls: readonly RequestedToolCall[]
  readonly finishReason?: string | undefined
  readonly rawFinishReason?: string | undefined
  readonly usage?: Usage | undefined
  readonly cost?: number | undefined
  /** Traces whose subagent report this request carried while running inside another turn's execution. */
  readonly followOnOf: readonly string[]
}

export interface RequestedToolCall {
  readonly callId: string
  readonly tool: string
  readonly input?: unknown
}

export interface ToolRecord extends RecordBase {
  readonly kind: 'execute_tool'
  readonly tool: string
  readonly callId: string
  readonly input?: unknown
  readonly result?: unknown
  readonly outcome: ToolOutcome
  readonly errorType?: string | undefined
  readonly toolTruncated?: boolean | undefined
  readonly childSessionId?: string | undefined
}

export type SpanRecord = InvokeRecord | ChatRecord | ToolRecord

export interface IdSource {
  readonly trace: () => string
  readonly span: () => string
}

/** Every bound the model applies. Overridable so a test can hit each boundary. */
export interface TurnModelLimits {
  /** Observations held for one session whose parent is not yet known. */
  readonly maxBufferedObservations: number
  readonly maxBufferedBytes: number
  /** Sessions held at once. */
  readonly maxBufferedSessions: number
  /** How long an unknown session may wait for its dispatch link before it gets its own trace. */
  readonly bufferWindowMs: number
  /** A trace with no observation for this long closes, marked incomplete. */
  readonly rootInactivityMs: number
  /** Open traces at once. The least recently active closes, marked incomplete. */
  readonly maxOpenTraces: number
  /** Closed traces remembered so a late report can name them. */
  readonly maxTombstones: number
  /** A title's text arrives in an event that can follow the end of its turn; the trace waits this long for it. */
  readonly titleWaitMs: number
  /** A standalone `generate` request has no end event; it closes after this long. */
  readonly standaloneRequestTimeoutMs: number
  /** Open request and tool spans per trace. Beyond this a span is dropped and counted. */
  readonly maxOpenSpansPerTrace: number
  /** Output parts kept per request. */
  readonly maxOutputParts: number
  /** Prompts kept per span. */
  readonly maxPromptsPerSpan: number
}

export const DEFAULT_LIMITS: TurnModelLimits = {
  maxBufferedObservations: 64,
  maxBufferedBytes: 256 * 1024,
  maxBufferedSessions: 16,
  bufferWindowMs: 5_000,
  rootInactivityMs: 30 * 60_000,
  maxOpenTraces: 32,
  maxTombstones: 256,
  titleWaitMs: 10_000,
  standaloneRequestTimeoutMs: 120_000,
  maxOpenSpansPerTrace: 1_024,
  maxOutputParts: 64,
  maxPromptsPerSpan: 32,
}

export interface TurnModelStats {
  readonly openTraces: number
  readonly sessions: number
  readonly bufferedSessions: number
  readonly bufferedBytes: number
  readonly tombstones: number
  readonly unresolvedDispatches: number
  readonly droppedSpans: number
}

export interface TurnModel {
  /** Feeds one observation. Returns the spans that finished because of it. */
  readonly observe: (observation: Observation) => SpanRecord[]
  /** Closes everything still open as interrupted and incomplete, and releases all state. */
  readonly flush: (at: number) => SpanRecord[]
  readonly stats: () => TurnModelStats
}

// ---------------------------------------------------------------------------------------------------------------------
// Internal mutable state. Per-invocation trackers in a closure, never exported.
// ---------------------------------------------------------------------------------------------------------------------

interface InvokeState {
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly role: 'root' | 'child'
  readonly sessionId: string
  start: number
  agent: string | undefined
  prompts: PromptRecord[]
  gaps: Set<string>
  marks: Set<string>
  status: SpanStatus
  error: ErrorInfo | undefined
  closed: boolean
  continuationOf: string | undefined
  reportDeliveredInTrace: string | undefined
  standalone: 'compaction' | 'generate' | undefined
}

interface TraceState {
  readonly id: string
  readonly rootSessionId: string
  readonly root: InvokeState
  readonly nodes: Map<string, SessionNode>
  /** Children dispatched in this trace whose final report has not been delivered: child id to its parent session. */
  readonly outstanding: Map<string, string>
  lastActivity: number
  activeExecutions: number
  openSpans: number
  closed: boolean
}

interface PendingItem {
  readonly inboxId: string
  readonly kind: InboxItemKind
  readonly at: number
  readonly childSessionId: string | undefined
  readonly reportState: string | undefined
  /** The trace whose child this report is about, or the id of a closed trace that was. */
  readonly reportTrace: TraceState | undefined
  readonly reportTombstone: string | undefined
  /** Enqueued while an execution was running: that execution will consume it. */
  joined: boolean
  claimed: boolean
}

interface RequestState {
  readonly spanId: string
  readonly trace: TraceState
  readonly sessionId: string
  readonly parentSpanId: string
  readonly requestKind: RequestKind
  readonly start: number
  agent: string | undefined
  model: string | undefined
  provider: string | undefined
  readonly request: unknown
  readonly attempt: number
  messageId: string | undefined
  texts: string[]
  reasoning: string[]
  toolCalls: RequestedToolCall[]
  finishReason: string | undefined
  rawFinishReason: string | undefined
  usage: Usage | undefined
  cost: number | undefined
  followOnOf: string[]
  gaps: Set<string>
  marks: Set<string>
  /** Closed by a `retry` hook: waiting only for its `step.started` to be skipped. */
  closed: boolean
}

interface ToolState {
  readonly spanId: string
  readonly trace: TraceState
  readonly sessionId: string
  readonly parentSpanId: string
  readonly callId: string
  readonly tool: string
  readonly start: number
  readonly agent: string | undefined
  readonly input: unknown
  result: unknown
  afterStatus: 'completed' | 'error' | undefined
  afterError: unknown
  interrupted: boolean
  childSessionId: string | undefined
  gaps: Set<string>
}

interface SessionNode {
  readonly id: string
  /** Set for a child session: its trace and its own invoke span. */
  readonly childOf: {readonly trace: TraceState; readonly invoke: InvokeState} | undefined
  readonly traces: Set<TraceState>
  active: {readonly trace: TraceState} | undefined
  agent: string | undefined
  readonly pending: PendingItem[]
  readonly prompts: Map<string, Extract<Observation, {kind: 'prompt'}>>
  readonly requests: RequestState[]
  readonly tools: Map<string, ToolState>
  readonly stepOwner: Map<string, RequestState>
  /** Steps still to start for requests a `retry` hook already closed. */
  skipStepStarts: number
  nextAttempt: number
  lastActivity: number
}

interface BufferedSession {
  readonly sessionId: string
  readonly firstAt: number
  readonly items: Observation[]
  bytes: number
}

const CREATING_KINDS: ReadonlySet<Observation['kind']> = new Set([
  'prompt',
  'inbox.enqueued',
  'session.created',
  'execution.started',
  'request',
])

export function createTurnModel(options: {
  readonly ids: IdSource
  readonly limits?: Partial<TurnModelLimits>
}): TurnModel {
  const limits: TurnModelLimits = {...DEFAULT_LIMITS, ...options.limits}
  const {ids} = options

  const traces = new Set<TraceState>()
  const sessions = new Map<string, SessionNode>()
  const buffered = new Map<string, BufferedSession>()
  /** Session ids a `session.created` event said have a parent, before any dispatch link arrived. */
  const parentHints = new Map<string, string>()
  /** Subagent dispatches whose child session id is not known yet: `<session>/<call>`. */
  const unresolved = new Set<string>()
  /** Child sessions that have been placed under a dispatch. */
  const linked = new Set<string>()
  const tombstones = new Map<string, string>()
  /** Marks to put on a root trace the moment it is opened for a session. */
  const pendingMarks = new Map<string, string>()
  let droppedSpans = 0
  let bufferedBytes = 0
  let out: SpanRecord[] = []
  let clock = 0

  const emit = (record: SpanRecord): void => {
    out.push(record)
  }

  // ------------------------------------------------------------------ traces and sessions

  function newInvoke(
    role: 'root' | 'child',
    sessionId: string,
    start: number,
    parentSpanId: string | undefined,
  ): InvokeState {
    return {
      spanId: ids.span(),
      parentSpanId,
      role,
      sessionId,
      start,
      agent: undefined,
      prompts: [],
      gaps: new Set(),
      marks: new Set(),
      status: 'ok',
      error: undefined,
      closed: false,
      continuationOf: undefined,
      reportDeliveredInTrace: undefined,
      standalone: undefined,
    }
  }

  function openTrace(
    rootSessionId: string,
    start: number,
    extra: {continuationOf?: string; mark?: string; standalone?: 'compaction' | 'generate'} = {},
  ): TraceState {
    if (traces.size >= limits.maxOpenTraces) {
      let oldest: TraceState | undefined
      for (const trace of traces) if (oldest === undefined || trace.lastActivity < oldest.lastActivity) oldest = trace
      if (oldest !== undefined) closeTrace(oldest, clock, 'ok', {incomplete: true})
    }
    const root = newInvoke('root', rootSessionId, start, undefined)
    if (extra.continuationOf !== undefined) {
      root.continuationOf = extra.continuationOf
      root.marks.add('continuation')
    }
    if (extra.mark !== undefined) root.marks.add(extra.mark)
    root.standalone = extra.standalone
    const trace: TraceState = {
      id: ids.trace(),
      rootSessionId,
      root,
      nodes: new Map(),
      outstanding: new Map(),
      lastActivity: start,
      activeExecutions: 0,
      openSpans: 0,
      closed: false,
    }
    traces.add(trace)
    return trace
  }

  function newNode(sessionId: string, childOf: SessionNode['childOf'], at: number): SessionNode {
    const node: SessionNode = {
      id: sessionId,
      childOf,
      traces: new Set(),
      active: undefined,
      agent: undefined,
      pending: [],
      prompts: new Map(),
      requests: [],
      tools: new Map(),
      stepOwner: new Map(),
      skipStepStarts: 0,
      nextAttempt: 1,
      lastActivity: at,
    }
    sessions.set(sessionId, node)
    return node
  }

  const touch = (trace: TraceState, at: number): void => {
    trace.lastActivity = Math.max(trace.lastActivity, at)
  }

  /** The invoke span a session's own work hangs under, in `trace`. */
  function invokeOf(node: SessionNode, trace: TraceState): InvokeState {
    return node.childOf !== undefined && node.childOf.trace === trace ? node.childOf.invoke : trace.root
  }

  function addPrompt(invoke: InvokeState, prompt: PromptRecord): void {
    if (invoke.prompts.length >= limits.maxPromptsPerSpan) {
      invoke.gaps.add('prompts-over-limit')
      return
    }
    invoke.prompts.push(prompt)
  }

  // ------------------------------------------------------------------ emitting

  function emitInvoke(trace: TraceState, invoke: InvokeState, at: number, extraMarks: readonly string[] = []): void {
    if (invoke.closed) return
    invoke.closed = true
    emit({
      kind: 'invoke_agent',
      role: invoke.role,
      spanId: invoke.spanId,
      traceId: trace.id,
      parentSpanId: invoke.parentSpanId,
      name: `invoke_agent ${invoke.agent ?? 'unknown'}`,
      start: invoke.start,
      end: Math.max(at, invoke.start),
      status: invoke.status,
      error: invoke.error,
      sessionId: invoke.sessionId,
      rootSessionId: trace.rootSessionId,
      agent: invoke.agent,
      gaps: [...invoke.gaps],
      marks: [...invoke.marks, ...extraMarks],
      prompts: invoke.prompts,
      continuationOf: invoke.continuationOf,
      reportDeliveredInTrace: invoke.reportDeliveredInTrace,
      standalone: invoke.standalone,
    })
  }

  function emitRequest(
    request: RequestState,
    at: number,
    status: SpanStatus,
    error?: ErrorInfo,
    extraMarks: readonly string[] = [],
  ): void {
    if (request.closed) return
    request.closed = true
    request.trace.openSpans = Math.max(0, request.trace.openSpans - 1)
    const model = request.model
    emit({
      kind: 'chat',
      spanId: request.spanId,
      traceId: request.trace.id,
      parentSpanId: request.parentSpanId,
      name: `chat ${model ?? request.requestKind}`,
      start: request.start,
      end: Math.max(at, request.start),
      status,
      error,
      sessionId: request.sessionId,
      rootSessionId: request.trace.rootSessionId,
      agent: request.agent,
      gaps: [...request.gaps],
      marks: [...request.marks, ...extraMarks],
      requestKind: request.requestKind,
      provider: request.provider,
      model,
      attempt: request.attempt,
      messageId: request.messageId,
      request: request.request,
      texts: request.texts,
      reasoning: request.reasoning,
      toolCalls: request.toolCalls,
      finishReason: request.finishReason,
      rawFinishReason: request.rawFinishReason,
      usage: request.usage,
      cost: request.cost,
      followOnOf: request.followOnOf,
    })
  }

  function emitTool(
    tool: ToolState,
    at: number,
    outcome: ToolOutcome,
    extra: {
      errorType?: string | undefined
      message?: string | undefined
      truncated?: boolean | undefined
      marks?: readonly string[]
    },
  ): void {
    tool.trace.openSpans = Math.max(0, tool.trace.openSpans - 1)
    const failed = outcome !== 'success'
    emit({
      kind: 'execute_tool',
      spanId: tool.spanId,
      traceId: tool.trace.id,
      parentSpanId: tool.parentSpanId,
      name: `execute_tool ${tool.tool}`,
      start: tool.start,
      end: Math.max(at, tool.start),
      status: outcome === 'interrupted' ? 'interrupted' : failed ? 'error' : 'ok',
      error: failed ? {type: extra.errorType ?? 'tool.execution', message: extra.message} : undefined,
      sessionId: tool.sessionId,
      rootSessionId: tool.trace.rootSessionId,
      agent: tool.agent,
      gaps: [...tool.gaps],
      marks: [...(extra.marks ?? [])],
      tool: tool.tool,
      callId: tool.callId,
      input: tool.input,
      result: tool.result,
      outcome,
      errorType: extra.errorType,
      toolTruncated: extra.truncated,
      childSessionId: tool.childSessionId,
    })
  }

  // ------------------------------------------------------------------ closing

  /** Closes a trace: its descendants first, then its root. `incomplete` marks every span that was still open. */
  function closeTrace(
    trace: TraceState,
    at: number,
    status: SpanStatus,
    close: {incomplete?: boolean; error?: ErrorInfo; deliveredIn?: string} = {},
  ): void {
    if (trace.closed) return
    trace.closed = true
    const marks = close.incomplete === true ? ['incomplete'] : []
    for (const node of trace.nodes.values()) {
      // A root session's node is shared by every trace of its turns: close only what belongs to this trace.
      for (const request of node.requests.filter(candidate => candidate.trace === trace)) {
        if (request.closed) continue
        // A title that never saw its `renamed` event, or a request cut off with its trace.
        if (request.messageId === undefined || request.requestKind !== 'primary') request.gaps.add('output')
        emitRequest(
          request,
          at,
          close.incomplete === true || request.messageId !== undefined ? 'interrupted' : 'ok',
          undefined,
          marks,
        )
      }
      for (const tool of [...node.tools.values()].filter(candidate => candidate.trace === trace)) {
        node.tools.delete(tool.callId)
        tool.gaps.add('outcome')
        emitTool(tool, at, 'interrupted', {marks: ['incomplete']})
        unresolved.delete(`${tool.sessionId}/${tool.callId}`)
      }
      if (node.childOf?.trace === trace) {
        node.childOf.invoke.status = close.incomplete === true ? 'interrupted' : node.childOf.invoke.status
        emitInvoke(trace, node.childOf.invoke, at, marks)
        linked.delete(node.id)
      }
      node.traces.delete(trace)
    }
    for (const childId of trace.outstanding.keys()) rememberTombstone(childId, trace.id)
    trace.root.status = status
    trace.root.error = close.error
    if (close.deliveredIn !== undefined) trace.root.reportDeliveredInTrace = close.deliveredIn
    emitInvoke(trace, trace.root, at, marks)
    for (const node of trace.nodes.values()) {
      node.active = node.active?.trace === trace ? undefined : node.active
      if (node.traces.size === 0 && node.childOf?.trace === trace) sessions.delete(node.id)
      else if (node.traces.size === 0 && node.pending.length === 0 && node.requests.every(r => r.closed)) {
        sessions.delete(node.id)
      }
    }
    traces.delete(trace)
  }

  function rememberTombstone(childId: string, traceId: string): void {
    tombstones.delete(childId)
    tombstones.set(childId, traceId)
    while (tombstones.size > limits.maxTombstones) {
      const oldest = tombstones.keys().next()
      if (oldest.done === true) break
      tombstones.delete(oldest.value)
    }
  }

  const titlePending = (trace: TraceState): boolean => {
    for (const node of trace.nodes.values()) {
      if (node.requests.some(request => request.requestKind === 'title' && !request.closed)) return true
    }
    return false
  }

  /** Closes `node`'s own span, or the trace, when nothing is running and nothing is owed to it. */
  function maybeClose(node: SessionNode, trace: TraceState, at: number): void {
    if (trace.closed) return
    if (node.active?.trace === trace) return
    for (const parent of trace.outstanding.values()) if (parent === node.id) return
    if (node.childOf === undefined || node.id === trace.rootSessionId) {
      if (trace.outstanding.size > 0 || trace.activeExecutions > 0) return
      // A title's text can still arrive; `sweep` closes the trace if it never does.
      if (titlePending(trace)) return
      closeTrace(trace, at, trace.root.status === 'ok' ? 'ok' : trace.root.status, {error: trace.root.error})
      return
    }
    emitInvoke(trace, node.childOf.invoke, at)
  }

  // ------------------------------------------------------------------ routing and buffering

  const shouldBuffer = (sessionId: string): boolean => unresolved.size > 0 || parentHints.has(sessionId)

  function bufferObservation(sessionId: string, observation: Observation): void {
    let entry = buffered.get(sessionId)
    if (entry === undefined) {
      if (buffered.size >= limits.maxBufferedSessions) {
        // No room to wait: this session gets its own trace now, and the new observation with it.
        releaseBuffer(sessionId, [observation], 'unattributed')
        return
      }
      entry = {sessionId, firstAt: observation.at, items: [], bytes: 0}
      buffered.set(sessionId, entry)
    }
    const size = observation.bytes ?? 0
    if (entry.items.length + 1 > limits.maxBufferedObservations || entry.bytes + size > limits.maxBufferedBytes) {
      const items = [...entry.items, observation]
      bufferedBytes -= entry.bytes
      buffered.delete(sessionId)
      releaseBuffer(sessionId, items, 'unattributed')
      return
    }
    entry.items.push(observation)
    entry.bytes += size
    bufferedBytes += size
  }

  /** Gives a buffered session its own trace. `unattributed` when something said it is a child whose parent never proved. */
  function releaseBuffer(sessionId: string, items: readonly Observation[], reason: 'unattributed' | 'root'): void {
    const hinted = parentHints.has(sessionId)
    createRootNode(sessionId, items[0]?.at ?? clock)
    const node = sessions.get(sessionId)
    if (node !== undefined && (hinted || reason === 'unattributed')) pendingMarks.set(sessionId, 'unattributed')
    for (const item of items) dispatch(item)
  }

  function createRootNode(sessionId: string, at: number): SessionNode {
    return sessions.get(sessionId) ?? newNode(sessionId, undefined, at)
  }

  function expireBuffers(now: number): void {
    for (const [sessionId, entry] of [...buffered]) {
      if (now - entry.firstAt < limits.bufferWindowMs) continue
      buffered.delete(sessionId)
      bufferedBytes -= entry.bytes
      releaseBuffer(sessionId, entry.items, parentHints.has(sessionId) ? 'unattributed' : 'root')
    }
  }

  /** The node for `sessionId`, creating a root-session node when nothing says it is a child. Undefined: buffered. */
  function route(observation: Observation & {readonly sessionId: string}): SessionNode | undefined {
    const existing = sessions.get(observation.sessionId)
    if (existing !== undefined) return existing
    if (buffered.has(observation.sessionId)) {
      bufferObservation(observation.sessionId, observation)
      return undefined
    }
    if (!CREATING_KINDS.has(observation.kind)) return undefined
    if (shouldBuffer(observation.sessionId)) {
      bufferObservation(observation.sessionId, observation)
      return undefined
    }
    return newNode(observation.sessionId, undefined, observation.at)
  }

  // ------------------------------------------------------------------ executions

  function beginExecution(node: SessionNode, at: number): TraceState {
    if (node.active !== undefined) return node.active.trace
    if (node.childOf !== undefined) {
      const {trace, invoke} = node.childOf
      node.active = {trace}
      trace.activeExecutions += 1
      attachPendingPrompts(node, invoke, at)
      return trace
    }

    const waiting = node.pending.filter(item => !item.joined)
    const users = waiting.filter(item => item.kind === 'user')
    const reports = waiting.filter(item => item.kind === 'synthetic')
    const compaction = waiting.find(item => item.kind === 'compaction')
    const extra: {continuationOf?: string; mark?: string; standalone?: 'compaction' | 'generate'} = {}
    let owner: TraceState | undefined
    let start = at

    if (users.length > 0) {
      start = Math.min(...users.map(item => promptTime(node, item)))
    } else if (compaction !== undefined) {
      extra.standalone = 'compaction'
      start = compaction.at
    } else if (reports.length > 0) {
      // A report with nothing else: the turn that started the child carries on.
      owner = reports.map(item => item.reportTrace).find(trace => trace !== undefined && !trace.closed)
      const tombstone = reports.map(item => item.reportTombstone).find(id => id !== undefined)
      if (owner === undefined) {
        if (tombstone === undefined) extra.mark = 'unattributed'
        else extra.continuationOf = tombstone
        start = Math.min(...reports.map(item => item.at))
      }
    } else {
      extra.mark = 'trigger-unknown'
    }

    const trace = owner ?? openTrace(node.id, start, extra)
    const pendingMark = pendingMarks.get(node.id)
    if (pendingMark !== undefined && owner === undefined) {
      trace.root.marks.add(pendingMark)
      pendingMarks.delete(node.id)
    }
    if (extra.mark === 'trigger-unknown') trace.root.gaps.add('trigger')
    trace.nodes.set(node.id, node)
    node.traces.add(trace)
    node.active = {trace}
    trace.activeExecutions += 1
    touch(trace, at)
    if (owner === undefined) attachPendingPrompts(node, trace.root, at)
    return trace
  }

  function promptTime(node: SessionNode, item: PendingItem): number {
    return node.prompts.get(item.inboxId)?.at ?? item.at
  }

  /** Moves the user prompts that started an execution onto the span that carries them. */
  function attachPendingPrompts(node: SessionNode, invoke: InvokeState, at: number): void {
    for (const item of node.pending) {
      if (item.kind !== 'user' || item.joined) continue
      const prompt = node.prompts.get(item.inboxId)
      addPrompt(invoke, {
        messageId: item.inboxId,
        at: prompt?.at ?? item.at,
        content: prompt?.content,
        delivery: prompt?.delivery,
        midTurn: false,
      })
      if (prompt === undefined) invoke.gaps.add('prompt-content')
      item.joined = true
    }
    // Prompts that arrived with no inbox item yet (the hook leads the event): the turn's own.
    for (const [id, prompt] of node.prompts) {
      if (invoke.prompts.some(existing => existing.messageId === id)) continue
      if (node.pending.some(item => item.inboxId === id)) continue
      addPrompt(invoke, {
        messageId: id,
        at: prompt.at,
        content: prompt.content,
        delivery: prompt.delivery,
        midTurn: false,
      })
    }
    invoke.start = Math.min(invoke.start, invoke.prompts[0]?.at ?? at)
  }

  // ------------------------------------------------------------------ handlers

  function onPrompt(o: Extract<Observation, {kind: 'prompt'}>): void {
    const node = route(o)
    if (node === undefined) return
    const active = node.active
    if (active === undefined) node.prompts.set(o.messageId, o)
    else {
      // Mid-execution: it joins the running turn and opens no root of its own.
      addPrompt(invokeOf(node, active.trace), {
        messageId: o.messageId,
        at: o.at,
        content: o.content,
        delivery: o.delivery,
        midTurn: true,
      })
      touch(active.trace, o.at)
    }
  }

  function onEnqueued(o: Extract<Observation, {kind: 'inbox.enqueued'}>): void {
    const node = route(o)
    if (node === undefined) return
    let reportTrace: TraceState | undefined
    let reportTombstone: string | undefined
    if (o.item === 'synthetic' && o.childSessionId !== undefined) {
      for (const trace of traces) if (trace.outstanding.has(o.childSessionId)) reportTrace = trace
      reportTombstone = tombstones.get(o.childSessionId)
    }
    const item: PendingItem = {
      inboxId: o.inboxId,
      kind: o.item,
      at: o.at,
      childSessionId: o.childSessionId,
      reportState: o.reportState,
      reportTrace,
      reportTombstone,
      joined: node.active !== undefined,
      claimed: false,
    }
    node.pending.push(item)
    if (node.active !== undefined) touch(node.active.trace, o.at)
  }

  function onDelivered(o: Extract<Observation, {kind: 'inbox.delivered'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) return
    const index = node.pending.findIndex(item => item.inboxId === o.inboxId)
    if (index === -1) return
    const [item] = node.pending.splice(index, 1)
    node.prompts.delete(o.inboxId)
    if (item === undefined || item.kind !== 'synthetic' || item.childSessionId === undefined) return
    const trace = item.reportTrace
    if (trace === undefined || trace.closed || item.reportState === 'running') return
    trace.outstanding.delete(item.childSessionId)
    touch(trace, o.at)
    const parent = sessions.get(o.sessionId)
    // Delivered into a different turn's execution: this turn is done, and says where its report went.
    const runningIn = parent?.active?.trace
    if (parent !== undefined && runningIn !== undefined && runningIn !== trace && parent.id === trace.rootSessionId) {
      trace.root.reportDeliveredInTrace = runningIn.id
    }
    if (parent !== undefined) maybeClose(parent, trace, o.at)
  }

  function onCreated(o: Extract<Observation, {kind: 'session.created'}>): void {
    if (o.parentSessionId !== undefined && !linked.has(o.sessionId) && !sessions.has(o.sessionId)) {
      parentHints.set(o.sessionId, o.parentSessionId)
      while (parentHints.size > limits.maxTombstones) {
        const oldest = parentHints.keys().next()
        if (oldest.done === true) break
        parentHints.delete(oldest.value)
      }
    }
    const node = sessions.get(o.sessionId)
    if (node !== undefined && o.agent !== undefined) node.agent = o.agent
    if (node?.childOf !== undefined && o.agent !== undefined) node.childOf.invoke.agent ??= o.agent
  }

  function onExecutionStarted(o: Extract<Observation, {kind: 'execution.started'}>): void {
    const node = route(o)
    if (node === undefined) return
    if (node.active === undefined) beginExecution(node, o.at)
  }

  function onExecutionEnded(o: Extract<Observation, {kind: 'execution.ended'}>): void {
    const node = sessions.get(o.sessionId)
    const trace = node?.active?.trace
    if (node === undefined || trace === undefined) return
    node.active = undefined
    trace.activeExecutions = Math.max(0, trace.activeExecutions - 1)
    touch(trace, o.at)
    const invoke = invokeOf(node, trace)
    if (o.outcome === 'succeeded') {
      maybeClose(node, trace, o.at)
      return
    }
    const status: SpanStatus = o.outcome === 'failed' ? 'error' : 'interrupted'
    const error: ErrorInfo | undefined =
      o.outcome === 'failed' ? (o.error ?? {type: 'execution.failed'}) : {type: 'interrupted', message: o.reason}
    invoke.status = status
    invoke.error = error
    if (node.id === trace.rootSessionId && node.childOf === undefined) {
      closeTrace(trace, o.at, status, {error})
    } else {
      emitInvoke(trace, invoke, o.at)
    }
  }

  function followOnClaims(node: SessionNode, trace: TraceState): string[] {
    const traceIds: string[] = []
    for (const item of node.pending) {
      if (item.kind !== 'synthetic' || item.claimed) continue
      item.claimed = true
      const origin = item.reportTrace
      if (origin !== undefined && origin !== trace && !origin.closed) traceIds.push(origin.id)
    }
    return traceIds
  }

  function onRequest(o: Extract<Observation, {kind: 'request'}>): void {
    const node = route(o)
    if (node === undefined) return
    let trace = node.active?.trace
    if (trace === undefined) {
      const standalone = o.requestKind === 'generate' && node.pending.every(item => item.joined)
      if (standalone) {
        trace = openTrace(node.id, o.at, {standalone: 'generate'})
        trace.nodes.set(node.id, node)
        node.traces.add(trace)
        trace.root.agent = o.agent
      } else {
        trace = beginExecution(node, o.at)
      }
    }
    touch(trace, o.at)
    const invoke = invokeOf(node, trace)
    invoke.agent ??= o.agent
    node.agent ??= o.agent
    if (trace.openSpans >= limits.maxOpenSpansPerTrace) {
      droppedSpans += 1
      invoke.gaps.add('spans-over-limit')
      return
    }
    trace.openSpans += 1
    const attempt = o.requestKind === 'primary' ? node.nextAttempt : 1
    const request: RequestState = {
      spanId: ids.span(),
      trace,
      sessionId: node.id,
      parentSpanId: invoke.spanId,
      requestKind: o.requestKind,
      start: o.at,
      agent: o.requestKind === 'title' ? 'title' : o.agent,
      model: o.model,
      provider: o.provider,
      request: o.content,
      attempt,
      messageId: undefined,
      texts: [],
      reasoning: [],
      toolCalls: [],
      finishReason: undefined,
      rawFinishReason: undefined,
      usage: undefined,
      cost: undefined,
      followOnOf: o.requestKind === 'primary' ? followOnClaims(node, trace) : [],
      gaps: new Set(o.requestKind === 'primary' ? [] : ['finishReason', 'usage']),
      marks: new Set(),
      closed: false,
    }
    if (o.content === undefined) request.gaps.add('request')
    node.requests.push(request)
  }

  const oldestPending = (node: SessionNode, kind: RequestKind): RequestState | undefined =>
    node.requests.find(request => request.requestKind === kind && !request.closed && request.messageId === undefined)

  function removeRequest(node: SessionNode, request: RequestState): void {
    const index = node.requests.indexOf(request)
    if (index !== -1) node.requests.splice(index, 1)
  }

  function onRetry(o: Extract<Observation, {kind: 'retry'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) return
    const request = oldestPending(node, 'primary')
    if (request === undefined) return
    // The failed attempt: closed now, since no output will ever join it. Its `step.started` still arrives.
    request.gaps.add('output')
    emitRequest(request, o.at, 'error', o.error)
    node.skipStepStarts += 1
    node.nextAttempt = o.willRetry ? o.attempt : 1
    removeRequest(node, request)
    touch(request.trace, o.at)
  }

  function onStepStarted(o: Extract<Observation, {kind: 'step.started'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) return
    if (node.skipStepStarts > 0) {
      node.skipStepStarts -= 1
      return
    }
    const request = oldestPending(node, 'primary')
    if (request === undefined) return
    request.messageId = o.messageId
    request.agent ??= o.agent
    request.model ??= o.model
    request.provider ??= o.provider
    node.stepOwner.set(o.messageId, request)
    touch(request.trace, o.at)
  }

  function onStepEnded(o: Extract<Observation, {kind: 'step.ended'}>): void {
    const node = sessions.get(o.sessionId)
    const request = node?.stepOwner.get(o.messageId)
    if (node === undefined || request === undefined) return
    request.finishReason = o.finish
    request.rawFinishReason = o.rawFinish
    request.usage = o.usage
    request.cost = o.cost
    if (o.finish === undefined) request.gaps.add('finishReason')
    if (o.usage === undefined) request.gaps.add('usage')
    emitRequest(request, o.at, 'ok')
    node.stepOwner.delete(o.messageId)
    removeRequest(node, request)
    node.nextAttempt = 1
    touch(request.trace, o.at)
  }

  function onStepFailed(o: Extract<Observation, {kind: 'step.failed'}>): void {
    const node = sessions.get(o.sessionId)
    const request = node?.stepOwner.get(o.messageId)
    if (node === undefined || request === undefined) return
    request.usage = o.usage
    request.gaps.add('finishReason')
    emitRequest(request, o.at, o.error.type === 'aborted' ? 'interrupted' : 'error', o.error)
    node.stepOwner.delete(o.messageId)
    removeRequest(node, request)
    touch(request.trace, o.at)
  }

  function onOutput(o: Extract<Observation, {kind: 'output'}>): void {
    const request = sessions.get(o.sessionId)?.stepOwner.get(o.messageId)
    if (request === undefined) return
    const parts = o.part === 'text' ? request.texts : request.reasoning
    if (parts.length >= limits.maxOutputParts) request.gaps.add('output-over-limit')
    else parts.push(o.text)
  }

  function onToolBefore(o: Extract<Observation, {kind: 'tool.before'}>): void {
    const node = sessions.get(o.sessionId)
    const trace = node?.active?.trace ?? node?.childOf?.trace
    if (node === undefined || trace === undefined) return
    if (trace.openSpans >= limits.maxOpenSpansPerTrace) {
      droppedSpans += 1
      invokeOf(node, trace).gaps.add('spans-over-limit')
      return
    }
    trace.openSpans += 1
    const tool: ToolState = {
      spanId: ids.span(),
      trace,
      sessionId: node.id,
      parentSpanId: invokeOf(node, trace).spanId,
      callId: o.callId,
      tool: o.tool,
      start: o.at,
      agent: o.agent,
      input: o.input,
      result: undefined,
      afterStatus: undefined,
      afterError: undefined,
      interrupted: false,
      childSessionId: undefined,
      gaps: new Set(),
    }
    node.tools.set(o.callId, tool)
    const asked = o.messageId === undefined ? undefined : node.stepOwner.get(o.messageId)
    if (asked !== undefined) {
      if (asked.toolCalls.length >= limits.maxOutputParts) asked.gaps.add('tool-calls-over-limit')
      else asked.toolCalls.push({callId: o.callId, tool: o.tool, input: o.input})
    }
    if (o.tool === 'subagent') unresolved.add(`${node.id}/${o.callId}`)
    touch(trace, o.at)
  }

  /** The dispatch link: this tool call started that child session. */
  function link(parent: SessionNode, tool: ToolState | undefined, childId: string, at: number): void {
    if (tool !== undefined) {
      tool.childSessionId ??= childId
      unresolved.delete(`${tool.sessionId}/${tool.callId}`)
    }
    if (linked.has(childId) || sessions.has(childId)) return
    const trace = tool?.trace ?? parent.active?.trace ?? parent.childOf?.trace
    const entry = buffered.get(childId)
    buffered.delete(childId)
    if (entry !== undefined) bufferedBytes -= entry.bytes
    parentHints.delete(childId)
    if (trace === undefined || trace.closed) {
      // The dispatching turn is gone: the child cannot be placed in it.
      if (entry !== undefined) releaseBuffer(childId, entry.items, 'unattributed')
      return
    }
    const start = entry?.firstAt ?? at
    const invoke = newInvoke('child', childId, Math.min(start, at), tool?.spanId ?? invokeOf(parent, trace).spanId)
    if (tool === undefined) invoke.gaps.add('dispatch-call')
    const node = newNode(childId, {trace, invoke}, start)
    trace.nodes.set(childId, node)
    node.traces.add(trace)
    trace.outstanding.set(childId, parent.id)
    linked.add(childId)
    touch(trace, at)
    for (const item of entry?.items ?? []) dispatch(item)
  }

  function onToolAfter(o: Extract<Observation, {kind: 'tool.after'}>): void {
    const node = sessions.get(o.sessionId)
    const tool = node?.tools.get(o.callId)
    if (node === undefined) return
    if (tool !== undefined) {
      tool.result = o.result
      tool.afterStatus = o.status
      tool.afterError = o.error
      tool.interrupted = o.interrupted === true
      if (o.status === 'error' && o.error !== undefined) tool.result = undefined
    }
    if (o.childSessionId !== undefined) link(node, tool, o.childSessionId, o.at)
  }

  function onToolEnded(o: Extract<Observation, {kind: 'tool.ended'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) return
    let tool = node.tools.get(o.callId)
    if (tool === undefined) {
      const trace = node.active?.trace ?? node.childOf?.trace
      if (trace === undefined) return
      trace.openSpans += 1
      tool = {
        spanId: ids.span(),
        trace,
        sessionId: node.id,
        parentSpanId: invokeOf(node, trace).spanId,
        callId: o.callId,
        tool: 'unknown',
        start: o.at,
        agent: undefined,
        input: undefined,
        result: undefined,
        afterStatus: undefined,
        afterError: undefined,
        interrupted: false,
        childSessionId: undefined,
        gaps: new Set(['before-hook', 'input']),
      }
    }
    if (o.childSessionId !== undefined) link(node, tool, o.childSessionId, o.at)
    const outcome: ToolOutcome = o.succeeded
      ? 'success'
      : o.errorType === 'permission.rejected'
        ? 'rejected'
        : o.errorType === 'aborted' || tool.interrupted
          ? 'interrupted'
          : 'error'
    if (outcome !== 'success') tool.gaps.add('result')
    else if (tool.afterStatus === undefined) tool.gaps.add('result')
    node.tools.delete(o.callId)
    unresolved.delete(`${node.id}/${o.callId}`)
    emitTool(tool, o.at, outcome, {errorType: o.errorType, message: o.message, truncated: o.truncated})
    touch(tool.trace, o.at)
  }

  function onCompactionStarted(o: Extract<Observation, {kind: 'compaction.started'}>): void {
    const node = sessions.get(o.sessionId)
    const request = node === undefined ? undefined : oldestPending(node, 'compaction')
    if (request !== undefined && o.reason !== undefined) request.marks.add(`reason:${o.reason}`)
  }

  function onCompactionEnded(o: Extract<Observation, {kind: 'compaction.ended'}>): void {
    const node = sessions.get(o.sessionId)
    const request = node === undefined ? undefined : oldestPending(node, 'compaction')
    if (node === undefined || request === undefined) return
    if (o.ok) {
      if (o.text !== undefined) request.texts.push(o.text)
      request.usage = o.usage
      request.cost = o.cost
      request.gaps.delete('usage')
      if (o.usage === undefined) request.gaps.add('usage')
    }
    emitRequest(request, o.at, o.ok ? 'ok' : 'error', o.error)
    removeRequest(node, request)
    touch(request.trace, o.at)
  }

  function onTitle(o: Extract<Observation, {kind: 'title'}>): void {
    const node = sessions.get(o.sessionId)
    const request = node === undefined ? undefined : oldestPending(node, 'title')
    if (node === undefined || request === undefined) return
    request.texts.push(o.title)
    emitRequest(request, o.at, 'ok')
    removeRequest(node, request)
    touch(request.trace, o.at)
    const rootNode = request.trace.nodes.get(request.trace.rootSessionId)
    if (rootNode !== undefined && request.trace.activeExecutions === 0) maybeClose(rootNode, request.trace, o.at)
  }

  /** Cumulative usage moved with no execution running: the only completion signal a `generate` request has. */
  function onUsage(o: Extract<Observation, {kind: 'usage'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined || node.active !== undefined) return
    const request = oldestPending(node, 'generate')
    if (request === undefined) return
    emitRequest(request, o.at, 'ok')
    removeRequest(node, request)
    const trace = request.trace
    trace.root.start = Math.min(trace.root.start, request.start)
    closeTrace(trace, o.at, 'ok')
  }

  // ------------------------------------------------------------------ time

  function sweep(now: number): void {
    expireBuffers(now)
    for (const trace of [...traces]) {
      if (trace.closed) continue
      const standalone = trace.root.standalone === 'generate'
      const limit = standalone ? limits.standaloneRequestTimeoutMs : limits.rootInactivityMs
      if (now - trace.lastActivity > limit) {
        closeTrace(trace, now, 'ok', {incomplete: true})
      } else if (
        trace.activeExecutions === 0 &&
        trace.outstanding.size === 0 &&
        now - trace.lastActivity > limits.titleWaitMs &&
        titlePending(trace)
      ) {
        // The turn is over and only a title's text is missing: close without it, not as incomplete.
        closeTrace(trace, now, trace.root.status)
      }
    }
  }

  function dispatch(observation: Observation): void {
    switch (observation.kind) {
      case 'prompt':
        onPrompt(observation)
        break
      case 'inbox.enqueued':
        onEnqueued(observation)
        break
      case 'inbox.delivered':
        onDelivered(observation)
        break
      case 'session.created':
        onCreated(observation)
        break
      case 'execution.started':
        onExecutionStarted(observation)
        break
      case 'execution.ended':
        onExecutionEnded(observation)
        break
      case 'request':
        onRequest(observation)
        break
      case 'retry':
        onRetry(observation)
        break
      case 'step.started':
        onStepStarted(observation)
        break
      case 'step.ended':
        onStepEnded(observation)
        break
      case 'step.failed':
        onStepFailed(observation)
        break
      case 'output':
        onOutput(observation)
        break
      case 'tool.before':
        onToolBefore(observation)
        break
      case 'tool.after':
        onToolAfter(observation)
        break
      case 'tool.ended':
        onToolEnded(observation)
        break
      case 'compaction.started':
        onCompactionStarted(observation)
        break
      case 'compaction.ended':
        onCompactionEnded(observation)
        break
      case 'title':
        onTitle(observation)
        break
      case 'usage':
        onUsage(observation)
        break
      case 'tick':
        break
    }
  }

  return {
    observe: observation => {
      out = []
      clock = Math.max(clock, observation.at)
      sweep(clock)
      dispatch(observation)
      return out
    },
    flush: at => {
      out = []
      clock = Math.max(clock, at)
      for (const [sessionId, entry] of [...buffered]) {
        buffered.delete(sessionId)
        bufferedBytes -= entry.bytes
        releaseBuffer(sessionId, entry.items, 'unattributed')
      }
      for (const trace of [...traces]) closeTrace(trace, clock, 'interrupted', {incomplete: true})
      sessions.clear()
      tombstones.clear()
      bufferedBytes = 0
      unresolved.clear()
      linked.clear()
      parentHints.clear()
      pendingMarks.clear()
      return out
    },
    stats: () => ({
      openTraces: traces.size,
      sessions: sessions.size,
      bufferedSessions: buffered.size,
      bufferedBytes,
      tombstones: tombstones.size,
      unresolvedDispatches: unresolved.size,
      droppedSpans,
    }),
  }
}
