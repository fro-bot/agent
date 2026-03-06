import type {Logger} from '../../shared/logger.js'
import type {ErrorInfo} from '../comments/types.js'
import type {OpenCodeServerHandle} from './server.js'
import type {EventStreamResult} from './streaming.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from './types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createOpencode} from '@opencode-ai/sdk'
import {sleep} from '../../shared/async.js'
import {DEFAULT_AGENT, DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {getGitHubWorkspace, getOpenCodeLogPath, isOpenCodePromptArtifactEnabled} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLLMFetchError, isLlmFetchError} from '../comments/error-format.js'
import {CONTINUATION_PROMPT, sendPromptToSession} from './prompt-sender.js'
import {buildAgentPrompt} from './prompt.js'
import {MAX_LLM_RETRIES, RETRY_DELAY_MS} from './retry.js'

export async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
  serverHandle?: OpenCodeServerHandle,
): Promise<AgentResult> {
  const startTime = Date.now()
  const abortController = new AbortController()
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  const ownsServer = serverHandle == null
  let server: Awaited<ReturnType<typeof createOpencode>>['server'] | null = null

  if (timeoutMs > 0)
    timeoutId = setTimeout(() => {
      timedOut = true
      logger.warning('Execution timeout reached', {timeoutMs})
      abortController.abort()
    }, timeoutMs)
  logger.info('Executing OpenCode agent (SDK mode)', {
    agent: config?.agent ?? DEFAULT_AGENT,
    hasModelOverride: config?.model != null,
    timeoutMs,
  })

  try {
    let client: Awaited<ReturnType<typeof createOpencode>>['client']
    if (serverHandle == null) {
      const opencode = await createOpencode({signal: abortController.signal})
      client = opencode.client
      server = opencode.server
    } else client = serverHandle.client

    const sessionResponse = await client.session.create()
    if (sessionResponse.data == null || sessionResponse.error != null)
      throw new Error(
        `Failed to create session: ${sessionResponse.error == null ? 'No data returned' : String(sessionResponse.error)}`,
      )
    const sessionId = sessionResponse.data.id
    const initialPrompt = buildAgentPrompt({...promptOptions, sessionId}, logger)
    const directory = getGitHubWorkspace()

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

    let final: EventStreamResult = {
      tokens: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: null,
    }
    let lastError: string | null = null
    let lastLlmError: ErrorInfo | null = null
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (timedOut)
        return {
          success: false,
          exitCode: 130,
          duration: Date.now() - startTime,
          sessionId,
          error: `Execution timed out after ${timeoutMs}ms`,
          tokenUsage: final.tokens,
          model: final.model,
          cost: final.cost,
          prsCreated: final.prsCreated,
          commitsCreated: final.commitsCreated,
          commentsPosted: final.commentsPosted,
          llmError: lastLlmError,
        }
      if (timeoutMs > 0 && timeoutMs - (Date.now() - startTime) <= RETRY_DELAY_MS && attempt > 1) break

      const prompt = attempt === 1 ? initialPrompt : CONTINUATION_PROMPT
      const files = attempt === 1 ? promptOptions.fileParts : undefined
      const result = await sendPromptToSession(client, sessionId, prompt, files, directory, config, logger)
      if (result.success) {
        final = result.eventStreamResult
        return {
          success: true,
          exitCode: 0,
          duration: Date.now() - startTime,
          sessionId,
          error: null,
          tokenUsage: final.tokens,
          model: final.model,
          cost: final.cost,
          prsCreated: final.prsCreated,
          commitsCreated: final.commitsCreated,
          commentsPosted: final.commentsPosted,
          llmError: null,
        }
      }

      lastError = result.error
      lastLlmError = result.llmError
      if (!result.shouldRetry || attempt >= MAX_LLM_RETRIES) break
      logger.warning('LLM fetch error detected, retrying with continuation prompt', {
        attempt,
        maxAttempts: MAX_LLM_RETRIES,
        error: result.error,
        delayMs: RETRY_DELAY_MS,
        sessionId,
      })
      await sleep(RETRY_DELAY_MS)
    }

    return {
      success: false,
      exitCode: 1,
      duration: Date.now() - startTime,
      sessionId,
      error: lastError ?? 'Unknown error',
      tokenUsage: final.tokens,
      model: final.model,
      cost: final.cost,
      prsCreated: final.prsCreated,
      commitsCreated: final.commitsCreated,
      commentsPosted: final.commentsPosted,
      llmError: lastLlmError,
    }
  } catch (error) {
    const duration = Date.now() - startTime
    const errorMessage = toErrorMessage(error)
    logger.error('OpenCode execution failed', {error: errorMessage, durationMs: duration})
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
      llmError: isLlmFetchError(error) ? createLLMFetchError(errorMessage) : null,
    }
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId)
    abortController.abort()
    if (ownsServer) server?.close()
  }
}
