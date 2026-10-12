import type {SetupAdapter} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {SetupInputs} from './types.js'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {runSetup} from './setup.js'

export const runtimeSetupAdapter: SetupAdapter = {
  verifyOpenCodeAvailable: async (opencodePath: string | null, logger: Logger) => {
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
      // Full version token including any prerelease/build suffix (e.g. `1.18.34+harness.6546eb64`): the
      // caller compares it for exact equality with the pinned version, so a bare x.y.z would not do.
      const versionMatch = /(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)/.exec(version)
      const parsedVersion: string | null = versionMatch?.[1] ?? null
      logger.debug('OpenCode version verified', {version: parsedVersion})
      return {available: true, version: parsedVersion}
    } catch {
      logger.debug('OpenCode not available, will attempt auto-setup')
      return {available: false, version: null}
    }
  },
  runSetup: async (inputs: SetupInputs, githubToken: string) => runSetup(inputs, githubToken),
  addToPath: (toolPath: string) => {
    core.addPath(toolPath)
  },
}
