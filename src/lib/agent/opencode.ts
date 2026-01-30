/**
 * OpenCode SDK execution for RFC-013 and RFC-014.
 *
 * Handles launching OpenCode in server mode and communicating via SDK client.
 * Replaces CLI-based execution from RFC-012 with SDK-based execution.
 * RFC-014 adds file attachment support via SDK file parts.
 */

import type {Event, FilePartInput, TextPartInput} from '@opencode-ai/sdk'
import type {ErrorInfo} from '../comments/types.js'
import type {Logger} from '../logger.js'
import type {TokenUsage} from '../types.js'
import type {AgentResult, EnsureOpenCodeResult, ExecutionConfig, PromptOptions} from './types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {createOpencode} from '@opencode-ai/sdk'
import {sleep} from '../../utils/async.js'
import {outputTextContent, outputToolExecution} from '../../utils/console.js'
import {getGitHubWorkspace, getOpenCodeLogPath, isOpenCodePromptArtifactEnabled} from '../../utils/env.js'
import {toErrorMessage} from '../../utils/errors.js'
import {createAgentError, createLLMFetchError, isAgentNotFoundError, isLlmFetchError} from '../comments/error-format.js'
import {DEFAULT_MODEL, DEFAULT_TIMEOUT_MS} from '../constants.js'
import {extractCommitShas, extractGithubUrls} from '../github/urls.js'
import {runSetup} from '../setup/setup.js'
import {buildAgentPrompt} from './prompt.js'

/** Log a server event at debug level for troubleshooting. */
export function logServerEvent(event: Event, logger: Logger): void {
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
  stream: AsyncIterable<Event>,
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

    if (event.type === 'message.part.updated') {
      const part = event.properties.part
      if (part.sessionID !== sessionId) continue

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
          const toolName = part.tool
          const toolInput = toolState.input
          const title = toolState.title
          outputToolExecution(toolName, title)

          if (toolName.toLowerCase() === 'bash') {
            const command = String(toolInput.command ?? toolInput.cmd ?? '')
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
    } else if (event.type === 'session.error') {
      const errorSessionID = event.properties.sessionID
      if (errorSessionID === sessionId) {
        const sessionError = event.properties.error
        logger.error('Session error', {error: sessionError})

        const errorStr = typeof sessionError === 'string' ? sessionError : String(sessionError)

        if (isLlmFetchError(sessionError)) {
          llmError = createLLMFetchError(errorStr, model ?? undefined)
        } else if (isAgentNotFoundError(errorStr)) {
          llmError = createAgentError(errorStr)
        } else {
          llmError = createAgentError(errorStr)
        }
        break
      }
    } else if (event.type === 'session.idle') {
      const idleSessionID = event.properties.sessionID
      if (idleSessionID === sessionId) {
        if (lastText.length > 0) {
          outputTextContent(lastText)
          lastText = ''
        }
        break
      }
    }
  }

  if (lastText.length > 0) {
    outputTextContent(lastText)
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
  directory: string,
  config: ExecutionConfig | undefined,
  logger: Logger,
): Promise<PromptAttemptResult> {
  const agentName = (config?.agent ?? 'Sisyphus').toLowerCase()

  const events = await client.event.subscribe()
  const eventController =
    'controller' in events ? ((events as {controller?: AbortController}).controller ?? null) : null

  let eventStreamResult: EventStreamResult = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }

  const eventProcessingPromise = processEventStream(events.stream as AsyncIterable<Event>, sessionId, logger)
    .then(result => {
      eventStreamResult = result
    })
    .catch(error => {
      if (error instanceof Error && error.name !== 'AbortError') {
        logger.debug('Event stream error', {error: error.message})
      }
    })

  const textPart: TextPartInput = {type: 'text', text: promptText}
  const parts: (TextPartInput | FilePartInput)[] = [textPart]

  if (fileParts != null && fileParts.length > 0) {
    parts.push(...fileParts)
    logger.info('Including file attachments in prompt', {count: fileParts.length})
  }

  const model =
    config?.model == null
      ? {providerID: DEFAULT_MODEL.providerID, modelID: DEFAULT_MODEL.modelID}
      : {providerID: config.model.providerID, modelID: config.model.modelID}

  const promptBody: {
    agent?: string
    model?: {modelID: string; providerID: string}
    parts: (TextPartInput | FilePartInput)[]
  } = {
    agent: agentName,
    model,
    parts,
  }

  logger.debug('Sending prompt to OpenCode', {sessionId})
  const promptResponse = await client.session.promptAsync({
    path: {id: sessionId},
    body: promptBody,
    query: {directory},
  })

  if (promptResponse.error != null && eventController != null) {
    eventController.abort()
  }

  await eventProcessingPromise

  if (eventController != null) {
    eventController.abort()
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
    const directory = getGitHubWorkspace()

    // Write prompt artifact if enabled (RFC-018)
    if (isOpenCodePromptArtifactEnabled()) {
      const logPath = getOpenCodeLogPath()
      const hash = crypto.createHash('sha256').update(initialPrompt).digest('hex')
      const artifactPath = path.join(logPath, `prompt-${sessionId}-${hash.slice(0, 8)}.txt`)

      try {
        await fs.mkdir(logPath, {recursive: true})
        await fs.writeFile(artifactPath, initialPrompt, 'utf8')
        logger.info('Prompt artifact written', {hash, path: artifactPath})
      } catch (error) {
        logger.warning('Failed to write prompt artifact', {
          error: error instanceof Error ? error.message : String(error),
          path: artifactPath,
        })
      }
    }

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
          directory,
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

        await sleep(RETRY_DELAY_MS)
      } catch (error) {
        const errorMessage = toErrorMessage(error)
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

        await sleep(RETRY_DELAY_MS)
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
    const errorMessage = toErrorMessage(error)

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
