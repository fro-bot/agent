/**
 * OpenCode CLI execution for RFC-012.
 *
 * Handles launching OpenCode with the agent prompt and managing
 * execution lifecycle including platform-specific streaming.
 */

import type {Buffer} from 'node:buffer'
import type {Logger} from '../logger.js'
import type {AgentResult} from './types.js'
import process from 'node:process'
import * as exec from '@actions/exec'

/**
 * Execute OpenCode CLI with the given prompt.
 *
 * On Linux, wraps execution with `stdbuf` for real-time log streaming.
 * This matches the oMo Sisyphus workflow pattern.
 *
 * @param prompt - The complete agent prompt
 * @param opencodePath - Path to OpenCode binary (from setup action)
 * @param logger - Logger instance
 * @returns Agent result with exit code and duration
 */
export async function executeOpenCode(
  prompt: string,
  opencodePath: string | null,
  logger: Logger,
): Promise<AgentResult> {
  const startTime = Date.now()

  // Determine OpenCode command - use PATH if not explicitly provided
  const opencodeCmd = opencodePath ?? 'opencode'

  logger.info('Executing OpenCode agent', {
    promptLength: prompt.length,
    platform: process.platform,
    useStdbuf: process.platform === 'linux',
  })

  try {
    let exitCode: number

    if (process.platform === 'linux') {
      // Use stdbuf for real-time log streaming on Linux
      // -oL: line-buffered stdout
      // -eL: line-buffered stderr
      exitCode = await exec.exec('stdbuf', ['-oL', '-eL', opencodeCmd, 'run', prompt])
    } else {
      // macOS/Windows: direct execution (buffered output)
      exitCode = await exec.exec(opencodeCmd, ['run', prompt])
    }

    const duration = Date.now() - startTime

    logger.info('OpenCode execution completed', {
      exitCode,
      durationMs: duration,
    })

    return {
      success: exitCode === 0,
      exitCode,
      duration,
      sessionId: null, // Will be populated by RFC-004 session integration
      error: null,
    }
  } catch (error) {
    const duration = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)

    logger.error('OpenCode execution failed', {
      error: errorMessage,
      durationMs: duration,
    })

    return {
      success: false,
      exitCode: 1,
      duration,
      sessionId: null,
      error: errorMessage,
    }
  }
}

/**
 * Verify OpenCode is available and working.
 *
 * Runs `opencode --version` to ensure the binary is accessible.
 */
export async function verifyOpenCodeAvailable(
  opencodePath: string | null,
  logger: Logger,
): Promise<{available: boolean; version: string | null}> {
  const opencodeCmd = opencodePath ?? 'opencode'

  try {
    let version = ''
    await exec.exec(opencodeCmd, ['--version'], {
      listeners: {
        stdout: (data: Buffer) => {
          version += data.toString()
        },
      },
      silent: true,
    })

    const versionMatch = /(\d+\.\d+\.\d+)/.exec(version)
    const parsedVersion: string | null = versionMatch?.[1] ?? null

    logger.debug('OpenCode version verified', {version: parsedVersion})
    return {available: true, version: parsedVersion}
  } catch {
    logger.warning('OpenCode not available')
    return {available: false, version: null}
  }
}
