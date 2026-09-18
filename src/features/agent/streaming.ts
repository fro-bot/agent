import type {ClassificationPath, ErrorInfo, OwnershipLedger} from '@fro-bot/runtime'
import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {TokenUsage} from '../../shared/types.js'
import type {ExecutionDeadline} from './retry.js'
import {
  classifyContextOverflowError,
  classifyProviderAuthError,
  classifyQuotaError,
  createAgentError,
  createErrorInfo,
  createLLMFetchError,
  createRetryableApiError,
  isLlmFetchError,
} from '@fro-bot/runtime'
import {extractCommitShas, extractGithubUrls} from '../../services/github/urls.js'
import {outputTextContent, outputToolExecution} from '../../shared/console.js'

export interface EventStreamResult {
  readonly tokens: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly prsCreated: string[]
  readonly commitsCreated: string[]
  readonly commentsPostedUrls?: string[]
  readonly commentsPosted: number
  readonly llmError: ErrorInfo | null
  readonly classificationPath?: ClassificationPath
  /**
   * Set only when the event stream loop exited via an unexpected discontinuity -- not an
   * intentional local shutdown (caller abort, deadline expiry) and not a terminal signal
   * (session.idle, completed assistant message). A stream break is an observation-channel
   * failure, never evidence the turn ended: this field says the channel closed early, and
   * nothing more. Ledger reconciliation and polling continue independently of it.
   */
  readonly discontinuity?: {readonly message: string}
}

/** Mutable by design — updated in-place during stream processing. */
export interface ActivityTracker {
  firstMeaningfulEventReceived: boolean
  /** Set only by truly terminal signals: session.idle event or completed assistant message. */
  currentTurnTerminalSignalReceived: boolean
  currentTurnArmed?: boolean
  baselineMessageIds?: ReadonlySet<string>
  /**
   * Provisional, generation-scoped memory for the poll path's two-observation confirmation of a
   * completed assistant message -- recording this is a provisional observation, NOT an
   * authority-granting transition (see the invariant on `RootFreshnessTracker` below). It may only
   * tighten a completion guard (require a second matching observation before a candidate is even
   * returned to the caller) or carry evidence forward for a later, fully qualified admission to
   * consume; recording or matching it must never itself release `pendingParentMessageId` or
   * `restConfirmationRequired`, and must never authorize completion on its own.
   *
   * Keyed by (message id, revision), not by message id alone: confirmation belongs to a specific
   * generation. A stored id that matches but whose stored revision no longer matches the current
   * generation does not confirm -- it restarts the two-observation count for the new generation,
   * exactly as a different id would. This also makes every inter-poll or outer-admission rejection
   * that discards a candidate responsible for clearing this memory (not just the request-revision
   * check inside the observation itself) so a later admission can never bridge across a rejected
   * observation using memory left over from before it.
   */
  completedAssistantMessageId?: {readonly messageId: string; readonly revision: number | null}
  sessionIdle: boolean
  sessionError: string | null
  /** Set when a terminal provider ErrorInfo has been classified; first terminal signal wins. */
  terminalProviderError?: ErrorInfo
  /**
   * Structured form of the first generic (non-terminal) failure observed; retrievable
   * immediately, without waiting for the turn to conclude. Cleared if a later terminal
   * provider failure arrives -- `terminalProviderError` becomes authoritative at that point
   * (see `getObservedFailure`) and the generic record is dropped rather than left reachable.
   * A second generic failure never displaces this one while it stands.
   */
  genericError?: ErrorInfo
  /** Classification path for whichever failure (terminal or generic) is currently recorded. */
  classificationPath?: ClassificationPath
  /**
   * Root-freshness protocol state (Phase A). Optional so every existing caller that constructs an
   * `ActivityTracker` literal directly (tests, characterization fixtures) keeps its exact prior
   * behavior -- the sticky `sessionIdle`/`currentTurnTerminalSignalReceived` fields above remain
   * meaningful on their own when this is absent. When present, consumers additionally require
   * `hasFreshIdleCandidate()` before treating those sticky fields as current. See the tracker's own
   * doc comment for the model.
   */
  rootFreshness?: RootFreshnessTracker
}

/**
 * Whether idle/completion evidence recorded for the ROOT session is still current:
 *
 * - `unarmed` — before prompt submission; nothing has happened yet.
 * - `awaiting-activity` — armed, no root activity or idle evidence observed yet for this generation.
 * - `active` — root work is underway, or a new root user message was seen; any prior idle
 *   candidate is invalid.
 * - `idle-candidate` — the root reported idle for the CURRENT generation; still subject to the
 *   pending-parent-turn barrier and the caller's own ownership-ledger gate.
 *
 * A "generation" is an observation boundary (advanced only by `invalidateRootFreshness`), not one
 * model step -- polling the same stored message again must not itself advance it.
 */
export type RootFreshnessState = 'unarmed' | 'awaiting-activity' | 'active' | 'idle-candidate'

/**
 * Small tracker record for the root freshness protocol -- deliberately not a lifecycle framework
 * or event bus. `revision` is a monotonic counter bumped every time renewed root activity is
 * observed; any idle/completion evidence stamped with an older revision is stale by construction
 * and must be re-derived. `pendingParentMessageId` is a barrier: set when a new root user message
 * (including an injected background-task completion turn) is observed and not yet cleared until
 * that message's own terminal assistant reply is seen -- while set, no completion may be admitted.
 * `restConfirmationRequired` is set on an observation-channel discontinuity: a broken SSE stream
 * cannot itself prove freshness, so retained idle evidence needs a REST revalidation before a
 * consumer may rely on it again.
 *
 * **Governing invariant: generation-bound qualification before authorization.** A provisional
 * observation (e.g. a poll-path candidate that merely matches this tracker's current
 * `pendingParentMessageId`, or a REST response that merely matches its current `revision`) may
 * record generation-scoped evidence, or tighten a completion guard -- it must never itself release
 * a guard (`pendingParentMessageId`, `restConfirmationRequired`) or authorize completion. Any
 * transition that grants authority -- clearing the barrier, clearing the revalidation requirement,
 * writing a terminal signal, constructing a settlement -- must be justified by fully qualified
 * evidence whose generation (`revision`) and parent identity still match this tracker's state AT
 * THE COMMIT POINT, not at the moment the evidence was first observed. Qualification inspects the
 * pre-transition state; it must never mutate that state merely to make its own predicate pass --
 * that is exactly the circularity this tracker exists to prevent (a check that clears the barrier
 * it is itself supposed to be gated by). Two corollaries fall out of this: confirmation memory
 * belongs to a (message id, revision) pair, never to the message id alone (see
 * `ActivityTracker.completedAssistantMessageId`'s doc comment for the provisional-memory
 * exception this permits); and a REST response corroborates the SPECIFIC current completion
 * evidence it was requested against -- it never grants blanket permission to trust an arbitrary
 * future idle event for this generation.
 */
export interface RootFreshnessTracker {
  state: RootFreshnessState
  revision: number
  /** Most recent root user message id observed (including an injected task-completion turn). */
  latestRootUserMessageId: string | null
  /** The generation an idle candidate was stamped with; compared against `revision` at consumption. */
  idleCandidateRevision: number | null
  /** Barrier: a new root user message awaiting its terminal assistant reply. Null when clear. */
  pendingParentMessageId: string | null
  /** Set on SSE discontinuity; cleared once a REST check corroborates current state. */
  restConfirmationRequired: boolean
}

export function createRootFreshnessTracker(): RootFreshnessTracker {
  return {
    state: 'unarmed',
    revision: 0,
    latestRootUserMessageId: null,
    idleCandidateRevision: null,
    pendingParentMessageId: null,
    restConfirmationRequired: false,
  }
}

/** Arm before submission, per the transition list in the module doc -- starts with no completion evidence. */
export function armRootFreshness(tracker: RootFreshnessTracker): void {
  tracker.state = 'awaiting-activity'
  tracker.idleCandidateRevision = null
}

/**
 * Invalidate on renewed root activity: root status busy/retry, a new root user message, root
 * assistant creation/progress/text-deltas/tool-activity, or a newly discovered later root message
 * via REST. Clears idle eligibility and advances the revision so any evidence stamped with the
 * prior revision is stale. Never called for descendant activity -- callers must gate on
 * `eventSessionID === sessionId` (root-only) before calling this; descendant activity must never
 * change root lifecycle state.
 *
 * Also raises `restConfirmationRequired` when this bump supersedes an existing idle candidate:
 * SSE carries no sequence number or timestamp, so once the root has already reported idle once, a
 * bump followed by another idle event cannot be distinguished from a stale/delayed idle for the
 * SUPERSEDED generation arriving late -- `markRootIdleCandidate` would re-stamp either one as
 * belonging to the new revision. Requiring a REST/status corroboration before the next idle
 * candidate is trusted closes that gap. Scoped to this case (not every bump) because a plain
 * single-generation turn -- arm, activity, one terminal idle -- never has a prior idle candidate to
 * race against; only a second root user turn (e.g. an injected background-task-completion turn, or
 * any other renewed activity after the root already went idle once) can replay this ambiguity.
 * Cleared by `clearRootRevalidationRequirement` once a REST check proves the current generation --
 * so this costs at most one extra corroboration per superseded generation, not one per idle event.
 */
export function invalidateRootFreshness(tracker: RootFreshnessTracker, newRootUserMessageId?: string): void {
  if (tracker.state === 'unarmed') return
  const supersededIdleCandidate = tracker.state === 'idle-candidate'
  tracker.state = 'active'
  tracker.idleCandidateRevision = null
  tracker.revision += 1
  if (supersededIdleCandidate) tracker.restConfirmationRequired = true
  if (newRootUserMessageId != null) tracker.latestRootUserMessageId = newRootUserMessageId
}

/** Root idle creates an idle candidate for the CURRENT generation -- not permanent permission. */
export function markRootIdleCandidate(tracker: RootFreshnessTracker): void {
  if (tracker.state === 'unarmed') return
  tracker.state = 'idle-candidate'
  tracker.idleCandidateRevision = tracker.revision
}

/**
 * True only when the tracker holds idle evidence for the CURRENT generation, with no unresolved
 * newer parent turn and no unresolved SSE discontinuity requiring REST revalidation. Consumers
 * combine this with their own ownership-ledger drain check -- this function knows nothing about
 * ownership.
 */
export function hasFreshIdleCandidate(tracker: RootFreshnessTracker): boolean {
  return (
    tracker.state === 'idle-candidate' &&
    tracker.idleCandidateRevision === tracker.revision &&
    tracker.pendingParentMessageId == null &&
    !tracker.restConfirmationRequired
  )
}

/**
 * Register a new root user message as pending (awaiting its own terminal assistant reply) and
 * invalidate any current idle evidence. Correlates by message id: calling this again for the same
 * still-pending id is a no-op, so duplicate/retried events for the same injected turn do not
 * create a second phantom pending turn or spuriously re-advance the revision.
 */
export function registerPendingRootUserMessage(tracker: RootFreshnessTracker, messageId: string | null): void {
  if (messageId != null && tracker.pendingParentMessageId === messageId) return
  invalidateRootFreshness(tracker, messageId ?? undefined)
  if (messageId != null) tracker.pendingParentMessageId = messageId
}

/**
 * Clear the pending-parent-turn barrier once that message's own terminal assistant reply is
 * observed. Narrow contract, per the invariant on `RootFreshnessTracker` above: callers must only
 * invoke this at a commit point where `answeredParentId` is already fully qualified evidence (the
 * SSE-observed reply itself, or a poll candidate already admitted at final completion admission)
 * -- never merely because a provisional candidate's parent *matches* the pending id. Matching
 * qualifies a candidate for admission; it does not by itself authorize this call. Safe to call
 * speculatively in the sense that it is a no-op unless `answeredParentId` equals the tracker's
 * CURRENT `pendingParentMessageId` -- but callers must not rely on that no-op behavior as a
 * substitute for checking eligibility themselves before treating a candidate as satisfying the
 * barrier.
 */
export function resolvePendingRootUserMessage(tracker: RootFreshnessTracker, answeredParentId: string | null): void {
  if (answeredParentId != null && tracker.pendingParentMessageId === answeredParentId) {
    tracker.pendingParentMessageId = null
  }
}

/** Observation-channel failure cannot preserve authoritative freshness -- require REST revalidation. */
export function requireRootRevalidation(tracker: RootFreshnessTracker): void {
  tracker.restConfirmationRequired = true
}

/**
 * Clears the REST-revalidation requirement once a REST check has corroborated current state.
 * Narrow contract, per the invariant on `RootFreshnessTracker` above: this must only be called at
 * a commit point where the REST response has corroborated SPECIFIC current completion evidence
 * (an admitted message candidate, or a retained current-revision idle candidate with no pending
 * parent) -- never merely because the response's requested revision matched the tracker's
 * revision. A revision match alone proves the response describes the current generation; it says
 * nothing about whether that generation actually produced qualifying evidence, so it must not by
 * itself clear this requirement.
 */
export function clearRootRevalidationRequirement(tracker: RootFreshnessTracker): void {
  tracker.restConfirmationRequired = false
}

/** Shared provider-terminal classification for `session.status`/`retry`, used by both SSE and REST poll paths. */
export function classifyRetryStatusError(status: unknown): ErrorInfo | null {
  if (getStringProperty(status, 'type') !== 'retry') return null

  const action = getObjectProperty(status, 'action')
  const reason = getStringProperty(action, 'reason')
  if (reason == null) return null

  const nextRaw = getNumberProperty(status, 'next')
  const candidateResetAt = nextRaw != null && Number.isFinite(nextRaw) ? new Date(nextRaw) : undefined
  const resetAt = candidateResetAt != null && !Number.isNaN(candidateResetAt.getTime()) ? candidateResetAt : undefined

  return (
    classifyProviderAuthError({kind: 'retry-status', reason}) ??
    classifyQuotaError({kind: 'retry-status', reason, resetAt})
  )
}

function isTerminalProviderError(error: ErrorInfo): boolean {
  return error.type === 'context_overflow' || error.type === 'quota_exceeded' || error.type === 'provider_auth_error'
}

/** True when a thrown stream error reflects a shutdown we asked for, not one the transport handed us. */
function isIntentionalShutdown(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

/** Merge generic and terminal observations while freezing the first terminal provider signal. */
export function mergeActivityError(
  existing: ErrorInfo | null,
  candidate: ErrorInfo,
  activityTracker?: ActivityTracker,
  genericSessionError?: string,
  classificationPath?: ClassificationPath,
): ErrorInfo {
  const existingTerminal = activityTracker?.terminalProviderError
  if (existingTerminal != null) return existingTerminal

  const candidateIsTerminal = isTerminalProviderError(candidate)
  const existingIsTerminal = existing != null && isTerminalProviderError(existing)
  let merged = existing ?? candidate
  if (existingIsTerminal) merged = existing
  else if (candidateIsTerminal) merged = candidate

  if (activityTracker != null && isTerminalProviderError(merged)) {
    activityTracker.terminalProviderError = merged
    activityTracker.sessionError = merged.message
    if (classificationPath != null) activityTracker.classificationPath = classificationPath
    // A terminal signal is authoritative from here on -- clear any earlier generic record
    // rather than leaving its (possibly sensitive) content reachable off the tracker.
    activityTracker.genericError = undefined
    return merged
  }

  if (activityTracker != null && activityTracker.sessionError == null && genericSessionError != null) {
    activityTracker.sessionError = genericSessionError
    // `merged === candidate` is guaranteed here: `existing` can only be non-null once
    // `sessionError` has already been set by a prior call (both are written together below
    // and by the terminal branch above), so `sessionError == null` implies `existing == null`.
    activityTracker.genericError = merged
    if (classificationPath != null) activityTracker.classificationPath = classificationPath
  }

  return merged
}

/**
 * Single point of retrieval for whichever failure is currently recorded on the tracker, in
 * precedence order: a terminal provider failure always wins once observed (it upgrades any
 * earlier generic failure), otherwise the first generic failure. Returns null if nothing has
 * been observed yet. Callers should use this instead of reading `terminalProviderError` /
 * `genericError` directly and re-deriving the precedence themselves.
 */
export function getObservedFailure(
  activityTracker: ActivityTracker,
): {readonly error: ErrorInfo; readonly classificationPath: ClassificationPath | undefined} | null {
  const error = activityTracker.terminalProviderError ?? activityTracker.genericError
  if (error == null) return null
  return {error, classificationPath: activityTracker.classificationPath}
}

export function logServerEvent(event: Event, logger: Logger): void {
  const eventType = getStringProperty(event, 'type')
  if (eventType === 'sync') {
    const name = getStringProperty(event, 'name')
    const kind = name?.replace(/\.\d+$/, '') ?? 'sync'
    const data = getObjectProperty(event, 'data')
    const sessionID = getSessionID(data)
    logger.debug('Server event', {eventKind: kind, sessionID})
  } else {
    // Bounded log: never dump raw event properties (may carry provider message/URL/account metadata).
    const properties = getObjectProperty(event, 'properties')
    const sessionId = getSessionID(properties) ?? getSessionID(getObjectProperty(properties, 'part'))
    logger.debug('Server event', sessionId == null ? {eventType} : {eventType, sessionId})
  }
}

/**
 * Scans a bash command + its output for artifacts the model created directly
 * via `gh`/`git` (PR URLs, commit SHAs, posted-comment URLs).
 *
 * The comment-URL branch only fires when the model itself ran `gh issue
 * comment`/`gh pr comment` — true for autonomous flows (`workflow_dispatch`,
 * `schedule`) that keep the GitHub credential and self-post. For flows that
 * post through the action-owned response-file convention, the model never
 * runs those `gh` commands (the credential is withheld and the prompt tells
 * it to write a file instead), so this branch simply never matches and
 * `commentsPosted` for those runs stays at 0 here; the count is sourced
 * separately from the finalize post (`runFinalize` calls
 * `metrics.incrementComments()` after the response is delivered). The two
 * sources are mutually exclusive per run, so there is no double-count.
 */
export function detectArtifacts(
  command: string,
  output: string,
  prsCreated: string[],
  commitsCreated: string[],
  onCommentPosted: () => void,
  commentsPostedUrls?: string[],
): void {
  const urls = extractGithubUrls(output)
  if (command.includes('gh pr create')) {
    const prUrls = urls.filter(u => u.includes('/pull/') && !u.includes('#'))
    for (const url of prUrls) {
      if (!prsCreated.includes(url)) prsCreated.push(url)
    }
  }

  if (command.includes('git commit')) {
    const shas = extractCommitShas(output)
    for (const sha of shas) {
      if (!commitsCreated.includes(sha)) commitsCreated.push(sha)
    }
  }

  if (command.includes('gh issue comment') || command.includes('gh pr comment')) {
    const commentUrls = urls.filter(url => url.includes('#issuecomment'))
    for (const url of commentUrls) {
      if (commentsPostedUrls == null || !commentsPostedUrls.includes(url)) {
        commentsPostedUrls?.push(url)
        onCommentPosted()
      }
    }
  }
}

function getSessionID(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null

  const descriptor = Object.getOwnPropertyDescriptor(value, 'sessionID')
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getStringProperty(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null

  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getNumberProperty(value: unknown, property: string): number | null {
  if (value == null || typeof value !== 'object') return null

  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'number' ? descriptor.value : null
}

function getBooleanProperty(value: unknown, property: string): boolean | null {
  if (value == null || typeof value !== 'object') return null

  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'boolean' ? descriptor.value : null
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null

  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}

/**
 * Sums each owned session's latest-reported token totals into the run's overall cost.
 * Per-session latest-wins (see `tokensBySession` in `processEventStream`) plus a sum
 * across sessions gives the true run cost without a single session's report clobbering
 * another's. An empty map (no ledger, or no message.updated seen yet) yields `null`,
 * matching the pre-fix behavior of an untouched `tokens` variable.
 */
function sumOwnedSessionTokens(tokensBySession: ReadonlyMap<string, TokenUsage>): TokenUsage | null {
  if (tokensBySession.size === 0) return null

  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const sessionTokens of tokensBySession.values()) {
    input += sessionTokens.input
    output += sessionTokens.output
    reasoning += sessionTokens.reasoning
    cacheRead += sessionTokens.cache.read
    cacheWrite += sessionTokens.cache.write
  }

  return {input, output, reasoning, cache: {read: cacheRead, write: cacheWrite}}
}

const SESSION_ERROR_FIELD_MAX_LENGTH = 256
const GENERIC_SESSION_ERROR = 'Unknown session error'

function getBoundedStringProperty(value: unknown, property: string): string | null {
  const propertyValue = getStringProperty(value, property)
  if (propertyValue == null || propertyValue.length === 0) return null

  const normalized = propertyValue.replaceAll(/[\r\n]+/g, '; ').trim()
  if (normalized.length === 0) return null
  if (normalized.length <= SESSION_ERROR_FIELD_MAX_LENGTH) return normalized

  return `${normalized.slice(0, SESSION_ERROR_FIELD_MAX_LENGTH - 3)}...`
}

function getSessionErrorField(primary: unknown, fallback: unknown, property: string): string | null {
  return getBoundedStringProperty(primary, property) ?? getBoundedStringProperty(fallback, property)
}

/**
 * Normalize an SDK session error without coercing or retaining its raw payload. Exported so
 * `session-poll.ts`'s assistant-message error classifier (Phase B) can format a bounded,
 * safe-to-log diagnostic the same way the SSE `session.error` branch below does, instead of
 * reimplementing the bounding/truncation policy.
 */
export function normalizeSessionError(sessionError: unknown): string {
  if (typeof sessionError === 'string') return sessionError
  if (sessionError == null || typeof sessionError !== 'object') return GENERIC_SESSION_ERROR

  const errorData = getObjectProperty(sessionError, 'data')
  const provider = getSessionErrorField(sessionError, errorData, 'provider')
  const name = getSessionErrorField(sessionError, errorData, 'name')
  const code = getSessionErrorField(sessionError, errorData, 'code')
  const status =
    getNumberProperty(sessionError, 'status') ??
    getNumberProperty(sessionError, 'statusCode') ??
    getNumberProperty(errorData, 'status') ??
    getNumberProperty(errorData, 'statusCode')
  const fields: string[] = []

  if (provider != null) fields.push(`provider=${provider}`)
  if (name != null) fields.push(`name=${name}`)
  if (status != null && Number.isFinite(status)) fields.push(`status=${status}`)
  if (code != null) fields.push(`code=${code}`)

  return fields.length > 0 ? fields.join('; ') : GENERIC_SESSION_ERROR
}

function getEventSessionID(event: Event): string | null {
  return getSessionID(getObjectProperty(event, 'properties')) ?? getSessionID(getObjectProperty(event, 'data'))
}

function getEventKind(event: Event): string | null {
  const eventType = getStringProperty(event, 'type')
  if (eventType !== 'sync') return eventType

  return getStringProperty(event, 'name')?.replace(/\.\d+$/, '') ?? eventType
}

function getEventPayload(event: Event): unknown {
  return getObjectProperty(event, 'properties') ?? getObjectProperty(event, 'data')
}

function isStreamActivityEvent(eventType: string | null): boolean {
  return eventType === 'message.part.delta' || eventType?.startsWith('session.next.') === true
}

/**
 * Ownership check: true for the root session, or for a descendant session
 * this run's ledger has adopted (in any state — outstanding, unknown, or
 * settled; a trailing event from an already-settled descendant is still
 * attributable to this run, it just arrived late). False for a null session
 * id and false for any session this run does not own — including a session
 * belonging to a different run's tree. `ledger` absent means single-session
 * behavior: only the root session is owned, matching every existing run
 * exactly (backward-compatible no-op).
 *
 * A user-defined type guard so callers narrow `eventSessionID` to `string`
 * after `if (!isOwnedSession(...)) continue`.
 */
function isOwnedSession(
  eventSessionID: string | null,
  sessionId: string,
  ledger?: OwnershipLedger,
): eventSessionID is string {
  if (eventSessionID === null) return false
  if (eventSessionID === sessionId) return true
  if (ledger === undefined) return false
  return ledger.isTracked(eventSessionID)
}

/** A parsed `<task id="..." state="completed|error">` marker from an injected background-task completion turn. */
interface InjectedTaskCompletion {
  readonly childSessionId: string
  readonly state: 'completed' | 'error'
}

/**
 * Upstream's `task` tool injects a synthetic text prompt into the PARENT
 * session when a background dispatch finishes (see `tool/task.ts`'s
 * `inject()` / `renderOutput()`), rendered as
 * `<task id="{childSessionId}" state="completed|error">...`. This is the
 * only observable signal on the wire that a background execution settled —
 * there is no structured field carrying it. Matches the opening tag only;
 * the running state is never injected this way (only completed/error are).
 */
const INJECTED_TASK_COMPLETION_PATTERN = /<task id="([^"]+)" state="(completed|error)">/

function parseInjectedTaskCompletion(text: string): InjectedTaskCompletion | null {
  const match = INJECTED_TASK_COMPLETION_PATTERN.exec(text)
  if (match == null) return null

  const childSessionId = match[1]
  const state = match[2]
  if (childSessionId == null || (state !== 'completed' && state !== 'error')) return null

  return {childSessionId, state}
}

interface ToolCallInfo {
  readonly tool: string
  readonly input: unknown
}

export interface PermissionAskedRequest {
  readonly requestID: string
  readonly sessionID: string
  readonly permission: string
  readonly patterns: readonly string[]
}

export type PermissionAskedResponder = (request: PermissionAskedRequest) => Promise<void>

export async function processEventStream(
  stream: AsyncIterable<Event>,
  sessionId: string,
  signal: AbortSignal,
  logger: Logger,
  activityTracker?: ActivityTracker,
  deadline?: ExecutionDeadline,
  onPermissionAsked?: PermissionAskedResponder,
  ownershipLedger?: OwnershipLedger,
): Promise<EventStreamResult> {
  let lastText = ''
  // Per-session latest-reported totals. OpenCode reports cumulative totals per
  // message (see message.tokens in the upstream session store, and
  // ctx.assistantMessage.tokens = usage.tokens in processor.ts) rather than
  // deltas, so the latest report for a given session is that session's running
  // total — taking the latest per session and summing across owned sessions
  // gives the run's true cost. A root-only run (the only case before ownership
  // widening) has exactly one key here, so the sum equals what plain
  // assignment always produced.
  const tokensBySession = new Map<string, TokenUsage>()
  let model: string | null = null
  let cost: number | null = null
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  const commentsPostedUrls: string[] = []
  let commentsPosted = 0
  let llmError: ErrorInfo | null = null
  let classificationPath: ClassificationPath | undefined
  // V2 sync tool lifecycle: correlate called→success by callID
  const pendingToolCalls = new Map<string, ToolCallInfo>()

  // Isolated in its own function so a discontinuity (thrown error mid-stream) can be
  // caught around the whole loop without reindenting every branch inside it — the
  // catch below marks outstanding owned entries unknown before rethrowing.
  async function consumeStream(): Promise<void> {
    for await (const event of stream) {
      if (signal.aborted) break
      logServerEvent(event, logger)
      const eventType = getEventKind(event)
      const eventPayload = getEventPayload(event)

      if (eventType === 'permission.asked') {
        const eventSessionID = getEventSessionID(event)
        if (!isOwnedSession(eventSessionID, sessionId, ownershipLedger)) continue

        const requestID = getStringProperty(eventPayload, 'id')
        const permission = getStringProperty(eventPayload, 'permission') ?? 'unknown'
        const rawPatterns = getObjectProperty(eventPayload, 'patterns')
        const patterns: string[] = Array.isArray(rawPatterns)
          ? rawPatterns.filter((pattern): pattern is string => typeof pattern === 'string')
          : []
        const context = {sessionId, eventSessionID, permission, patterns}

        if (requestID == null) {
          logger.warning('OpenCode permission request missing request id', context)
          continue
        }

        // A descendant's request is denied exactly like the root's — there is no
        // human approval path on this surface, and widening ownership only means
        // the denial now also covers owned descendants. `sessionID` must be the
        // event's own session id (not the root's) so the reply targets the
        // session that actually asked.
        const request: PermissionAskedRequest = {
          requestID,
          sessionID: eventSessionID,
          permission,
          patterns,
        }
        if (onPermissionAsked === undefined) {
          logger.warning('OpenCode permission request observed but no responder is configured', context)
        } else {
          logger.warning('Rejecting OpenCode permission request', context)
          try {
            await onPermissionAsked(request)
          } catch (error) {
            logger.warning('Failed to reject OpenCode permission request', {
              ...context,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        continue
      }

      // Permission handling must run before this guard; an ask on an unarmed turn would otherwise be skipped and hang.
      if (activityTracker?.currentTurnArmed === false) continue

      if (activityTracker != null && isStreamActivityEvent(eventType)) {
        const eventSessionID = getEventSessionID(event)
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger)) {
          activityTracker.firstMeaningfulEventReceived = true
          // Root-only: descendant activity never changes root lifecycle state.
          if (eventSessionID === sessionId && activityTracker.rootFreshness != null) {
            invalidateRootFreshness(activityTracker.rootFreshness)
          }
        }
      }

      if (eventType === 'message.part.delta') {
        // New SDK shape: streaming text delta events accumulate into lastText, flushed on session.idle.
        // delta may be an object {type:'text', text:string} or a plain string when field === 'text'.
        const eventSessionID = getEventSessionID(event)
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger)) {
          if (eventSessionID === sessionId && activityTracker?.rootFreshness != null) {
            invalidateRootFreshness(activityTracker.rootFreshness)
          }
          const delta = getObjectProperty(eventPayload, 'delta')
          const deltaType = getStringProperty(delta, 'type')
          const deltaText = getStringProperty(delta, 'text')
          if (deltaType === 'text' && deltaText != null) {
            lastText += deltaText
          } else if (typeof delta === 'string' && getStringProperty(eventPayload, 'field') === 'text') {
            lastText += delta
          }
        }
      } else if (eventType === 'session.next.text.delta') {
        // Sync/session.next shape: delta is either a plain string or {type:'text', text:string}
        const eventSessionID = getEventSessionID(event)
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger)) {
          if (eventSessionID === sessionId && activityTracker?.rootFreshness != null) {
            invalidateRootFreshness(activityTracker.rootFreshness)
          }
          const deltaRaw = getObjectProperty(eventPayload, 'delta')
          const deltaText = typeof deltaRaw === 'string' ? deltaRaw : (getStringProperty(deltaRaw, 'text') ?? null)
          if (deltaText != null) lastText += deltaText
        }
      } else if (eventType === 'session.next.tool.called') {
        // V2 sync tool lifecycle: cache call info for correlation with success event
        const eventSessionID = getEventSessionID(event)
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger)) {
          if (eventSessionID === sessionId && activityTracker?.rootFreshness != null) {
            invalidateRootFreshness(activityTracker.rootFreshness)
          }
          const callID = getStringProperty(eventPayload, 'callID')
          const tool = getStringProperty(eventPayload, 'tool')
          const input = getObjectProperty(eventPayload, 'input')
          if (callID != null && tool != null) {
            pendingToolCalls.set(callID, {tool, input})
            logger.debug('Tool called', {callID, tool})
          }
        }
      } else if (eventType === 'session.next.tool.success') {
        // V2 sync tool lifecycle: render output and detect artifacts using correlated call info
        const eventSessionID = getEventSessionID(event)
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger)) {
          if (eventSessionID === sessionId && activityTracker?.rootFreshness != null) {
            invalidateRootFreshness(activityTracker.rootFreshness)
          }
          const callID = getStringProperty(eventPayload, 'callID')
          if (callID === null) continue

          const callInfo = pendingToolCalls.get(callID)
          if (callInfo !== undefined) {
            pendingToolCalls.delete(callID)
            const {tool, input} = callInfo
            // Title resolution: structured.title → input.title → bash command → tool name
            const structured = getObjectProperty(eventPayload, 'structured')
            const title =
              getStringProperty(structured, 'title') ??
              getStringProperty(input, 'title') ??
              (tool.toLowerCase() === 'bash'
                ? String(getObjectProperty(input, 'command') ?? getObjectProperty(input, 'cmd') ?? tool)
                : tool)
            outputToolExecution(tool, title)
            if (tool.toLowerCase() === 'bash') {
              const command = String(getObjectProperty(input, 'command') ?? getObjectProperty(input, 'cmd') ?? '')
              // Collect text output from content array for artifact detection
              const contentArr = getObjectProperty(eventPayload, 'content')
              const outputText = Array.isArray(contentArr)
                ? contentArr
                    .map((item: unknown) =>
                      getStringProperty(item, 'type') === 'text' ? (getStringProperty(item, 'text') ?? '') : '',
                    )
                    .join('\n')
                : ''
              detectArtifacts(
                command,
                outputText,
                prsCreated,
                commitsCreated,
                () => {
                  commentsPosted++
                },
                commentsPostedUrls,
              )
            }
          }
        }
      } else if (eventType === 'message.part.updated') {
        const part = getObjectProperty(eventPayload, 'part')
        const eventSessionID = getSessionID(eventPayload) ?? getSessionID(part)
        if (!isOwnedSession(eventSessionID, sessionId, ownershipLedger)) continue
        if (activityTracker != null) activityTracker.firstMeaningfulEventReceived = true
        // Root-only invalidation for general part activity. The injected-completion branch below
        // registers its own (barrier-setting) invalidation instead of this generic one, and must run
        // BEFORE `ownershipLedger.settle()` -- see that branch.
        if (eventSessionID === sessionId && activityTracker?.rootFreshness != null) {
          const partMessageId = getStringProperty(part, 'messageID')
          if (partMessageId == null || partMessageId !== activityTracker.rootFreshness.pendingParentMessageId) {
            invalidateRootFreshness(activityTracker.rootFreshness)
          }
        }

        const partType = getStringProperty(part, 'type')
        if (partType === 'text') {
          const text = getStringProperty(part, 'text')
          if (text != null) lastText = text
          const endTime = getNumberProperty(getObjectProperty(part, 'time'), 'end')
          if (endTime != null) {
            // Root-only, never ownership-widened: this checks whether the ROOT's own
            // text part is the synthetic turn upstream injects into the parent
            // session when a background dispatch finishes (see `tool/task.ts`'s
            // `inject()`). A descendant emitting similar-looking text is not this
            // signal — only the parent session ever receives the injected turn.
            //
            // Upstream persists the injected turn's USER message (via `inject()`'s own
            // `ops.prompt()` call) before the runner ever produces a reply to it -- so this text
            // part is the injected turn's own content arriving. Register it as pending root work
            // (barrier) BEFORE settling the ledger entry: a background completion injects another
            // parent turn, and clearing/ignoring that fact here is exactly the exposure this
            // freshness protocol closes. Correlated by message id so a duplicate/retried event for
            // the same injected turn does not create a second phantom pending turn.
            if (ownershipLedger !== undefined && eventSessionID === sessionId && text != null) {
              const completion = parseInjectedTaskCompletion(text)
              if (completion !== null) {
                if (activityTracker?.rootFreshness != null) {
                  const messageId = getStringProperty(part, 'messageID')
                  registerPendingRootUserMessage(activityTracker.rootFreshness, messageId)
                }
                ownershipLedger.settle(completion.childSessionId)
                logger.info('Background task completion turn observed — settled ownership entry', {
                  sessionId,
                  childSessionId: completion.childSessionId,
                  state: completion.state,
                })
              }
            }
            outputTextContent(lastText)
            lastText = ''
          }
        } else if (partType === 'tool') {
          const toolState = getObjectProperty(part, 'state')
          if (getStringProperty(toolState, 'status') === 'completed') {
            const tool = getStringProperty(part, 'tool') ?? ''

            // Background dispatch observed: a `task` tool call completes
            // immediately once dispatch begins, carrying `metadata.background
            // === true` and `metadata.jobId` (the child session id) — see
            // upstream `tool/task.ts`. Adopt the child into the ledger so its
            // own events route from here on. Mirrors the gateway's detection in
            // `run-core.ts` exactly — same signal, same fields.
            if (ownershipLedger !== undefined && tool === 'task') {
              const stateMetadata = getObjectProperty(toolState, 'metadata')
              const jobId = getStringProperty(stateMetadata, 'jobId')
              const isBackground = getBooleanProperty(stateMetadata, 'background')
              if (jobId !== null && isBackground === true) {
                const label = getStringProperty(toolState, 'title') ?? 'background task'
                ownershipLedger.adopt(jobId, label)
                logger.info('Background dispatch observed — adopted into ownership ledger', {sessionId, jobId, label})
              }
            }

            outputToolExecution(tool, String(getObjectProperty(toolState, 'title') ?? ''))
            if (tool.toLowerCase() === 'bash') {
              const input = getObjectProperty(toolState, 'input')
              const command = String(getObjectProperty(input, 'command') ?? getObjectProperty(input, 'cmd') ?? '')
              const output = String(getObjectProperty(toolState, 'output') ?? '')
              detectArtifacts(
                command,
                output,
                prsCreated,
                commitsCreated,
                () => {
                  commentsPosted++
                },
                commentsPostedUrls,
              )
            }
          }
        }
      } else if (eventType === 'message.updated') {
        const msg = getObjectProperty(eventPayload, 'info')
        const eventSessionID = getSessionID(eventPayload) ?? getSessionID(msg)
        const tokensData = getObjectProperty(msg, 'tokens')
        if (
          isOwnedSession(eventSessionID, sessionId, ownershipLedger) &&
          getStringProperty(msg, 'role') === 'assistant' &&
          tokensData != null
        ) {
          if (activityTracker != null) activityTracker.firstMeaningfulEventReceived = true
          if (eventSessionID === sessionId && activityTracker?.rootFreshness != null) {
            invalidateRootFreshness(activityTracker.rootFreshness)
            // Barrier resolution deliberately does NOT happen here. The SSE handler sees message
            // metadata and token deltas, not the full message-and-parts predicate the poll path
            // qualifies against (`detectMessageActivity` in session-poll.ts) -- a parent-id match on
            // its own is not fully qualified evidence per the invariant on `RootFreshnessTracker`
            // above, and upstream's prompt loop can still require another iteration even once
            // `finish: 'stop'` is visible (tool parts, provider-executed exceptions, etc.). The
            // barrier is REST-resolved only, committed at poll admission
            // (`pollForSessionCompletionObservation` in session-poll.ts) -- an explicit availability
            // tradeoff: a barrier-bearing turn cannot finish from SSE alone when REST is unavailable.
          }
          const sessionTokens: TokenUsage = {
            input: getNumberProperty(tokensData, 'input') ?? 0,
            output: getNumberProperty(tokensData, 'output') ?? 0,
            reasoning: getNumberProperty(tokensData, 'reasoning') ?? 0,
            cache: {
              read: getNumberProperty(getObjectProperty(tokensData, 'cache'), 'read') ?? 0,
              write: getNumberProperty(getObjectProperty(tokensData, 'cache'), 'write') ?? 0,
            },
          }
          // eventSessionID is narrowed to string here: isOwnedSession is a type guard that
          // rejects null ids, so this branch only runs when it resolved to a real session id.
          tokensBySession.set(eventSessionID, sessionTokens)
          model = getStringProperty(msg, 'modelID')
          cost = getNumberProperty(msg, 'cost')
          logger.debug('Token usage received', {tokens: sessionTokens, model, cost})
        }
      } else if (eventType === 'session.status') {
        const statusEventSessionID = getSessionID(eventPayload)
        if (isOwnedSession(statusEventSessionID, sessionId, ownershipLedger)) {
          const status = getObjectProperty(eventPayload, 'status')
          // Root-scoped renewed-activity signal: `busy`/`retry` status invalidates prior idle
          // evidence regardless of whether the status also classifies as a terminal provider
          // error below -- a retry status is still renewed root activity even when it is not (yet)
          // terminal.
          const statusType = getStringProperty(status, 'type')
          if (
            statusEventSessionID === sessionId &&
            (statusType === 'busy' || statusType === 'retry') &&
            activityTracker?.rootFreshness != null
          ) {
            invalidateRootFreshness(activityTracker.rootFreshness)
          }
          const terminalError = classifyRetryStatusError(status)
          if (terminalError != null) {
            // Root-scoped, mirroring `session.error` below for the same reason: a
            // descendant's retry status is real information -- classified above for
            // bounded diagnostics (logged just below), and its ledger entry marked
            // `unknown` -- but must not overwrite the root's own failure accumulator,
            // `llmError`, or lifecycle state. A descendant's completion is the
            // injected-completion and reconciliation path's responsibility, not this
            // branch's; see the `session.error` branch's comment for the full rationale.
            if (statusEventSessionID !== sessionId) {
              logger.error('Session status retry classified as terminal provider error on a descendant session', {
                sessionId,
                type: terminalError.type,
              })
              ownershipLedger?.markUnknown(statusEventSessionID)
              continue
            }

            if (deadline?.isExpired() === true && activityTracker?.terminalProviderError == null) continue
            logger.error('Session status retry classified as terminal provider error', {
              sessionId,
              type: terminalError.type,
            })
            classificationPath = 'structured'
            llmError = mergeActivityError(llmError, terminalError, activityTracker, undefined, classificationPath)
          }
        }
      } else if (eventType === 'session.error') {
        const errorEventSessionID = getSessionID(eventPayload)
        if (isOwnedSession(errorEventSessionID, sessionId, ownershipLedger)) {
          const sessionError = getObjectProperty(eventPayload, 'error')
          // Bounded log: never pass the raw session error payload to the logger.
          logger.error('Session error received', {sessionType: typeof sessionError})

          // Root-scoped, mirroring `session.idle` below for the same reason: a
          // descendant's error is real information (logged above, and its
          // ledger entry is marked `unknown` below) but must not end this
          // run's turn or feed `recoverFromContextOverflow`
          // (`src/harness/phases/execute.ts`, gated on this function's
          // returned `llmError.type === 'context_overflow'`). Without this
          // guard a descendant reporting context_overflow would archive and
          // restart the ROOT session on the descendant's behalf, and any
          // descendant error would end a turn the root session is still
          // actively running — the same premature-termination class idle was
          // kept root-scoped to avoid, through a different event.
          //
          // Chose `markUnknown` over `settle`: an error report is evidence
          // something went wrong, not proof the session stopped writing —
          // the same uncertainty a dropped stream event or a failed
          // reconciliation call leaves (see the discontinuity handler below,
          // and `OwnershipLedger`'s own doc on why `unknown` is never
          // collapsed into `settled`). The one signal this file treats as
          // confirmed-finished for an error outcome is upstream's injected
          // `<task id="..." state="error">` completion marker (handled earlier
          // in this loop, in the `message.part.updated` branch), which calls
          // `settle` unconditionally for both `completed` and `error` states —
          // that is upstream's own authoritative "this execution is done"
          // signal; a raw `session.error` event is not.
          if (errorEventSessionID !== sessionId) {
            if (errorEventSessionID != null) ownershipLedger?.markUnknown(errorEventSessionID)
            continue
          }

          // Allowlisted structured fields only — never echo the raw session error object/URL.
          const errorData = getObjectProperty(sessionError, 'data')
          const status =
            getNumberProperty(sessionError, 'status') ??
            getNumberProperty(sessionError, 'statusCode') ??
            getNumberProperty(errorData, 'status') ??
            getNumberProperty(errorData, 'statusCode')
          const code = getStringProperty(sessionError, 'code') ?? getStringProperty(errorData, 'code')
          const name = getStringProperty(sessionError, 'name') ?? getStringProperty(errorData, 'name')
          // Intentional tradeoff: object message text is classification-only for quota and excluded from safe
          // fetch-retry classification, so object {message: 'fetch failed'} remains non-retryable; string/thrown
          // fetch errors remain retryable.
          const structuredMessage =
            getStringProperty(sessionError, 'message') ?? getStringProperty(errorData, 'message')
          const plainMessage = typeof sessionError === 'string' ? sessionError : undefined
          const message = structuredMessage ?? plainMessage

          const terminalError =
            classifyProviderAuthError({
              kind: 'session-error',
              name,
            }) ??
            classifyContextOverflowError({
              kind: 'session-error',
              name,
            }) ??
            classifyQuotaError({
              kind: 'session-error',
              status: status ?? undefined,
              code: code ?? undefined,
              message: message ?? undefined,
            })

          if (terminalError != null) {
            if (deadline?.isExpired() === true && activityTracker?.terminalProviderError == null) continue
            logger.error('Session error classified as terminal provider error', {sessionId, type: terminalError.type})
            classificationPath = 'structured'
            llmError = mergeActivityError(llmError, terminalError, activityTracker, undefined, classificationPath)
          } else if (llmError == null || isTerminalProviderError(llmError) === false) {
            const errorStr = normalizeSessionError(sessionError)
            let genericError: ErrorInfo
            let genericClassificationPath: ClassificationPath
            if (isLlmFetchError(errorStr)) {
              genericError = createLLMFetchError(errorStr, model ?? undefined)
              genericClassificationPath = 'fallback'
            } else if (status === 429) {
              // Ordinary 429 without account_rate_limit stays retryable rate_limit.
              genericError = createErrorInfo('rate_limit', errorStr, true)
              genericClassificationPath = 'name'
            } else {
              const isRetryable =
                getBooleanProperty(sessionError, 'isRetryable') ?? getBooleanProperty(errorData, 'isRetryable')
              if (isRetryable === true) {
                genericError = createRetryableApiError(errorStr, model ?? undefined)
                genericClassificationPath = 'structured'
              } else if (isRetryable === false) {
                genericError = createAgentError(errorStr)
                genericClassificationPath = 'structured'
              } else {
                genericError = createAgentError(errorStr)
                genericClassificationPath = name != null || status != null || code != null ? 'name' : 'unclassified'
              }
            }
            if (classificationPath == null) classificationPath = genericClassificationPath
            llmError = mergeActivityError(llmError, genericError, activityTracker, errorStr, classificationPath)
          }
        }
      } else if (eventType === 'session.idle' && getSessionID(eventPayload) === sessionId) {
        // Deliberately root-scoped by construction (`=== sessionId`, not
        // `isOwnedSession`): a descendant going idle says nothing about
        // whether the root session's own turn is done, and treating it as
        // this run's idle would end the parent's turn while it is still
        // working. `session.error` above is root-scoped for the identical
        // reason. The next person widening a filter in this function should
        // ask the same question these two answered: does this signal, when
        // it fires on a descendant, actually mean the ROOT session is done?
        if (activityTracker != null) {
          activityTracker.sessionIdle = true
          activityTracker.currentTurnTerminalSignalReceived = true
          // Root idle creates an idle CANDIDATE for the current generation, not permanent
          // permission: `markRootIdleCandidate` stamps it with the current revision, so any root
          // activity observed afterward (including an injected completion turn) invalidates it
          // again rather than leaving these sticky flags as unconditional permission to finish.
          if (activityTracker.rootFreshness != null) markRootIdleCandidate(activityTracker.rootFreshness)
        }
        if (lastText.length > 0) {
          outputTextContent(lastText)
          lastText = ''
        }
      }
    }
  }

  let discontinuity: {readonly message: string} | undefined

  // Shared by both the thrown-discontinuity path and the unexpected-EOF path below so the
  // freshness/ledger consequences of "we can no longer see this stream" are recorded exactly
  // once, the same way, regardless of which exit triggered it.
  function recordDiscontinuity(message: string): void {
    // Unexpected discontinuity: the observation channel closed without an intentional
    // shutdown and without a terminal signal. Selecting an error never proves quiescence,
    // and observing quiescence never erases an error -- this must never be read as the turn
    // concluding, only as "we can no longer see it." Preserve everything accumulated so far
    // instead of throwing it away, and mark every currently-outstanding owned entry unknown
    // -- reconciliation (triggered by the caller that owns the SDK client, since this
    // function only has the stream) is how they later resolve to settled or cancelled.
    discontinuity = {message}
    logger.warning('Event stream discontinuity — observation channel closed unexpectedly', {
      sessionId,
      error: message,
    })
    // Observation-channel failure cannot preserve authoritative freshness: a broken SSE stream
    // does not prove the root is quiescent. Require REST revalidation before any retained idle
    // evidence may be consumed again -- failure evidence itself is untouched by this. Note also
    // that this gap is never *erased* by a later successful poll: polling can legitimately learn
    // the root session completed, but it cannot establish that no unobserved background dispatch
    // occurred while this channel was blind, so the recorded gap must stand regardless.
    if (activityTracker?.rootFreshness != null) requireRootRevalidation(activityTracker.rootFreshness)
    if (ownershipLedger !== undefined) {
      const outstandingEntries = ownershipLedger.snapshot().filter(entry => entry.state === 'outstanding')
      for (const entry of outstandingEntries) {
        ownershipLedger.markUnknown(entry.sessionId)
      }
      logger.warning('Event stream discontinuity — marked outstanding owned entries unknown', {
        sessionId,
        unknownCount: outstandingEntries.length,
      })
    }
  }

  try {
    await consumeStream()
    // The loop above only ever exits without throwing in two ways: the for-await iterator ran
    // dry on its own, or the top-of-loop `if (signal.aborted) break` fired. The latter covers
    // every intentional local shutdown this stream can observe -- including a deadline expiry,
    // since the caller's signal here is a combined AbortSignal.any(...) that includes the
    // deadline's own signal (see retry.ts's `eventSignal`), so bounded collection continuing
    // past an already-decided attempt still exits through this same abort-triggered break, not
    // through iterator exhaustion. A `signal.aborted` still false at this point means the first
    // case happened: the transport ended the stream without anyone asking it to. That is exactly
    // as much an observation gap as a thrown discontinuity, so record it the same way.
    //
    // Deliberately NOT scoped to ledger occupancy. The uncertainty this records is precisely
    // "did an unobserved dispatch happen while we could not see the stream" -- requiring an
    // already-outstanding ledger entry before recording that uncertainty assumes away the one
    // failure mode this exists to catch: the stream closing *before* the dispatch-adoption event
    // ever landed, leaving the ledger empty (or absent) with no record that anything was missed.
    // Every real caller (see retry.ts) only aborts *after* deciding the turn is over from events
    // this loop already delivered, so `!signal.aborted` reaching this line always means the
    // transport ended the stream without anyone asking it to -- record it regardless of what the
    // ledger currently holds (empty, fully settled, outstanding, or no ledger at all).
    if (!signal.aborted) {
      recordDiscontinuity('Event stream ended unexpectedly')
    }
  } catch (error) {
    if (isIntentionalShutdown(error, signal)) {
      // The caller told us to stop (deadline expiry, attempt abort, etc.) -- this is not a
      // transport failure, it's the expected shape of a requested shutdown. Say nothing
      // about the turn: no diagnostic, no ledger churn, no fabricated failure.
    } else {
      const message = error instanceof Error ? error.message : String(error)
      recordDiscontinuity(message)
    }
  }

  if (lastText.length > 0) outputTextContent(lastText)
  return {
    tokens: sumOwnedSessionTokens(tokensBySession),
    model,
    cost,
    prsCreated,
    commitsCreated,
    commentsPostedUrls,
    commentsPosted,
    llmError,
    classificationPath,
    ...(discontinuity == null ? {} : {discontinuity}),
  }
}

/**
 * Pure artifact scanner over completed assistant message parts.
 * Called after the live SSE stream completes to reconcile any artifacts the stream may have missed.
 * No console writes — only detects PR/commit/comment artifacts from bash tool parts.
 * Returns a partial EventStreamResult with artifacts detected from the bash tool parts.
 *
 * Like `detectArtifacts`, the comment count this returns only reflects a
 * model self-post via `gh` (autonomous flows); it stays 0 for
 * response-file-convention flows, whose count comes from the finalize post.
 */
export function detectArtifactsFromMessageParts(
  parts: readonly unknown[],
  logger: Logger,
): Pick<EventStreamResult, 'prsCreated' | 'commitsCreated' | 'commentsPostedUrls' | 'commentsPosted'> {
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  const commentsPostedUrls: string[] = []
  let commentsPosted = 0

  for (const part of parts) {
    const partType = getStringProperty(part, 'type')
    if (partType === 'tool') {
      const toolState = getObjectProperty(part, 'state')
      if (getStringProperty(toolState, 'status') === 'completed') {
        const tool = getStringProperty(part, 'tool') ?? ''
        if (tool.toLowerCase() === 'bash') {
          const input = getObjectProperty(toolState, 'input')
          const command = String(getObjectProperty(input, 'command') ?? getObjectProperty(input, 'cmd') ?? '')
          const output = String(getObjectProperty(toolState, 'output') ?? '')
          logger.debug('Artifact scan: bash tool part', {command: command.slice(0, 80)})
          detectArtifacts(
            command,
            output,
            prsCreated,
            commitsCreated,
            () => {
              commentsPosted++
            },
            commentsPostedUrls,
          )
        }
      }
    }
  }

  return {prsCreated, commitsCreated, commentsPostedUrls, commentsPosted}
}
