import type {
  ClassificationPath,
  ErrorInfo,
  OwnershipLedger,
  V2DomainEvent,
  V2ErrorInfo,
  V2InterruptReason,
} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {EventStreamResult, ObservedActivityError} from './streaming.js'
import {
  classifyProviderFailure,
  createAgentError,
  createLLMFetchError,
  mapV2EventStream,
  readBackgroundDispatch,
  readBackgroundShellDispatch,
  readToolShellId,
  settleLedgerFromShellNotice,
  settleLedgerFromSubagentNotice,
  shellLedgerKey,
  terminalSignalFromPayload,
} from '@fro-bot/runtime'
import {outputTextContent, outputToolExecution} from '../../shared/console.js'
import {toErrorMessage} from '../../shared/errors.js'
import {detectArtifacts, observeClassification} from './streaming.js'

/**
 * Event loop for a run on OpenCode V2: the sibling of `streaming.ts`.
 *
 * What V2 changes here, and what stays:
 * - The wire. Frames are mapped by the runtime mapper (`mapV2EventStream`), so this loop never reads a raw event name.
 * - Completion. There is no `session.idle`. A root turn ends with `session.execution.succeeded`, `.failed` or
 *   `.interrupted`; the loop records which on the tracker and tells the attempt (`onRootTerminal`). A new
 *   `execution.started` clears it, because a notice-triggered turn invalidates the earlier result the same way V1's
 *   renewed root activity invalidated an idle candidate.
 * - Reasoning. It has its own events and carries no text into this loop, so it cannot reach the console or a response.
 * - Permissions and forms. The Action starts its own loopback server per run, so every ask this process observes
 *   belongs to the run (the same premise as V1). Every permission ask is rejected and every form is cancelled, from
 *   any session, fire-and-continue: awaiting either would starve the stream. A failed reply or cancel is logged and
 *   never fails the run.
 * - Ownership. The ledger is adopted from observed background dispatches and settled from notices, as the gateway
 *   does. Release (waiting for the directory to be quiet) is the V2 drain, not this loop.
 *
 * Gap: the V2 mapper maps no usage event, so `tokens`, `cost` and `model` stay null on V2.
 */

export type RootTerminalV2 =
  | {readonly kind: 'succeeded'}
  | {readonly kind: 'failed'}
  | {readonly kind: 'interrupted'; readonly reason: V2InterruptReason}

/** Mutable by design — updated in place during stream processing, like V1's `ActivityTracker`. */
export interface ActivityTrackerV2 {
  /** Any event of an owned session was observed: the turn reached the remote. */
  firstMeaningfulEventReceived: boolean
  /** The root's `execution.started` was observed in the current generation. */
  rootExecutionStarted: boolean
  /** The root's most recent turn ended this way. Cleared by the next `execution.started`. */
  rootTerminal: RootTerminalV2 | null
  /**
   * Inbox items carrying a completion notice for the root that are queued and not yet part of a turn. Root idle is not
   * terminal while one is queued (probe P2): the notice wakes the root for a second turn. Cleared by the matching
   * `inbox.delivered`.
   */
  readonly queuedNoticeInboxIds: Set<string>
  /** The root is between `execution.started` and its terminal event. */
  rootRunning: boolean
  /**
   * A completion notice was delivered to an IDLE root, or queued for one: a turn is owed and has not started. It is the
   * fence that keeps the previous turn's success (still sitting in memory, or persisted on the server) from being read
   * as the run's result in the gap before that turn's `execution.started`. Cleared by that start.
   */
  turnOwed: boolean
  /**
   * Bumped by every event that changes what the root's result means: a turn starting, a root notice queued or delivered,
   * a terminal. A REST read that began under one revision and ends under another is stale and is discarded.
   */
  rootRevision: number
  /** A terminal provider failure (the shared rule's `stop`, or context overflow). First one wins. */
  terminalProviderError?: ErrorInfo
  /** The first generic (non-terminal) failure. Dropped when a terminal one arrives. */
  genericError?: ErrorInfo
  classificationPath?: ClassificationPath
  /** Set when the stream proved it cannot be trusted to have shown everything (a replaced or lost connection). */
  streamBlind: boolean
  /**
   * The session-wait route answered after the root had started and no terminal event followed. The stream may have
   * missed it, so the poll path reads the persisted state instead.
   */
  idleHintWithoutTerminal: boolean
}

export function createActivityTrackerV2(): ActivityTrackerV2 {
  return {
    firstMeaningfulEventReceived: false,
    rootExecutionStarted: false,
    rootTerminal: null,
    queuedNoticeInboxIds: new Set<string>(),
    rootRunning: false,
    turnOwed: false,
    rootRevision: 0,
    streamBlind: false,
    idleHintWithoutTerminal: false,
  }
}

export interface PermissionAskV2 {
  readonly requestId: string
  readonly sessionId: string
  readonly action: string
  readonly resources: readonly string[]
}

export interface FormAskV2 {
  readonly formId: string
  readonly sessionId: string
}

export type PermissionAskedResponderV2 = (request: PermissionAskV2) => Promise<void>
export type FormAskedResponderV2 = (form: FormAskV2) => Promise<void>

export interface ProcessEventStreamV2Options {
  /** Parsed frames from `subscribeEvents`. */
  readonly stream: AsyncIterable<unknown>
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly tracker: ActivityTrackerV2
  readonly ownershipLedger?: OwnershipLedger
  /** Rejects the ask. A rejection of the returned promise is logged, never escalated. */
  readonly onPermissionAsked?: PermissionAskedResponderV2
  /** Cancels the form. A rejection of the returned promise is logged, never escalated. */
  readonly onFormAsked?: FormAskedResponderV2
  /** The stream's first `server.connected` frame was read: the subscription is live. */
  readonly onStreamConnected?: () => void
  /** The root's turn ended. Fires once per turn. */
  readonly onRootTerminal?: (terminal: RootTerminalV2) => void
  /** An owned session moved: the run must fail and the session must stop. */
  readonly onFatal?: (cause: 'session_moved') => void
  /**
   * Receives a reader of what has been gathered so far, once at the start. The result is otherwise returned only when the
   * stream ends, which a run that keeps observing past its attempt cannot wait for.
   */
  readonly exposeSnapshot?: (snapshot: () => EventStreamResult) => void
}

const V2_AUTH_TYPE = 'provider.auth'
/** Errors the server retried or the shared rule treats as recoverable: the Action may send a continuation. */
const V2_RETRYABLE_TYPES = new Set([
  'provider.rate-limit',
  'provider.internal',
  'provider.timeout',
  'provider.transport',
])
/** Error types that mean the account cannot pay for the call. The status of a free or budget limit is not 402. */
const V2_QUOTA_TYPES = new Set([
  'provider.quota',
  'provider.free-limit',
  'provider.budget-limit',
  'provider.model-budget-limit',
])

/**
 * Map a V2 structured error onto the Action's failure classes through the shared rule. Total: an unrecognized error
 * still yields a label. `detail` is built from the error type and status only, because the upstream message is
 * provider- or plugin-controlled and the generic label echoes `detail`.
 *
 * - `provider.auth` is the structured auth marker → `provider_auth` (stop).
 * - the quota family → `insufficient_quota` through the code the shared rule reads (stop).
 * - `provider.transport` → `llm_fetch_error` (retryable).
 * - rate limit, internal and timeout → retryable API errors.
 * - anything else → a non-retryable agent error.
 */
export function classifyV2Error(
  error: V2ErrorInfo,
  model: string | null,
): ObservedActivityError & {
  readonly classificationPath: ClassificationPath
} {
  const detail = `type=${error.type}${error.status === null ? '' : `; status=${error.status}`}`
  const classification = classifyProviderFailure(
    terminalSignalFromPayload(
      {
        name: error.type === V2_AUTH_TYPE ? 'ProviderAuthError' : error.type,
        message: error.message,
        ...(error.status === null ? {} : {status: error.status}),
        ...(V2_QUOTA_TYPES.has(error.type) ? {code: 'insufficient_quota'} : {}),
        ...(V2_RETRYABLE_TYPES.has(error.type) ? {isRetryable: true} : {}),
      },
      {detail, model: model ?? undefined},
    ),
  )

  if (classification.kind === 'unclassified' && error.type === 'provider.transport') {
    return {error: createLLMFetchError(detail, model ?? undefined), terminal: false, classificationPath: 'name'}
  }
  return {...observeClassification(classification), classificationPath: classification.classificationPath}
}

/** The failure currently recorded on the tracker, terminal first. */
export function getObservedFailureV2(tracker: ActivityTrackerV2): {
  readonly error: ErrorInfo
  readonly terminal: boolean
  readonly classificationPath: ClassificationPath | undefined
} | null {
  const error = tracker.terminalProviderError ?? tracker.genericError
  if (error == null) return null
  return {error, terminal: tracker.terminalProviderError != null, classificationPath: tracker.classificationPath}
}

function recordFailure(tracker: ActivityTrackerV2, observed: ReturnType<typeof classifyV2Error>): void {
  if (tracker.terminalProviderError != null) return
  if (observed.terminal) {
    tracker.terminalProviderError = observed.error
    tracker.genericError = undefined
    tracker.classificationPath = observed.classificationPath
    return
  }
  if (tracker.genericError == null) {
    tracker.genericError = observed.error
    tracker.classificationPath = observed.classificationPath
  }
}

function subagentLabel(input: Readonly<Record<string, unknown>> | null | undefined): string {
  const description = input?.description
  return typeof description === 'string' && description.length > 0 ? description : 'subagent'
}

function stringInput(input: Readonly<Record<string, unknown>> | null | undefined, key: string): string {
  const value = input?.[key]
  return typeof value === 'string' ? value : ''
}

function titleFromInput(input: Readonly<Record<string, unknown>> | null | undefined): string {
  const title = stringInput(input, 'description') || stringInput(input, 'command') || stringInput(input, 'filePath')
  return title.length > 120 ? `${title.slice(0, 117)}...` : title
}

const UNATTRIBUTED_EVENTS_PER_SESSION = 16
const UNATTRIBUTED_SESSIONS_MAX = 64

function getStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null
  const property = (value as Record<string, unknown>)[key]
  return typeof property === 'string' ? property : null
}

/** The child session a `subagent` call's metadata names (`context.progress({sessionID, status})`), or `null`. */
function readSubagentSessionId(metadata: unknown): string | null {
  const id = getStringProperty(metadata, 'sessionID')
  return id !== null && id.length > 0 ? id : null
}

interface ToolCallInfo {
  readonly name: string | null
  readonly input: Readonly<Record<string, unknown>> | null
}

export async function processEventStreamV2(options: ProcessEventStreamV2Options): Promise<EventStreamResult> {
  const {stream, sessionId, signal, logger, tracker, ownershipLedger, onPermissionAsked, onFormAsked} = options

  const pendingText = new Map<string, string>()
  // Keyed by session, message and call: provider call ids repeat across sessions, and two sessions running tools at once
  // would otherwise overwrite and delete each other's names, inputs and shell ids.
  const toolCalls = new Map<string, ToolCallInfo>()
  const shellByCall = new Map<string, string>()
  const callKey = (event: {
    readonly sessionId: string
    readonly messageId: string | null
    readonly callId: string
  }): string => `${event.sessionId}\u0000${event.messageId ?? ''}\u0000${event.callId}`
  // Events about a session that is not owned YET, kept in case an owned session's progress later shows it descends from
  // the run. Bounded: a stranger's events are never replayed and must not grow without limit.
  const unattributed = new Map<string, V2DomainEvent[]>()
  // A notice can precede the dispatch result on the stream; the child or shell is then settled the moment it is adopted.
  const noticedChildIds = new Set<string>()
  const noticedShellIds = new Set<string>()
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  const commentsPostedUrls: string[] = []
  let commentsPosted = 0
  let connectedCount = 0
  let discontinuity: {readonly message: string; readonly errorName?: string} | undefined

  const isOwned = (id: string | null): id is string =>
    id !== null && (id === sessionId || ownershipLedger?.isTracked(id) === true)

  const flushText = (): void => {
    for (const text of pendingText.values()) if (text.length > 0) outputTextContent(text)
    pendingText.clear()
  }

  const bufferUnattributed = (sessionKey: string | null, event: V2DomainEvent): void => {
    if (sessionKey === null || ownershipLedger === undefined) return
    const held = unattributed.get(sessionKey)
    if (held !== undefined) {
      if (held.length < UNATTRIBUTED_EVENTS_PER_SESSION) held.push(event)
      return
    }
    if (unattributed.size >= UNATTRIBUTED_SESSIONS_MAX) return
    unattributed.set(sessionKey, [event])
  }

  /**
   * A session the run's tree provably contains: named by an owned session's own `subagent` tool progress or result. It is
   * tracked so its background shells and notices are owned, and any event it emitted before it was known is replayed.
   * Foreground or background alike; the dispatching call's end settles a foreground one.
   */
  const adoptDescendant = (childSessionId: string, label: string): void => {
    if (ownershipLedger === undefined || childSessionId === sessionId) return
    const known = ownershipLedger.isTracked(childSessionId)
    ownershipLedger.adopt(childSessionId, label)
    if (noticedChildIds.has(childSessionId)) ownershipLedger.settle(childSessionId)
    if (known) return
    logger.info('Owned subagent session discovered; adopted into ownership ledger', {
      sessionId,
      childSessionId,
    })
    const held = unattributed.get(childSessionId)
    unattributed.delete(childSessionId)
    for (const event of held ?? []) handle(event)
  }

  const adoptShell = (shellId: string): void => {
    if (ownershipLedger === undefined) return
    const key = shellLedgerKey(shellId)
    const fresh = !ownershipLedger.isTracked(key)
    // The command is model-controlled text and stays out of the ledger label and the logs.
    ownershipLedger.adopt(key, 'background shell')
    if (noticedShellIds.has(shellId)) ownershipLedger.settle(key)
    if (fresh) logger.info('Background shell adopted into ownership ledger', {sessionId, shellId})
  }

  /**
   * A completion notice for the root was queued, or the one queued was delivered. Either way the root's earlier success
   * no longer stands: the notice starts a second turn, and only that turn's own success ends the run. A failed or
   * interrupted root keeps its result, because no later turn is owed to a run that already ended badly.
   */
  const invalidateRootSuccess = (): void => {
    if (tracker.rootTerminal?.kind === 'succeeded') tracker.rootTerminal = null
  }

  const noteRootNotice = (targetSessionId: string, inboxId: string | null): void => {
    if (targetSessionId !== sessionId || inboxId === null) return
    tracker.queuedNoticeInboxIds.add(inboxId)
    tracker.rootRevision += 1
    // An idle root will be woken for it; a running one may take it into the turn it is in (see `inbox_delivered`).
    if (!tracker.rootRunning) tracker.turnOwed = true
    invalidateRootSuccess()
  }

  const markTerminal = (terminal: RootTerminalV2): void => {
    tracker.rootRunning = false
    tracker.rootRevision += 1
    tracker.rootTerminal = terminal
    flushText()
    options.onRootTerminal?.(terminal)
  }

  const events = mapV2EventStream(stream, {logger, isOwnedSession: isOwned})

  const snapshot = (): EventStreamResult => {
    const failure = getObservedFailureV2(tracker)
    return {
      tokens: null,
      model: null,
      cost: null,
      prsCreated: [...prsCreated],
      commitsCreated: [...commitsCreated],
      commentsPostedUrls: [...commentsPostedUrls],
      commentsPosted,
      llmError: failure?.error ?? null,
      classificationPath: failure?.classificationPath,
      ...(discontinuity === undefined ? {} : {discontinuity}),
    }
  }
  options.exposeSnapshot?.(snapshot)

  async function consume(): Promise<void> {
    for await (const event of events) {
      if (signal.aborted) break
      if (!handle(event)) break
    }
  }

  /** Returns false to end the loop. */
  function handle(event: V2DomainEvent): boolean {
    switch (event.kind) {
      case 'connected': {
        connectedCount += 1
        if (connectedCount === 1) {
          options.onStreamConnected?.()
          return true
        }
        // A second announcement means the connection was replaced and the events in between were never delivered.
        recordDiscontinuity('Event stream was replaced (a second server.connected arrived)')
        return false
      }

      case 'text_delta': {
        if (event.sessionId !== sessionId) return true
        tracker.firstMeaningfulEventReceived = true
        const key = `${event.messageId ?? event.sessionId}:${event.ordinal}`
        pendingText.set(key, `${pendingText.get(key) ?? ''}${event.delta}`)
        return true
      }

      case 'text_ended': {
        if (event.sessionId !== sessionId) return true
        tracker.firstMeaningfulEventReceived = true
        const key = `${event.messageId ?? event.sessionId}:${event.ordinal}`
        // The end event repeats the text of the deltas; the whole text is the authority.
        const text = event.text.length > 0 ? event.text : (pendingText.get(key) ?? '')
        pendingText.delete(key)
        if (text.length > 0) outputTextContent(text)
        return true
      }

      case 'reasoning_activity': {
        // Carries no text, so there is nothing to suppress.
        if (isOwned(event.sessionId)) tracker.firstMeaningfulEventReceived = true
        return true
      }

      case 'tool_started': {
        if (isOwned(event.sessionId)) toolCalls.set(callKey(event), {name: event.name, input: null})
        return true
      }

      case 'tool_called': {
        if (!isOwned(event.sessionId)) return true
        tracker.firstMeaningfulEventReceived = true
        toolCalls.set(callKey(event), {name: toolCalls.get(callKey(event))?.name ?? null, input: event.input})
        return true
      }

      case 'tool_progress': {
        if (!isOwned(event.sessionId)) return true
        tracker.firstMeaningfulEventReceived = true
        const shellId = readToolShellId(event.metadata)
        if (shellId !== null) shellByCall.set(callKey(event), shellId)
        // A `subagent` call names the child it started in its progress, foreground or background: the child is part of
        // this run's tree from that moment, and what it starts (a background shell above all) belongs to the run.
        if (toolCalls.get(callKey(event))?.name === 'subagent') {
          const childSessionId = readSubagentSessionId(event.metadata)
          if (childSessionId !== null)
            adoptDescendant(childSessionId, subagentLabel(toolCalls.get(callKey(event))?.input))
        }
        return true
      }

      case 'tool_finished': {
        if (!isOwned(event.sessionId)) return true
        tracker.firstMeaningfulEventReceived = true
        const info = toolCalls.get(callKey(event))
        toolCalls.delete(callKey(event))
        const callShellId = readToolShellId(event.metadata) ?? shellByCall.get(callKey(event)) ?? null
        shellByCall.delete(callKey(event))
        const name = info?.name ?? null
        if (name !== null && event.calls.length === 0) {
          outputToolExecution(name, titleFromInput(info?.input))
        }

        // Artifacts: a direct `shell` call carries its command; an `execute` call lists the calls it made.
        const command =
          name === 'shell'
            ? stringInput(info?.input, 'command')
            : event.calls
                .filter(call => call.tool === 'shell')
                .map(call => stringInput(call.input, 'command'))
                .join('\n')
        if (command.length > 0) {
          detectArtifacts(
            command,
            event.text,
            prsCreated,
            commitsCreated,
            () => {
              commentsPosted += 1
            },
            commentsPostedUrls,
          )
        }

        if (ownershipLedger !== undefined && name !== null) {
          const dispatch = readBackgroundDispatch(name, event)
          if (dispatch !== null) {
            adoptDescendant(dispatch.childSessionId, subagentLabel(info?.input))
            logger.info('Background dispatch observed; adopted into ownership ledger', {
              sessionId,
              childSessionId: dispatch.childSessionId,
            })
          }
          if (name === 'subagent' && dispatch === null && event.outcome === 'success') {
            // A foreground call that completed: its child ended with the call. The child stays tracked (a late trailing
            // event is still the run's), and what it left running is accounted for by its own shell entries.
            const childSessionId = readSubagentSessionId(event.metadata)
            if (childSessionId !== null && getStringProperty(event.metadata, 'status') === 'completed') {
              adoptDescendant(childSessionId, subagentLabel(info?.input))
              ownershipLedger.settle(childSessionId)
            }
          }
          if (name === 'shell') {
            // Only a call that returned `running` outlives its call and sends a notice.
            const shellDispatch = readBackgroundShellDispatch(name, event)
            if (shellDispatch !== null) adoptShell(shellDispatch.shellId)
            else if (callShellId !== null) ownershipLedger.release(shellLedgerKey(callShellId))
          }
        }
        return true
      }

      case 'permission_asked': {
        // Ownership is deliberately not required: every ask this subscription observes belongs to this run (the
        // Action owns the server), and an unanswered ask blocks its session until the deadline.
        const context = {sessionId, eventSessionId: event.sessionId, action: event.action, resources: event.resources}
        if (onPermissionAsked === undefined) {
          logger.warning('OpenCode V2 permission request observed but no responder is configured', context)
          return true
        }
        logger.warning('Rejecting OpenCode V2 permission request', context)
        // Fire-and-continue: awaiting would stall every later event of every session until the run's deadline.
        // eslint-disable-next-line no-void
        void onPermissionAsked({
          requestId: event.requestId,
          sessionId: event.sessionId,
          action: event.action,
          resources: event.resources,
        }).catch((error: unknown) => {
          logger.warning('Failed to reject OpenCode V2 permission request', {...context, error: toErrorMessage(error)})
        })
        return true
      }

      case 'form_asked': {
        // V2 has no question route: nobody can fill a form in a CI run (the `question` tool is also denied in the
        // config, R18). Cancel it at once so the asking step continues, and keep going.
        const context = {sessionId, eventSessionId: event.sessionId, formKind: event.formKind}
        if (onFormAsked === undefined) {
          logger.warning('OpenCode V2 form observed but no responder is configured', context)
          return true
        }
        logger.warning('Cancelling OpenCode V2 form', context)
        // eslint-disable-next-line no-void
        void onFormAsked({formId: event.formId, sessionId: event.sessionId}).catch((error: unknown) => {
          logger.warning('Failed to cancel OpenCode V2 form; the run continues', {
            ...context,
            error: toErrorMessage(error),
          })
        })
        return true
      }

      case 'shell_started': {
        // The earliest signal that an owned session started a shell, ahead of the tool call returning. A shell nobody
        // tagged (`POST /api/shell`), one a stranger's session started, and a user-run command (awaited by its own
        // request, no notice) are not owned. Idempotent: the tool result adopts the same key again.
        if (event.userCommand || event.ownerSessionId === null) return true
        if (!isOwned(event.ownerSessionId)) {
          bufferUnattributed(event.ownerSessionId, event)
          return true
        }
        adoptShell(event.shellId)
        return true
      }

      case 'inbox_delivered': {
        if (event.sessionId === sessionId && tracker.queuedNoticeInboxIds.delete(event.inboxId)) {
          tracker.rootRevision += 1
          // Delivered to an idle root: its turn is on the way, and the fence holds until that turn starts. Delivered to a
          // running one: that turn took the notice in, and nothing further is owed.
          if (!tracker.rootRunning) tracker.turnOwed = true
          invalidateRootSuccess()
        }
        return true
      }

      case 'permission_replied':
      case 'form_resolved':
      case 'session_moved':
      case 'shell_exited':
      case 'step_failed': {
        return true
      }

      case 'retry_scheduled': {
        // A retry is not a failure: the terminal event decides. The root may be mid-backoff.
        if (isOwned(event.sessionId)) {
          tracker.firstMeaningfulEventReceived = true
          logger.warning('OpenCode V2 provider retry scheduled; waiting', {
            sessionId: event.sessionId,
            attempt: event.attempt,
          })
        }
        return true
      }

      case 'subagent_notice': {
        if (!isOwned(event.sessionId)) {
          bufferUnattributed(event.sessionId, event)
          return true
        }
        noticedChildIds.add(event.notice.childSessionId)
        if (ownershipLedger !== undefined) settleLedgerFromSubagentNotice(ownershipLedger, event.notice)
        noteRootNotice(event.sessionId, event.inboxId)
        return true
      }

      case 'shell_notice': {
        if (!isOwned(event.ownerSessionId)) {
          bufferUnattributed(event.ownerSessionId, event)
          return true
        }
        noticedShellIds.add(event.shellId)
        if (ownershipLedger !== undefined) {
          settleLedgerFromShellNotice(ownershipLedger, {shellId: event.shellId, state: event.state})
        }
        noteRootNotice(event.ownerSessionId, event.inboxId)
        return true
      }

      case 'execution_started': {
        if (event.sessionId === sessionId) {
          tracker.firstMeaningfulEventReceived = true
          tracker.rootExecutionStarted = true
          tracker.rootRunning = true
          tracker.turnOwed = false
          tracker.rootRevision += 1
          // A new turn (for instance the one a child's notice starts) invalidates the earlier turn's result.
          tracker.rootTerminal = null
        } else if (isOwned(event.sessionId)) {
          tracker.firstMeaningfulEventReceived = true
        }
        return true
      }

      case 'execution_succeeded': {
        // Root-scoped: a descendant finishing a turn must never end the run while the root is working.
        if (event.sessionId === sessionId) markTerminal({kind: 'succeeded'})
        return true
      }

      case 'execution_failed': {
        if (event.sessionId === sessionId) {
          recordFailure(tracker, classifyV2Error(event.error, null))
          markTerminal({kind: 'failed'})
        } else if (isOwned(event.sessionId)) {
          // A child's failure does not end the root's turn and is not proof the child stopped writing.
          ownershipLedger?.markUnknown(event.sessionId)
          logger.warning('Owned child reported a terminal execution failure; marked unknown', {
            sessionId,
            childSessionId: event.sessionId,
          })
        } else {
          bufferUnattributed(event.sessionId, event)
        }
        return true
      }

      case 'execution_interrupted': {
        if (event.sessionId === sessionId) markTerminal({kind: 'interrupted', reason: event.reason})
        else if (isOwned(event.sessionId)) {
          ownershipLedger?.markUnknown(event.sessionId)
          logger.warning('Owned child was interrupted; marked unknown', {
            sessionId,
            childSessionId: event.sessionId,
            reason: event.reason,
          })
        } else {
          bufferUnattributed(event.sessionId, event)
        }
        return true
      }

      case 'fatal': {
        // The outside-checkout rules re-base on the destination (P12), so the run can no longer be trusted to stay in
        // its sandbox. The move tools are denied in the config; this is the backstop.
        logger.error('An owned session moved during the run; failing it', {sessionId, movedSessionId: event.sessionId})
        tracker.terminalProviderError ??= createAgentError('An owned OpenCode session changed location during the run')
        tracker.classificationPath ??= 'structured'
        options.onFatal?.(event.cause)
        markTerminal({kind: 'failed'})
        return true
      }

      case 'malformed': {
        // The mapper already logged the type and reason. A request nobody can read cannot be answered, so name it.
        if (event.eventType === 'permission.asked' || event.eventType === 'form.created') {
          logger.error('An unreadable OpenCode V2 request cannot be answered; its session may block', {
            sessionId,
            eventType: event.eventType,
          })
        }
        return true
      }
    }
  }

  function recordDiscontinuity(message: string, errorName?: string): void {
    // The observation channel closed without an intentional shutdown and without a terminal signal. A stream break is
    // an observation failure, never evidence the turn ended: keep what was gathered, mark owned work unknown, and let
    // the poll path corroborate.
    discontinuity = errorName === undefined ? {message} : {message, errorName}
    tracker.streamBlind = true
    logger.warning('Event stream discontinuity — observation channel closed unexpectedly', {sessionId, error: message})
    if (ownershipLedger !== undefined) {
      const outstanding = ownershipLedger.snapshot().filter(entry => entry.state === 'outstanding')
      for (const entry of outstanding) ownershipLedger.markUnknown(entry.sessionId)
      logger.warning('Event stream discontinuity — marked outstanding owned entries unknown', {
        sessionId,
        unknownCount: outstanding.length,
      })
    }
  }

  try {
    await consume()
    // The loop ends without throwing only when the iterator ran dry or the abort check fired. Every intentional local
    // shutdown goes through the signal, so a signal still unset here means the transport ended the stream.
    if (!signal.aborted && discontinuity === undefined) recordDiscontinuity('Event stream ended unexpectedly')
  } catch (error) {
    if (!(signal.aborted || (error instanceof Error && error.name === 'AbortError'))) {
      recordDiscontinuity(toErrorMessage(error), error instanceof Error ? error.name : undefined)
    }
  }

  flushText()
  return snapshot()
}
