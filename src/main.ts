/**
 * Fro Bot Agent - Main Entry Point
 *
 * GitHub Action harness for OpenCode + oMo agents with persistent session state.
 * This is the entry point that orchestrates the agent workflow.
 *
 * Lifecycle (RFC-012):
 * 1. Parse inputs, verify OpenCode available
 * 2. Collect GitHub context
 * 3. Acknowledge receipt (eyes reaction + working label)
 * 4. Restore cache
 * 5. Build agent prompt
 * 6. Execute OpenCode agent
 * 7. Complete acknowledgment (update reaction, remove label)
 * 8. Save cache (always, in finally block)
 */

import type {ReactionContext} from './lib/agent/types.js'
import type {CacheKeyComponents} from './lib/cache-key.js'
import type {CacheResult} from './lib/types.js'
import process from 'node:process'
import * as core from '@actions/core'
import {
  acknowledgeReceipt,
  buildAgentPrompt,
  collectAgentContext,
  completeAcknowledgment,
  executeOpenCode,
  fetchDefaultBranch,
  verifyOpenCodeAvailable,
} from './lib/agent/index.js'
import {restoreCache, saveCache} from './lib/cache.js'
import {parseActionInputs} from './lib/inputs.js'
import {createLogger} from './lib/logger.js'
import {setActionOutputs} from './lib/outputs.js'
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
async function run(): Promise<void> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: 'bootstrap'})

  // Track agent state for cleanup
  let reactionCtx: ReactionContext | null = null
  let agentSuccess = false

  try {
    bootstrapLogger.info('Starting Fro Bot Agent')

    // 1. Parse and validate action inputs
    const inputsResult = parseActionInputs()

    if (!inputsResult.success) {
      core.setFailed(`Invalid inputs: ${inputsResult.error.message}`)
      return
    }

    const inputs = inputsResult.data
    const logger = createLogger({phase: 'main'})

    logger.info('Action inputs parsed', {
      sessionRetention: inputs.sessionRetention,
      s3Backup: inputs.s3Backup,
      hasGithubToken: inputs.githubToken.length > 0,
      hasPrompt: inputs.prompt != null,
    })

    // 2. Verify OpenCode is available (from setup action)
    const opencodePath = process.env.OPENCODE_PATH ?? null
    const opencodeCheck = await verifyOpenCodeAvailable(opencodePath, logger)

    if (!opencodeCheck.available) {
      core.setFailed('OpenCode is not available. Did you run the setup action first?')
      return
    }

    logger.info('OpenCode verified', {version: opencodeCheck.version})

    // 3. Collect GitHub context
    const contextLogger = createLogger({phase: 'context'})
    const agentContext = collectAgentContext(contextLogger)

    // Fetch default branch asynchronously (non-blocking enhancement)
    const defaultBranch = await fetchDefaultBranch(agentContext.repo, contextLogger)
    const contextWithBranch = {...agentContext, defaultBranch}

    // 4. Build reaction context for acknowledgment
    const botLogin = process.env.BOT_LOGIN ?? null
    reactionCtx = {
      repo: agentContext.repo,
      commentId: agentContext.commentId,
      issueNumber: agentContext.issueNumber,
      issueType: agentContext.issueType,
      botLogin,
    }

    // 5. Acknowledge receipt immediately (eyes reaction + working label)
    const ackLogger = createLogger({phase: 'acknowledgment'})
    await acknowledgeReceipt(reactionCtx, ackLogger)

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

    const cacheStatus = cacheResult.corrupted ? 'corrupted' : cacheResult.hit ? 'hit' : 'miss'
    logger.info('Cache restore completed', {cacheStatus, key: cacheResult.key})

    // 7. Build agent prompt
    const promptLogger = createLogger({phase: 'prompt'})
    const prompt = buildAgentPrompt(
      {
        context: contextWithBranch,
        customPrompt: inputs.prompt,
        cacheStatus,
      },
      promptLogger,
    )

    // 8. Execute OpenCode agent (skip in test mode)
    const skipExecution = process.env.SKIP_AGENT_EXECUTION === 'true'
    let result: {success: boolean; exitCode: number; sessionId: string | null; error: string | null}

    if (skipExecution) {
      logger.info('Skipping agent execution (SKIP_AGENT_EXECUTION=true)')
      result = {success: true, exitCode: 0, sessionId: null, error: null}
    } else {
      const execLogger = createLogger({phase: 'execution'})
      result = await executeOpenCode(prompt, opencodePath, execLogger)
    }

    agentSuccess = result.success

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
      core.setFailed(`Agent execution failed with exit code ${result.exitCode}`)
    }
  } catch (error) {
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
    // Always cleanup: update reactions and save cache
    try {
      // Complete acknowledgment (update reaction, remove label)
      if (reactionCtx != null) {
        const cleanupLogger = createLogger({phase: 'cleanup'})
        await completeAcknowledgment(reactionCtx, agentSuccess, cleanupLogger)
      }

      // Save cache
      const cacheComponents: CacheKeyComponents = {
        agentIdentity: 'github',
        repo: getGitHubRepository(),
        ref: getGitHubRefName(),
        os: getRunnerOS(),
      }

      const cacheLogger = createLogger({phase: 'cache-save'})
      await saveCache({
        components: cacheComponents,
        runId: getGitHubRunId(),
        logger: cacheLogger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
      })
    } catch (cleanupError) {
      bootstrapLogger.warning('Cleanup failed (non-fatal)', {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }
  }
}

await run()
