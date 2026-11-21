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
  /**
   * A title, compaction or generate request is prepared once and retried below the hook (v2.3.2 `generate.ts`,
   * `compaction.ts` `deliver`), so how many provider attempts it took cannot be seen: this one span stands for all of them.
   */
  readonly attemptCountUnknown: boolean
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
  /** The provider ran the tool: the session events are all there is, no hook fires for it. */
  readonly providerExecuted: boolean
  /** Snapshots this span replaced (the call event's arguments, when a hook's replaced them). For whoever counts them. */
  readonly discarded: readonly unknown[]
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
  /**
   * Per session: tool names and hook observations held while the session event that opens or closes the call has not
   * arrived. Past this the oldest is dropped, silently.
   */
  readonly maxPendingToolNotes: number
  /**
   * Characters of model output (text and reasoning, a compaction summary, a title) one open request keeps. A part that does
   * not fit is omitted whole, never clipped (a cut before redaction could split a secret), and the span says so. Equal to the
   * span's own output bound.
   */
  readonly maxOutputChars: number
  /** The same, summed over every open request in the model: past it, parts are cut or omitted the same way. */
  readonly maxHeldOutputChars: number
  /**
   * A session with no trace, no running execution and nothing open is forgotten after this long without an observation, and
   * its held snapshots are handed back. Independent of open traces: a prompt for a session that never starts an execution
   * has no trace to close it.
   */
  readonly sessionIdleMs: number
  /** Idle sessions kept at once; past it the least recently active is forgotten. A running session never counts. */
  readonly maxIdleSessions: number
  /**
   * Finished call ids remembered per session, so a repeated terminal event (or a late hook) for a call that already ended
   * is ignored instead of opening a second span. Past it the oldest id is forgotten.
   */
  readonly maxCompletedCallsPerSession: number
  /** Prompts one session holds while waiting for an execution; past it the oldest is dropped. */
  readonly maxPendingPromptsPerSession: number
  /** How long such a note waits for its event before it is dropped, silently. Checked on a tick and on the next note. */
  readonly toolNoteWaitMs: number
  /**
   * How long a closed trace's id is remembered so a late subagent report can name it. After it, the report is an
   * unattributed trace. The count bound (`maxTombstones`) applies too.
   */
  readonly tombstoneTtlMs: number
  /**
   * Primary request hook times kept per session for the step join (see "Binding steps to requests"). Oldest first out, so a step
   * whose hook was dropped finds no hook at all and binds nothing; it never falls through to an older one.
   */
  readonly maxHookTimes: number
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
  maxOutputChars: 128 * 1024,
  maxHeldOutputChars: 8 * 1024 * 1024,
  sessionIdleMs: 10 * 60_000,
  maxIdleSessions: 64,
  maxCompletedCallsPerSession: 256,
  maxPendingPromptsPerSession: 64,
  maxPendingToolNotes: 64,
  toolNoteWaitMs: 10_000,
  tombstoneTtlMs: 24 * 60 * 60_000,
  maxHookTimes: 64,
}

export interface TurnModelStats {
  readonly openTraces: number
  readonly sessions: number
  readonly bufferedSessions: number
  readonly bufferedBytes: number
  /** Refused primary requests still holding a place for their step events. */
  /** Primary request hook times held across sessions (bounded per session by `maxHookTimes`). */
  readonly hookTimes: number
  /** Hook entries that still reference a request: only requests that are open. */
  readonly historyRequestsHeld: number
  /** Times a session was withheld (see "Binding steps to requests"): zero in any run whose steps and hooks the join could place. */
  readonly withholds: number
  /** Steps bound to a request and still open, across sessions: each is released when its step ends or fails. */
  readonly openSteps: number
  readonly tombstones: number
  readonly unresolvedDispatches: number
  /** Tool names and hook observations waiting for their session event. */
  readonly pendingToolNotes: number
  /** Characters of model output held by open requests. */
  readonly heldOutputChars: number
  readonly droppedSpans: number
}

export interface TurnModel {
  /** Feeds one observation. Returns the spans that finished because of it. */
  readonly observe: (observation: Observation) => SpanRecord[]
  /** Closes everything still open as interrupted and incomplete, and releases all state. */
  readonly flush: (at: number) => SpanRecord[]
  readonly stats: () => TurnModelStats
  /**
   * The snapshots the model dropped without a span to carry them (an expired session's prompts, a hook note that timed out,
   * a repeated terminal event). Returned once, for whoever counts them to release.
   */
  readonly takeDiscarded: () => unknown[]
  /**
   * The snapshots that now have a second owner (a tool call's arguments are in the model's record of what was asked and in
   * the tool span). Returned once; each needs one more release.
   */
  readonly takeRetained: () => unknown[]
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
  /** Characters of `texts` and `reasoning`, counted against the output budgets. */
  outputChars: number
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
  /** The agent, model and provider its step named. Kept apart from the hook's own, which a span prefers and a withheld one is limited to. */
  stepAgent: string | undefined
  stepModel: string | undefined
  stepProvider: string | undefined
  /**
   * Its step may not be its own, or its step data may be incomplete (a loss was reported while it waited for a step or ran): it
   * carries nothing a step produced, only
   * an incomplete outcome and its hook-time metadata.
   */
  bindUncertain: boolean
}

interface ToolState {
  readonly spanId: string
  readonly trace: TraceState
  readonly sessionId: string
  readonly parentSpanId: string
  readonly callId: string
  tool: string
  readonly start: number
  agent: string | undefined
  input: unknown
  /** The call event's arguments, kept until a hook's replace them. */
  callInput: unknown
  inputFromHook: boolean
  result: unknown
  resultFromHook: boolean
  providerExecuted: boolean
  afterStatus: 'completed' | 'error' | undefined
  afterError: unknown
  interrupted: boolean
  childSessionId: string | undefined
  discarded: unknown[]
  gaps: Set<string>
}

/** What the hooks and the input-started event told us about a call, held until its session event arrives. */
interface ToolNote {
  readonly at: number
  tool?: string | undefined
  before?: Extract<Observation, {kind: 'tool.before'}> | undefined
  after?: Extract<Observation, {kind: 'tool.after'}> | undefined
}

/**
 * One primary request hook: when the plugin received it, and the request it opened while that request is open. None when the span
 * cap refused it or a loss stood for it, and none once the request closed: the record keeps no payload alive.
 */
interface HookRecord {
  readonly at: number
  request: RequestState | undefined
  /** A step has resolved to this hook (bound or not), or its execution ended after it: its own step is done with, or will never come. */
  consumed: boolean
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
  /** Calls with no span yet, by call id, oldest first. */
  readonly notes: Map<string, ToolNote>
  /** Call ids that have ended, oldest first. */
  readonly completed: Set<string>
  readonly stepOwner: Map<string, RequestState>
  /** The session's primary request hooks, in the order they arrived: the step join's record (see "Binding steps to requests"). */
  readonly hooks: HookRecord[]
  /**
   * This session binds nothing until its execution ends (see "Binding steps to requests"). Stored with the hook record, so it lives
   * exactly as long as the record does.
   */
  withheld: boolean
  /** The newest primary hook time this session was told of, recorded or not: what an execution's end is compared with. */
  newestHookAt: number
  /** When the session's latest execution ended, by the end event's own time. */
  lastEndedAt: number
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

function applyBefore(tool: ToolState, o: Extract<Observation, {kind: 'tool.before'}>): void {
  tool.agent = o.agent ?? tool.agent
  if (tool.tool === 'unknown') tool.tool = o.tool
  if (o.input !== undefined) {
    // The arguments the tool received win over the ones the model wrote; the superseded snapshot is handed back.
    if (tool.input !== undefined) tool.discarded.push(tool.input)
    tool.input = o.input
    tool.inputFromHook = true
  }
}

/** What an observation holds, for the buffer's byte bound: its stated bytes, or the text it carries. */
function observedSize(observation: Observation): number {
  if (observation.bytes !== undefined) return observation.bytes
  if (observation.kind === 'output') return observation.text.length
  if (observation.kind === 'title') return observation.title.length
  return 0
}

/** A confirmed subagent dispatch: the stock `subagent` tool, by the same test the called-event path uses. */
const isSubagentDispatch = (tool: {readonly tool: string}): boolean => tool.tool === 'subagent'

export function createTurnModel(options: {
  readonly ids: IdSource
  readonly limits?: Partial<TurnModelLimits>
}): TurnModel {
  const limits: TurnModelLimits = {...DEFAULT_LIMITS, ...options.limits}
  const {ids} = options

  const traces = new Set<TraceState>()
  /** Lost hooks' times for sessions with no node yet, newest per session, bounded: applied when the session's node is created. */
  const earlyLostHooks = new Map<string, number>()
  let withholds = 0
  const sessions = new Map<string, SessionNode>()
  const buffered = new Map<string, BufferedSession>()
  /** Session ids a `session.created` event said have a parent, before any dispatch link arrived. */
  const parentHints = new Map<string, string>()
  /** Subagent dispatches whose child session id is not known yet: `<session>/<call>`. */
  const unresolved = new Set<string>()
  /** Child sessions that have been placed under a dispatch. */
  const linked = new Set<string>()
  /** Children already given their own unattributed trace (their buffer was released before a link came), oldest first. */
  const releasedChildren = new Set<string>()
  /** Characters of model output held by open requests, against `maxHeldOutputChars`. */
  let heldOutputChars = 0

  /** Snapshots dropped with no span to carry them, until `takeDiscarded` hands them back. */
  let discarded: unknown[] = []
  /** Snapshots that gained a second owner, until `takeRetained` hands them over. */
  let retained: unknown[] = []
  const discard = (value: unknown): void => {
    if (typeof value === 'object' && value !== null) discarded.push(value)
  }

  /** Child session id to the closed trace it belonged to, and when it closed. Oldest first. */
  const tombstones = new Map<string, {readonly traceId: string; readonly at: number}>()
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
      notes: new Map(),
      completed: new Set(),
      stepOwner: new Map(),
      hooks: [],
      withheld: false,
      newestHookAt: Number.NEGATIVE_INFINITY,
      lastEndedAt: Number.NEGATIVE_INFINITY,
      nextAttempt: 1,
      lastActivity: at,
    }
    sessions.set(sessionId, node)
    // A hook lost before the session was seen leaves its time all the same.
    const lost = earlyLostHooks.get(sessionId)
    if (lost !== undefined) {
      earlyLostHooks.delete(sessionId)
      recordHook(node, lost, undefined, true)
    }
    // The idle limit applies when a node is created; a node left idle later stays until it expires.
    enforceIdleBound(node)
    return node
  }

  /** Nothing running, open or owed: only queued prompts and notes, which no trace will ever close. */
  const isIdle = (node: SessionNode): boolean =>
    node.childOf === undefined &&
    node.traces.size === 0 &&
    node.active === undefined &&
    node.requests.length === 0 &&
    node.tools.size === 0

  /** Forgets an idle session and hands back what it held. */
  function forgetSession(node: SessionNode): void {
    for (const prompt of node.prompts.values()) discard(prompt.content)
    for (const note of node.notes.values()) discardNote(note)
    sessions.delete(node.id)
  }

  function discardNote(note: ToolNote): void {
    discard(note.before?.input)
    discard(note.after?.result)
  }

  /** Keeps the idle sessions within `maxIdleSessions`, forgetting the least recently active. `keep` is never forgotten. */
  function enforceIdleBound(keep: SessionNode): void {
    const idle = [...sessions.values()].filter(node => node !== keep && isIdle(node))
    if (idle.length < limits.maxIdleSessions) return
    idle.sort((a, b) => a.lastActivity - b.lastActivity)
    for (const node of idle.slice(0, idle.length - limits.maxIdleSessions + 1)) forgetSession(node)
  }

  function expireIdleSessions(now: number): void {
    for (const node of [...sessions.values()]) {
      if (isIdle(node) && now - node.lastActivity > limits.sessionIdleMs) forgetSession(node)
    }
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
    const hook = sessions.get(request.sessionId)?.hooks.find(candidate => candidate.request === request)
    if (hook !== undefined) hook.request = undefined
    // The request's output moves into its record: it no longer counts against what open requests hold.
    heldOutputChars = Math.max(0, heldOutputChars - request.outputChars)
    request.trace.openSpans = Math.max(0, request.trace.openSpans - 1)
    // An uncertain request holds nothing a step produced, however much arrived: no output, message id, finish reason, usage, cost,
    // status or error, and none of the step's agent, model or provider. A request whose step was never bound, one whose step
    // may be someone else's, and one whose events were partly lost are all this one case: a partial answer with no way to know
    // what is missing is worse than none, and there is one gap name for it. The outcome is only "incomplete".
    const unbound = request.bindUncertain
    const model = request.model ?? (unbound ? undefined : request.stepModel)
    emit({
      kind: 'chat',
      spanId: request.spanId,
      traceId: request.trace.id,
      parentSpanId: request.parentSpanId,
      name: `chat ${model ?? request.requestKind}`,
      start: request.start,
      end: Math.max(at, request.start),
      status: unbound ? 'interrupted' : status,
      error: unbound ? undefined : error,
      sessionId: request.sessionId,
      rootSessionId: request.trace.rootSessionId,
      agent: request.agent ?? (unbound ? undefined : request.stepAgent),
      gaps: unbound
        ? ['step-binding-uncertain', ...(request.gaps.has('request') ? ['request'] : [])]
        : [...request.gaps],
      marks: unbound ? [...request.marks, 'incomplete', ...extraMarks] : [...request.marks, ...extraMarks],
      requestKind: request.requestKind,
      provider: request.provider ?? (unbound ? undefined : request.stepProvider),
      model,
      attempt: request.attempt,
      messageId: unbound ? undefined : request.messageId,
      request: request.request,
      texts: unbound ? [] : request.texts,
      reasoning: unbound ? [] : request.reasoning,
      toolCalls: unbound ? [] : request.toolCalls,
      finishReason: unbound ? undefined : request.finishReason,
      rawFinishReason: unbound ? undefined : request.rawFinishReason,
      usage: unbound ? undefined : request.usage,
      cost: unbound ? undefined : request.cost,
      followOnOf: request.followOnOf,
      attemptCountUnknown: request.requestKind !== 'primary',
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
      providerExecuted: tool.providerExecuted,
      discarded: tool.discarded,
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
        removeRequest(node, request)
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
      else if (
        node.traces.size === 0 &&
        node.pending.length === 0 &&
        node.requests.every(r => r.closed) &&
        // The record is kept while it holds a hook no step has settled (the next execution's, seen before this end) or the
        // session is withheld: the idle bounds forget it.
        !node.withheld &&
        node.hooks.every(hook => hook.consumed)
      ) {
        sessions.delete(node.id)
      }
    }
    traces.delete(trace)
  }

  function rememberTombstone(childId: string, traceId: string): void {
    tombstones.delete(childId)
    tombstones.set(childId, {traceId, at: clock})
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
    const size = observedSize(observation)
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
    if (hinted || reason === 'unattributed') {
      // A link that arrives later must not create a second, empty child for work that already has its own trace.
      releasedChildren.add(sessionId)
      while (releasedChildren.size > limits.maxTombstones) {
        const oldest = releasedChildren.values().next()
        if (oldest.done === true) break
        releasedChildren.delete(oldest.value)
      }
    }
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
    if (active === undefined) {
      node.prompts.set(o.messageId, o)
      while (node.prompts.size > limits.maxPendingPromptsPerSession) {
        const oldest = node.prompts.entries().next()
        if (oldest.done === true) break
        node.prompts.delete(oldest.value[0])
        discard(oldest.value[1].content)
        const queued = node.pending.findIndex(item => item.inboxId === oldest.value[0])
        if (queued !== -1) node.pending.splice(queued, 1)
      }
    } else {
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
      const remembered = tombstones.get(o.childSessionId)
      // At exactly the ttl it is still remembered; one millisecond later it is not.
      reportTombstone =
        remembered !== undefined && o.at - remembered.at <= limits.tombstoneTtlMs ? remembered.traceId : undefined
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
    // An execution cannot start before the previous one ended (or in the same millisecond, in any recording): the clock stepped
    // back across the boundary, and the previous end event settles hooks by a time that no longer orders them.
    if (o.at <= node.lastEndedAt) withhold(node)
    if (node.active === undefined) beginExecution(node, o.at)
  }

  function onExecutionEnded(o: Extract<Observation, {kind: 'execution.ended'}>): void {
    const node = sessions.get(o.sessionId)
    // The execution is over: what waited for a step that cannot be trusted is closed here, as incomplete.
    if (node !== undefined) closeUncertain(node, o.at)
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
      // The origin's id: from the trace itself when it is known (open or since closed), else from the tombstone it left.
      const origin = item.reportTrace?.id ?? item.reportTombstone
      if (origin !== undefined && origin !== trace.id) traceIds.push(origin)
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
    // Every primary hook, admitted or refused, consumes the retry hook's attempt number that came before it.
    const attempt = o.requestKind === 'primary' ? node.nextAttempt : 1
    if (o.requestKind === 'primary') node.nextAttempt = 1
    if (trace.openSpans >= limits.maxOpenSpansPerTrace) {
      droppedSpans += 1
      invoke.gaps.add('spans-over-limit')
      // No span, but its step still arrives and must find its own hook, which holds no request.
      if (o.requestKind === 'primary') recordHook(node, o.at, undefined)
      return
    }
    trace.openSpans += 1
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
      outputChars: 0,
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
      bindUncertain: false,
      stepAgent: undefined,
      stepModel: undefined,
      stepProvider: undefined,
    }
    if (o.content === undefined) request.gaps.add('request')
    node.requests.push(request)
    if (o.requestKind === 'primary') {
      if (node.withheld) request.bindUncertain = true
      recordHook(node, o.at, request)
    }
  }

  // ------------------------------------------------------------------ binding steps to requests
  //
  // THE RULE. A primary request's hook carries no message id, and the step events that follow name only a message id, so a step is
  // joined to its request by TIME, never by arrival order. A `step.started` carries `started`, the server's clock at the start of
  // its attempt, taken after the request hook returned and before the provider was called: hook(n) <= started(n) <= hook(n+1) in
  // real time, as integers of the same clock. So a step belongs to the session's LATEST primary hook whose receive time is at or
  // before `started`, provided every earlier hook already has its step. It is wrong only when an earlier hook's step is the one in
  // hand: `started(n) == hook(n+1)` (a step that starts, runs and ends in the very millisecond the next hook arrives; the gap
  // between hook(n) and `started(n)` can be anything, another plugin's hook may sit in it), or a wall clock that stepped back
  // between hook(n) and `started(n)`, so that hook(n+1) reads earlier than `started(n)`. Arrival order cannot be used: the hook is
  // a direct call and the events come through a pull loop, so hook(n+1) is often seen before step.started(n).
  //
  // A step binds the request of that hook if it is still open and has no step, and the session is not withheld. Otherwise it binds
  // nothing and its later events (by message id) are ignored. A step older than every recorded hook binds nothing, and nothing
  // else: it cannot be confused with any recorded hook.
  //
  // ONE WITHHOLD STATE. A session that is withheld binds nothing until its execution ends. Every primary request of it that has
  // not finished (waiting or bound) and every later one exports no step data: only the hook's own agent, model, provider and
  // request, an incomplete outcome and the gap `step-binding-uncertain`, with no synthesized finish reason. It clears only on an
  // observed `execution.ended` for the session, and then the hook record restarts empty. It is set by exactly these triggers:
  //   1. An ambiguous step: it resolves to a hook and an EARLIER hook is still unconsumed. That earlier hook may own the step
  //      (equal-millisecond start, or a clock step-back between its hook and its start). A hook is consumed when a step has
  //      resolved to it, bound or not (a refused or lost hook's time-only entry too), or when its execution ended before it. Steps of a
  //      session arrive in publish order, so ordinarily every earlier hook has had its step and nothing is ever withheld; a hook
  //      observed AHEAD of earlier step events is not an earlier hook of any step before it. Over-withholding is accepted: an
  //      abandoned request (a hook that never gets a step, as after a recovery) withholds the session at its next step, until the
  //      execution ends. Under-withholding is not.
  //   2. The clock went backwards: a primary hook earlier than the previous one. Old-epoch steps may still be in flight and no
  //      time can be trusted. (A step-back that leaves the later hook later than the previous one is trigger 1's: the step in flight
  //      finds its own hook still waiting. Residual, undetectable: one across an execution boundary that reads the next execution's
  //      hook before the previous end event's time and after the previous hook.)
  //   3. A loss without complete evidence: a loss marker that is a broadcast (it names no session: an unattributed drop, or more
  //      sessions than a marker can hold), or whose lost-hook times no longer fit. A marker that names its session and carries the
  //      time of every primary hook it stands for does not withhold: the hook is recorded like a refused one (it holds no request,
  //      so a step that resolves to it binds nothing, and it counts for trigger 1 and 2: its own step is awaited), and the session's unfinished requests are
  //      marked uncertain (the loss may have been a request's `step.started` or part of its output, which would show as the whole).
  //   4. A step whose `started` is missing or not a finite number: an event the join cannot place.
  //   5. An execution that starts at or before the previous one's end (by the events' own times; no recording has a gap under
  //      45 ms): the clock stepped back across the boundary, so the end event settles hooks by a time that no longer orders them.
  //      (Residual, undetectable: a step-back after the start, and one across a boundary whose session was forgotten at its end,
  //      which nothing remembers.)
  //   Also: the hook record is bounded (`maxHookTimes`); evicting a hook that was never consumed withholds (its step could still
  //   arrive and there would be nothing to compare it with).
  // Not a trigger: a request refused at the span cap. Its hook is recorded with no request, so its step resolves to it and binds
  // nothing; whether that step could be someone else's is trigger 1's question like any other.

  function recordHook(node: SessionNode, at: number, request: RequestState | undefined, lost = false): void {
    // A lost hook is told by an event, in event order: its time says nothing about the clock, only that the hook happened.
    node.newestHookAt = lost ? Math.max(node.newestHookAt, at) : at
    if (node.withheld) return
    const newest = node.hooks.at(-1)
    if (newest !== undefined && at < newest.at) {
      withhold(node)
      return
    }
    node.hooks.push({at, request, consumed: false})
    while (node.hooks.length > limits.maxHookTimes) {
      const gone = node.hooks.shift()
      if (gone !== undefined && !gone.consumed) {
        withhold(node)
        return
      }
    }
  }

  /** The session binds nothing until its execution ends: everything unfinished is uncertain, and so is everything that follows. */
  function withhold(node: SessionNode): void {
    if (!node.withheld) withholds += 1
    node.withheld = true
    node.hooks.length = 0
    markUnfinished(node)
  }

  /**
   * Marks every primary request of the session that has not finished as uncertain. Its step data is withheld whole, so what it
   * already holds is let go: the tool call arguments it shares with the tool spans are handed back (the chat span will not carry
   * them).
   */
  function markUnfinished(node: SessionNode): void {
    for (const request of node.requests) {
      if (request.requestKind !== 'primary' || request.closed || request.bindUncertain) continue
      request.bindUncertain = true
      for (const call of request.toolCalls) discard(call.input)
      request.toolCalls = []
    }
  }

  /** The hook a step started at `started` belongs to: the latest hook at or before it. Withholds when that is ambiguous. */
  function resolveStep(node: SessionNode, started: number): HookRecord | undefined {
    let index = node.hooks.length - 1
    while (index >= 0 && (node.hooks[index]?.at ?? Number.POSITIVE_INFINITY) > started) index -= 1
    const found = node.hooks[index]
    if (found === undefined) return undefined
    const waiting = node.hooks.findIndex(hook => !hook.consumed)
    if (waiting !== -1 && waiting < index) {
      withhold(node)
      return undefined
    }
    found.consumed = true
    return found
  }

  /**
   * The pipeline lost something here in the sequence. A buffered child hears of it in its own buffer, in order. A marker that
   * names its sessions and the time of each primary hook it lost records those hooks and marks what is unfinished; a marker that
   * does not (a broadcast, or one whose times no longer fit) withholds every session.
   */
  function onLoss(o: Extract<Observation, {kind: 'loss'}>): void {
    const broadcast = o.sessionIds === undefined || o.incomplete === true
    const named = (sessionId: string): void => {
      const lostHook = o.hookAt?.get(sessionId)
      const node = sessions.get(sessionId)
      if (node !== undefined) {
        if (broadcast) withhold(node)
        else {
          if (lostHook !== undefined) recordHook(node, lostHook, undefined, true)
          markUnfinished(node)
        }
      } else if (buffered.has(sessionId)) {
        bufferObservation(sessionId, {
          ...o,
          sessionIds: [sessionId],
          hookAt: lostHook === undefined ? undefined : new Map([[sessionId, lostHook]]),
          incomplete: broadcast,
        })
      } else if (lostHook !== undefined) rememberEarlyLostHook(sessionId, lostHook)
    }
    if (o.sessionIds !== undefined) {
      for (const sessionId of o.sessionIds) named(sessionId)
      return
    }
    // A broadcast reaches every session the model knows, and keeps the times it does carry for the sessions they belong to.
    for (const sessionId of new Set([...sessions.keys(), ...buffered.keys(), ...(o.hookAt?.keys() ?? [])]))
      named(sessionId)
  }

  /** A hook lost before its session was seen leaves its time all the same, applied when the session's node is created. */
  function rememberEarlyLostHook(sessionId: string, at: number): void {
    earlyLostHooks.delete(sessionId)
    earlyLostHooks.set(sessionId, Math.max(at, earlyLostHooks.get(sessionId) ?? at))
    while (earlyLostHooks.size > limits.maxTombstones) {
      const oldest = earlyLostHooks.keys().next()
      if (oldest.done === true) break
      earlyLostHooks.delete(oldest.value)
    }
  }

  /** The execution ended: what waited for a step that cannot be trusted is closed, as incomplete, and the withhold is over. */
  function closeUncertain(node: SessionNode, at: number): void {
    node.nextAttempt = 1
    node.lastEndedAt = at
    // A hook at or after the end time is the next execution's, observed before this event (hooks are direct calls, events a pull
    // loop). While the session was withheld such hooks were not recorded, and their steps would find a clean record: the withhold
    // then carries over to the next execution's end, and what is that execution's is left open.
    const carriesOver = node.withheld && node.newestHookAt >= at
    node.withheld = carriesOver
    // A step is published before its execution's end, so a hook of that execution that still has none never gets it. `at` is the
    // end event's own server time, taken when it was published; the next execution's hooks come after it. A hook at exactly that
    // time is left alone: it may be the next execution's. A settled hook never receives a step.
    for (const hook of node.hooks) {
      if (hook.at >= at) continue
      hook.consumed = true
      hook.request = undefined
    }
    for (const request of [...node.requests]) {
      if (!request.bindUncertain || request.closed || (carriesOver && request.start >= at)) continue
      request.gaps.add('output')
      emitRequest(request, at, 'interrupted', undefined, ['incomplete'])
      removeRequest(node, request)
    }
  }

  const oldestPending = (node: SessionNode, kind: RequestKind): RequestState | undefined =>
    node.requests.find(request => request.requestKind === kind && !request.closed && request.messageId === undefined)

  /** A closed request leaves the session's records: a session can outlive the trace the request belonged to. */
  function removeRequest(node: SessionNode, request: RequestState): void {
    const index = node.requests.indexOf(request)
    if (index !== -1) node.requests.splice(index, 1)
    if (request.messageId !== undefined && node.stepOwner.get(request.messageId) === request) {
      node.stepOwner.delete(request.messageId)
    }
  }

  function onRetry(o: Extract<Observation, {kind: 'retry'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) return
    node.nextAttempt = o.willRetry ? o.attempt : 1
    // The retry hook follows the failed attempt's request hook on the hook channel, so the attempt that failed is the session's
    // newest primary hook. One that already has a step is closed by that step's failure; one with none is closed here, since no
    // output will ever join it, and its own `step.started`, when it comes, finds a closed request and binds nothing.
    const request = node.hooks.at(-1)?.request
    if (request === undefined || request.closed || request.messageId !== undefined || request.bindUncertain) return
    request.gaps.add('output')
    emitRequest(request, o.at, 'error', o.error)
    removeRequest(node, request)
    touch(request.trace, o.at)
  }

  function onStepStarted(o: Extract<Observation, {kind: 'step.started'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) return
    if (o.started === undefined || !Number.isFinite(o.started)) {
      withhold(node)
      return
    }
    // A withheld session records no hooks, so a step finds none and binds nothing.
    const request = resolveStep(node, o.started)?.request
    if (request === undefined || request.closed || request.messageId !== undefined || request.bindUncertain) return
    request.messageId = o.messageId
    request.stepAgent = o.agent
    request.stepModel = o.model
    request.stepProvider = o.provider
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
    removeRequest(node, request)
    touch(request.trace, o.at)
  }

  function onStepFailed(o: Extract<Observation, {kind: 'step.failed'}>): void {
    const node = sessions.get(o.sessionId)
    const request = node?.stepOwner.get(o.messageId)
    if (node === undefined || request === undefined) return
    request.usage = o.usage
    request.gaps.add('finishReason')
    emitRequest(request, o.at, o.error.type === 'aborted' ? 'interrupted' : 'error', o.error)
    removeRequest(node, request)
    touch(request.trace, o.at)
  }

  function onOutput(o: Extract<Observation, {kind: 'output'}>): void {
    const request = sessions.get(o.sessionId)?.stepOwner.get(o.messageId)
    if (request === undefined || request.bindUncertain) return
    if (o.omitted === true) {
      // The pipeline's inbox was full of raw text: the text is not here, and the span says so.
      request.gaps.add('output-omitted')
      return
    }
    addOutput(request, o.part === 'text' ? request.texts : request.reasoning, o.text)
  }

  /**
   * Keeps one output part, within the per-request and the aggregate character budgets and the part-count limit. A part that
   * does not fit is omitted whole, never clipped: a cut before redaction could split a secret. The request says so.
   */
  function addOutput(request: RequestState, parts: string[], text: string): void {
    if (request.closed) return
    if (parts.length >= limits.maxOutputParts) {
      request.gaps.add('output-over-limit')
      return
    }
    const room = Math.min(limits.maxOutputChars - request.outputChars, limits.maxHeldOutputChars - heldOutputChars)
    if (room <= 0) {
      request.gaps.add('output-omitted')
      return
    }
    // Raw text is never clipped before redaction (a cut could split a secret and leave its prefix): a part that does not fit
    // is omitted whole, and the span says so.
    if (text.length > room) {
      request.gaps.add('output-omitted')
      return
    }
    const kept = text
    parts.push(kept)
    request.outputChars += kept.length
    heldOutputChars += kept.length
  }

  // ------------------------------------------------------------------ tool calls
  //
  // A call's lifecycle comes from the session events: `session.tool.called` opens the span (published before any local
  // execution, v2.3.2 `step.ts`) and `session.tool.success` or `.failed` closes it, keyed by call id. A provider-executed
  // call never reaches the local path, so it has no hook at all. The `execute.before` and `execute.after` hooks only add
  // what the events do not carry: the agent, the arguments the tool received, and the result the hook saw. A hook that
  // arrives before its event is a note, held briefly and boundedly; one whose event never comes opens nothing.

  function noteFor(node: SessionNode, callId: string, at: number): ToolNote {
    let note = node.notes.get(callId)
    if (note === undefined) {
      note = {at}
      node.notes.set(callId, note)
      while (node.notes.size > limits.maxPendingToolNotes) {
        const oldest = node.notes.entries().next()
        if (oldest.done === true) break
        node.notes.delete(oldest.value[0])
        discardNote(oldest.value[1])
      }
    }
    return note
  }

  function expireNotes(now: number): void {
    for (const node of sessions.values()) {
      for (const [callId, note] of node.notes) {
        if (now - note.at > limits.toolNoteWaitMs) {
          node.notes.delete(callId)
          discardNote(note)
        } else break
      }
    }
  }

  /** Opens the span for a call, or returns the one already open. Undefined when no trace can hold it. */
  function openTool(
    node: SessionNode,
    callId: string,
    at: number,
    init: {tool?: string | undefined; gaps?: readonly string[]},
  ): ToolState | undefined {
    const existing = node.tools.get(callId)
    if (existing !== undefined) return existing
    const trace = node.active?.trace ?? node.childOf?.trace
    if (trace === undefined) return undefined
    if (trace.openSpans >= limits.maxOpenSpansPerTrace) {
      droppedSpans += 1
      invokeOf(node, trace).gaps.add('spans-over-limit')
      return undefined
    }
    trace.openSpans += 1
    const note = node.notes.get(callId)
    const tool: ToolState = {
      spanId: ids.span(),
      trace,
      sessionId: node.id,
      parentSpanId: invokeOf(node, trace).spanId,
      callId,
      tool: init.tool ?? note?.tool ?? note?.before?.tool ?? note?.after?.tool ?? 'unknown',
      start: at,
      agent: undefined,
      input: undefined,
      callInput: undefined,
      inputFromHook: false,
      result: undefined,
      resultFromHook: false,
      providerExecuted: false,
      afterStatus: undefined,
      afterError: undefined,
      interrupted: false,
      childSessionId: undefined,
      discarded: [],
      gaps: new Set(init.gaps ?? []),
    }
    node.tools.set(callId, tool)
    if (tool.tool === 'unknown') tool.gaps.add('tool-name')
    if (note?.before !== undefined) applyBefore(tool, note.before)
    if (note?.after !== undefined) applyAfter(node, tool, note.after)
    node.notes.delete(callId)
    touch(trace, at)
    return tool
  }

  function applyAfter(node: SessionNode, tool: ToolState, o: Extract<Observation, {kind: 'tool.after'}>): void {
    tool.afterStatus = o.status
    tool.afterError = o.error
    tool.interrupted = o.interrupted === true
    if (o.status === 'completed' && o.result !== undefined) {
      if (tool.result !== undefined) tool.discarded.push(tool.result)
      tool.result = o.result
      tool.resultFromHook = true
    }
    if (o.childSessionId !== undefined && isSubagentDispatch(tool)) link(node, tool, o.childSessionId, o.at)
  }

  function onToolNamed(o: Extract<Observation, {kind: 'tool.named'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) return
    expireNotes(o.at)
    noteFor(node, o.callId, o.at).tool = o.tool
  }

  function onToolCalled(o: Extract<Observation, {kind: 'tool.called'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined) {
      discard(o.input)
      return
    }
    if (node.completed.has(o.callId)) {
      discard(o.input)
      return
    }
    const tool = openTool(node, o.callId, o.at, {})
    if (tool === undefined) {
      discard(o.input)
      return
    }
    tool.providerExecuted = o.executed
    tool.callInput = o.input
    if (!tool.inputFromHook) tool.input = o.input
    else if (o.input !== undefined) tool.discarded.push(o.input)
    const asked = o.messageId === undefined ? undefined : node.stepOwner.get(o.messageId)
    // An uncertain request's chat span carries no tool calls, so it takes no second owner of the arguments (nothing would release it).
    if (asked !== undefined && !asked.bindUncertain) {
      if (asked.toolCalls.length >= limits.maxOutputParts) asked.gaps.add('tool-calls-over-limit')
      else {
        asked.toolCalls.push({callId: o.callId, tool: tool.tool, input: o.input})
        // The same object is now held by the request's record and by the tool span: two owners.
        if (typeof o.input === 'object' && o.input !== null) retained.push(o.input)
      }
    }
    if (isSubagentDispatch(tool)) unresolved.add(`${node.id}/${o.callId}`)
  }

  function onToolBefore(o: Extract<Observation, {kind: 'tool.before'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined || node.completed.has(o.callId)) {
      discard(o.input)
      return
    }
    const tool = node.tools.get(o.callId)
    if (tool !== undefined) {
      applyBefore(tool, o)
      if (tool.tool === 'subagent') unresolved.add(`${node.id}/${o.callId}`)
      return
    }
    // The hook came first: hold it for the event, boundedly. If the event never comes this opens nothing.
    expireNotes(o.at)
    noteFor(node, o.callId, o.at).before = o
  }

  /** The dispatch link: this tool call started that child session. */
  function link(parent: SessionNode, tool: ToolState | undefined, childId: string, at: number): void {
    if (tool !== undefined) {
      tool.childSessionId ??= childId
      unresolved.delete(`${tool.sessionId}/${tool.callId}`)
    }
    if (linked.has(childId) || sessions.has(childId) || releasedChildren.has(childId)) return
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
    if (node === undefined || node.completed.has(o.callId)) {
      discard(o.result)
      return
    }
    const tool = node.tools.get(o.callId)
    if (tool !== undefined) {
      applyAfter(node, tool, o)
      return
    }
    expireNotes(o.at)
    noteFor(node, o.callId, o.at).after = o
  }

  /** Error types that mean the call was refused before it ran, by the user's rules or by this plugin's own guard. */
  const REFUSED_ERROR_TYPES: ReadonlySet<string> = new Set(['permission.rejected', 'plugin.reuse-guard'])

  function onToolEnded(o: Extract<Observation, {kind: 'tool.ended'}>): void {
    const node = sessions.get(o.sessionId)
    if (node === undefined || node.completed.has(o.callId)) {
      // A repeat of a terminal event (or one for a session we do not hold): ignored, its snapshot handed back.
      discard(o.result)
      return
    }
    // A call can end with no called event: its input never parsed, or the events were lost. The end event is the authority.
    const tool = node.tools.get(o.callId) ?? openTool(node, o.callId, o.at, {gaps: ['call-event', 'input']})
    if (tool === undefined) return
    if (o.executed === true) tool.providerExecuted = true
    if (o.childSessionId !== undefined && isSubagentDispatch(tool)) link(node, tool, o.childSessionId, o.at)
    // What the hook saw wins; the event's content is what the model saw, for a call no hook fired for.
    if (!tool.resultFromHook && o.result !== undefined) {
      if (tool.result !== undefined) tool.discarded.push(tool.result)
      tool.result = o.result
    } else if (o.result !== undefined) {
      tool.discarded.push(o.result)
    }
    const outcome: ToolOutcome = o.succeeded
      ? 'success'
      : o.errorType !== undefined && REFUSED_ERROR_TYPES.has(o.errorType)
        ? 'rejected'
        : o.errorType === 'aborted' || tool.interrupted
          ? 'interrupted'
          : 'error'
    if (outcome !== 'success' || tool.result === undefined) tool.gaps.add('result')
    node.tools.delete(o.callId)
    unresolved.delete(`${node.id}/${o.callId}`)
    node.completed.add(o.callId)
    while (node.completed.size > limits.maxCompletedCallsPerSession) {
      const oldest = node.completed.values().next()
      if (oldest.done === true) break
      node.completed.delete(oldest.value)
    }
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
      if (o.omitted === true) request.gaps.add('output-omitted')
      else if (o.text !== undefined) addOutput(request, request.texts, o.text)
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
    if (o.omitted === true) request.gaps.add('output-omitted')
    else addOutput(request, request.texts, o.title)
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
    expireIdleSessions(now)
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
    // A session waiting for its dispatch link keeps ALL its observations in order, whatever their kind: the step, output,
    // tool and end events of a child that finished before the link arrived are replayed with its start, never dropped.
    // (The buffer entry is removed before a replay, so replayed observations do not come back here.)
    if ('sessionId' in observation && buffered.has(observation.sessionId) && !sessions.has(observation.sessionId)) {
      bufferObservation(observation.sessionId, observation)
      return
    }
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
      case 'loss':
        onLoss(observation)
        break
      case 'tool.named':
        onToolNamed(observation)
        break
      case 'tool.called':
        onToolCalled(observation)
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
        expireNotes(observation.at)
        break
    }
  }

  return {
    observe: observation => {
      out = []
      clock = Math.max(clock, observation.at)
      sweep(clock)
      if ('sessionId' in observation) {
        const known = sessions.get(observation.sessionId)
        if (known !== undefined) known.lastActivity = clock
      }
      dispatch(observation)
      return out
    },
    takeRetained: () => {
      const taken = retained
      retained = []
      return taken
    },
    takeDiscarded: () => {
      const taken = discarded
      discarded = []
      return taken
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
      for (const node of sessions.values()) forgetSession(node)
      sessions.clear()
      tombstones.clear()
      bufferedBytes = 0
      unresolved.clear()
      linked.clear()
      releasedChildren.clear()
      parentHints.clear()
      pendingMarks.clear()
      return out
    },
    stats: () => ({
      openTraces: traces.size,
      sessions: sessions.size,
      bufferedSessions: buffered.size,
      bufferedBytes,
      hookTimes: [...sessions.values()].reduce((sum, node) => sum + node.hooks.length, 0),
      historyRequestsHeld: [...sessions.values()].reduce(
        (sum, node) => sum + node.hooks.filter(hook => hook.request !== undefined).length,
        0,
      ),
      withholds,
      openSteps: [...sessions.values()].reduce((sum, node) => sum + node.stepOwner.size, 0),
      tombstones: tombstones.size,
      unresolvedDispatches: unresolved.size,
      heldOutputChars,
      pendingToolNotes: [...sessions.values()].reduce((sum, node) => sum + node.notes.size, 0),
      droppedSpans,
    }),
  }
}
