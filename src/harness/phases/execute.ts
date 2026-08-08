import type {ErrorInfo, SessionSearchResult} from '@fro-bot/runtime'
import type {ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {Logger} from '../../shared/logger.js'
import type {ResolvedOutputMode, TokenUsage} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import * as fs from 'node:fs/promises'
import process from 'node:process'
import * as core from '@actions/core'
import {
  archiveSession,
  findLatestSession,
  resolveResponseDelivery,
  searchSessions,
  writeSessionSummary,
} from '@fro-bot/runtime'
import {executeOpenCode, resolveOutputMode} from '../../features/agent/index.js'
import {inspectResponseFile, resolveResponseSurface} from '../../features/agent/response-file.js'
import {createLogger} from '../../shared/logger.js'
import {STATE_KEYS} from '../config/state-keys.js'
import {buildSessionSearchQuery} from './session-prep.js'

export interface ExecutePhaseResult {
  readonly success: boolean
  readonly exitCode: number
  readonly sessionId: string | null
  readonly error: string | null
  readonly tokenUsage: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly prsCreated: readonly string[]
  readonly commitsCreated: readonly string[]
  readonly commentsPosted: number
  readonly llmError: ErrorInfo | null
  readonly resolvedOutputMode: ResolvedOutputMode | null
  readonly overflowRecovery?: {
    readonly recovered: boolean
    readonly archivedSessionId: string
    readonly archiveSucceeded: boolean
  }
}

interface ContextOverflowRecoveryOptions {
  readonly bootstrap: BootstrapPhaseResult
  readonly routing: RoutingPhaseResult
  readonly cacheRestore: CacheRestorePhaseResult
  readonly sessionPrep: SessionPrepPhaseResult
  readonly metrics: MetricsCollector
  readonly execLogger: Logger
  readonly executionStartTime: number
  readonly promptOptions: PromptOptions
  readonly executionConfig: ExecutionConfig
  readonly overflowedResult: ExecutePhaseResult
  readonly overflowedSessionId: string
  readonly resolveSessionId: (candidateSessionId: string | null, afterTimestamp: number) => Promise<string | null>
}

async function recoverFromContextOverflow(options: ContextOverflowRecoveryOptions): Promise<ExecutePhaseResult> {
  const {
    bootstrap,
    routing,
    cacheRestore,
    sessionPrep,
    metrics,
    execLogger,
    executionStartTime,
    promptOptions,
    executionConfig,
    overflowedResult,
    overflowedSessionId,
    resolveSessionId,
  } = options

  const archiveSucceeded = await archiveSession(cacheRestore.serverHandle.server.url, overflowedSessionId, execLogger)
  if (archiveSucceeded === false) {
    execLogger.warning('Overflowed session archive failed; next run may re-continue it', {
      sessionId: overflowedSessionId,
    })
  }

  const recoverySearchQuery = buildSessionSearchQuery(
    sessionPrep.logicalKey,
    routing.agentContext.issueTitle,
    routing.agentContext.repo,
  )
  let recoveryPriorWorkContext: readonly SessionSearchResult[] = []
  try {
    recoveryPriorWorkContext = await searchSessions(
      recoverySearchQuery,
      cacheRestore.serverHandle.client,
      sessionPrep.normalizedWorkspace,
      {limit: 5, excludeSessionIds: [overflowedSessionId]},
      execLogger,
    )
  } catch (error) {
    execLogger.warning('Recovery prior-work search failed; proceeding with empty context', {error})
  }
  for (const session of recoveryPriorWorkContext) {
    metrics.addSessionUsed(session.sessionId)
  }

  const remainingMs = bootstrap.inputs.timeoutMs - (Date.now() - executionStartTime)
  if (remainingMs <= 0) return overflowedResult

  const recoveryPromptOptions: PromptOptions = {
    ...promptOptions,
    sessionContext: {
      recentSessions: sessionPrep.recentSessions,
      priorWorkContext: recoveryPriorWorkContext,
    },
    currentThreadSessionId: null,
    isContinuation: false,
  }
  const recoveryExecutionConfig: ExecutionConfig = {
    ...executionConfig,
    continueSessionId: undefined,
    timeoutMs: remainingMs,
  }
  if (bootstrap.delivery === 'file-convention' && bootstrap.responseFilePath != null) {
    try {
      await fs.rm(bootstrap.responseFilePath, {force: true})
    } catch (error) {
      execLogger.warning('Failed to clear stale response file before overflow recovery', {
        responseFilePath: bootstrap.responseFilePath,
        error,
      })
    }
  }
  const recoveryStartTime = Date.now()
  const recoveryExecResult = await executeOpenCode(
    recoveryPromptOptions,
    execLogger,
    recoveryExecutionConfig,
    cacheRestore.serverHandle,
  )
  const recoverySessionId = await resolveSessionId(recoveryExecResult.sessionId, recoveryStartTime)

  if (recoveryExecResult.llmError?.type === 'context_overflow' && recoverySessionId != null) {
    const recoveryArchiveSucceeded = await archiveSession(
      cacheRestore.serverHandle.server.url,
      recoverySessionId,
      execLogger,
    )
    if (recoveryArchiveSucceeded === false) {
      execLogger.warning('Overflowed recovery session archive failed; next run may re-continue it', {
        sessionId: recoverySessionId,
      })
    }
  }

  return {
    ...recoveryExecResult,
    sessionId: recoverySessionId,
    resolvedOutputMode: overflowedResult.resolvedOutputMode,
    overflowRecovery: {
      recovered: recoveryExecResult.success,
      archivedSessionId: overflowedSessionId,
      archiveSucceeded,
    },
  }
}

export async function runExecute(
  bootstrap: BootstrapPhaseResult,
  routing: RoutingPhaseResult,
  cacheRestore: CacheRestorePhaseResult,
  sessionPrep: SessionPrepPhaseResult,
  metrics: MetricsCollector,
  startTime: number,
): Promise<ExecutePhaseResult> {
  const resolvedOutputMode = resolveOutputMode(
    routing.triggerResult.context.eventType,
    bootstrap.inputs.prompt,
    bootstrap.inputs.outputMode,
  )

  const promptOptions: PromptOptions = {
    context: routing.agentContext,
    customPrompt: bootstrap.inputs.prompt,
    cacheStatus: cacheRestore.cacheStatus,
    sessionContext: {
      recentSessions: sessionPrep.recentSessions,
      priorWorkContext: sessionPrep.priorWorkContext,
    },
    logicalKey: sessionPrep.logicalKey ?? null,
    isContinuation: sessionPrep.isContinuation,
    currentThreadSessionId: sessionPrep.continueSessionId ?? null,
    triggerContext: routing.triggerResult.context,
    resolvedOutputMode,
    fileParts: sessionPrep.attachmentResult?.fileParts,
    responseMode: bootstrap.inputs.responseMode,
    responseDelivery: bootstrap.delivery,
    responseFilePath: bootstrap.responseFilePath,
  }

  const skipExecution = process.env.SKIP_AGENT_EXECUTION === 'true'
  const executionStartTime = Date.now()

  let result: ExecutePhaseResult
  if (skipExecution) {
    bootstrap.logger.info('Skipping agent execution (SKIP_AGENT_EXECUTION=true)')
    result = {
      success: true,
      exitCode: 0,
      sessionId: null,
      error: null,
      tokenUsage: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: null,
      resolvedOutputMode,
    }
  } else {
    const execLogger = createLogger({phase: 'execution'})
    execLogger.info('Starting OpenCode execution', {
      logicalKey: sessionPrep.logicalKey?.key ?? null,
      continueSessionId: sessionPrep.continueSessionId,
    })

    const executionConfig: ExecutionConfig = {
      agent: bootstrap.inputs.agent,
      model: bootstrap.inputs.model,
      timeoutMs: bootstrap.inputs.timeoutMs,
      omoProviders: bootstrap.inputs.omoProviders,
      continueSessionId: sessionPrep.continueSessionId ?? undefined,
      sessionTitle: sessionPrep.sessionTitle ?? undefined,
      credentialProvisioned:
        resolveResponseDelivery(routing.triggerResult.context.eventName, bootstrap.inputs.responseMode).credential ===
        'provision',
    }

    const resolveSessionId = async (
      candidateSessionId: string | null,
      afterTimestamp: number,
    ): Promise<string | null> => {
      if (candidateSessionId != null) return candidateSessionId

      const sessionLogger = createLogger({phase: 'session'})
      const latestSession = await findLatestSession(
        cacheRestore.serverHandle.client,
        sessionPrep.normalizedWorkspace,
        afterTimestamp,
        sessionLogger,
      )
      if (latestSession == null) return null

      sessionLogger.debug('Identified session from execution', {sessionId: latestSession.session.id})
      return latestSession.session.id
    }

    const execResult = await executeOpenCode(promptOptions, execLogger, executionConfig, cacheRestore.serverHandle)

    const sessionId = await resolveSessionId(execResult.sessionId, executionStartTime)

    result = {
      ...execResult,
      sessionId,
      resolvedOutputMode,
    }

    const credentialProvisioned = executionConfig.credentialProvisioned === true
    const responseFileStatus = await inspectResponseFile(
      bootstrap.responseFilePath,
      resolveResponseSurface(routing.agentContext, routing.triggerResult.context),
      execLogger,
    )
    // Provisioned credentials can hide completed external writes; only a non-provisioned run without a valid response may be replayed.
    if (
      result.llmError?.type === 'context_overflow' &&
      credentialProvisioned === false &&
      responseFileStatus === 'absent' &&
      sessionId != null
    ) {
      result = await recoverFromContextOverflow({
        bootstrap,
        routing,
        cacheRestore,
        sessionPrep,
        metrics,
        execLogger,
        executionStartTime,
        promptOptions,
        executionConfig,
        overflowedResult: result,
        overflowedSessionId: sessionId,
        resolveSessionId,
      })
    }

    execLogger.info('Completed OpenCode execution', {
      success: result.success,
      sessionId: result.sessionId,
      logicalKey: sessionPrep.logicalKey?.key ?? null,
    })
  }

  if (result.sessionId != null) {
    core.saveState(STATE_KEYS.SESSION_ID, result.sessionId)
    metrics.addSessionCreated(result.sessionId)
  }
  if (result.tokenUsage != null) {
    metrics.setTokenUsage(result.tokenUsage, result.model, result.cost)
  }
  for (const pr of result.prsCreated) {
    metrics.addPRCreated(pr)
  }
  for (const commit of result.commitsCreated) {
    metrics.addCommitCreated(commit)
  }
  for (let i = 0; i < result.commentsPosted; i++) {
    metrics.incrementComments()
  }

  if (result.sessionId != null) {
    const sessionLogger = createLogger({phase: 'session'})
    await writeSessionSummary(
      result.sessionId,
      {
        eventType: routing.agentContext.eventName,
        repo: routing.agentContext.repo,
        ref: routing.agentContext.ref,
        runId: Number(routing.agentContext.runId),
        cacheStatus: cacheRestore.cacheStatus,
        sessionIds: [result.sessionId],
        logicalKey: sessionPrep.logicalKey?.key,
        createdPRs: [...result.prsCreated],
        createdCommits: [...result.commitsCreated],
        duration: Math.round((Date.now() - startTime) / 1000),
        tokenUsage: result.tokenUsage,
      },
      cacheRestore.serverHandle.client,
      sessionLogger,
    )
    sessionLogger.debug('Wrote session summary', {sessionId: result.sessionId})
  }

  return result
}
