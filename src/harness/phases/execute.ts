import type {ErrorInfo} from '@fro-bot/runtime'
import type {ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {ResolvedOutputMode, TokenUsage} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import process from 'node:process'
import * as core from '@actions/core'
import {archiveSession, findLatestSession, searchSessions, writeSessionSummary} from '@fro-bot/runtime'
import {executeOpenCode, resolveOutputMode} from '../../features/agent/index.js'
import {createLogger} from '../../shared/logger.js'
import {STATE_KEYS} from '../config/state-keys.js'

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
  readonly overflowRecovery?: {readonly recovered: boolean; readonly archivedSessionId: string}
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

    let sessionId = await resolveSessionId(execResult.sessionId, executionStartTime)

    result = {
      ...execResult,
      sessionId,
      resolvedOutputMode,
    }

    if (result.llmError?.type === 'context_overflow' && result.commentsPosted === 0 && sessionId != null) {
      const overflowedSessionId = sessionId
      await archiveSession(cacheRestore.serverHandle.server.url, overflowedSessionId, execLogger)

      const recoverySearchQuery =
        sessionPrep.logicalKey?.key ?? routing.agentContext.issueTitle ?? routing.agentContext.repo
      const recoveryPriorWorkContext = await searchSessions(
        recoverySearchQuery,
        cacheRestore.serverHandle.client,
        sessionPrep.normalizedWorkspace,
        {limit: 5, excludeSessionIds: [overflowedSessionId]},
        execLogger,
      )
      for (const session of recoveryPriorWorkContext) {
        metrics.addSessionUsed(session.sessionId)
      }

      const remainingMs = bootstrap.inputs.timeoutMs - (Date.now() - executionStartTime)
      if (remainingMs > 0) {
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
        const recoveryStartTime = Date.now()
        const recoveryExecResult = await executeOpenCode(
          recoveryPromptOptions,
          execLogger,
          recoveryExecutionConfig,
          cacheRestore.serverHandle,
        )
        const recoverySessionId = await resolveSessionId(recoveryExecResult.sessionId, recoveryStartTime)
        sessionId = recoverySessionId

        if (recoveryExecResult.llmError?.type === 'context_overflow' && recoverySessionId != null) {
          await archiveSession(cacheRestore.serverHandle.server.url, recoverySessionId, execLogger)
        }

        result = {
          ...recoveryExecResult,
          sessionId,
          resolvedOutputMode,
          overflowRecovery: {
            recovered: recoveryExecResult.success,
            archivedSessionId: overflowedSessionId,
          },
        }
      }
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
