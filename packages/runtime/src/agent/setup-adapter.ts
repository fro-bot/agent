import type {Logger} from '../shared/logger.js'
import type {OmoProviders} from '../shared/types.js'

/**
 * Setup action inputs needed by the runtime's auto-setup path.
 * Mirrors the shape from services/setup/types.ts without crossing the package boundary.
 */
export interface SetupInputs {
  readonly opencodeVersion: string
  readonly authJson: string
  readonly appId: string | null
  readonly privateKey: string | null
  readonly opencodeConfig: string | null
  readonly systematicConfig: string | null
  readonly omoConfig: string | null
  readonly omoVersion: string
  readonly systematicVersion: string
  readonly omoProviders: OmoProviders
}

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
