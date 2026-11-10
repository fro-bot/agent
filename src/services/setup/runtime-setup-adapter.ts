import type {SetupAdapter} from '@fro-bot/runtime'
import type {SetupInputs} from './types.js'
import * as core from '@actions/core'
import {runSetup} from './setup.js'

export const runtimeSetupAdapter: SetupAdapter = {
  runSetup: async (inputs: SetupInputs, githubToken: string) => runSetup(inputs, githubToken),
  addToPath: (toolPath: string) => {
    core.addPath(toolPath)
  },
}
