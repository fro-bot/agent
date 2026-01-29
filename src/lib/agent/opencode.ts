/**
 * OpenCode SDK execution for RFC-013 and RFC-014.
 *
 * Handles launching OpenCode in server mode and communicating via SDK client.
 * Replaces CLI-based execution from RFC-012 with SDK-based execution.
 * RFC-014 adds file attachment support via SDK file parts.
 */

import type {FilePartInput, TextPartInput} from '@opencode-ai/sdk'
import type {ErrorInfo} from '../comments/types.js'
import type {Logger} from '../logger.js'
import type {TokenUsage} from '../types.js'
import type {AgentResult, EnsureOpenCodeResult, ExecutionConfig, PromptOptions} from './types.js'
import process from 'node:process'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {createOpencode} from '@opencode-ai/sdk'
import {createLLMFetchError, isLlmFetchError} from '../comments/error-format.js'
import {DEFAULT_TIMEOUT_MS} from '../constants.js'
import {extractCommitShas, extractGithubUrls} from '../github/urls.js'
import {runSetup} from '../setup/setup.js'
import {buildAgentPrompt} from './prompt.js'

/** ANSI color codes for tool output formatting */
const TOOL_COLORS: Record<string, [string, string]> = {
  todowrite: ['Todo', '\u001B[33m\u001B[1m'],
  todoread: ['Todo', '\u001B[33m\u001B[1m'],
  bash: ['Bash', '\u001B[31m\u001B[1m'],
  edit: ['Edit', '\u001B[32m\u001B[1m'],
  glob: ['Glob', '\u001B[34m\u001B[1m'],
  grep: ['Grep', '\u001B[34m\u001B[1m'],
  list: ['List', '\u001B[34m\u001B[1m'],
  read: ['Read', '\u001B[35m\u001B[1m'],
  write: ['Write', '\u001B[32m\u001B[1m'],
  websearch: ['Search', '\u001B[2m\u001B[1m'],
} as const
const ANSI_RESET = '\u001B[0m'
const ANSI_DIM = '\u001B[0m\u001B[2m'

function outputToolExecution(toolName: string, title: string): void {
  const [displayName, color] = TOOL_COLORS[toolName.toLowerCase()] ?? [toolName, '\u001B[36m\u001B[1m']
  const paddedName = displayName.padEnd(7, ' ')
  process.stdout.write(`\n${color}|${ANSI_RESET}${ANSI_DIM} ${paddedName} ${ANSI_RESET}${title}\n`)
}

function outputTextContent(text: string): void {
  process.stdout.write(`\n${text}\n`)
}

interface EventProperties {
  part?: {
    sessionID?: string
    type?: string
    text?: string
    tool?: string
    time?: {end?: number}
    state?: {status?: string; title?: string; input?: Record<string, unknown>; output?: string}
  }
  message?: {
    sessionID?: string
    role?: string
    modelID?: string
    cost?: number
    tokens?: {
      input?: number
      output?: number
      reasoning?: number
      cache?: {read?: number; write?: number}
    }
  }
  info?: {id?: string; title?: string; version?: string}
  sessionID?: string
  error?: unknown
}

export interface OpenCodeEvent {
  type: string
  properties: EventProperties
}

/** Log a server event at debug level for troubleshooting. */
export function logServerEvent(event: OpenCodeEvent, logger: Logger): void {
  logger.debug('Server event', {
    eventType: event.type,
    properties: event.properties,
  })
}

interface EventStreamResult {
  tokens: TokenUsage | null
  model: string | null
  cost: number | null
  prsCreated: string[]
  commitsCreated: string[]
  commentsPosted: number
  llmError: ErrorInfo | null
}

/**
 * Detect artifacts created by the agent during execution.
 *
 * Scans bash command output for GitHub URLs and git commit SHAs to track
 * what the agent has accomplished.
 */
export function detectArtifacts(
  command: string,
  output: string,
  prsCreated: string[],
  commitsCreated: string[],
  onCommentPosted: () => void,
): void {
  const urls = extractGithubUrls(output)

  // 1. Detect PR creation (gh pr create)
  if (command.includes('gh pr create')) {
    // PR creation typically outputs the PR URL (without fragments)
    const prUrls = urls.filter(u => u.includes('/pull/') && !u.includes('#'))
    for (const url of prUrls) {
      if (!prsCreated.includes(url)) {
        prsCreated.push(url)
      }
    }
  }

  // 2. Detect Commits (git commit)
  if (command.includes('git commit')) {
    const shas = extractCommitShas(output)
    for (const sha of shas) {
      if (!commitsCreated.includes(sha)) {
        commitsCreated.push(sha)
      }
    }
  }

  // 3. Detect Comment posting (gh issue/pr comment)
  if (command.includes('gh issue comment') || command.includes('gh pr comment')) {
    // Commenting typically outputs the comment URL (with #issuecomment- suffix)
    const hasComment = urls.some(url => url.includes('#issuecomment'))
    if (hasComment) {
      onCommentPosted()
    }
  }
}

async function processEventStream(
  stream: AsyncIterable<OpenCodeEvent>,
  sessionId: string,
  logger: Logger,
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
    logServerEvent(event, logger)
    const props = event.properties

    if (event.type === 'message.part.updated') {
      const part = props.part
      if (part?.sessionID !== sessionId) continue

      if (part.type === 'text' && typeof part.text === 'string') {
        lastText = part.text
        const endTime = part.time?.end

        if (endTime != null && Number.isFinite(endTime)) {
          outputTextContent(lastText)
          lastText = ''
        }
      } else if (part.type === 'tool' && part.state?.status === 'completed') {
        const toolName = part.tool ?? 'unknown'
        const toolInput = part.state.input ?? {}
        const title = part.state.title ?? (Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : 'Unknown')
        outputToolExecution(toolName, title)

        if (toolName.toLowerCase() === 'bash') {
          const command = String(toolInput.command ?? toolInput.cmd ?? '')
          const output = String(part.state.output ?? '')
          detectArtifacts(command, output, prsCreated, commitsCreated, () => {
            commentsPosted++
          })
        }
      }
    } else if (event.type === 'message.updated') {
      const msg = props.message
      if (msg?.sessionID === sessionId && msg.role === 'assistant' && msg.tokens != null) {
        tokens = {
          input: msg.tokens.input ?? 0,
          output: msg.tokens.output ?? 0,
          reasoning: msg.tokens.reasoning ?? 0,
          cache: {
            read: msg.tokens.cache?.read ?? 0,
            write: msg.tokens.cache?.write ?? 0,
          },
        }
        model = msg.modelID ?? null
        cost = msg.cost ?? null
        logger.debug('Token usage received', {tokens, model, cost})
      }
    } else if (event.type === 'session.error' && props.sessionID === sessionId) {
      logger.error('Session error', {error: props.error})

      // Check if this is a recoverable LLM fetch error
      if (isLlmFetchError(props.error)) {
        const errorMessage = typeof props.error === 'string' ? props.error : String(props.error)
        llmError = createLLMFetchError(errorMessage, model ?? undefined)
      }
    }
  }

  return {tokens, model, cost, prsCreated, commitsCreated, commentsPosted, llmError}
}

const MAX_LLM_RETRIES = 3
const RETRY_DELAY_MS = 5000

const CONTINUATION_PROMPT = `The previous request was interrupted by a network error (fetch failed).
Please continue where you left off. If you were in the middle of a task, resume it.
If you had completed the task, confirm the completion.`

interface PromptAttemptResult {
  success: boolean
  error: string | null
  llmError: ErrorInfo | null
  shouldRetry: boolean
  eventStreamResult: EventStreamResult
}

async function sendPromptToSession(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  promptText: string,
  fileParts: readonly FilePartInput[] | undefined,
  config: ExecutionConfig | undefined,
  logger: Logger,
): Promise<PromptAttemptResult> {
  const agentName = config?.agent ?? 'Sisyphus'

  const events = await client.event.subscribe()

  let eventStreamEnded = false
  let eventStreamResult: EventStreamResult = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }

  const eventProcessingPromise = processEventStream(events.stream as AsyncIterable<OpenCodeEvent>, sessionId, logger)
    .then(result => {
      eventStreamResult = result
    })
    .catch(error => {
      if (error instanceof Error && error.name !== 'AbortError') {
        logger.debug('Event stream error', {error: error.message})
      }
    })
    .finally(() => {
      eventStreamEnded = true
    })

  const textPart: TextPartInput = {type: 'text', text: promptText}
  const parts: (TextPartInput | FilePartInput)[] = [textPart]

  if (fileParts != null && fileParts.length > 0) {
    parts.push(...fileParts)
    logger.info('Including file attachments in prompt', {count: fileParts.length})
  }

  const promptBody: {
    agent?: string
    model?: {modelID: string; providerID: string}
    parts: (TextPartInput | FilePartInput)[]
  } = {
    agent: agentName,
    parts,
  }

  if (config?.model != null) {
    promptBody.model = {
      providerID: config.model.providerID,
      modelID: config.model.modelID,
    }
  }

  logger.debug('Sending prompt to OpenCode', {sessionId})
  const promptResponse = await client.session.prompt({
    path: {id: sessionId},
    body: promptBody,
  })

  // Grace period for event stream to flush
  if (!eventStreamEnded) {
    const gracePeriod = new Promise<void>(resolve => setTimeout(resolve, 2000))
    await Promise.race([eventProcessingPromise, gracePeriod])
  }

  if (promptResponse.error != null) {
    logger.error('OpenCode prompt failed', {error: String(promptResponse.error)})

    const promptErrorLlm = isLlmFetchError(promptResponse.error)
      ? createLLMFetchError(String(promptResponse.error), eventStreamResult.model ?? undefined)
      : eventStreamResult.llmError

    return {
      success: false,
      error: String(promptResponse.error),
      llmError: promptErrorLlm,
      shouldRetry: promptErrorLlm != null,
      eventStreamResult,
    }
  }

  return {
    success: true,
    error: null,
    llmError: null,
    shouldRetry: false,
    eventStreamResult,
  }
}

export async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
): Promise<AgentResult> {
  const startTime = Date.now()
  const abortController = new AbortController()

  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  let server: Awaited<ReturnType<typeof createOpencode>>['server'] | null = null

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true
      logger.warning('Execution timeout reached', {timeoutMs})
      abortController.abort()
    }, timeoutMs)
  }

  logger.info('Executing OpenCode agent (SDK mode)', {
    agent: config?.agent ?? 'Sisyphus',
    hasModelOverride: config?.model != null,
    timeoutMs,
  })

  try {
    // Create server and session ONCE (outside retry loop)
    const opencode = await createOpencode({
      signal: abortController.signal,
    })
    const {client} = opencode
    server = opencode.server

    logger.debug('OpenCode server started', {url: server.url})

    const sessionResponse = await client.session.create()
    if (sessionResponse.data == null || sessionResponse.error != null) {
      const errorMsg = sessionResponse.error == null ? 'No data returned' : String(sessionResponse.error)
      throw new Error(`Failed to create session: ${errorMsg}`)
    }
    const sessionId = sessionResponse.data.id
    logger.debug('Session created', {sessionId})

    // Build initial prompt
    const initialPrompt = buildAgentPrompt({...promptOptions, sessionId}, logger)

    // Track results - only from successful attempt (failed attempts waste tokens)
    let finalTokens: TokenUsage | null = null
    let finalModel: string | null = null
    let finalCost: number | null = null
    let finalPRs: string[] = []
    let finalCommits: string[] = []
    let finalComments = 0
    let lastError: string | null = null
    let lastLlmError: ErrorInfo | null = null

    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (timedOut) {
        return {
          success: false,
          exitCode: 130,
          duration: Date.now() - startTime,
          sessionId,
          error: `Execution timed out after ${timeoutMs}ms`,
          tokenUsage: finalTokens,
          model: finalModel,
          cost: finalCost,
          prsCreated: finalPRs,
          commitsCreated: finalCommits,
          commentsPosted: finalComments,
          llmError: lastLlmError,
        }
      }

      // Check remaining time before attempting (Issue #3)
      const elapsedMs = Date.now() - startTime
      const remainingMs = timeoutMs - elapsedMs
      if (timeoutMs > 0 && remainingMs <= RETRY_DELAY_MS && attempt > 1) {
        logger.warning('Insufficient time remaining for retry', {
          remainingMs,
          requiredMs: RETRY_DELAY_MS,
          attempt,
        })
        break
      }

      // First attempt: send initial prompt. Retries: send continuation prompt
      const promptToSend = attempt === 1 ? initialPrompt : CONTINUATION_PROMPT
      const filePartsToSend = attempt === 1 ? promptOptions.fileParts : undefined

      logger.debug('Sending prompt', {attempt, isRetry: attempt > 1})

      try {
        const attemptResult = await sendPromptToSession(
          client,
          sessionId,
          promptToSend,
          filePartsToSend,
          config,
          logger,
        )

        if (attemptResult.success) {
          // Only track results from successful attempt (Issue #1 & #2)
          const {eventStreamResult} = attemptResult
          finalTokens = eventStreamResult.tokens
          finalModel = eventStreamResult.model
          finalCost = eventStreamResult.cost
          finalPRs = [...eventStreamResult.prsCreated]
          finalCommits = [...eventStreamResult.commitsCreated]
          finalComments = eventStreamResult.commentsPosted

          const duration = Date.now() - startTime
          logger.info('OpenCode execution completed', {sessionId, durationMs: duration, attempts: attempt})

          return {
            success: true,
            exitCode: 0,
            duration,
            sessionId,
            error: null,
            tokenUsage: finalTokens,
            model: finalModel,
            cost: finalCost,
            prsCreated: finalPRs,
            commitsCreated: finalCommits,
            commentsPosted: finalComments,
            llmError: null,
          }
        }

        lastError = attemptResult.error
        lastLlmError = attemptResult.llmError

        if (!attemptResult.shouldRetry || attempt >= MAX_LLM_RETRIES) {
          if (attemptResult.shouldRetry && attempt >= MAX_LLM_RETRIES) {
            logger.warning('LLM fetch error: max retries exhausted', {
              attempts: attempt,
              error: attemptResult.error,
            })
          }
          break
        }

        logger.warning('LLM fetch error detected, retrying with continuation prompt', {
          attempt,
          maxAttempts: MAX_LLM_RETRIES,
          error: attemptResult.error,
          delayMs: RETRY_DELAY_MS,
          sessionId,
        })

        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error('Prompt attempt failed with exception', {attempt, error: errorMessage})

        lastError = errorMessage
        const caughtLlmError = isLlmFetchError(error) ? createLLMFetchError(errorMessage) : null
        lastLlmError = caughtLlmError

        if (caughtLlmError == null || attempt >= MAX_LLM_RETRIES) {
          if (caughtLlmError != null && attempt >= MAX_LLM_RETRIES) {
            logger.warning('LLM fetch error: max retries exhausted', {attempts: attempt, error: errorMessage})
          }
          break
        }

        logger.warning('LLM fetch error detected (exception), retrying with continuation prompt', {
          attempt,
          maxAttempts: MAX_LLM_RETRIES,
          error: errorMessage,
          delayMs: RETRY_DELAY_MS,
          sessionId,
        })

        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }

    // All retries exhausted or non-retryable error
    return {
      success: false,
      exitCode: 1,
      duration: Date.now() - startTime,
      sessionId,
      error: lastError ?? 'Unknown error',
      tokenUsage: finalTokens,
      model: finalModel,
      cost: finalCost,
      prsCreated: finalPRs,
      commitsCreated: finalCommits,
      commentsPosted: finalComments,
      llmError: lastLlmError,
    }
  } catch (error) {
    const duration = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)

    logger.error('OpenCode execution failed', {
      error: errorMessage,
      durationMs: duration,
    })

    const caughtLlmError = isLlmFetchError(error) ? createLLMFetchError(errorMessage) : null

    return {
      success: false,
      exitCode: 1,
      duration,
      sessionId: null,
      error: errorMessage,
      tokenUsage: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: caughtLlmError,
    }
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
    abortController.abort()
    server?.close()
  }
}

/**
 * Verify OpenCode is available and working.
 *
 * Runs `opencode --version` to ensure the binary is accessible.
 */
export async function verifyOpenCodeAvailable(
  opencodePath: string | null,
  logger: Logger,
): Promise<{available: boolean; version: string | null}> {
  const opencodeCmd = opencodePath ?? 'opencode'

  try {
    let version = ''
    await exec.exec(opencodeCmd, ['--version'], {
      listeners: {
        stdout: (data: Uint8Array) => {
          version += data.toString()
        },
      },
      silent: true,
    })

    const versionMatch = /(\d+\.\d+\.\d+)/.exec(version)
    const parsedVersion: string | null = versionMatch?.[1] ?? null

    logger.debug('OpenCode version verified', {version: parsedVersion})
    return {available: true, version: parsedVersion}
  } catch {
    logger.warning('OpenCode not available')
    return {available: false, version: null}
  }
}

export interface EnsureOpenCodeOptions {
  logger: Logger
  opencodeVersion: string
}

export async function ensureOpenCodeAvailable(options: EnsureOpenCodeOptions): Promise<EnsureOpenCodeResult> {
  const {logger, opencodeVersion} = options

  const existingPath = process.env.OPENCODE_PATH ?? null
  const check = await verifyOpenCodeAvailable(existingPath, logger)

  if (check.available && check.version != null) {
    logger.info('OpenCode already available', {version: check.version})
    return {
      path: existingPath ?? 'opencode',
      version: check.version,
      didSetup: false,
    }
  }

  logger.info('OpenCode not found, running auto-setup', {requestedVersion: opencodeVersion})

  const setupResult = await runSetup()

  if (setupResult == null) {
    throw new Error('Auto-setup failed: runSetup returned null')
  }

  core.addPath(setupResult.opencodePath)
  process.env.OPENCODE_PATH = setupResult.opencodePath

  logger.info('Auto-setup completed', {
    version: setupResult.opencodeVersion,
    path: setupResult.opencodePath,
  })

  return {
    path: setupResult.opencodePath,
    version: setupResult.opencodeVersion,
    didSetup: true,
  }
}
