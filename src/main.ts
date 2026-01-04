/**
 * Fro Bot Agent - Main Entry Point
 *
 * GitHub Action harness for OpenCode + oMo agents with persistent session state.
 * This is the entry point that orchestrates the agent workflow.
 */

import type {CacheKeyComponents} from './lib/cache-key.js'

import type {CacheResult} from './lib/types.js'
import * as core from '@actions/core'
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
 * Parses inputs, initializes logging, and runs the agent workflow.
 */
async function run(): Promise<void> {
  const startTime = Date.now()

  // Create a bootstrap logger for early startup
  const bootstrapLogger = createLogger({phase: 'bootstrap'})

  try {
    bootstrapLogger.info('Starting Fro Bot Agent')

    // Parse and validate action inputs
    const inputsResult = parseActionInputs()

    if (!inputsResult.success) {
      core.setFailed(`Invalid inputs: ${inputsResult.error.message}`)
      return
    }

    const inputs = inputsResult.data

    // Create main logger with run context
    const logger = createLogger({
      phase: 'main',
    })

    logger.info('Action inputs parsed successfully', {
      sessionRetention: inputs.sessionRetention,
      s3Backup: inputs.s3Backup,
      hasGithubToken: inputs.githubToken.length > 0,
      hasPrompt: inputs.prompt != null,
    })

    // Build cache key components from environment
    const cacheComponents: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: getGitHubRepository(),
      ref: getGitHubRefName(),
      os: getRunnerOS(),
    }

    // Restore cache (early in run)
    const cacheLogger = createLogger({phase: 'cache'})
    const cacheResult: CacheResult = await restoreCache({
      components: cacheComponents,
      logger: cacheLogger,
      storagePath: getOpenCodeStoragePath(),
      authPath: getOpenCodeAuthPath(),
    })

    logger.info('Cache restore completed', {
      hit: cacheResult.hit,
      corrupted: cacheResult.corrupted,
      key: cacheResult.key,
    })

    // TODO: RFC-003 - GitHub client initialization
    // TODO: RFC-004 - Session management
    // TODO: RFC-005 - Event handling
    // TODO: RFC-006 - Permission gating

    // For now, just log that we're ready
    logger.info('Agent infrastructure initialized')

    // Calculate duration and set outputs
    const duration = Date.now() - startTime

    setActionOutputs({
      sessionId: null, // Will be set by RFC-004
      cacheStatus: cacheResult.corrupted ? 'corrupted' : cacheResult.hit ? 'hit' : 'miss',
      duration,
    })

    logger.info('Agent run completed', {durationMs: duration})
  } catch (error) {
    const duration = Date.now() - startTime

    // Ensure we always set outputs even on failure
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
    // Save cache (always, even on failure)
    try {
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
    } catch {
      // Cache save failure should not mask the original error
    }
  }
}

await run()
