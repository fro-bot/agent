/**
 * OpenCode SDK execution for RFC-013.
 *
 * Handles launching OpenCode in server mode and communicating via SDK client.
 * Replaces CLI-based execution from RFC-012 with SDK-based execution.
 */

import type {Buffer} from 'node:buffer'
import type {ChildProcess} from 'node:child_process'
import type {Logger} from '../logger.js'
import type {AgentResult, ExecutionConfig} from './types.js'
import {spawn} from 'node:child_process'
import process from 'node:process'
import * as exec from '@actions/exec'
import {createOpencodeClient} from '@opencode-ai/sdk'
import {DEFAULT_TIMEOUT_MS} from '../constants.js'

/** Default port for OpenCode server */
const SERVER_PORT = 4096

/** Default hostname for OpenCode server */
const SERVER_HOSTNAME = '127.0.0.1'

/** Maximum retries for connection verification */
const MAX_CONNECTION_RETRIES = 30

/** Delay between connection retries in milliseconds */
const CONNECTION_RETRY_DELAY_MS = 300

/**
 * OpenCode server instance with cleanup function.
 */
interface OpenCodeServer {
  readonly url: string
  readonly process: ChildProcess
  close: () => void
}

/**
 * Create and start the OpenCode server process.
 *
 * Spawns `opencode serve` with hostname and port configuration.
 * Waits for the server to indicate it's ready via stdout.
 *
 * @param opencodePath - Path to OpenCode binary (null uses 'opencode' from PATH)
 * @param logger - Logger instance
 * @returns Promise resolving to server instance
 */
async function createOpenCodeServer(opencodePath: string | null, logger: Logger): Promise<OpenCodeServer> {
  return new Promise((resolve, reject) => {
    const opencodeCmd = opencodePath ?? 'opencode'
    const args = ['serve', `--hostname=${SERVER_HOSTNAME}`, `--port=${SERVER_PORT}`]

    logger.debug('Starting OpenCode server', {command: opencodeCmd, args})

    const proc = spawn(opencodeCmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let serverStarted = false
    let stderrBuffer = ''

    const cleanup = () => {
      if (!proc.killed) {
        proc.kill('SIGTERM')
      }
    }

    proc.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      logger.debug('OpenCode server stdout', {output: output.trim()})

      // Look for server ready message
      if (!serverStarted && output.includes('listening')) {
        serverStarted = true
        const url = `http://${SERVER_HOSTNAME}:${SERVER_PORT}`
        logger.info('OpenCode server started', {url})
        resolve({
          url,
          process: proc,
          close: cleanup,
        })
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderrBuffer += data.toString()
      logger.debug('OpenCode server stderr', {output: data.toString().trim()})
    })

    proc.on('error', error => {
      logger.error('OpenCode server failed to start', {error: error.message})
      reject(new Error(`Failed to start OpenCode server: ${error.message}`))
    })

    proc.on('exit', (code, signal) => {
      if (!serverStarted) {
        const exitInfo = code == null ? `signal ${signal}` : `code ${code}`
        logger.error('OpenCode server exited before ready', {exitInfo, stderr: stderrBuffer})
        reject(new Error(`OpenCode server exited (${exitInfo}) before becoming ready`))
      }
    })

    // Timeout for server startup
    setTimeout(() => {
      if (!serverStarted) {
        cleanup()
        reject(new Error('OpenCode server startup timeout (10s)'))
      }
    }, 10000)
  })
}

/**
 * Verify connection to OpenCode server with retry loop.
 *
 * Uses client.app.log() as a lightweight health check.
 *
 * @param client - OpenCode SDK client
 * @param logger - Logger instance
 */
async function assertOpenCodeConnected(client: ReturnType<typeof createOpencodeClient>, logger: Logger): Promise<void> {
  for (let attempt = 1; attempt <= MAX_CONNECTION_RETRIES; attempt++) {
    try {
      await client.app.log()
      logger.debug('OpenCode connection verified', {attempt})
      return
    } catch (error) {
      if (attempt === MAX_CONNECTION_RETRIES) {
        throw new Error(
          `Failed to connect to OpenCode after ${MAX_CONNECTION_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      logger.debug('Connection attempt failed, retrying', {attempt, maxRetries: MAX_CONNECTION_RETRIES})
      await new Promise(resolve => setTimeout(resolve, CONNECTION_RETRY_DELAY_MS))
    }
  }
}

/**
 * Resolve agent name.
 *
 * Note: The SDK doesn't expose an agent listing API, so we accept the
 * configured agent name and pass it through. The server will validate.
 *
 * @param agentName - Requested agent name
 * @param logger - Logger instance
 * @returns Agent name to use
 */
function resolveAgent(agentName: string, logger: Logger): string {
  logger.debug('Using agent', {agent: agentName})
  return agentName
}

/**
 * Subscribe to session events for logging (fire-and-forget).
 *
 * Opens SSE connection to /event endpoint and logs tool completions.
 * Non-blocking - errors are logged but don't fail execution.
 *
 * @param serverUrl - OpenCode server URL
 * @param sessionId - Session ID to filter events
 * @param logger - Logger instance
 * @returns AbortController to cancel subscription
 */
function subscribeSessionEvents(serverUrl: string, sessionId: string, logger: Logger): AbortController {
  const controller = new AbortController()

  // Fire and forget - explicitly ignore promise using catch
  ;(async () => {
    try {
      const response = await fetch(`${serverUrl}/event`, {
        signal: controller.signal,
        headers: {Accept: 'text/event-stream'},
      })

      if (!response.ok || response.body == null) {
        logger.debug('Event subscription failed', {status: response.status})
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      let readResult: {done: boolean; value?: Uint8Array} = await reader.read()
      while (!readResult.done) {
        const chunk = readResult.value == null ? '' : decoder.decode(readResult.value, {stream: true})
        buffer += chunk

        const lines = buffer.split('\n')
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.trim().length === 0) continue

          if (line.startsWith('data:')) {
            try {
              const event = JSON.parse(line.slice(5)) as {
                type?: string
                properties?: {
                  part?: {sessionID?: string; type?: string}
                  tool?: {name?: string}
                }
              }
              if (event.properties?.part?.sessionID === sessionId && event.properties?.tool?.name != null) {
                logger.debug('Tool execution', {tool: event.properties.tool.name})
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
        readResult = await reader.read()
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        logger.debug('Event subscription error', {error: error.message})
      }
    }
  })().catch(() => {
    // Silently ignore - fire and forget pattern
  })

  return controller
}

/**
 * Execute OpenCode with SDK mode.
 *
 * Lifecycle:
 * 1. Spawn OpenCode server
 * 2. Create SDK client and verify connection
 * 3. Resolve agent configuration
 * 4. Create session
 * 5. Subscribe to events (background)
 * 6. Send prompt via client.session.prompt()
 * 7. Wait for response
 * 8. Return result with sessionId
 * 9. Cleanup server in finally block
 *
 * @param prompt - The complete agent prompt
 * @param opencodePath - Path to OpenCode binary (from setup action)
 * @param logger - Logger instance
 * @param config - Optional execution configuration (agent, model, timeout)
 * @returns Agent result with exit code and session ID
 */
export async function executeOpenCode(
  prompt: string,
  opencodePath: string | null,
  logger: Logger,
  config?: ExecutionConfig,
): Promise<AgentResult> {
  const startTime = Date.now()
  let server: OpenCodeServer | null = null
  let eventController: AbortController | null = null

  // Setup timeout if configured
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true
      logger.warning('Execution timeout reached', {timeoutMs})
      eventController?.abort()
      server?.close()
    }, timeoutMs)
  }

  logger.info('Executing OpenCode agent (SDK mode)', {
    promptLength: prompt.length,
    agent: config?.agent ?? 'Sisyphus',
    hasModelOverride: config?.model != null,
    timeoutMs,
  })

  try {
    server = await createOpenCodeServer(opencodePath, logger)

    const client = createOpencodeClient({baseUrl: server.url})

    await assertOpenCodeConnected(client, logger)

    const agentName = config?.agent ?? 'Sisyphus'
    const agent = resolveAgent(agentName, logger)

    const sessionResponse = await client.session.create()
    if (sessionResponse.data == null || sessionResponse.error != null) {
      const errorMsg = sessionResponse.error == null ? 'No data returned' : String(sessionResponse.error)
      throw new Error(`Failed to create session: ${errorMsg}`)
    }
    const sessionId = sessionResponse.data.id
    logger.debug('Session created', {sessionId})

    eventController = subscribeSessionEvents(server.url, sessionId, logger)

    logger.debug('Sending prompt to OpenCode...')
    const promptBody: {
      agent?: string
      model?: {modelID: string; providerID: string}
      parts: {text: string; type: 'text'}[]
    } = {
      agent,
      parts: [{type: 'text', text: prompt}],
    }

    if (config?.model != null) {
      promptBody.model = {
        providerID: config.model.providerID,
        modelID: config.model.modelID,
      }
    }

    const promptResponse = await client.session.prompt({
      path: {id: sessionId},
      body: promptBody,
    })

    if (timedOut) {
      return {
        success: false,
        exitCode: 130,
        duration: Date.now() - startTime,
        sessionId,
        error: `Execution timed out after ${timeoutMs}ms`,
      }
    }

    if (promptResponse.error != null) {
      logger.error('OpenCode prompt failed', {error: String(promptResponse.error)})
      return {
        success: false,
        exitCode: 1,
        duration: Date.now() - startTime,
        sessionId,
        error: String(promptResponse.error),
      }
    }

    const duration = Date.now() - startTime
    logger.info('OpenCode execution completed', {
      sessionId,
      durationMs: duration,
    })

    return {
      success: true,
      exitCode: 0,
      duration,
      sessionId,
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
  } finally {
    // Cleanup
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
    eventController?.abort()
    server?.close()
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
