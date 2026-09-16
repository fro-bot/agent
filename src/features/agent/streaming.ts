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
}

/** Mutable by design — updated in-place during stream processing. */
export interface ActivityTracker {
  firstMeaningfulEventReceived: boolean
  /** Set only by truly terminal signals: session.idle event or completed assistant message. */
  currentTurnTerminalSignalReceived: boolean
  currentTurnArmed?: boolean
  baselineMessageIds?: ReadonlySet<string>
  /** Tracks last observed completed assistant message ID so the polling fallback can confirm it remains the latest across two polls before reporting completion — guards against races with the next agent loop step. */
  completedAssistantMessageId?: string
  sessionIdle: boolean
  sessionError: string | null
  /** Set when a terminal provider ErrorInfo has been classified; first terminal signal wins. */
  terminalProviderError?: ErrorInfo
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

/** Merge generic and terminal observations while freezing the first terminal provider signal. */
export function mergeActivityError(
  existing: ErrorInfo | null,
  candidate: ErrorInfo,
  activityTracker?: ActivityTracker,
  genericSessionError?: string,
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
    activityTracker.currentTurnTerminalSignalReceived = true
    return merged
  }

  if (activityTracker != null && activityTracker.sessionError == null && genericSessionError != null) {
    activityTracker.sessionError = genericSessionError
  }

  return merged
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

/** Normalize an SDK session error without coercing or retaining its raw payload. */
function normalizeSessionError(sessionError: unknown): string {
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
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger))
          activityTracker.firstMeaningfulEventReceived = true
      }

      if (eventType === 'message.part.delta') {
        // New SDK shape: streaming text delta events accumulate into lastText, flushed on session.idle.
        // delta may be an object {type:'text', text:string} or a plain string when field === 'text'.
        const eventSessionID = getEventSessionID(event)
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger)) {
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
          const deltaRaw = getObjectProperty(eventPayload, 'delta')
          const deltaText = typeof deltaRaw === 'string' ? deltaRaw : (getStringProperty(deltaRaw, 'text') ?? null)
          if (deltaText != null) lastText += deltaText
        }
      } else if (eventType === 'session.next.tool.called') {
        // V2 sync tool lifecycle: cache call info for correlation with success event
        const eventSessionID = getEventSessionID(event)
        if (isOwnedSession(eventSessionID, sessionId, ownershipLedger)) {
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
            if (ownershipLedger !== undefined && eventSessionID === sessionId && text != null) {
              const completion = parseInjectedTaskCompletion(text)
              if (completion !== null) {
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
        if (isOwnedSession(getSessionID(eventPayload), sessionId, ownershipLedger)) {
          const status = getObjectProperty(eventPayload, 'status')
          const terminalError = classifyRetryStatusError(status)
          if (terminalError != null) {
            if (deadline?.isExpired() === true && activityTracker?.terminalProviderError == null) continue
            logger.error('Session status retry classified as terminal provider error', {
              sessionId,
              type: terminalError.type,
            })
            classificationPath = 'structured'
            llmError = mergeActivityError(llmError, terminalError, activityTracker)
          }
        }
      } else if (eventType === 'session.error') {
        if (isOwnedSession(getSessionID(eventPayload), sessionId, ownershipLedger)) {
          const sessionError = getObjectProperty(eventPayload, 'error')
          // Bounded log: never pass the raw session error payload to the logger.
          logger.error('Session error received', {sessionType: typeof sessionError})

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
            llmError = mergeActivityError(llmError, terminalError, activityTracker)
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
            llmError = mergeActivityError(llmError, genericError, activityTracker, errorStr)
          }
        }
      } else if (eventType === 'session.idle' && getSessionID(eventPayload) === sessionId) {
        if (activityTracker != null) {
          activityTracker.sessionIdle = true
          activityTracker.currentTurnTerminalSignalReceived = true
        }
        if (lastText.length > 0) {
          outputTextContent(lastText)
          lastText = ''
        }
      }
    }
  }

  try {
    await consumeStream()
  } catch (error) {
    // Stream discontinuity: never infer "nothing outstanding" from a stream that
    // stopped talking. Mark every currently-outstanding owned entry unknown —
    // reconciliation (triggered by the caller that owns the SDK client, since this
    // function only has the stream) is how they later resolve to settled or cancelled.
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
    throw error
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
