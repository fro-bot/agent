import type {SessionClient} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import * as exec from '@actions/exec'

export interface OpenCodeServerHandle {
  readonly client: SessionClient
  readonly server: {readonly url: string; close: () => void}
  readonly shutdown: () => void
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
