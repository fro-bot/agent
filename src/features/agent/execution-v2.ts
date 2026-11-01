import type {ActionOpenCodeV2Client, ErrorInfo, OpenCodeV2ServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {AgentResultV2, AttemptResultV2, LiveObservationV2} from './live-observation-v2.js'
import type {FormAskV2, PermissionAskV2} from './streaming-v2.js'
import type {EventStreamResult} from './streaming.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from './types.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {
  buildAttachmentDir,
  createActionOpenCodeV2Client,
  createAttachmentDirExclusive,
  createLLMFetchError,
  isLlmFetchError,
} from '@fro-bot/runtime'
import {DEFAULT_MODEL, DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {
  getGitHubRunAttempt,
  getGitHubRunId,
  getOpenCodeLogPath,
  isOpenCodePromptArtifactEnabled,
} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {sendPromptToSessionV2} from './prompt-sender-v2.js'
import {buildAgentPrompt} from './prompt.js'
import {materializeReferenceFiles} from './reference-files.js'
import {createExecutionDeadline, MAX_LLM_RETRIES, RETRY_DELAYS_MS} from './retry.js'
import {waitForAbortableDelay} from './session-poll.js'
import {collectRunUsageV2, readSessionUsageV2, type SessionUsageV2} from './usage-v2.js'

const SESSION_INTERRUPT_TIMEOUT_MS = 2_000
const PERMISSION_REPLY_TIMEOUT_MS = 5_000
const PERMISSION_REPLY_MAX_ATTEMPTS = 2
const FORM_CANCEL_TIMEOUT_MS = 10_000
const FORM_CANCEL_MESSAGE = 'This run cannot answer questions. Continue without an answer.'

/**
 * Run a prompt to completion on OpenCode V2: the sibling of `executeOpenCode`. The deadline, the one-comment protocol and
 * the result shape are V1's; the retry policy is not: a turn that fails after the send ends the run (V2 retries transient
 * provider errors itself), and only a prompt that never reached a turn is sent again; what changes is the wire (`/api/*` through the runtime remote
 * client over the server handle's authenticated fetch) and where the model and agent live (the session, not the prompt).
 *
 * Release boundary: after the attempt this returns, and `releaseRunV2` (`drain-v2.ts`, called from `run.ts`) decides when
 * the server may go. Root idle is not terminal on V2 (a background child's notice starts a second turn, probe P2), so
 * what this function reports is the root's own turn; the drain waits for the directory, and on a deadline the stop path
 * kills the shells and interrupts every owned session. This function interrupts only the root, on the Action's own
 * timeout.
 *
 * Usage: the V2 mapper maps no usage event, so tokens, cost and model are read from the session records
 * (`usage-v2.ts`) once the attempt is over.
 */

/**
 * Reject one permission ask. Never `once` or `always`: `always` would be stored upstream as a saved permission outliving
 * the run (#1990). Bounded by its own timeout and a small retry budget, independent of the run's deadline, because the
 * stream fires this without awaiting it.
 */
export async function replyToPermissionAskV2(client: ActionOpenCodeV2Client, request: PermissionAskV2): Promise<void> {
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= PERMISSION_REPLY_MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await client.replyPermission({
        sessionId: request.sessionId,
        requestId: request.requestId,
        decision: 'reject',
        signal: AbortSignal.timeout(PERMISSION_REPLY_TIMEOUT_MS),
      })
      if (reply.success) return
      lastError =
        reply.error.kind === 'http' || reply.error.kind === 'auth'
          ? `${reply.error.kind} ${reply.error.status}`
          : reply.error.kind
    } catch (error) {
      lastError = toErrorMessage(error)
    }
  }
  throw new Error(`Permission reply failed after ${PERMISSION_REPLY_MAX_ATTEMPTS} attempt(s): ${lastError}`)
}

/** Cancel one form. Rejects when the cancel fails; the stream logs that and the run continues. */
export async function cancelFormV2(client: ActionOpenCodeV2Client, form: FormAskV2): Promise<void> {
  const result = await client.cancelForm({
    sessionId: form.sessionId,
    formId: form.formId,
    message: FORM_CANCEL_MESSAGE,
    signal: AbortSignal.timeout(FORM_CANCEL_TIMEOUT_MS),
  })
  if (!result.success) {
    throw new Error(
      `Form cancel failed: ${result.error.kind === 'http' || result.error.kind === 'auth' ? `${result.error.kind} ${result.error.status}` : result.error.kind}`,
    )
  }
}

/**
 * Interrupt the root through the V2 interrupt route. `{interrupted: false}` only means nothing active was interrupted
 * (idle, or a prompt not admitted yet, probe P1), so it is logged and never read as a stop. Best-effort and bounded.
 */
export async function interruptRootSession(
  client: ActionOpenCodeV2Client,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    const result = await client.interrupt({sessionId, signal: AbortSignal.timeout(SESSION_INTERRUPT_TIMEOUT_MS)})
    if (!result.success) {
      logger.warning('OpenCode V2 session interrupt failed; continuing teardown', {sessionId, error: result.error.kind})
    } else if (!result.data.interrupted) {
      logger.debug('OpenCode V2 session interrupt found nothing active', {sessionId})
    }
  } catch (error) {
    logger.debug('OpenCode V2 session interrupt threw; continuing teardown', {sessionId, error: toErrorMessage(error)})
  }
}

/** Best-effort re-assertion of the title V2 may have regenerated after the first prompt. */
async function reassertSessionTitleV2(
  client: ActionOpenCodeV2Client,
  sessionId: string,
  title: string | undefined,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  if (title === undefined) return
  try {
    const result = await client.updateSession({sessionId, title, signal})
    if (!result.success && !signal.aborted) {
      logger.warning('Best-effort session title re-assertion failed', {sessionId, error: result.error.kind})
    }
  } catch (error) {
    if (!signal.aborted) {
      logger.warning('Best-effort session title re-assertion failed', {sessionId, error: toErrorMessage(error)})
    }
  }
}

/** The V2 client over the handle's authenticated fetch: the password never leaves the handle. */
export function createActionClientV2(handle: OpenCodeV2ServerHandle): ActionOpenCodeV2Client {
  return createActionOpenCodeV2Client({
    baseUrl: handle.url,
    fetch: async (input, init) => handle.fetch(String(input).slice(handle.url.length), init),
  })
}

export async function executeOpenCodeV2(
  promptOptions: PromptOptions,
  logger: Logger,
  config: ExecutionConfig | undefined,
  serverHandle: OpenCodeV2ServerHandle,
  ownershipLedger?: OwnershipLedger,
  client: ActionOpenCodeV2Client = createActionClientV2(serverHandle),
): Promise<AgentResultV2> {
  const startTime = Date.now()
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = createExecutionDeadline(timeoutMs, logger)
  // The location every session of this run lives in: the one the server was started and gated for.
  const directory = serverHandle.directory
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
  // The selected stopping cause: set once per decision point, never re-derived from a later clock read (the invariant
  // V1's finalizer documents). Only 'deadline' authorizes the root interrupt below.
  let stoppingCause: 'deadline' | 'other' | null = null
  // Sticky across attempts: a later clean attempt must not clear an earlier gap.
  let observationGap = false
  // An attempt's prompt POST failed after it may have been sent: sticky, and reported to the caller whatever happens next.
  let sendUncertain = false
  // The root's usage before this run's first prompt: V2 reports cumulative figures per session, so a continued session
  // is read once up front. Without a baseline a continued session's usage would include earlier runs, so it is left out.
  let usageBaseline: SessionUsageV2 | null = null
  let usageReadable = true
  const applyUsage = async (): Promise<void> => {
    if (sessionId == null || !usageReadable) return
    const usage = await collectRunUsageV2({
      fetchRoute: serverHandle.fetch,
      rootSessionId: sessionId,
      baseline: usageBaseline,
      ...(ownershipLedger === undefined ? {} : {ledger: ownershipLedger}),
    })
    final = {
      ...final,
      tokens: usage.tokens ?? final.tokens,
      cost: usage.cost ?? final.cost,
      model: usage.model ?? final.model,
    }
  }
  logger.info('Executing OpenCode agent (V2)', {
    agent: config?.agent ?? 'build (default)',
    hasModelOverride: config?.model != null,
    timeoutMs,
  })

  const timeoutResult = async (): Promise<AgentResult> => {
    await applyUsage()
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
      classificationPath: final.classificationPath,
      observationGap,
      ...(sendUncertain ? {sendUncertain} : {}),
    }
  }

  try {
    const model = config?.model ?? DEFAULT_MODEL
    const modelRef = {providerID: model.providerID, modelID: model.modelID}

    if (config?.continueSessionId == null) {
      const created = await deadline.run(
        async () =>
          client.createSession({
            directory,
            ...(config?.sessionTitle === undefined ? {} : {title: config.sessionTitle}),
            ...(config?.agent == null ? {} : {agent: config.agent}),
            model: modelRef,
            signal: deadline.signal,
          }),
        'session creation',
      )
      if (!created.success) {
        // The fetch-error class is recognized by wording (`isLlmFetchError`), so a transport failure says "network error".
        throw new Error(
          created.error.kind === 'network'
            ? 'Failed to create session: network error'
            : `Failed to create session (${created.error.kind})`,
        )
      }
      sessionId = created.data.id
      logger.info('Created new OpenCode session', {sessionId, sessionTitle: config?.sessionTitle ?? null})
    } else {
      sessionId = config.continueSessionId
      logger.info('Continuing existing OpenCode session', {sessionId})
    }
    const activeSessionId = sessionId
    // Registered at once: every shutdown path interrupts registered sessions before stdin closes.
    serverHandle.registerOwnedSession(activeSessionId)

    if (config?.continueSessionId != null) {
      // V1 sent the model and agent with every prompt; on V2 a continued session takes them through its own routes.
      const switches = await deadline.run(async () => {
        const switchedModel = await client.switchModel({
          sessionId: activeSessionId,
          model: modelRef,
          signal: deadline.signal,
        })
        if (!switchedModel.success) return `model (${switchedModel.error.kind})`
        if (config.agent != null) {
          const agent = await client.switchAgent({
            sessionId: activeSessionId,
            agent: config.agent,
            signal: deadline.signal,
          })
          if (!agent.success) return `agent (${agent.error.kind})`
        }
        return null
      }, 'session configuration')
      if (switches !== null) throw new Error(`Failed to configure the continued session: ${switches}`)
      usageBaseline = await readSessionUsageV2(serverHandle.fetch, activeSessionId)
      usageReadable = usageBaseline !== null
    }

    const {text: initialPrompt, referenceFiles} = buildAgentPrompt(
      {...promptOptions, sessionId: activeSessionId},
      logger,
    )
    const logPath = getOpenCodeLogPath()
    await deadline.run(async () => fs.mkdir(logPath, {recursive: true}), 'OpenCode log directory creation')

    if (isOpenCodePromptArtifactEnabled()) {
      const hash = crypto.createHash('sha256').update(initialPrompt).digest('hex')
      const artifactPath = path.join(logPath, `prompt-${activeSessionId}-${hash.slice(0, 8)}.txt`)
      try {
        await deadline.run(async () => fs.writeFile(artifactPath, initialPrompt, 'utf8'), 'prompt artifact write')
        logger.info('Prompt artifact written', {hash, path: artifactPath})
      } catch (error) {
        logger.warning('Failed to write prompt artifact', {error: toErrorMessage(error), path: artifactPath})
      }
    }

    // Reference files go in a dedicated run-scoped directory under RUNNER_TEMP (see `buildAttachmentDir`), which the
    // CI config grants as the one outside-checkout exception. Same fail-safe as V1 when RUNNER_TEMP is unset.
    const runnerTemp = process.env.RUNNER_TEMP
    const attachmentDir =
      runnerTemp != null && runnerTemp.trim().length > 0
        ? buildAttachmentDir({
            runnerTemp: runnerTemp.trim(),
            runId: getGitHubRunId(),
            runAttempt: getGitHubRunAttempt(),
          })
        : logPath
    if (attachmentDir !== logPath) {
      await deadline.run(async () => createAttachmentDirExclusive(attachmentDir), 'attachment directory creation')
    }
    const referenceFileParts = await deadline.run(
      async () => materializeReferenceFiles(referenceFiles, attachmentDir, logger),
      'reference file materialization',
    )
    // V2 takes `{uri, name}` and reads the `file:` URI itself; the V1 part shape carries the same two facts.
    const files = [...(promptOptions.fileParts ?? []), ...referenceFileParts].map(part => ({
      uri: part.url,
      ...(part.filename === undefined ? {} : {name: part.filename}),
    }))

    let lastError: string | null = null
    let promptAccepted = false
    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (deadline.isExpired()) {
        stoppingCause = 'deadline'
        return await timeoutResult()
      }
      const retryDelay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0]
      const result: AttemptResultV2 = await (async (): Promise<AttemptResultV2> => {
        try {
          return await sendPromptToSessionV2({
            client,
            sessionId: activeSessionId,
            promptText: initialPrompt,
            files,
            directory,
            logger,
            deadline,
            onPermissionAsked: async request => replyToPermissionAskV2(client, request),
            onFormAsked: async form => cancelFormV2(client, form),
            onFatal: () => {
              // An owned session moved: stop the root now. The run fails through the attempt's own result.
              // eslint-disable-next-line no-void
              void interruptRootSession(client, activeSessionId, logger)
            },
            ...(ownershipLedger === undefined ? {} : {ownershipLedger}),
          })
        } finally {
          if (!deadline.isExpired()) {
            await reassertSessionTitleV2(client, activeSessionId, config?.sessionTitle, logger, deadline.signal)
          }
        }
      })()

      final = result.eventStreamResult
      if (result.eventStreamResult.discontinuity != null) observationGap = true
      if (result.sendUncertain === true) sendUncertain = true

      if (result.success) {
        stoppingCause = 'other'
        // The turn a notice starts after this return adds to the session's figures; the release reads them again.
        const liveObservation: LiveObservationV2 | undefined =
          result.liveObservation === undefined || !usageReadable
            ? result.liveObservation
            : {
                ...result.liveObservation,
                refreshUsage: async () =>
                  collectRunUsageV2({
                    fetchRoute: serverHandle.fetch,
                    rootSessionId: activeSessionId,
                    baseline: usageBaseline,
                    ...(ownershipLedger === undefined ? {} : {ledger: ownershipLedger}),
                  }),
              }
        await applyUsage()
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
          observationGap,
          ...(liveObservation === undefined ? {} : {liveObservation}),
        }
      }

      if (result.outcome === 'timeout') {
        stoppingCause = 'deadline'
        return await timeoutResult()
      }

      lastError = result.error
      lastLlmError = result.llmError
      stoppingCause = result.settlement.kind === 'deadline' ? 'deadline' : 'other'
      const promptWasAccepted = promptAccepted
      if (result.outcome !== 'submit_failed') promptAccepted = true

      // After the send a failed turn ends the run: V2 retries transient provider errors itself (rate limits, provider
      // internals, transport failures; at most four retries with backoff, `specs/v2/session.md` "Retry Is Narrow And
      // Observable"), so a failure that reaches here already outlasted that, and a second prompt would only risk repeating
      // side effects. The job re-run is the retry. Only a failure BEFORE the prompt reached a turn (the event stream never
      // connected, or the server refused the prompt) is sent again.
      const canResendOriginalPrompt =
        result.outcome === 'submit_failed' && !promptWasAccepted && result.llmError?.retryable === true
      if (!canResendOriginalPrompt || attempt >= MAX_LLM_RETRIES || stoppingCause === 'deadline') break

      logger.warning('Prompt not delivered; sending it again', {
        attempt,
        maxAttempts: MAX_LLM_RETRIES,
        error: result.error,
        delayMs: retryDelay,
        sessionId,
      })
      if (deadline.isExpired()) break
      await deadline.run(async () => {
        await waitForAbortableDelay(retryDelay, deadline.signal)
      }, 'retry delay')
    }

    await applyUsage()
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
      observationGap,
      ...(sendUncertain ? {sendUncertain} : {}),
    }
  } catch (error) {
    // An explicit, tagged deadline rejection is the one exception that IS a deadline cause, identified by name.
    if (error instanceof Error && error.name === 'DeadlineExceededError') {
      stoppingCause = 'deadline'
      return await timeoutResult()
    }
    // An untagged exception never became an attempt result. If the deadline already expired, default to deadline-caused
    // so teardown interrupts (nothing was decided); otherwise 'other' gives teardown no interrupt authority.
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
      observationGap,
      ...(sendUncertain ? {sendUncertain} : {}),
    }
  } finally {
    // Interrupt the root if and only if the selected stopping cause is 'deadline' and a session exists. This never
    // consults the clock (the V1 finalizer's rule): a non-deadline failure gets no interrupt authority.
    if (stoppingCause === 'deadline' && sessionId != null) await interruptRootSession(client, sessionId, logger)
    deadline.dispose()
  }
}
