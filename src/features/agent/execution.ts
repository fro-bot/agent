import type {ErrorInfo} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {OpenCodeServerHandle} from './server.js'
import type {EventStreamResult} from './streaming.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from './types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createLLMFetchError, isLlmFetchError, reassertSessionTitle, withScrubbedEnv} from '@fro-bot/runtime'
import {createOpencode} from '@opencode-ai/sdk'
import {DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {getGitHubWorkspace, getOpenCodeLogPath, isOpenCodePromptArtifactEnabled} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {CONTINUATION_PROMPT, sendPromptToSession} from './prompt-sender.js'
import {buildAgentPrompt} from './prompt.js'
import {materializeReferenceFiles} from './reference-files.js'
import {createExecutionDeadline, MAX_LLM_RETRIES, RETRY_DELAYS_MS, type ExecutionDeadline} from './retry.js'
import {waitForAbortableDelay} from './session-poll.js'

const SESSION_ABORT_TIMEOUT_MS = 2_000

async function abortRemoteSession(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  logger: Logger,
): Promise<void> {
  if (typeof client.session.abort !== 'function') return

  const abortController = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const abortRequest = client.session.abort({path: {id: sessionId}, signal: abortController.signal})
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort()
        reject(new Error(`Session abort timed out after ${SESSION_ABORT_TIMEOUT_MS}ms`))
      }, SESSION_ABORT_TIMEOUT_MS)
    })
    await Promise.race([abortRequest, timeout])
  } catch (error) {
    logger.debug('Timed-out OpenCode session abort failed; continuing teardown', {
      sessionId,
      error: toErrorMessage(error),
    })
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId)
  }
}

export async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
  serverHandle?: OpenCodeServerHandle,
): Promise<AgentResult> {
  const startTime = Date.now()
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline: ExecutionDeadline = createExecutionDeadline(timeoutMs, logger)
  const ownsServer = serverHandle == null
  let server: Awaited<ReturnType<typeof createOpencode>>['server'] | null = null
  let client: Awaited<ReturnType<typeof createOpencode>>['client'] | null = null
  let sessionId: string | null = null
  let final: EventStreamResult = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }
  let lastLlmError: ErrorInfo | null = null
  logger.info('Executing OpenCode agent (SDK mode)', {
    agent: config?.agent ?? 'build (default)',
    hasModelOverride: config?.model != null,
    timeoutMs,
  })

  const timeoutResult = (): AgentResult => ({
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
  })

  try {
    let serverUrl: string | null = null
    if (serverHandle == null) {
      const opencode = await deadline.run(
        async () => withScrubbedEnv(async () => createOpencode({signal: deadline.signal}), logger),
        'OpenCode server creation',
      )
      client = opencode.client
      server = opencode.server
      serverUrl = opencode.server.url
    } else {
      client = serverHandle.client
      serverUrl = serverHandle.server.url
    }
    if (client == null) throw new Error('OpenCode client was not initialized')
    const sessionClient = client

    if (config?.continueSessionId == null) {
      const createPayload =
        config?.sessionTitle == null ? undefined : ({body: {title: config.sessionTitle}} as Record<string, unknown>)
      const sessionResponse = await deadline.run(
        async () =>
          createPayload == null
            ? sessionClient.session.create({signal: deadline.signal})
            : sessionClient.session.create({...createPayload, signal: deadline.signal}),
        'session creation',
      )
      if (sessionResponse.data == null || sessionResponse.error != null)
        throw new Error(
          `Failed to create session: ${sessionResponse.error == null ? 'No data returned' : String(sessionResponse.error)}`,
        )
      sessionId = sessionResponse.data.id
      logger.info('Created new OpenCode session', {sessionId, sessionTitle: config?.sessionTitle ?? null})
    } else {
      sessionId = config.continueSessionId
      logger.info('Continuing existing OpenCode session', {sessionId})
    }
    if (sessionId == null) throw new Error('OpenCode session was not initialized')
    const activeSessionId = sessionId
    const {text: initialPrompt, referenceFiles} = buildAgentPrompt({...promptOptions, sessionId}, logger)
    const directory = getGitHubWorkspace()
    const logPath = getOpenCodeLogPath()
    await deadline.run(async () => fs.mkdir(logPath, {recursive: true}), 'OpenCode log directory creation')

    if (isOpenCodePromptArtifactEnabled()) {
      const hash = crypto.createHash('sha256').update(initialPrompt).digest('hex')
      const artifactPath = path.join(logPath, `prompt-${sessionId}-${hash.slice(0, 8)}.txt`)
      try {
        await deadline.run(async () => fs.writeFile(artifactPath, initialPrompt, 'utf8'), 'prompt artifact write')
        logger.info('Prompt artifact written', {hash, path: artifactPath})
      } catch (error) {
        logger.warning('Failed to write prompt artifact', {
          error: error instanceof Error ? error.message : String(error),
          path: artifactPath,
        })
      }
    }

    const referenceFileParts = await deadline.run(
      async () => materializeReferenceFiles(referenceFiles, logPath, logger),
      'reference file materialization',
    )
    const allFileParts = [...(promptOptions.fileParts ?? []), ...referenceFileParts]

    let lastError: string | null = null
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (deadline.isExpired()) return timeoutResult()
      const retryDelay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0]

      const prompt = attempt === 1 ? initialPrompt : CONTINUATION_PROMPT
      const files = allFileParts.length > 0 ? allFileParts : undefined
      const result = await (async () => {
        try {
          return await deadline.run(
            async () =>
              sendPromptToSession(
                sessionClient,
                activeSessionId,
                prompt,
                files,
                directory,
                config,
                logger,
                serverUrl,
                deadline,
              ),
            'OpenCode prompt attempt',
          )
        } finally {
          if (deadline.isExpired() === false)
            await reassertSessionTitle(sessionClient, activeSessionId, config?.sessionTitle, logger, {
              signal: deadline.signal,
              isExpired: deadline.isExpired,
              remainingMs: deadline.remainingMs,
            })
        }
      })()

      if (deadline.isExpired()) return timeoutResult()

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
      await deadline.run(async () => {
        await waitForAbortableDelay(retryDelay, deadline.signal)
      }, 'retry delay')
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
    if (deadline.isTimedOut()) return timeoutResult()
    const duration = Date.now() - startTime
    const errorMessage = toErrorMessage(error)
    logger.error('OpenCode execution failed', {error: errorMessage, durationMs: duration})
    return {
      success: false,
      exitCode: 1,
      duration,
      sessionId,
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
    if (deadline.isTimedOut() && client != null && sessionId != null)
      await abortRemoteSession(client, sessionId, logger)
    deadline.dispose()
    if (ownsServer) server?.close()
  }
}
