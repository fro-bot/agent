import type {SetupAdapter} from '@fro-bot/runtime'
import type {RunSetupOptions} from './setup.js'
import type {SetupInputs} from './types.js'
import * as core from '@actions/core'
import {runSetup} from './setup.js'

export function createRuntimeSetupAdapter(options: RunSetupOptions = {}): SetupAdapter {
  return {
    runSetup: async (inputs: SetupInputs, githubToken: string) => runSetup(inputs, githubToken, options),
    addToPath: (toolPath: string) => {
      core.addPath(toolPath)
    },
  }
}

export const runtimeSetupAdapter: SetupAdapter = createRuntimeSetupAdapter()
