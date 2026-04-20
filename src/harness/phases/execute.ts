import type {ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {ErrorInfo} from '../../features/comments/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {ResolvedOutputMode, TokenUsage} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import process from 'node:process'
import * as core from '@actions/core'
import {findLatestSession, writeSessionSummary} from '@fro-bot/runtime'
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

    const execResult = await executeOpenCode(promptOptions, execLogger, executionConfig, cacheRestore.serverHandle)

    let sessionId = execResult.sessionId
    if (sessionId == null) {
      const sessionLogger = createLogger({phase: 'session'})
      const latestSession = await findLatestSession(
        cacheRestore.serverHandle.client,
        sessionPrep.normalizedWorkspace,
        executionStartTime,
        sessionLogger,
      )
      if (latestSession != null) {
        sessionId = latestSession.session.id
        sessionLogger.debug('Identified session from execution', {sessionId})
      }
    }

    result = {
      ...execResult,
      sessionId,
      resolvedOutputMode,
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
