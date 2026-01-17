/**
 * Fro Bot Agent - Main Entry Point
 *
 * GitHub Action harness for OpenCode + oMo agents with persistent session state.
 * This is the entry point that orchestrates the agent workflow.
 *
 * Lifecycle (RFC-012 + RFC-004 + RFC-005 + RFC-013 integration):
 * 1. Parse inputs, verify OpenCode available
 * 2. Collect GitHub context
 * 3. Route event and check skip conditions (RFC-005)
 * 4. Acknowledge receipt (eyes reaction + working label) - ONLY if processing
 * 5. Restore cache
 * 6. Session introspection (list recent, search prior work)
 * 7. Build agent prompt (with session context)
 * 8. Execute OpenCode agent (SDK mode - RFC-013)
 * 9. Write session summary (if sessionId available)
 * 10. Complete acknowledgment (update reaction, remove label)
 * 11. Prune old sessions (before cache save)
 * 12. Save cache (always, in finally block)
 */

import type {ExecutionConfig, PromptOptions, ReactionContext} from './lib/agent/types.js'
import type {CacheKeyComponents} from './lib/cache-key.js'
import type {Octokit} from './lib/github/types.js'
import type {CacheResult, RunSummary} from './lib/types.js'
import process from 'node:process'
import * as core from '@actions/core'
import {
  acknowledgeReceipt,
  collectAgentContext,
  completeAcknowledgment,
  ensureOpenCodeAvailable,
  executeOpenCode,
} from './lib/agent/index.js'
import {restoreCache, saveCache} from './lib/cache.js'
import {createClient, getBotLogin, getDefaultBranch, parseGitHubContext} from './lib/github/index.js'
import {parseActionInputs} from './lib/inputs.js'
import {createLogger} from './lib/logger.js'
import {setActionOutputs} from './lib/outputs.js'
import {
  DEFAULT_PRUNING_CONFIG,
  findLatestSession,
  listSessions,
  pruneSessions,
  searchSessions,
  writeSessionSummary,
} from './lib/session/index.js'
import {STATE_KEYS} from './lib/state-keys.js'
import {routeEvent} from './lib/triggers/index.js'
import {
  getGitHubRefName,
  getGitHubRepository,
  getGitHubRunId,
  getOpenCodeAuthPath,
  getOpenCodeStoragePath,
  getRunnerOS,
} from './utils/env.js'

/**
 * Main action entry point.
 * Orchestrates: acknowledge → collect context → execute agent → complete acknowledgment
 */
async function run(): Promise<number> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: 'bootstrap'})

  // Track agent state for cleanup
  let reactionCtx: ReactionContext | null = null
  let agentSuccess = false
  let exitCode = 0
  let githubClient: Octokit | null = null

  core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
  core.saveState(STATE_KEYS.CACHE_SAVED, 'false')

  try {
    bootstrapLogger.info('Starting Fro Bot Agent')

    // 1. Parse and validate action inputs
    const inputsResult = parseActionInputs()

    if (!inputsResult.success) {
      core.setFailed(`Invalid inputs: ${inputsResult.error.message}`)
      return 1
    }

    const inputs = inputsResult.data
    const logger = createLogger({phase: 'main'})

    logger.info('Action inputs parsed', {
      sessionRetention: inputs.sessionRetention,
      s3Backup: inputs.s3Backup,
      hasGithubToken: inputs.githubToken.length > 0,
      hasPrompt: inputs.prompt != null,
      agent: inputs.agent,
      hasModelOverride: inputs.model != null,
      timeoutMs: inputs.timeoutMs,
    })

    // 2. Ensure OpenCode is available (auto-setup if needed)
    const opencodeResult = await ensureOpenCodeAvailable({
      logger,
      opencodeVersion: inputs.opencodeVersion,
    })

    if (opencodeResult.didSetup) {
      logger.info('OpenCode auto-setup completed', {version: opencodeResult.version})
    } else {
      logger.info('OpenCode already available', {version: opencodeResult.version})
    }

    // 3. Collect GitHub context
    const contextLogger = createLogger({phase: 'context'})
    const agentContext = collectAgentContext(contextLogger)

    // Fetch default branch asynchronously (non-blocking enhancement)
    githubClient = createClient({token: inputs.githubToken, logger: contextLogger})
    const defaultBranch = await getDefaultBranch(githubClient, agentContext.repo, contextLogger)
    const contextWithBranch = {...agentContext, defaultBranch}

    // 3b. Route event and check skip conditions (RFC-005) - BEFORE acknowledgment
    const triggerLogger = createLogger({phase: 'trigger'})
    const githubContext = parseGitHubContext(triggerLogger)
    const triggerResult = routeEvent(githubContext, triggerLogger, {
      login: githubContext.actor,
      requireMention: true,
    })

    if (!triggerResult.shouldProcess) {
      triggerLogger.info('Skipping event', {
        reason: triggerResult.skipReason,
        message: triggerResult.skipMessage,
      })
      setActionOutputs({
        sessionId: null,
        cacheStatus: 'miss',
        duration: Date.now() - startTime,
      })
      return 0
    }

    triggerLogger.info('Event routed for processing', {
      eventType: triggerResult.context.eventType,
      hasMention: triggerResult.context.hasMention,
      command: triggerResult.context.command?.action ?? null,
    })

    core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'true')

    // 4. Get bot login for reaction context and build reaction context for acknowledgment
    const botLogin = await getBotLogin(githubClient, contextLogger)
    reactionCtx = {
      repo: agentContext.repo,
      commentId: agentContext.commentId,
      issueNumber: agentContext.issueNumber,
      issueType: agentContext.issueType,
      botLogin,
    }

    // 5. Acknowledge receipt immediately (eyes reaction + working label) - ONLY if processing
    const ackLogger = createLogger({phase: 'acknowledgment'})
    await acknowledgeReceipt(githubClient, reactionCtx, ackLogger)

    // 6. Build cache key components and restore cache
    const cacheComponents: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: getGitHubRepository(),
      ref: getGitHubRefName(),
      os: getRunnerOS(),
    }

    const cacheLogger = createLogger({phase: 'cache'})
    const cacheResult: CacheResult = await restoreCache({
      components: cacheComponents,
      logger: cacheLogger,
      storagePath: getOpenCodeStoragePath(),
      authPath: getOpenCodeAuthPath(),
    })

    const cacheStatus: 'corrupted' | 'hit' | 'miss' = cacheResult.corrupted
      ? 'corrupted'
      : cacheResult.hit
        ? 'hit'
        : 'miss'
    logger.info('Cache restore completed', {cacheStatus, key: cacheResult.key})

    // 6b. Session introspection (RFC-004) - gather prior session context
    const sessionLogger = createLogger({phase: 'session'})
    const projectPath = process.env.GITHUB_WORKSPACE ?? process.cwd()

    const recentSessions = await listSessions(projectPath, {limit: 10}, sessionLogger)
    sessionLogger.debug('Listed recent sessions', {count: recentSessions.length})

    // Search for prior work related to current issue (if applicable)
    const searchQuery = contextWithBranch.issueTitle ?? contextWithBranch.repo
    const priorWorkContext = await searchSessions(searchQuery, projectPath, {limit: 5}, sessionLogger)
    sessionLogger.debug('Searched prior sessions', {
      query: searchQuery,
      resultCount: priorWorkContext.length,
    })

    // 7. Build prompt options (prompt built inside executeOpenCode with sessionId)
    const promptOptions: PromptOptions = {
      context: contextWithBranch,
      customPrompt: inputs.prompt,
      cacheStatus,
      sessionContext: {
        recentSessions,
        priorWorkContext,
      },
      triggerContext: triggerResult.context,
    }

    // 8. Execute OpenCode agent (skip in test mode)
    const skipExecution = process.env.SKIP_AGENT_EXECUTION === 'true'
    let result: {success: boolean; exitCode: number; sessionId: string | null; error: string | null}
    const executionStartTime = Date.now()

    if (skipExecution) {
      logger.info('Skipping agent execution (SKIP_AGENT_EXECUTION=true)')
      result = {success: true, exitCode: 0, sessionId: null, error: null}
    } else {
      const execLogger = createLogger({phase: 'execution'})

      // RFC-013: Build execution config from parsed inputs
      const executionConfig: ExecutionConfig = {
        agent: inputs.agent,
        model: inputs.model,
        timeoutMs: inputs.timeoutMs,
      }

      const execResult = await executeOpenCode(promptOptions, execLogger, executionConfig)

      // SDK mode returns sessionId directly (RFC-013)
      // Fall back to session discovery for backward compatibility
      let sessionId: string | null = execResult.sessionId
      if (sessionId == null) {
        const latestSession = await findLatestSession(executionStartTime, sessionLogger)
        if (latestSession != null) {
          sessionId = latestSession.session.id
          sessionLogger.debug('Identified session from execution', {sessionId})
        }
      }

      result = {...execResult, sessionId}
    }

    if (result.sessionId != null) {
      core.saveState(STATE_KEYS.SESSION_ID, result.sessionId)
    }

    agentSuccess = result.success

    // 8b. Write session summary (RFC-004) if we have a sessionId
    if (result.sessionId != null) {
      const runSummary: RunSummary = {
        eventType: contextWithBranch.eventName,
        repo: contextWithBranch.repo,
        ref: contextWithBranch.ref,
        runId: Number(contextWithBranch.runId),
        cacheStatus,
        sessionIds: [result.sessionId],
        createdPRs: [],
        createdCommits: [],
        duration: Math.round((Date.now() - startTime) / 1000),
        tokenUsage: null,
      }
      await writeSessionSummary(result.sessionId, runSummary, sessionLogger)
      sessionLogger.debug('Wrote session summary', {sessionId: result.sessionId})
    }

    // 9. Calculate duration and set outputs
    const duration = Date.now() - startTime

    setActionOutputs({
      sessionId: result.sessionId,
      cacheStatus,
      duration,
    })

    if (result.success) {
      logger.info('Agent run completed successfully', {durationMs: duration})
    } else {
      exitCode = result.exitCode
      core.setFailed(`Agent execution failed with exit code ${result.exitCode}`)
    }
  } catch (error) {
    exitCode = 1
    const duration = Date.now() - startTime

    setActionOutputs({
      sessionId: null,
      cacheStatus: 'miss',
      duration,
    })

    if (error instanceof Error) {
      bootstrapLogger.error('Agent failed', {error: error.message})
      core.setFailed(error.message)
    } else {
      bootstrapLogger.error('Agent failed with unknown error')
      core.setFailed('An unknown error occurred')
    }
  } finally {
    // Always cleanup: update reactions, prune sessions, and save cache
    try {
      // Complete acknowledgment (update reaction, remove label)
      if (reactionCtx != null && githubClient != null) {
        const cleanupLogger = createLogger({phase: 'cleanup'})
        await completeAcknowledgment(githubClient, reactionCtx, agentSuccess, cleanupLogger)
      }

      // Prune old sessions (RFC-004) before cache save
      const pruneLogger = createLogger({phase: 'prune'})
      const storagePath = getOpenCodeStoragePath()
      const pruneResult = await pruneSessions(storagePath, DEFAULT_PRUNING_CONFIG, pruneLogger)
      if (pruneResult.prunedCount > 0) {
        pruneLogger.info('Pruned old sessions', {
          pruned: pruneResult.prunedCount,
          remaining: pruneResult.remainingCount,
        })
      }

      // Save cache
      const cacheComponents: CacheKeyComponents = {
        agentIdentity: 'github',
        repo: getGitHubRepository(),
        ref: getGitHubRefName(),
        os: getRunnerOS(),
      }

      const cacheLogger = createLogger({phase: 'cache-save'})
      const cacheSaved = await saveCache({
        components: cacheComponents,
        runId: getGitHubRunId(),
        logger: cacheLogger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
      })

      if (cacheSaved) {
        core.saveState(STATE_KEYS.CACHE_SAVED, 'true')
      }
    } catch (cleanupError) {
      bootstrapLogger.warning('Cleanup failed (non-fatal)', {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }
  }

  return exitCode
}

await run().then(exitCode => {
  process.exit(exitCode)
})
