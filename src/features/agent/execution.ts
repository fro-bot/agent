import type {ErrorInfo, OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {OpenCodeServerHandle} from './server-adapter.js'
import type {EventStreamResult, PermissionAskedResponder} from './streaming.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from './types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createLLMFetchError, isLlmFetchError, reassertSessionTitle, withScrubbedEnv} from '@fro-bot/runtime'
import {createOpencode} from '@opencode-ai/sdk'
import {DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {getGitHubWorkspace, getOpenCodeLogPath, isOpenCodePromptArtifactEnabled} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {buildContinuationPrompt, sendPromptToSession} from './prompt-sender.js'
import {buildAgentPrompt} from './prompt.js'
import {materializeReferenceFiles} from './reference-files.js'
import {inspectResponseFile} from './response-file.js'
import {
  createExecutionDeadline,
  MAX_LLM_RETRIES,
  mergeArtifactResults,
  RETRY_DELAYS_MS,
  type ExecutionDeadline,
} from './retry.js'
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
  let abortTimedOut = false
  try {
    const abortRequest = client.session.abort({path: {id: sessionId}, signal: abortController.signal})
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortTimedOut = true
        abortController.abort()
        reject(new Error(`Session abort timed out after ${SESSION_ABORT_TIMEOUT_MS}ms`))
      }, SESSION_ABORT_TIMEOUT_MS)
    })
    await Promise.race([abortRequest, timeout])
  } catch (error) {
    if (abortTimedOut) {
      logger.warning('OpenCode session abort exceeded teardown budget; continuing teardown', {sessionId})
    } else {
      logger.debug('OpenCode session abort failed; continuing teardown', {sessionId, error: toErrorMessage(error)})
    }
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId)
  }
}

export async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
  serverHandle?: OpenCodeServerHandle,
  ownershipLedger?: OwnershipLedger,
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
  // Set immediately before every return that reflects a decided outcome (success, or a failure
  // the attempt itself selected) -- never inferred afterward from deadline state, and never
  // cleared. See the finalizer below for why this replaces consulting the deadline alone.
  let terminalOutcomeAccepted = false
  // Mirrors `lastError`/`lastLlmError`: the most recent attempt's own `deferred` flag, read only
  // by the after-loop failure return below.
  let lastAttemptDeferred = false
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
    classificationPath: final.classificationPath,
  })

  try {
    let serverUrl: string | null = null
    if (serverHandle == null) {
      // This branch is currently unreachable from the Action: CacheRestorePhaseResult.serverHandle
      // is non-nullable, bootstrap failure returns early, and the execute phase always passes the
      // handle through. If it ever becomes live, note that it inherits OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      // only because bootstrapOpenCodeServer (server.ts) sets that env var as a side effect and
      // deliberately never reverts it -- nothing here sets it directly, so a spawn on this path would
      // otherwise start with the watcher on.
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
    const onPermissionAsked: PermissionAskedResponder = async request => {
      await sessionClient.postSessionIdPermissionsPermissionId({
        path: {id: request.sessionID, permissionID: request.requestID},
        body: {response: 'reject'},
        query: {directory},
        signal: deadline.signal,
      })
    }

    let lastError: string | null = null
    let promptAccepted = false
    let nextPrompt: {readonly kind: 'initial'} | {readonly kind: 'continuation'; readonly error: ErrorInfo} = {
      kind: 'initial',
    }
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (deadline.isExpired()) return timeoutResult()
      const retryDelay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0]

      const prompt =
        nextPrompt.kind === 'initial'
          ? initialPrompt
          : buildContinuationPrompt(nextPrompt.error, config?.credentialProvisioned === true)
      const files = allFileParts.length > 0 ? allFileParts : undefined
      const result = await (async () => {
        try {
          const attemptResult = await sendPromptToSession(
            sessionClient,
            activeSessionId,
            prompt,
            files,
            directory,
            config,
            logger,
            serverUrl,
            deadline,
            onPermissionAsked,
            ownershipLedger,
          )
          return attemptResult
        } finally {
          if (deadline.isExpired() === false)
            await reassertSessionTitle(sessionClient, activeSessionId, config?.sessionTitle, logger, {
              signal: deadline.signal,
              isExpired: deadline.isExpired,
              remainingMs: deadline.remainingMs,
            })
        }
      })()

      final = mergeArtifactResults(result.eventStreamResult, final)

      if (result.success) {
        terminalOutcomeAccepted = true
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
          classificationPath: final.classificationPath,
        }
      }

      lastError = result.error
      lastLlmError = result.llmError
      lastAttemptDeferred = result.deferred === true
      const promptWasAccepted = promptAccepted
      if (result.outcome !== 'submit_failed') promptAccepted = true

      const responseFileStatus = await inspectResponseFile(
        promptOptions.responseFilePath,
        promptOptions.responseSurface,
        logger,
      )
      if (responseFileStatus !== 'absent') break

      const canResendOriginalPrompt =
        result.outcome === 'submit_failed' && promptWasAccepted === false && result.llmError?.retryable === true
      const canContinueTurn = result.outcome === 'turn_failed_retryable'
      if (
        (canResendOriginalPrompt === false && canContinueTurn === false) ||
        attempt >= MAX_LLM_RETRIES ||
        deadline.isExpired()
      )
        break

      if (canContinueTurn) {
        // Defensive: a retryable turn failure always carries the error that made it
        // retryable, so this is unreachable today. Without an error there is nothing
        // to describe, and a continuation must never fall back to the original prompt.
        if (result.llmError == null) break
        nextPrompt = {kind: 'continuation', error: result.llmError}
      } else {
        nextPrompt = {kind: 'initial'}
      }

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

    // The loop can only reach here via a decided failure (response file present, non-retryable,
    // or retries exhausted) or because the shared deadline forced it to give up mid-retry. Only
    // the former is an accepted terminal outcome -- a deferred failure folded back after deadline
    // expiry (lastAttemptDeferred) means the deadline is why this attempt ended, not the attempt
    // itself, and the remote session must still be considered for abort.
    terminalOutcomeAccepted = lastAttemptDeferred === false
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
      classificationPath: final.classificationPath,
    }
  } catch (error) {
    if (deadline.isTimedOut()) return timeoutResult()
    // A genuine unexpected exception, not a synthesized timeout. Treat it as terminal unless the
    // wall-clock deadline had already expired when it was caught -- isExpired() (not isTimedOut())
    // so an in-flight expiry that the latched timer has not yet observed still counts.
    terminalOutcomeAccepted = deadline.isExpired() === false
    const duration = Date.now() - startTime
    const errorMessage = toErrorMessage(error)
    const transportFailure = isLlmFetchError(error)
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
      llmError: transportFailure ? createLLMFetchError(errorMessage) : null,
      classificationPath: transportFailure ? 'fallback' : 'unclassified',
    }
  } finally {
    // Teardown must abort only when BOTH hold: the wall-clock deadline expired, and no terminal
    // outcome was accepted. Neither condition alone is enough -- four rounds of regressions on this
    // function family (see retry.ts's runPromptAttempt deferred-failure handling) each fixed one and
    // broke its mirror image:
    //   1. a failed prompt submission was silently discarded when the ownership ledger deferred
    //      completion (a failure could report success);
    //   2. restoring it after the deadline throw let expiry replace it with a generic timeout;
    //   3. suppressing that throw meant a normal return, which cleared a caller-tracked
    //      `shouldAbortRemoteOnTimeout` flag, so an expired session was never aborted;
    //   4. deleting that flag in favor of consulting `deadline.isTimedOut()` alone made the abort
    //      unconditional on expiry, so a run that succeeded before the deadline -- whose bounded
    //      stream cleanup then crossed it -- had its already-reported-successful remote session
    //      aborted anyway. Upstream, aborting a session cancels its background jobs regardless of
    //      whether it already completed, which is exactly the owned work `runDrain` (running after
    //      this finalizer, see harness/run.ts) exists to settle gracefully -- an unconditional abort
    //      here pre-empts that mechanism entirely.
    //
    // `deadline.isExpired()` (not `isTimedOut()`) is used for the first condition: `isTimedOut()` is
    // latched timer state, so under event-loop starvation teardown could observe `false`, dispose the
    // timer, and skip aborting genuinely unfinished work -- the same failure mode as round 2, just on
    // the other side of the deadline. `isExpired()` checks wall-clock time on demand and only falls
    // back to the latch, so it is authoritative even when the timer callback has not yet run.
    //
    // `terminalOutcomeAccepted` is the second condition, and unlike the deleted flag it is derived
    // from the result rather than threaded through control flow: it is set exactly once, immediately
    // before each return that reflects a decided outcome (success, or a failure the attempt itself
    // selected, as opposed to one the deadline had to conclude on the attempt's behalf -- see
    // retry.ts's `deferred` field on `AttemptResult`). Once a return statement sets it, the value is
    // already final; nothing between that assignment and this finalizer can change what was decided,
    // so it cannot go stale the way a flag tracking control flow can.
    if (deadline.isExpired() && terminalOutcomeAccepted === false && client != null && sessionId != null)
      await abortRemoteSession(client, sessionId, logger)
    deadline.dispose()
    if (ownsServer) server?.close()
  }
}
