import type {SetupInputs} from '../../../../src/services/setup/types.js'
import type {Logger} from '../shared/logger.js'

export interface SetupAdapter {
  readonly verifyOpenCodeAvailable: (
    opencodePath: string | null,
    logger: Logger,
  ) => Promise<{available: boolean; version: string | null}>
  readonly runSetup: (
    inputs: SetupInputs,
    githubToken: string,
  ) => Promise<{
    readonly opencodePath: string
    readonly opencodeVersion: string
  } | null>
  readonly addToPath: (toolPath: string) => void
}
