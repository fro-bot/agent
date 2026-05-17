import type {ErrorInfo} from '@fro-bot/runtime'
import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {TokenUsage} from '../../shared/types.js'
import {createAgentError, createLLMFetchError, isLlmFetchError} from '@fro-bot/runtime'
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

export interface FallbackRenderOptions {
  readonly renderText: boolean
  readonly renderTools: boolean
}

/** Mutable by design — updated in-place during stream processing. */
export interface ActivityTracker {
  firstMeaningfulEventReceived: boolean
  /** Set only by truly terminal signals: session.idle event or completed assistant message. */
  currentTurnTerminalSignalReceived: boolean
  currentTurnArmed?: boolean
  baselineMessageIds?: ReadonlySet<string>
  completedAssistantMessageId?: string
  completedAssistantMessageObservedAt?: number
  /** True once outputTextContent has been called during live stream processing. */
  textOutputEmitted?: boolean
  /** True once outputToolExecution has been called during live stream processing. */
  toolOutputEmitted?: boolean
  /** Parts from the fallback completed assistant message, set by detectMessageActivity. */
  fallbackMessageParts?: readonly unknown[]
  sessionIdle: boolean
  sessionError: string | null
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
    logger.debug('Server event', {eventType, properties: getObjectProperty(event, 'properties')})
  }
}

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

function markTextOutputEmitted(activityTracker: ActivityTracker | undefined): void {
  if (activityTracker != null) activityTracker.textOutputEmitted = true
}

function markToolOutputEmitted(activityTracker: ActivityTracker | undefined): void {
  if (activityTracker != null) activityTracker.toolOutputEmitted = true
}

function outputStreamTextContent(text: string, activityTracker: ActivityTracker | undefined): void {
  outputTextContent(text)
  markTextOutputEmitted(activityTracker)
}

function outputStreamToolExecution(
  toolName: string,
  title: string,
  activityTracker: ActivityTracker | undefined,
): void {
  outputToolExecution(toolName, title)
  markToolOutputEmitted(activityTracker)
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
          outputStreamToolExecution(tool, title, activityTracker)
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
          outputStreamTextContent(lastText, activityTracker)
          lastText = ''
        }
      } else if (partType === 'tool') {
        const toolState = getObjectProperty(part, 'state')
        if (getStringProperty(toolState, 'status') === 'completed') {
          const tool = getStringProperty(part, 'tool') ?? ''
          outputStreamToolExecution(tool, String(getObjectProperty(toolState, 'title') ?? ''), activityTracker)
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
    } else if (eventType === 'session.error') {
      if (getSessionID(eventPayload) === sessionId) {
        const sessionError = getObjectProperty(eventPayload, 'error')
        const errorStr = typeof sessionError === 'string' ? sessionError : String(sessionError)
        logger.error('Session error', {error: sessionError})
        llmError = isLlmFetchError(sessionError)
          ? createLLMFetchError(errorStr, model ?? undefined)
          : createAgentError(errorStr)
        if (activityTracker != null) activityTracker.sessionError = errorStr
      }
    } else if (eventType === 'session.idle' && getSessionID(eventPayload) === sessionId) {
      if (activityTracker != null) {
        activityTracker.sessionIdle = true
        activityTracker.currentTurnTerminalSignalReceived = true
      }
      if (lastText.length > 0) {
        outputStreamTextContent(lastText, activityTracker)
        lastText = ''
      }
    }
  }

  if (lastText.length > 0) outputStreamTextContent(lastText, activityTracker)
  return {tokens, model, cost, prsCreated, commitsCreated, commentsPostedUrls, commentsPosted, llmError}
}

/**
 * Render completed assistant message parts from the message-fallback path.
 * Called after the live SSE stream completes to backfill any visible output it missed.
 * Text and tool rendering are gated independently via FallbackRenderOptions so callers can
 * suppress whichever side already streamed live (avoids double-printing).
 * Returns a partial EventStreamResult with artifacts detected from the bash tool parts.
 */
export function renderFallbackMessageParts(
  parts: readonly unknown[],
  logger: Logger,
  options: FallbackRenderOptions = {renderText: true, renderTools: true},
): Pick<EventStreamResult, 'prsCreated' | 'commitsCreated' | 'commentsPostedUrls' | 'commentsPosted'> {
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  const commentsPostedUrls: string[] = []
  let commentsPosted = 0

  for (const part of parts) {
    const partType = getStringProperty(part, 'type')
    if (partType === 'text') {
      const text = getStringProperty(part, 'text')
      if (text != null && options.renderText === true) {
        outputTextContent(text)
        logger.debug('Fallback: rendered text part')
      }
    } else if (partType === 'tool') {
      const toolState = getObjectProperty(part, 'state')
      if (getStringProperty(toolState, 'status') === 'completed') {
        const tool = getStringProperty(part, 'tool') ?? ''
        const title = String(getObjectProperty(toolState, 'title') ?? '')
        if (options.renderTools === true) {
          outputToolExecution(tool, title)
          logger.debug('Fallback: rendered tool part', {tool, title})
        }
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
  }

  return {prsCreated, commitsCreated, commentsPostedUrls, commentsPosted}
}
