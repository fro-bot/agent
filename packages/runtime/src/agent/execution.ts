import type {createOpencode} from '@opencode-ai/sdk'
import type {Logger} from '../shared/logger.js'
import type {PromptAttemptRunner} from './prompt-sender.js'
import type {ErrorInfo, ExecutionConfig, PromptOptions} from './types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createOpencode as createOpencodeClient} from '@opencode-ai/sdk'
import {reassertSessionTitle} from '../session/index.js'
import {sleep} from '../shared/async.js'
import {DEFAULT_AGENT, DEFAULT_TIMEOUT_MS} from '../shared/constants.js'
import {getGitHubWorkspace, getOpenCodeLogPath, isOpenCodePromptArtifactEnabled} from '../shared/env.js'
import {toErrorMessage} from '../shared/errors.js'
import {createLLMFetchError, isLlmFetchError} from './llm-error-helpers.js'
import {CONTINUATION_PROMPT, sendPromptToSession} from './prompt-sender.js'
import {buildAgentPrompt} from './prompt.js'
import {materializeReferenceFiles} from './reference-files.js'
import {MAX_LLM_RETRIES, RETRY_DELAYS_MS} from './retry.js'

interface RuntimeServerHandle {
  readonly client: Awaited<ReturnType<typeof createOpencode>>['client']
  readonly server: {close: () => void}
}

export async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
  serverHandle?: RuntimeServerHandle,
  promptAttemptRunner?: PromptAttemptRunner,
): Promise<{
  readonly success: boolean
  readonly exitCode: number
  readonly duration: number
  readonly sessionId: string | null
  readonly error: string | null
  readonly tokenUsage: unknown
  readonly model: string | null
  readonly cost: number | null
  readonly prsCreated: readonly string[]
  readonly commitsCreated: readonly string[]
  readonly commentsPosted: number
  readonly llmError: ErrorInfo | null
}> {
  const startTime = Date.now()
  const abortController = new AbortController()
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  const ownsServer = serverHandle == null
  let server: Awaited<ReturnType<typeof createOpencodeClient>>['server'] | null = null

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true
      logger.warning('Execution timeout reached', {timeoutMs})
      abortController.abort()
    }, timeoutMs)
  }

  logger.info('Executing OpenCode agent (SDK mode)', {
    agent: config?.agent ?? DEFAULT_AGENT,
    hasModelOverride: config?.model != null,
    timeoutMs,
  })

  try {
    let client: Awaited<ReturnType<typeof createOpencodeClient>>['client']
    if (serverHandle == null) {
      const opencode = await createOpencodeClient({signal: abortController.signal})
      client = opencode.client
      server = opencode.server
    } else {
      client = serverHandle.client
    }

    let sessionId: string
    if (config?.continueSessionId == null) {
      const createPayload =
        config?.sessionTitle == null ? undefined : ({body: {title: config.sessionTitle}} as Record<string, unknown>)
      const sessionResponse =
        createPayload == null ? await client.session.create() : await client.session.create(createPayload)
      if (sessionResponse.data == null || sessionResponse.error != null) {
        throw new Error(
          `Failed to create session: ${sessionResponse.error == null ? 'No data returned' : String(sessionResponse.error)}`,
        )
      }
      sessionId = sessionResponse.data.id
      logger.info('Created new OpenCode session', {sessionId, sessionTitle: config?.sessionTitle ?? null})
    } else {
      sessionId = config.continueSessionId
      logger.info('Continuing existing OpenCode session', {sessionId})
    }

    const {text: initialPrompt, referenceFiles} = buildAgentPrompt({...promptOptions, sessionId}, logger)
    const directory = getGitHubWorkspace()
    const logPath = getOpenCodeLogPath()
    await fs.mkdir(logPath, {recursive: true})

    if (isOpenCodePromptArtifactEnabled()) {
      const hash = crypto.createHash('sha256').update(initialPrompt).digest('hex')
      const artifactPath = path.join(logPath, `prompt-${sessionId}-${hash.slice(0, 8)}.txt`)
      try {
        await fs.writeFile(artifactPath, initialPrompt, 'utf8')
        logger.info('Prompt artifact written', {hash, path: artifactPath})
      } catch (error) {
        logger.warning('Failed to write prompt artifact', {
          error: error instanceof Error ? error.message : String(error),
          path: artifactPath,
        })
      }
    }

    const referenceFileParts = await materializeReferenceFiles(referenceFiles, logPath, logger)
    const allFileParts = [...(promptOptions.fileParts ?? []), ...referenceFileParts]

    let final = {
      tokens: null,
      model: null,
      cost: null,
      prsCreated: [] as string[],
      commitsCreated: [] as string[],
      commentsPosted: 0,
      llmError: null as ErrorInfo | null,
    }
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
          tokenUsage: final.tokens,
          model: final.model,
          cost: final.cost,
          prsCreated: final.prsCreated,
          commitsCreated: final.commitsCreated,
          commentsPosted: final.commentsPosted,
          llmError: lastLlmError,
        }
      }

      const retryDelay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0]
      if (timeoutMs > 0 && timeoutMs - (Date.now() - startTime) <= retryDelay && attempt > 1) break

      const prompt = attempt === 1 ? initialPrompt : CONTINUATION_PROMPT
      const files = allFileParts.length > 0 ? allFileParts : undefined
      const result = await (async () => {
        try {
          return await sendPromptToSession(
            client,
            sessionId,
            prompt,
            files,
            directory,
            config,
            logger,
            promptAttemptRunner,
          )
        } finally {
          await reassertSessionTitle(client, sessionId, config?.sessionTitle, logger)
        }
      })()

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
        delayMs: retryDelay,
        sessionId,
      })
      await sleep(retryDelay)
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
