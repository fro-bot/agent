import type {ErrorInfo, OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {AttemptResult} from './prompt-sender.js'
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
  // The execution's selected stopping cause: 'deadline' when the shared deadline is what ended
  // observation, 'other' for every other decided outcome (success, a failure the attempt itself
  // selected, or an unexpected exception unrelated to the deadline). Set exactly once per decision
  // point, immediately before or alongside the return/break it explains -- never re-derived later
  // from a fresh clock read, and never cleared once set. This is the sole input the finalizer
  // consults; see its comment for why it never touches the clock itself. Governing invariant:
  // selecting an error never proves quiescence, and observing quiescence never erases an error.
  let stoppingCause: 'deadline' | 'other' | null = null
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
      // Deadline admission failure before another attempt: the deadline itself is what prevents
      // this attempt from starting at all.
      if (deadline.isExpired()) {
        stoppingCause = 'deadline'
        return timeoutResult()
      }
      const retryDelay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0]

      const prompt =
        nextPrompt.kind === 'initial'
          ? initialPrompt
          : buildContinuationPrompt(nextPrompt.error, config?.credentialProvisioned === true)
      const files = allFileParts.length > 0 ? allFileParts : undefined
      const result: AttemptResult = await (async (): Promise<AttemptResult> => {
        try {
          return await sendPromptToSession(
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
        // Completion is never a deadline cause, regardless of the clock -- observing quiescence
        // never erases an error, and here there is no error to erase.
        stoppingCause = 'other'
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

      // A bare deadline settlement with no failure to report (retry.ts's `AttemptOutcome ===
      // 'timeout'`) is the canonical timed-out attempt: nothing was decided but the deadline
      // itself, so this ends the execution immediately with the standard timeout result rather
      // than surfacing the settlement's raw internal diagnostic text.
      if (result.outcome === 'timeout') {
        stoppingCause = 'deadline'
        return timeoutResult()
      }

      lastError = result.error
      lastLlmError = result.llmError
      // The attempt itself states what ended it -- read here, never re-derived from a clock read
      // taken after the fact. Only a `deadline` settlement authorizes teardown to abort; every other
      // settlement (a selected failure, a cancellation, a watchdog) is 'other', regardless of
      // whether the clock happens to show expired by the time control returns here. Replaces the old
      // ledger-coupled heuristic; see 'preserves a pre-deadline retryable failure when cleanup
      // crosses the deadline without retrying' (opencode.test.ts) for the regression this still
      // covers -- for the right reason now.
      stoppingCause = result.settlement.kind === 'deadline' ? 'deadline' : 'other'
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
      // Retry admission gate 1: an attempt whose own settlement was the deadline (captured above)
      // never earns another attempt, regardless of outcome classification.
      const settlementAdmitsRetry = stoppingCause !== 'deadline'
      // Retry admission gate 2: owned work must finish draining before another attempt starts --
      // an outstanding or unknown ledger entry means this run cannot yet prove it is safe to keep
      // going, independent of what the last attempt's own outcome was.
      const ledgerAdmitsRetry = ownershipLedger == null || ownershipLedger.isDrainComplete()
      if (
        (canResendOriginalPrompt === false && canContinueTurn === false) ||
        attempt >= MAX_LLM_RETRIES ||
        settlementAdmitsRetry === false ||
        ledgerAdmitsRetry === false
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
      // Admission control for the committed retry delay: if cleanup (inspectResponseFile, above)
      // already exhausted the budget, the previous failure and its (non-deadline) cause stand as
      // decided -- do not manufacture a deadline throw here, and do not let it become an abort
      // cause on the previous attempt's behalf. Only a deadline that concludes the delay itself,
      // once committed (below), ends the execution by deadline.
      if (deadline.isExpired()) break

      await deadline.run(async () => {
        await waitForAbortableDelay(retryDelay, deadline.signal)
      }, 'retry delay')
    }

    // The loop can only reach here via a decided failure (response file present, non-retryable, or
    // retries exhausted -- the same post-loop path either way) or because the shared deadline
    // admission checks above forced it to give up mid-retry. `stoppingCause` was already set,
    // per attempt, at the point each failure settled (see attemptDeadlineExpiredAtSettle above) --
    // nothing here re-derives it from a fresh clock read.
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
    // An explicit, tagged deadline rejection (deadline.run() losing its internal race during
    // setup, submission, or a committed retry delay) is the one exception that IS a deadline cause
    // -- identified by name, never by re-deriving it from clock state.
    if (error instanceof Error && error.name === 'DeadlineExceededError') {
      stoppingCause = 'deadline'
      return timeoutResult()
    }
    // A genuine unexpected exception, untagged as a deadline rejection (already ruled out above by
    // name): it never became an AttemptResult, so there is no settlement to read -- this is the one
    // place in this function where a clock read is genuinely unavoidable rather than a re-derivation
    // of a decision already made elsewhere. Nothing was decided for this attempt, so quiescence
    // cannot be proven; selecting this error does not prove the remote session is done. Deliberate
    // choice: if the deadline has already expired, default to deadline-caused so teardown aborts
    // (an unexpected exception plus an expired clock still means nothing was decided, so this errs
    // toward not leaving the remote session ownerless); if the deadline has not expired, 'other'
    // leaves teardown with no abort authority, same as any other undecided failure.
    stoppingCause = deadline.isExpired() ? 'deadline' : 'other'
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
    // Finalizer rule: abort the root session if and only if the execution's selected stopping
    // cause is 'deadline', and a client and session exist. This never consults the clock -- no
    // isExpired(), no isTimedOut() -- because that re-derivation-after-an-await is exactly the bug
    // pattern seven review rounds kept reintroducing (each fix read the clock at a slightly
    // different, still-wrong moment). `stoppingCause` is set exactly once per decision point,
    // synchronously with the return/break it explains, so by the time teardown runs it is already
    // final and cannot have gone stale from cleanup that ran afterward.
    //
    // This deliberately does not widen the narrow existing abort responsibility: a non-deadline
    // provider failure, a watchdog failure, and a stream problem all set stoppingCause to 'other'
    // and must not newly authorize a root abort here -- "do not abort here" means this run has no
    // authority to cancel the session, not that the session is known to be quiescent. Local
    // cancellation of a losing racer inside sendPromptToSession/runPromptAttempt is cleanup, not an
    // execution settlement, and is never consulted here either.
    if (stoppingCause === 'deadline' && client != null && sessionId != null)
      await abortRemoteSession(client, sessionId, logger)
    deadline.dispose()
    if (ownsServer) server?.close()
  }
}
