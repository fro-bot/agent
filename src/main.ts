/**
 * Fro Bot Agent - Main Entry Point
 *
 * GitHub Action harness for OpenCode + oMo agents with persistent session state.
 * This is the entry point that orchestrates the agent workflow.
 */

import * as core from '@actions/core'
import {parseActionInputs} from './lib/inputs.js'
import {createLogger} from './lib/logger.js'
import {setActionOutputs} from './lib/outputs.js'

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

    // TODO: RFC-002 - Cache restore
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
      cacheStatus: 'miss', // Will be set by RFC-002
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
  }
}

await run()
