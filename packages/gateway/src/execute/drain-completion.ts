/**
 * Drain-completion gate for a gateway run that adopted background work.
 *
 * Why this exists: upstream's `task` tool (`tool/task.ts`) marks a background child non-live FIRST,
 * then persists a synthetic `<task id="{childSessionId}" state="completed|error">` user message on the
 * PARENT, then starts a new root turn. Ledger reconciliation settles an entry the moment the child is
 * non-live, so "the ledger drained" can be true before the injected turn exists. Completing on the ledger
 * alone loses the parent's follow-up turn. A cancelled job injects nothing (`tool/task.ts:261`).
 *
 * This gate is the extra condition run-core consults before it treats a drained ledger as completion. It
 * applies ONLY to runs that adopted a background dispatch (the ledger holds an entry); every other run keeps
 * the original root-idle return path and never constructs this.
 *
 * Success is admitted only when ALL of these hold at one commit point:
 * - the ledger reports drain-complete (`unknown` still blocks, exactly as before);
 * - every ledger entry has its notice observed (SSE or REST) or is cancel-exempt (REST shows its last
 *   assistant message aborted);
 * - the root idle evidence is current-generation (no root activity or new root user message since);
 * - REST shows the root is not live;
 * - REST `session.messages` shows the LATEST root user message answered by a qualified terminal assistant
 *   reply (small local copy of the Action's predicate in `src/features/agent/session-poll.ts` — no
 *   cross-layer import);
 * - the revision captured before those requests still equals the current one.
 *
 * No notice and no cancel evidence never admits: the run's hard deadline reports it incomplete.
 * Human waits take no part here. Not a state machine framework: a revision counter, an idle stamp, a set
 * of observed notices, and one validation in flight.
 */

import type {LedgerReconcileAdapter, OpenCodeServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

/** Cadence of re-validation while draining. A rejected pass is re-run no faster than this. */
export const DRAIN_VALIDATION_INTERVAL_MS = 1_000

/** Upper bound on every REST request a validation pass makes. */
export const DRAIN_REQUEST_TIMEOUT_MS = 5_000

/**
 * Upstream's `MessageAbortedError` (`packages/core/src/v1/session.ts`: `NamedError.create("MessageAbortedError")`),
 * written onto `info.error.name` of an interrupted assistant message.
 */
const ABORTED_ERROR_NAME = 'MessageAbortedError'

/** `<task id="{childSessionId}" state="completed|error">` — see `renderOutput` in upstream `tool/task.ts`. */
const TASK_NOTICE_PATTERN = /<task id="([^"]+)" state="(completed|error)">/

export interface TaskNotice {
  readonly childSessionId: string
  readonly state: 'completed' | 'error'
}

/** Parse the opening tag of an injected background-task notice. The `running` state is never injected. */
export function parseTaskNotice(text: string): TaskNotice | null {
  const match = TASK_NOTICE_PATTERN.exec(text)
  const childSessionId = match?.[1]
  const state = match?.[2]
  if (childSessionId === undefined || (state !== 'completed' && state !== 'error')) return null
  return {childSessionId, state}
}

function getStringProperty(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null
  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}

function getBooleanProperty(value: unknown, property: string): boolean | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'boolean' ? descriptor.value : null
}

function getNumberProperty(value: unknown, property: string): number | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'number' ? descriptor.value : null
}

/** A notice parsed out of a persisted/streamed message part, or null when the part is not one. */
export function parseSyntheticNoticePart(part: unknown): TaskNotice | null {
  if (getStringProperty(part, 'type') !== 'text') return null
  if (getBooleanProperty(part, 'synthetic') !== true) return null
  const text = getStringProperty(part, 'text')
  return text === null ? null : parseTaskNotice(text)
}

type BoundedResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false}

interface RestMessageFacts {
  readonly userMessageIds: readonly string[]
  readonly latestUserMessageId: string | null
  /** Children named by a synthetic notice part on any persisted user message. */
  readonly noticeChildren: ReadonlySet<string>
  readonly latestAssistant: {readonly info: unknown; readonly parts: unknown} | null
}

function readMessages(data: unknown): RestMessageFacts | null {
  if (!Array.isArray(data)) return null
  const userMessageIds: string[] = []
  const noticeChildren = new Set<string>()
  let latestAssistant: {readonly info: unknown; readonly parts: unknown} | null = null
  for (const message of data as readonly unknown[]) {
    const info = getObjectProperty(message, 'info')
    const id = getStringProperty(info, 'id')
    if (id === null) continue
    const role = getStringProperty(info, 'role')
    if (role === 'user') {
      userMessageIds.push(id)
      const parts = getObjectProperty(message, 'parts')
      if (Array.isArray(parts)) {
        for (const part of parts as readonly unknown[]) {
          const notice = parseSyntheticNoticePart(part)
          if (notice !== null) noticeChildren.add(notice.childSessionId)
        }
      }
    } else if (role === 'assistant') {
      latestAssistant = {info, parts: getObjectProperty(message, 'parts')}
    }
  }
  return {
    userMessageIds,
    latestUserMessageId: userMessageIds.at(-1) ?? null,
    noticeChildren,
    latestAssistant,
  }
}

/**
 * Whether an assistant message is a qualified terminal reply to `parentId`. Local copy of the Action's
 * predicate (`detectMessageActivity` in `src/features/agent/session-poll.ts`):
 * - answers the parent, carries no error, and has `time.completed`;
 * - `finish` is set and is neither `tool-calls` nor `unknown` (`time.completed` alone is not a success
 *   certificate — upstream sets it during cleanup of failed and intermediate steps too);
 * - no tool part blocks it. Any non-provider-executed tool part means the model has not yet received the
 *   result and will produce another turn — except an orphaned interrupted tool (`state.status === 'error'`
 *   with `state.metadata.interrupted === true`), which is abandoned, not pending.
 */
function isQualifiedTerminalReply(
  assistant: {readonly info: unknown; readonly parts: unknown},
  parentId: string,
): boolean {
  const {info, parts} = assistant
  if (getStringProperty(info, 'parentID') !== parentId) return false
  if (getObjectProperty(info, 'error') != null) return false
  if (getNumberProperty(getObjectProperty(info, 'time'), 'completed') === null) return false
  const finish = getStringProperty(info, 'finish')
  if (finish === null || finish === 'tool-calls' || finish === 'unknown') return false
  if (Array.isArray(parts)) {
    const hasBlockingTool = (parts as readonly unknown[]).some(part => {
      if (getStringProperty(part, 'type') !== 'tool') return false
      if (getBooleanProperty(getObjectProperty(part, 'metadata'), 'providerExecuted') === true) return false
      const state = getObjectProperty(part, 'state')
      const interrupted = getBooleanProperty(getObjectProperty(state, 'metadata'), 'interrupted')
      return !(getStringProperty(state, 'status') === 'error' && interrupted === true)
    })
    if (hasBlockingTool) return false
  }
  return true
}

/** Whether the last assistant message of a child session ended aborted — upstream injects nothing for it. */
function endedAborted(facts: RestMessageFacts): boolean {
  if (facts.latestAssistant === null) return false
  return getStringProperty(getObjectProperty(facts.latestAssistant.info, 'error'), 'name') === ABORTED_ERROR_NAME
}

export interface DrainCompletionOptions {
  readonly client: OpenCodeServerHandle['client']
  readonly directory: string
  readonly rootSessionId: string
  readonly ledger: OwnershipLedger
  /** Directory-scoped liveness — the reconcile adapter's `liveSessionIds`. */
  readonly adapter: LedgerReconcileAdapter
  /** The run's combined signal: deadline, inactivity, cancel. Aborting it ends validation. */
  readonly signal: AbortSignal
  readonly logger: GatewayLogger
  /** Called at most once, only for an admitted completion. */
  readonly onAdmitted: () => void
  readonly validationIntervalMs?: number
  readonly requestTimeoutMs?: number
}

export interface DrainCompletion {
  /** Root assistant/text/tool activity or a root busy/retry status: invalidates current idle evidence. */
  readonly noteRootActivity: () => void
  /** A root user message observed on the stream. Idempotent by id; a new id invalidates idle evidence. */
  readonly noteRootUserMessage: (messageId: string) => void
  /**
   * A root synthetic notice part observed on the stream. Deduped by `(messageID, partID)`: a duplicate
   * changes nothing. Registers the injected user message BEFORE any validation can run.
   */
  readonly noteNotice: (notice: TaskNotice, messageId: string | null, partId: string | null) => void
  /** Root idle stamps the current revision. */
  readonly noteRootIdle: () => void
  /** The run entered drain: validation passes may now run, retried on the interval. */
  readonly beginDrain: () => void
  /** Ask for a validation pass. Never completes anything itself; coalesced to one in flight. */
  readonly requestValidation: () => void
  readonly dispose: () => void
}

export function createDrainCompletion(options: DrainCompletionOptions): DrainCompletion {
  const {
    client,
    directory,
    rootSessionId,
    ledger,
    adapter,
    signal,
    logger,
    onAdmitted,
    validationIntervalMs = DRAIN_VALIDATION_INTERVAL_MS,
    requestTimeoutMs = DRAIN_REQUEST_TIMEOUT_MS,
  } = options

  let closed = false
  // Aborted on dispose so a request still in flight when the run exits stops, and its cap timer is cleared.
  const lifecycle = new AbortController()
  let draining = false
  let inFlight = false
  let rerunRequested = false
  let retryTimer: ReturnType<typeof setInterval> | undefined

  // Generation counter: bumped by any root activity or new root user message. Idle evidence stamped with an
  // older revision is stale by construction.
  let revision = 0
  let idleRevision: number | null = null
  // The newest root user message the stream has shown. REST must show it too (see `validate`).
  let latestStreamUserMessageId: string | null = null
  const seenUserMessageIds = new Set<string>()
  const seenNoticeKeys = new Set<string>()
  const noticedChildren = new Set<string>()
  const cancelExempt = new Set<string>()

  function invalidate(): void {
    revision += 1
    idleRevision = null
  }

  function registerUserMessage(messageId: string): void {
    if (seenUserMessageIds.has(messageId)) return
    seenUserMessageIds.add(messageId)
    latestStreamUserMessageId = messageId
    invalidate()
  }

  function noteRootActivity(): void {
    if (closed) return
    invalidate()
  }

  function noteRootUserMessage(messageId: string): void {
    if (closed) return
    registerUserMessage(messageId)
  }

  function noteNotice(notice: TaskNotice, messageId: string | null, partId: string | null): void {
    if (closed) return
    const key =
      messageId !== null && partId !== null
        ? `${messageId}:${partId}`
        : `child:${notice.childSessionId}:${notice.state}`
    if (seenNoticeKeys.has(key)) return
    seenNoticeKeys.add(key)
    // Register the injected turn as pending first: nothing can test completion between these statements.
    if (messageId === null) invalidate()
    else if (seenUserMessageIds.has(messageId)) invalidate()
    else registerUserMessage(messageId)
    noticedChildren.add(notice.childSessionId)
    requestValidation()
  }

  function noteRootIdle(): void {
    if (closed) return
    idleRevision = revision
  }

  /**
   * Run one REST request bounded by the run signal, dispose, and a hard cap. Never rejects; a hung, failed,
   * or aborted request is `{ok: false}` so the caller treats it as "no evidence", never as success.
   *
   * The request receives a per-request signal that fires at the cap, on dispose, and when the run signal
   * aborts — the SDK has no fetch timeout of its own, so without it a hung request keeps running while each
   * retry starts another. The signal is a plain controller fed by listeners that are ALL removed in `finally`,
   * not an `AbortSignal.any` composite: a composite stays registered on its parents until garbage collection,
   * so retries would accumulate on the long-lived run and lifecycle signals.
   */
  async function bounded<T>(request: (requestSignal: AbortSignal) => Promise<T>): Promise<BoundedResult<T>> {
    if (signal.aborted || lifecycle.signal.aborted) return {ok: false}
    const requestController = new AbortController()
    const abortRequest = (): void => {
      requestController.abort()
    }
    signal.addEventListener('abort', abortRequest, {once: true})
    lifecycle.signal.addEventListener('abort', abortRequest, {once: true})
    const capTimer = setTimeout(abortRequest, requestTimeoutMs)
    const abandoned = new Promise<BoundedResult<T>>(resolve => {
      requestController.signal.addEventListener('abort', () => resolve({ok: false}), {once: true})
    })
    try {
      return await Promise.race([
        request(requestController.signal).then(
          (value): BoundedResult<T> => ({ok: true, value}),
          (): BoundedResult<T> => ({ok: false}),
        ),
        abandoned,
      ])
    } finally {
      clearTimeout(capTimer)
      signal.removeEventListener('abort', abortRequest)
      lifecycle.signal.removeEventListener('abort', abortRequest)
    }
  }

  async function readSessionMessages(sessionId: string): Promise<RestMessageFacts | null> {
    const result = await bounded(async requestSignal =>
      client.session.messages({path: {id: sessionId}, query: {directory}, signal: requestSignal}),
    )
    if (!result.ok) return null
    const response = result.value as {readonly error?: unknown; readonly data?: unknown}
    if (response.error != null) return null
    return readMessages(response.data)
  }

  async function rootIsLive(): Promise<boolean | null> {
    const result = await bounded(async requestSignal => adapter.liveSessionIds(requestSignal))
    if (!result.ok || result.value.success === false) return null
    return result.value.data.has(rootSessionId)
  }

  function reject(reason: string, context: Record<string, unknown> = {}): void {
    logger.debug({sessionId: rootSessionId, reason, ...context}, 'run-core: drain completion not admitted')
  }

  async function validate(): Promise<void> {
    // Captured before any request: renewed root activity while these are in flight invalidates whatever
    // they describe, not only what happens afterward.
    const requestedRevision = revision
    const unconfirmed = ledger
      .snapshot()
      .map(entry => entry.sessionId)
      .filter(id => !noticedChildren.has(id) && !cancelExempt.has(id))

    const [live, rootFacts, childFacts] = await Promise.all([
      rootIsLive(),
      readSessionMessages(rootSessionId),
      Promise.all(unconfirmed.map(async id => ({id, facts: await readSessionMessages(id)}))),
    ])
    if (closed || signal.aborted) return

    // A persisted notice the stream never delivered still counts toward the fence.
    if (rootFacts !== null) {
      for (const child of rootFacts.noticeChildren) noticedChildren.add(child)
    }
    // Cancel exemption: positive REST evidence only. Missing or failed evidence is NOT exempt.
    for (const {id, facts} of childFacts) {
      if (noticedChildren.has(id)) continue
      if (facts !== null && endedAborted(facts)) cancelExempt.add(id)
    }

    if (live === null) return reject('root-liveness-unavailable')
    if (live === true) return reject('root-live')
    if (rootFacts === null) return reject('root-messages-unavailable')

    const latestUserId = rootFacts.latestUserMessageId
    if (latestUserId === null) return reject('no-root-user-message')
    // The stream's newest root user turn must be visible in REST too; otherwise REST describes an older
    // state. A newer turn REST shows that the stream missed is fine: it is judged as the latest below.
    if (latestStreamUserMessageId !== null && !rootFacts.userMessageIds.includes(latestStreamUserMessageId)) {
      return reject('stream-user-message-not-persisted')
    }
    // Only the LATEST root user message needs a qualified reply; one reply can answer several notices.
    if (rootFacts.latestAssistant === null || !isQualifiedTerminalReply(rootFacts.latestAssistant, latestUserId)) {
      return reject('latest-root-user-message-unanswered')
    }

    const unfenced = ledger
      .snapshot()
      .map(entry => entry.sessionId)
      .filter(id => !noticedChildren.has(id) && !cancelExempt.has(id))
    if (unfenced.length > 0) return reject('notice-not-observed', {children: unfenced})

    // Commit point — nothing awaited between here and `onAdmitted`.
    if (revision !== requestedRevision) return reject('revision-drift')
    if (idleRevision === null || idleRevision !== revision) return reject('idle-evidence-stale')
    if (!ledger.isDrainComplete()) return reject('ledger-not-drained')

    closed = true
    onAdmitted()
  }

  function requestValidation(): void {
    if (closed || !draining || signal.aborted) return
    if (inFlight) {
      rerunRequested = true
      return
    }
    // Nothing to validate without a drained ledger and current-generation root idle evidence.
    if (!ledger.isDrainComplete()) return
    if (idleRevision === null || idleRevision !== revision) return
    inFlight = true
    rerunRequested = false
    validate()
      .catch((error: unknown) => {
        reject('validation-threw', {detail: error instanceof Error ? error.message : String(error)})
      })
      .finally(() => {
        inFlight = false
        if (rerunRequested) requestValidation()
      })
  }

  function beginDrain(): void {
    if (closed || draining) return
    draining = true
    retryTimer = setInterval(requestValidation, validationIntervalMs)
  }

  function dispose(): void {
    closed = true
    lifecycle.abort()
    if (retryTimer !== undefined) clearInterval(retryTimer)
    retryTimer = undefined
  }

  return {noteRootActivity, noteRootUserMessage, noteNotice, noteRootIdle, beginDrain, requestValidation, dispose}
}
