import type {ErrorInfo} from '@fro-bot/runtime'
import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {TokenUsage} from '../../shared/types.js'
import {
  classifyQuotaError,
  createAgentError,
  createErrorInfo,
  createLLMFetchError,
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
  /** Set when a quota_exceeded ErrorInfo has been classified; fails fast (no grace, no v2 wait success). */
  quotaExceeded?: ErrorInfo
}

/** Shared quota classification for `session.status`/`retry`, used by both SSE and REST poll paths. */
export function classifyRetryStatusQuota(status: unknown): ErrorInfo | null {
  if (getStringProperty(status, 'type') !== 'retry') return null

  const action = getObjectProperty(status, 'action')
  const reason = getStringProperty(action, 'reason')
  if (reason == null) return null

  const nextRaw = getNumberProperty(status, 'next')
  const candidateResetAt = nextRaw != null && Number.isFinite(nextRaw) ? new Date(nextRaw) : undefined
  const resetAt = candidateResetAt != null && !Number.isNaN(candidateResetAt.getTime()) ? candidateResetAt : undefined

  return classifyQuotaError({kind: 'retry-status', reason, resetAt})
}

/** First-writer-wins, except quota may upgrade a prior error and is then sticky (never downgraded). */
function mergeTerminalError(existing: ErrorInfo | null, candidate: ErrorInfo): ErrorInfo {
  if (existing == null) return candidate
  if (existing.type === 'quota_exceeded') return existing
  if (candidate.type === 'quota_exceeded') return candidate
  return existing
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

function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null

  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
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

interface ToolCallInfo {
  readonly tool: string
  readonly input: unknown
}

export async function processEventStream(
  stream: AsyncIterable<Event>,
  sessionId: string,
  signal: AbortSignal,
  logger: Logger,
  activityTracker?: ActivityTracker,
): Promise<EventStreamResult> {
  let lastText = ''
  let tokens: TokenUsage | null = null
  let model: string | null = null
  let cost: number | null = null
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  const commentsPostedUrls: string[] = []
  let commentsPosted = 0
  let llmError: ErrorInfo | null = null
  // V2 sync tool lifecycle: correlate called→success by callID
  const pendingToolCalls = new Map<string, ToolCallInfo>()

  for await (const event of stream) {
    if (signal.aborted) break
    logServerEvent(event, logger)
    if (activityTracker?.currentTurnArmed === false) continue
    const eventType = getEventKind(event)
    const eventPayload = getEventPayload(event)

    if (activityTracker != null && isStreamActivityEvent(eventType)) {
      const eventSessionID = getEventSessionID(event)
      if (eventSessionID === sessionId) activityTracker.firstMeaningfulEventReceived = true
    }

    if (eventType === 'message.part.delta') {
      // New SDK shape: streaming text delta events accumulate into lastText, flushed on session.idle.
      // delta may be an object {type:'text', text:string} or a plain string when field === 'text'.
      const eventSessionID = getEventSessionID(event)
      if (eventSessionID === sessionId) {
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
      if (eventSessionID === sessionId) {
        const deltaRaw = getObjectProperty(eventPayload, 'delta')
        const deltaText = typeof deltaRaw === 'string' ? deltaRaw : (getStringProperty(deltaRaw, 'text') ?? null)
        if (deltaText != null) lastText += deltaText
      }
    } else if (eventType === 'session.next.tool.called') {
      // V2 sync tool lifecycle: cache call info for correlation with success event
      const eventSessionID = getEventSessionID(event)
      if (eventSessionID === sessionId) {
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
      if (eventSessionID === sessionId) {
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
      if (eventSessionID !== sessionId) continue
      if (activityTracker != null) activityTracker.firstMeaningfulEventReceived = true

      const partType = getStringProperty(part, 'type')
      if (partType === 'text') {
        const text = getStringProperty(part, 'text')
        if (text != null) lastText = text
        const endTime = getNumberProperty(getObjectProperty(part, 'time'), 'end')
        if (endTime != null) {
          outputTextContent(lastText)
          lastText = ''
        }
      } else if (partType === 'tool') {
        const toolState = getObjectProperty(part, 'state')
        if (getStringProperty(toolState, 'status') === 'completed') {
          const tool = getStringProperty(part, 'tool') ?? ''
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
      if (eventSessionID === sessionId && getStringProperty(msg, 'role') === 'assistant' && tokensData != null) {
        if (activityTracker != null) activityTracker.firstMeaningfulEventReceived = true
        tokens = {
          input: getNumberProperty(tokensData, 'input') ?? 0,
          output: getNumberProperty(tokensData, 'output') ?? 0,
          reasoning: getNumberProperty(tokensData, 'reasoning') ?? 0,
          cache: {
            read: getNumberProperty(getObjectProperty(tokensData, 'cache'), 'read') ?? 0,
            write: getNumberProperty(getObjectProperty(tokensData, 'cache'), 'write') ?? 0,
          },
        }
        model = getStringProperty(msg, 'modelID')
        cost = getNumberProperty(msg, 'cost')
        logger.debug('Token usage received', {tokens, model, cost})
      }
    } else if (eventType === 'session.status') {
      if (getSessionID(eventPayload) === sessionId) {
        const status = getObjectProperty(eventPayload, 'status')
        const quotaError = classifyRetryStatusQuota(status)
        if (quotaError != null && llmError?.type !== 'quota_exceeded') {
          logger.error('Session status retry classified as quota exceeded', {sessionId, type: quotaError.type})
          llmError = mergeTerminalError(llmError, quotaError)
          if (activityTracker != null) {
            activityTracker.sessionError = llmError.message
            activityTracker.quotaExceeded = llmError
            activityTracker.currentTurnTerminalSignalReceived = true
          }
        }
      }
    } else if (eventType === 'session.error') {
      if (getSessionID(eventPayload) === sessionId) {
        const sessionError = getObjectProperty(eventPayload, 'error')
        // Bounded log: never pass the raw session error payload to the logger.
        logger.error('Session error received', {sessionType: typeof sessionError})

        // Quota may upgrade a prior non-quota error; quota itself is sticky.
        if (llmError == null || llmError.type !== 'quota_exceeded') {
          // Allowlisted structured fields only — never echo the raw session error object/URL.
          const errorData = getObjectProperty(sessionError, 'data') ?? sessionError
          const status = getNumberProperty(errorData, 'status') ?? getNumberProperty(errorData, 'statusCode')
          const code = getStringProperty(errorData, 'code')
          const structuredMessage = getStringProperty(errorData, 'message')
          const plainMessage = typeof sessionError === 'string' ? sessionError : undefined
          const message = structuredMessage ?? plainMessage

          const quotaError = classifyQuotaError({
            kind: 'session-error',
            status: status ?? undefined,
            code: code ?? undefined,
            message: message ?? undefined,
          })

          if (quotaError == null) {
            if (llmError == null) {
              const errorStr = typeof sessionError === 'string' ? sessionError : String(sessionError)
              if (isLlmFetchError(sessionError)) {
                llmError = createLLMFetchError(errorStr, model ?? undefined)
              } else if (status === 429) {
                // Ordinary 429 without account_rate_limit stays retryable rate_limit.
                llmError = createErrorInfo('rate_limit', errorStr, true)
              } else {
                llmError = createAgentError(errorStr)
              }
              if (activityTracker != null) activityTracker.sessionError = errorStr
            }
          } else {
            llmError = mergeTerminalError(llmError, quotaError)
            if (activityTracker != null) {
              activityTracker.sessionError = llmError.message
              activityTracker.quotaExceeded = llmError
              activityTracker.currentTurnTerminalSignalReceived = true
            }
          }
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

  if (lastText.length > 0) outputTextContent(lastText)
  return {tokens, model, cost, prsCreated, commitsCreated, commentsPostedUrls, commentsPosted, llmError}
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
