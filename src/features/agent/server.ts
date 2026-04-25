import type {Result} from '@bfra.me/es/result'
import type {SessionClient} from '@fro-bot/runtime'
import type {SetupInputs} from '../../services/setup/types.js'
import type {Logger} from '../../shared/logger.js'
import type {EnsureOpenCodeResult} from './types.js'
import process from 'node:process'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {createOpencode} from '@opencode-ai/sdk'
import {runSetup} from '../../services/setup/setup.js'
import {err, ok} from '../../shared/types.js'

export interface OpenCodeServerHandle {
  readonly client: SessionClient
  readonly server: {readonly url: string; close: () => void}
  readonly shutdown: () => void
}

export async function bootstrapOpenCodeServer(
  signal: AbortSignal,
  logger: Logger,
): Promise<Result<OpenCodeServerHandle, Error>> {
  try {
    const opencode = await createOpencode({signal})
    const {client, server} = opencode
    logger.debug('OpenCode server bootstrapped', {url: server.url})
    return ok({
      client,
      server,
      shutdown: () => {
        server.close()
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warning('Failed to bootstrap OpenCode server', {error: message})
    return err(new Error(`Server bootstrap failed: ${message}`))
  }
}

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
    logger.debug('OpenCode not available, will attempt auto-setup')
    return {available: false, version: null}
  }
}

export interface EnsureOpenCodeOptions {
  readonly logger: Logger
  readonly opencodeVersion: string
  readonly githubToken: string
  readonly authJson: string
  readonly omoVersion: string
  readonly systematicVersion: string
  readonly omoProviders: SetupInputs['omoProviders']
  readonly opencodeConfig: string | null
  readonly systematicConfig: string | null
}

export async function ensureOpenCodeAvailable(options: EnsureOpenCodeOptions): Promise<EnsureOpenCodeResult> {
  const {logger, opencodeVersion} = options
  const existingPath = process.env.OPENCODE_PATH ?? null
  const check = await verifyOpenCodeAvailable(existingPath, logger)

  if (check.available && check.version != null) {
    logger.info('OpenCode already available', {version: check.version})
    return {path: existingPath ?? 'opencode', version: check.version, didSetup: false}
  }

  logger.info('OpenCode not found, running auto-setup', {requestedVersion: opencodeVersion})
  const setupInputs: SetupInputs = {
    opencodeVersion,
    authJson: options.authJson,
    appId: null,
    privateKey: null,
    opencodeConfig: options.opencodeConfig,
    systematicConfig: options.systematicConfig,
    omoConfig: null,
    omoVersion: options.omoVersion,
    systematicVersion: options.systematicVersion,
    omoProviders: options.omoProviders,
  }
  const setupResult = await runSetup(setupInputs, options.githubToken)
  if (setupResult == null) {
    throw new Error('Auto-setup failed: runSetup returned null')
  }

  core.addPath(setupResult.opencodePath)
  process.env.OPENCODE_PATH = setupResult.opencodePath
  logger.info('Auto-setup completed', {version: setupResult.opencodeVersion, path: setupResult.opencodePath})
  return {path: setupResult.opencodePath, version: setupResult.opencodeVersion, didSetup: true}
}
