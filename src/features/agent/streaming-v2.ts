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

function stringInput(input: Readonly<Record<string, unknown>> | null | undefined, key: string): string {
  const value = input?.[key]
  return typeof value === 'string' ? value : ''
}

function titleFromInput(input: Readonly<Record<string, unknown>> | null | undefined): string {
  const title = stringInput(input, 'description') || stringInput(input, 'command') || stringInput(input, 'filePath')
  return title.length > 120 ? `${title.slice(0, 117)}...` : title
}

interface ToolCallInfo {
  readonly name: string | null
  readonly input: Readonly<Record<string, unknown>> | null
}

export async function processEventStreamV2(options: ProcessEventStreamV2Options): Promise<EventStreamResult> {
  const {stream, sessionId, signal, logger, tracker, ownershipLedger, onPermissionAsked, onFormAsked} = options

  const pendingText = new Map<string, string>()
  const toolCalls = new Map<string, ToolCallInfo>()
  const shellByCall = new Map<string, string>()
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

  const adoptShell = (shellId: string): void => {
    if (ownershipLedger === undefined) return
    const key = shellLedgerKey(shellId)
    ownershipLedger.adopt(key, 'background shell')
    if (noticedShellIds.has(shellId)) ownershipLedger.settle(key)
  }

  const markTerminal = (terminal: RootTerminalV2): void => {
    tracker.rootTerminal = terminal
    flushText()
    options.onRootTerminal?.(terminal)
  }

  const events = mapV2EventStream(stream, {logger, isOwnedSession: isOwned})

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
        if (isOwned(event.sessionId)) toolCalls.set(event.callId, {name: event.name, input: null})
        return true
      }

      case 'tool_called': {
        if (!isOwned(event.sessionId)) return true
        tracker.firstMeaningfulEventReceived = true
        toolCalls.set(event.callId, {name: toolCalls.get(event.callId)?.name ?? null, input: event.input})
        return true
      }

      case 'tool_progress': {
        if (!isOwned(event.sessionId)) return true
        tracker.firstMeaningfulEventReceived = true
        const shellId = readToolShellId(event.metadata)
        if (shellId !== null) shellByCall.set(event.callId, shellId)
        return true
      }

      case 'tool_finished': {
        if (!isOwned(event.sessionId)) return true
        tracker.firstMeaningfulEventReceived = true
        const info = toolCalls.get(event.callId)
        toolCalls.delete(event.callId)
        const callShellId = readToolShellId(event.metadata) ?? shellByCall.get(event.callId) ?? null
        shellByCall.delete(event.callId)
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
            const description = info?.input?.description
            const label = typeof description === 'string' && description.length > 0 ? description : 'background task'
            ownershipLedger.adopt(dispatch.childSessionId, label)
            if (noticedChildIds.has(dispatch.childSessionId)) ownershipLedger.settle(dispatch.childSessionId)
            logger.info('Background dispatch observed; adopted into ownership ledger', {
              sessionId,
              childSessionId: dispatch.childSessionId,
            })
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

      case 'permission_replied':
      case 'form_resolved':
      case 'session_moved':
      case 'shell_started':
      case 'shell_exited':
      case 'inbox_delivered':
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
        if (!isOwned(event.sessionId)) return true
        noticedChildIds.add(event.notice.childSessionId)
        if (ownershipLedger !== undefined) settleLedgerFromSubagentNotice(ownershipLedger, event.notice)
        return true
      }

      case 'shell_notice': {
        if (!isOwned(event.ownerSessionId)) return true
        noticedShellIds.add(event.shellId)
        if (ownershipLedger !== undefined) {
          settleLedgerFromShellNotice(ownershipLedger, {shellId: event.shellId, state: event.state})
        }
        return true
      }

      case 'execution_started': {
        if (event.sessionId === sessionId) {
          tracker.firstMeaningfulEventReceived = true
          tracker.rootExecutionStarted = true
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
  const failure = getObservedFailureV2(tracker)
  return {
    tokens: null,
    model: null,
    cost: null,
    prsCreated,
    commitsCreated,
    commentsPostedUrls,
    commentsPosted,
    llmError: failure?.error ?? null,
    classificationPath: failure?.classificationPath,
    ...(discontinuity === undefined ? {} : {discontinuity}),
  }
}
