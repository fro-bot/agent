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
 * - every ledger entry is covered per dispatch (see `lacksEvidence`): a notice observed (SSE or REST) for each of
 *   its upstream jobs, or the job's cancellation (REST shows its dispatch segment ending aborted) — only evidence
 *   from this run's own dispatches counts, never a reused session's earlier history, and one dispatch earns one
 *   credit even when it shows both a notice and an abort;
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
import type {ReplyTextPart} from './reply-delivery.js'

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

/**
 * The creation-order key of an upstream message id. Ids come from `MessageID.ascending()`
 * (`packages/opencode/src/id/id.ts:51-70`): `msg_` + 12 hex digits (48 bits of `Date.now() * 0x1000 + counter`,
 * the counter incrementing within one millisecond and resetting on a new one) + a random base62 tail. The hex
 * field is fixed-width and lowercase, so plain string comparison of it is creation order. Null: not such an id
 * (a client-supplied id, or a test fixture), which orders against nothing.
 */
const MESSAGE_ORDER_PATTERN = /^msg_([0-9a-f]{12})/

export function messageOrderKey(messageId: string | null): string | null {
  if (messageId === null) return null
  return MESSAGE_ORDER_PATTERN.exec(messageId)?.[1] ?? null
}

type BoundedResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false}

/** One persisted synthetic notice part: the child it names, its terminal state, and the message that carries it. */
interface RestNotice {
  readonly childSessionId: string
  readonly state: 'completed' | 'error'
  readonly key: string
  /** `info.id` of the carrying user message. */
  readonly messageId: string
  /** `info.time.created` of the carrying user message, or null when REST did not report one. */
  readonly createdAt: number | null
}

/**
 * One dispatch segment of a (child) session: a user prompt and the assistant messages that follow it. A background
 * job on a reused session starts a NEW user prompt, so segments are how a session's history is told apart.
 */
interface RestSegment {
  /** `info.id` of the segment's user prompt, or null for an assistant message with no prompt before it. */
  readonly messageId: string | null
  /** `info.time.created` of the segment's user prompt, or null when REST did not report one. */
  readonly startedAt: number | null
  /** The LAST assistant message of the segment ended `MessageAbortedError`. */
  readonly aborted: boolean
}

interface RestMessageFacts {
  readonly userMessageIds: readonly string[]
  readonly latestUserMessageId: string | null
  /** Every synthetic notice part on a persisted user message. */
  readonly notices: readonly RestNotice[]
  /** Ids of the persisted user messages that carry a synthetic notice part. */
  readonly noticeMessageIds: ReadonlySet<string>
  readonly latestAssistant: {readonly info: unknown; readonly parts: unknown} | null
  readonly segments: readonly RestSegment[]
  /** Every persisted assistant message, in order, with the user message it answers. */
  readonly assistantMessages: readonly {readonly parentId: string | null; readonly parts: unknown}[]
}

function readMessages(data: unknown): RestMessageFacts | null {
  if (!Array.isArray(data)) return null
  const userMessageIds: string[] = []
  const notices: RestNotice[] = []
  const noticeMessageIds = new Set<string>()
  const assistantMessages: {readonly parentId: string | null; readonly parts: unknown}[] = []
  // A child session is resumed by sending it a new user prompt, so each dispatch is one run of messages starting at a
  // user prompt. An aborted segment is one whose LAST assistant message ended aborted; an aborted message that a
  // later message in the same segment followed is not a cancellation.
  const segments: {messageId: string | null; startedAt: number | null; aborted: boolean}[] = []
  let latestAssistant: {readonly info: unknown; readonly parts: unknown} | null = null
  for (const message of data as readonly unknown[]) {
    const info = getObjectProperty(message, 'info')
    const id = getStringProperty(info, 'id')
    if (id === null) continue
    const role = getStringProperty(info, 'role')
    const createdAt = getNumberProperty(getObjectProperty(info, 'time'), 'created')
    if (role === 'user') {
      userMessageIds.push(id)
      segments.push({messageId: id, startedAt: createdAt, aborted: false})
      const parts = getObjectProperty(message, 'parts')
      if (Array.isArray(parts)) {
        for (const [index, part] of (parts as readonly unknown[]).entries()) {
          const notice = parseSyntheticNoticePart(part)
          if (notice !== null) {
            // Same key shape as the stream's (`messageID:partID`), so one notice seen both ways counts once.
            notices.push({
              childSessionId: notice.childSessionId,
              state: notice.state,
              key: `${id}:${getStringProperty(part, 'id') ?? `index-${index}`}`,
              messageId: id,
              createdAt,
            })
            noticeMessageIds.add(id)
          }
        }
      }
    } else if (role === 'assistant') {
      const parts = getObjectProperty(message, 'parts')
      latestAssistant = {info, parts}
      // An assistant message before any user prompt (a truncated history) still belongs to some segment.
      const segment =
        segments.at(-1) ?? (segments.push({messageId: null, startedAt: null, aborted: false}), segments.at(-1))
      if (segment !== undefined) {
        segment.aborted = getStringProperty(getObjectProperty(info, 'error'), 'name') === ABORTED_ERROR_NAME
      }
      assistantMessages.push({parentId: getStringProperty(info, 'parentID'), parts})
    }
  }
  return {
    userMessageIds,
    latestUserMessageId: userMessageIds.at(-1) ?? null,
    notices,
    noticeMessageIds,
    latestAssistant,
    segments,
    assistantMessages,
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

/**
 * Text parts of the assistant messages that answer a follow-up turn: a user message carrying a synthetic notice
 * (persisted or seen on the stream) or the latest root user message. Earlier turns' output is not this gate's
 * business. Synthetic parts (the harness talking to the agent) and `ignored` parts are never reply text.
 */
function followUpReplyText(
  facts: RestMessageFacts,
  latestUserId: string,
  streamNoticeMessageIds: ReadonlySet<string>,
): readonly ReplyTextPart[] {
  const followUpParents = new Set<string>([latestUserId, ...facts.noticeMessageIds, ...streamNoticeMessageIds])
  const result: ReplyTextPart[] = []
  for (const message of facts.assistantMessages) {
    if (message.parentId === null || !followUpParents.has(message.parentId)) continue
    if (!Array.isArray(message.parts)) continue
    for (const part of message.parts as readonly unknown[]) {
      if (getStringProperty(part, 'type') !== 'text') continue
      if (getBooleanProperty(part, 'synthetic') === true || getBooleanProperty(part, 'ignored') === true) continue
      const id = getStringProperty(part, 'id')
      const text = getStringProperty(part, 'text')
      if (id === null || text === null || text.length === 0) continue
      result.push({id, text})
    }
  }
  return result
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
  /**
   * Delivery fence, AND'ed with every other admission condition: whether the stream has delivered the follow-up
   * turns' persisted reply text parts (non-synthetic, non-ignored, in message order) to the reply sink in full.
   * The sink is append-only and may already be on screen, so completion never repairs missing text — it waits for
   * the stream to deliver it and otherwise reaches the deadline as incomplete. Omitted: no fence.
   */
  readonly isReplyDelivered?: (parts: readonly ReplyTextPart[]) => boolean
  readonly validationIntervalMs?: number
  readonly requestTimeoutMs?: number
}

/**
 * How a dispatching `task` tool part relates to the gate's knowledge of its child: `adopted` is the first sight of
 * the child this run, `reused` a new job on a child already tracked (upstream `background.start`), `extension` a
 * running job chained onto (`background.extend`: a new user prompt in the child, but no new job and no notice).
 * `adopted-extension` is an extension that is also the first sight of the child this run: the job it chained onto
 * started outside this run and `extend` never notifies, so the child owes no notice (a later one is surplus).
 */
export type DispatchKind = 'adopted' | 'adopted-extension' | 'reused' | 'extension'

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
  /**
   * A background `task` dispatch reached a child session (see `DispatchKind`). Each `adopted`/`reused` dispatch is a
   * separate upstream job that injects its own notice, and `startedAt` (the tool part's `state.time.start`) opens
   * the window of child segments and parent notices that belong to this run; `dispatchMessageId` (the tool part's
   * `messageID`) orders the job against the evidence that can credit it. The caller dedupes by the dispatch's
   * own tool part identity. Call BEFORE anything that can request validation.
   */
  readonly noteDispatch: (
    childSessionId: string,
    kind: DispatchKind,
    startedAt: number | null,
    dispatchMessageId: string | null,
  ) => void
  /** Root idle stamps the current revision. */
  readonly noteRootIdle: () => void
  /** The run entered drain: validation passes may now run, retried on the interval. */
  readonly beginDrain: () => void
  /** Ask for a validation pass. Never completes anything itself; coalesced to one in flight. */
  readonly requestValidation: () => void
  readonly dispose: () => void
}

/** One upstream background job a run started on a child session. */
interface DispatchJob {
  /**
   * Creation-order key of the assistant message that carried the dispatching `task` tool part. A notice or a child
   * segment can belong to this job only if it was created AFTER that message. Null: the dispatch reported no
   * orderable message id, so it cannot be told apart from other jobs (any evidence may credit it).
   */
  readonly orderKey: string | null
}

/** What the gate knows of the dispatches (upstream background jobs) a run made on one child session. */
interface ChildDispatches {
  /** Jobs started on the child during this run, in observation order (extensions are not jobs). */
  readonly jobs: readonly DispatchJob[]
  /**
   * Earliest known start (`state.time.start` of the dispatching tool part) of this run's dispatches. Child segments
   * and persisted parent notices created before it predate the run. Null: no dispatch reported a time.
   */
  readonly windowStart: number | null
  /** A running job was extended: the child holds user prompts that are not dispatches. */
  readonly extended: boolean
}

/** A notice the gate has seen for a child. */
interface ChildNotice {
  readonly state: TaskNotice['state']
  readonly orderKey: string | null
  /** Seen on the live stream (this run by construction) rather than read back from REST. */
  readonly live: boolean
  /** REST `time.created` of the carrying message; meaningful only when not `live`. */
  readonly createdAt: number | null
}

/** An aborted child segment inside the child's window. */
interface AbortedSegment {
  readonly orderKey: string | null
}

/** Whether evidence created after message `evidenceKey` can belong to `job`. */
function followsDispatch(job: DispatchJob, evidenceKey: string | null): boolean {
  if (job.orderKey === null) return true
  return evidenceKey !== null && evidenceKey > job.orderKey
}

/**
 * Whether every job can be given its own distinct resolver (maximum bipartite matching by augmenting paths —
 * optimal for any eligibility shape, and the sets here hold a handful of items).
 */
function everyJobResolved(jobs: readonly DispatchJob[], resolverKeys: readonly (string | null)[]): boolean {
  const owner = Array.from({length: resolverKeys.length}, () => -1)
  function assign(jobIndex: number, visited: Set<number>): boolean {
    const job = jobs[jobIndex]
    if (job === undefined) return false
    for (const [resolverIndex, key] of resolverKeys.entries()) {
      if (visited.has(resolverIndex) || !followsDispatch(job, key)) continue
      visited.add(resolverIndex)
      const current = owner[resolverIndex] ?? -1
      if (current === -1 || assign(current, visited)) {
        owner[resolverIndex] = jobIndex
        return true
      }
    }
    return false
  }
  return jobs.every((_job, index) => assign(index, new Set<number>()))
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
    isReplyDelivered,
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
  const streamNoticeMessageIds = new Set<string>()
  // The fence is per DISPATCH (one upstream background job), not per child session: a reused session injects one
  // notice per job. See `lacksEvidence` for the exact coverage rule.
  const noticesByChild = new Map<string, Map<string, ChildNotice>>()
  const dispatchesByChild = new Map<string, ChildDispatches>()
  // Aborted segments REST last showed inside each child's window (this run's dispatches only).
  const abortedByChild = new Map<string, readonly AbortedSegment[]>()

  function recordNotice(childSessionId: string, key: string, notice: ChildNotice): void {
    const notices = noticesByChild.get(childSessionId) ?? new Map<string, ChildNotice>()
    // The stream's copy of a notice wins over its REST copy: same message, and the stream needs no clock.
    if (notices.get(key)?.live !== true) notices.set(key, notice)
    noticesByChild.set(childSessionId, notices)
  }

  /** Whether a message created at `createdAt` belongs to this run's dispatches of `childSessionId`. */
  function inWindow(childSessionId: string, createdAt: number | null): boolean {
    const windowStart = dispatchesByChild.get(childSessionId)?.windowStart ?? null
    if (windowStart === null) return true
    // A known window and an unplaceable message: no evidence, never covered.
    return createdAt !== null && createdAt >= windowStart
  }

  /**
   * Whether `childSessionId` still lacks evidence for one of its dispatches (upstream jobs). Evidence is
   * correlated to JOBS, never pooled per child:
   *
   * - **Ordering.** Every job's dispatching tool part belongs to an assistant message created before the job
   *   runs; its child segments and its notice are created after it (`MessageID.ascending()` is creation order
   *   within the server: `id/id.ts:51-70`; assistant message `session/prompt.ts:1187`; child prompt
   *   `tool/task.ts:203`; notice `tool/task.ts:231-252` → `session/prompt.ts:657`). A notice or an aborted
   *   segment can credit a job only if its message id is greater than the job's dispatch message id. Evidence
   *   ordered before every job (the original job of a first-seen extension, an earlier run's notice) is
   *   surplus and credits nothing. This needs no clock and works on the stream as well as REST, and a notice
   *   observed before its own dispatch's tool-completion event is still ordered after it.
   * - **Matching.** Each job needs its own distinct resolver (a notice or an aborted segment that follows its
   *   dispatch): a maximum bipartite matching must cover every job.
   * - **Overlap.** A dispatch can show both signals: aborting a child ends its segment `MessageAbortedError` AND
   *   fails the job, which injects an `error` notice (`tool/task.ts:213-218`, `:256-264`). Notices carry no job
   *   id, so the two cannot be tied to one job, and a matching alone could spend them on two jobs. The
   *   aggregate bound stays as a second, necessary condition over the eligible evidence: with D jobs, N
   *   eligible notices (E `error`) and A eligible aborted segments (capped at D), at most min(A, E) notices can
   *   belong to aborted segments (a `completed` notice never does), so `N - min(A, E) >= D - A`.
   * - A job with no orderable dispatch id is credited by any evidence, and for such jobs the bound alone decides
   *   (the matching reduces to N + A >= D, which the bound implies).
   * - A child that was EXTENDED holds user prompts that belong to no job, so its aborted segments cannot be
   *   attributed: it earns no cancel credit and waits for notices alone.
   * Notices read back from REST must also lie inside the child's time window (an earlier run's parent turns).
   */
  function lacksEvidence(childSessionId: string): boolean {
    const dispatches = dispatchesByChild.get(childSessionId)
    // A tracked child the gate never saw dispatched (restored ownership) owes one notice that any evidence covers.
    const jobs = dispatches?.jobs ?? [{orderKey: null}]
    if (jobs.length === 0) return false
    const notices = [...(noticesByChild.get(childSessionId)?.values() ?? [])].filter(
      notice => notice.live || inWindow(childSessionId, notice.createdAt),
    )
    const eligibleNotices = notices.filter(notice => jobs.some(job => followsDispatch(job, notice.orderKey)))
    const eligibleAborted =
      dispatches?.extended === true
        ? []
        : (abortedByChild.get(childSessionId) ?? []).filter(segment =>
            jobs.some(job => followsDispatch(job, segment.orderKey)),
          )
    const errored = eligibleNotices.filter(notice => notice.state === 'error').length
    const aborted = Math.min(eligibleAborted.length, jobs.length)
    if (eligibleNotices.length - Math.min(aborted, errored) < jobs.length - aborted) return true
    return !everyJobResolved(jobs, [
      ...eligibleNotices.map(notice => notice.orderKey),
      ...eligibleAborted.map(segment => segment.orderKey),
    ])
  }

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
    if (messageId !== null) streamNoticeMessageIds.add(messageId)
    // Register the injected turn as pending first: nothing can test completion between these statements.
    if (messageId === null) invalidate()
    else if (seenUserMessageIds.has(messageId)) invalidate()
    else registerUserMessage(messageId)
    recordNotice(notice.childSessionId, key, {
      state: notice.state,
      orderKey: messageOrderKey(messageId),
      live: true,
      createdAt: null,
    })
    requestValidation()
  }

  function noteDispatch(
    childSessionId: string,
    kind: DispatchKind,
    startedAt: number | null,
    dispatchMessageId: string | null,
  ): void {
    if (closed) return
    const previous = dispatchesByChild.get(childSessionId)
    // An entry the gate never saw dispatched (restored ownership) still owes the one notice it was adopted for.
    // A child first seen through an extension owes none: its job started outside this run.
    const firstSight = kind === 'adopted' || kind === 'adopted-extension'
    const base: ChildDispatches = previous ?? {
      jobs: firstSight ? [] : [{orderKey: null}],
      windowStart: null,
      extended: false,
    }
    const windowStart =
      startedAt === null
        ? base.windowStart
        : base.windowStart === null
          ? startedAt
          : Math.min(base.windowStart, startedAt)
    // An extension is not a job (no notice of its own) but adds a user prompt to the child.
    if (kind === 'extension' || kind === 'adopted-extension') {
      dispatchesByChild.set(childSessionId, {...base, windowStart, extended: true})
      return
    }
    dispatchesByChild.set(childSessionId, {
      ...base,
      jobs: [...base.jobs, {orderKey: messageOrderKey(dispatchMessageId)}],
      windowStart,
    })
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
      .filter(lacksEvidence)

    const [live, rootFacts, childFacts] = await Promise.all([
      rootIsLive(),
      readSessionMessages(rootSessionId),
      Promise.all(unconfirmed.map(async id => ({id, facts: await readSessionMessages(id)}))),
    ])
    if (closed || signal.aborted) return

    // A persisted notice the stream never delivered still counts toward the fence. It is cached with its creation
    // time and order key, and judged against the child's CURRENT window and jobs each time (`lacksEvidence`), so a
    // later dispatch moves the window past notices that were cached earlier.
    if (rootFacts !== null) {
      for (const notice of rootFacts.notices) {
        recordNotice(notice.childSessionId, notice.key, {
          state: notice.state,
          orderKey: messageOrderKey(notice.messageId),
          live: false,
          createdAt: notice.createdAt,
        })
      }
    }
    // Cancel evidence: positive REST evidence only, and only segments that started within this run's window — a
    // reused child's history can hold aborted segments from long before this run. Missing or failed evidence is
    // NOT evidence. Replaced, not accumulated: the latest successful read is the truth.
    for (const {id, facts} of childFacts) {
      if (facts === null || !lacksEvidence(id)) continue
      abortedByChild.set(
        id,
        facts.segments
          .filter(segment => segment.aborted && inWindow(id, segment.startedAt))
          .map(segment => ({orderKey: messageOrderKey(segment.messageId)})),
      )
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
      .filter(lacksEvidence)
    if (unfenced.length > 0) return reject('notice-not-observed', {children: unfenced})

    // Delivery fence: the reply the user will read must already be in the sink. Ids only in the log, never text.
    if (isReplyDelivered !== undefined) {
      const replyParts = followUpReplyText(rootFacts, latestUserId, streamNoticeMessageIds)
      if (!isReplyDelivered(replyParts))
        return reject('reply-text-not-delivered', {partIds: replyParts.map(part => part.id)})
    }

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

  return {
    noteRootActivity,
    noteRootUserMessage,
    noteNotice,
    noteDispatch,
    noteRootIdle,
    beginDrain,
    requestValidation,
    dispose,
  }
}
