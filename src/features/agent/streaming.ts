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
  completedAssistantMessageId?: string
  completedAssistantMessageObservedAt?: number
  sessionIdle: boolean
  sessionError: string | null
}

export function logServerEvent(event: Event, logger: Logger): void {
  logger.debug('Server event', {eventType: event.type, properties: event.properties})
}

export function detectArtifacts(
  command: string,
  output: string,
  prsCreated: string[],
  commitsCreated: string[],
  onCommentPosted: () => void,
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
    const hasComment = urls.some(url => url.includes('#issuecomment'))
    if (hasComment) onCommentPosted()
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
  let commentsPosted = 0
  let llmError: ErrorInfo | null = null

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

    if (eventType === 'message.part.updated') {
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
            detectArtifacts(command, output, prsCreated, commitsCreated, () => {
              commentsPosted++
            })
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
        outputTextContent(lastText)
        lastText = ''
      }
    }
  }

  if (lastText.length > 0) outputTextContent(lastText)
  return {tokens, model, cost, prsCreated, commitsCreated, commentsPosted, llmError}
}
