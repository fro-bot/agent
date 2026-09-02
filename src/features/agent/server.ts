import type {Logger} from '../../shared/logger.js'
import * as exec from '@actions/exec'

// OpenCodeServerHandle is NOT redefined here. The canonical definition lives in
// @fro-bot/runtime (packages/runtime/src/agent/server.ts) and is re-exported by
// ./server-adapter.ts; a second local copy previously drifted from it silently (the
// runtime's shutdown() became async while this one stayed `() => void`, and nothing
// caught it because a Promise-returning function is structurally assignable to a
// void-returning one). Import the type from ./server-adapter.js instead.

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
