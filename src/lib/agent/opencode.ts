/**
 * OpenCode SDK execution for RFC-013.
 *
 * Handles launching OpenCode in server mode and communicating via SDK client.
 * Replaces CLI-based execution from RFC-012 with SDK-based execution.
 */

import type {Logger} from '../logger.js'
import type {AgentResult, EnsureOpenCodeResult, ExecutionConfig, PromptOptions} from './types.js'
import process from 'node:process'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {createOpencode} from '@opencode-ai/sdk'
import {DEFAULT_TIMEOUT_MS} from '../constants.js'
import {runSetup} from '../setup/setup.js'
import {buildAgentPrompt} from './prompt.js'

/** ANSI color codes for tool output formatting */
const TOOL_COLORS: Record<string, [string, string]> = {
  todowrite: ['Todo', '\u001B[33m\u001B[1m'],
  todoread: ['Todo', '\u001B[33m\u001B[1m'],
  bash: ['Bash', '\u001B[31m\u001B[1m'],
  edit: ['Edit', '\u001B[32m\u001B[1m'],
  glob: ['Glob', '\u001B[34m\u001B[1m'],
  grep: ['Grep', '\u001B[34m\u001B[1m'],
  list: ['List', '\u001B[34m\u001B[1m'],
  read: ['Read', '\u001B[35m\u001B[1m'],
  write: ['Write', '\u001B[32m\u001B[1m'],
  websearch: ['Search', '\u001B[2m\u001B[1m'],
} as const
const ANSI_RESET = '\u001B[0m'
const ANSI_DIM = '\u001B[0m\u001B[2m'

function outputToolExecution(toolName: string, title: string): void {
  const [displayName, color] = TOOL_COLORS[toolName.toLowerCase()] ?? [toolName, '\u001B[36m\u001B[1m']
  const paddedName = displayName.padEnd(7, ' ')
  process.stdout.write(`\n${color}|${ANSI_RESET}${ANSI_DIM} ${paddedName} ${ANSI_RESET}${title}\n`)
}

function outputTextContent(text: string): void {
  process.stdout.write(`\n${text}\n`)
}

interface EventProperties {
  part?: {
    sessionID?: string
    type?: string
    text?: string
    tool?: string
    time?: {end?: number}
    state?: {status?: string; title?: string; input?: Record<string, unknown>}
  }
  info?: {id?: string; title?: string; version?: string}
  sessionID?: string
  error?: unknown
}

interface OpenCodeEvent {
  type: string
  properties: EventProperties
}

async function processEventStream(
  stream: AsyncIterable<OpenCodeEvent>,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  let lastText = ''

  for await (const event of stream) {
    const props = event.properties

    if (event.type === 'message.part.updated') {
      const part = props.part
      if (part?.sessionID !== sessionId) continue

      if (part.type === 'text' && typeof part.text === 'string') {
        lastText = part.text
        const endTime = part.time?.end

        if (endTime != null && Number.isFinite(endTime)) {
          outputTextContent(lastText)
          lastText = ''
        }
      } else if (part.type === 'tool' && part.state?.status === 'completed') {
        const toolName = part.tool ?? 'unknown'
        const toolInput = part.state.input ?? {}
        const title = part.state.title ?? (Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : 'Unknown')
        outputToolExecution(toolName, title)
      }
    } else if (event.type === 'session.error' && props.sessionID === sessionId) {
      logger.error('Session error', {error: props.error})
    }
  }
}

export async function executeOpenCode(
  promptOptions: PromptOptions,
  logger: Logger,
  config?: ExecutionConfig,
): Promise<AgentResult> {
  const startTime = Date.now()
  const abortController = new AbortController()

  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  let server: Awaited<ReturnType<typeof createOpencode>>['server'] | null = null

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true
      logger.warning('Execution timeout reached', {timeoutMs})
      abortController.abort()
    }, timeoutMs)
  }

  logger.info('Executing OpenCode agent (SDK mode)', {
    agent: config?.agent ?? 'Sisyphus',
    hasModelOverride: config?.model != null,
    timeoutMs,
  })

  try {
    const opencode = await createOpencode({
      signal: abortController.signal,
    })
    const {client} = opencode
    server = opencode.server

    logger.debug('OpenCode server started', {url: server.url})

    const sessionResponse = await client.session.create()
    if (sessionResponse.data == null || sessionResponse.error != null) {
      const errorMsg = sessionResponse.error == null ? 'No data returned' : String(sessionResponse.error)
      throw new Error(`Failed to create session: ${errorMsg}`)
    }
    const sessionId = sessionResponse.data.id
    logger.debug('Session created', {sessionId})

    const prompt = buildAgentPrompt({...promptOptions, sessionId}, logger)

    const agentName = config?.agent ?? 'Sisyphus'
    logger.debug('Using agent', {agent: agentName})

    const events = await client.event.subscribe()

    let eventStreamEnded = false
    const eventProcessingPromise = processEventStream(events.stream as AsyncIterable<OpenCodeEvent>, sessionId, logger)
      .catch(error => {
        if (error instanceof Error && error.name !== 'AbortError') {
          logger.debug('Event stream error', {error: error.message})
        }
      })
      .finally(() => {
        eventStreamEnded = true
      })

    const promptBody: {
      agent?: string
      model?: {modelID: string; providerID: string}
      parts: {text: string; type: 'text'}[]
    } = {
      agent: agentName,
      parts: [{type: 'text', text: prompt}],
    }

    if (config?.model != null) {
      promptBody.model = {
        providerID: config.model.providerID,
        modelID: config.model.modelID,
      }
    }

    logger.debug('Sending prompt to OpenCode', {sessionId, body: promptBody})
    const promptResponse = await client.session.prompt({
      path: {id: sessionId},
      body: promptBody,
    })

    // Give event stream a short grace period to flush remaining events, then abort
    // Don't wait indefinitely - the prompt response indicates completion
    if (!eventStreamEnded) {
      const gracePeriod = new Promise<void>(resolve => setTimeout(resolve, 1000))
      await Promise.race([eventProcessingPromise, gracePeriod])
    }

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
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
    abortController.abort()
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
        stdout: (data: Uint8Array) => {
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

export interface EnsureOpenCodeOptions {
  logger: Logger
  opencodeVersion: string
}

export async function ensureOpenCodeAvailable(options: EnsureOpenCodeOptions): Promise<EnsureOpenCodeResult> {
  const {logger, opencodeVersion} = options

  const existingPath = process.env.OPENCODE_PATH ?? null
  const check = await verifyOpenCodeAvailable(existingPath, logger)

  if (check.available && check.version != null) {
    logger.info('OpenCode already available', {version: check.version})
    return {
      path: existingPath ?? 'opencode',
      version: check.version,
      didSetup: false,
    }
  }

  logger.info('OpenCode not found, running auto-setup', {requestedVersion: opencodeVersion})

  const setupResult = await runSetup()

  if (setupResult == null) {
    throw new Error('Auto-setup failed: runSetup returned null')
  }

  core.addPath(setupResult.opencodePath)
  process.env.OPENCODE_PATH = setupResult.opencodePath

  logger.info('Auto-setup completed', {
    version: setupResult.opencodeVersion,
    path: setupResult.opencodePath,
  })

  return {
    path: setupResult.opencodePath,
    version: setupResult.opencodeVersion,
    didSetup: true,
  }
}
