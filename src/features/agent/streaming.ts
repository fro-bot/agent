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

    if (event.type === 'message.part.updated') {
      const part = event.properties.part
      if (part.sessionID !== sessionId) continue
      if (activityTracker != null) activityTracker.firstMeaningfulEventReceived = true

      if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        lastText = part.text
        const endTime = 'time' in part ? part.time?.end : undefined
        if (endTime != null && Number.isFinite(endTime)) {
          outputTextContent(lastText)
          lastText = ''
        }
      } else if (part.type === 'tool') {
        const toolState = part.state
        if (toolState.status === 'completed') {
          outputToolExecution(part.tool, toolState.title)
          if (part.tool.toLowerCase() === 'bash') {
            const command = String(toolState.input.command ?? toolState.input.cmd ?? '')
            const output = String(toolState.output)
            detectArtifacts(command, output, prsCreated, commitsCreated, () => {
              commentsPosted++
            })
          }
        }
      }
    } else if (event.type === 'message.updated') {
      const msg = event.properties.info
      if (msg.sessionID === sessionId && msg.role === 'assistant' && msg.tokens != null) {
        if (activityTracker != null) activityTracker.firstMeaningfulEventReceived = true
        tokens = {
          input: msg.tokens.input ?? 0,
          output: msg.tokens.output ?? 0,
          reasoning: msg.tokens.reasoning ?? 0,
          cache: {read: msg.tokens.cache?.read ?? 0, write: msg.tokens.cache?.write ?? 0},
        }
        model = msg.modelID ?? null
        cost = msg.cost ?? null
        logger.debug('Token usage received', {tokens, model, cost})
      }
    } else if (event.type === 'session.error') {
      if (event.properties.sessionID === sessionId) {
        const sessionError = event.properties.error
        const errorStr = typeof sessionError === 'string' ? sessionError : String(sessionError)
        logger.error('Session error', {error: sessionError})
        llmError = isLlmFetchError(sessionError)
          ? createLLMFetchError(errorStr, model ?? undefined)
          : createAgentError(errorStr)
        if (activityTracker != null) activityTracker.sessionError = errorStr
      }
    } else if (event.type === 'session.idle' && event.properties.sessionID === sessionId) {
      if (activityTracker != null) activityTracker.sessionIdle = true
      if (lastText.length > 0) {
        outputTextContent(lastText)
        lastText = ''
      }
    }
  }

  if (lastText.length > 0) outputTextContent(lastText)
  return {tokens, model, cost, prsCreated, commitsCreated, commentsPosted, llmError}
}
