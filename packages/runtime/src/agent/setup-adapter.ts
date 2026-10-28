import type {Logger} from '../shared/logger.js'
import type {CredentialDisposition} from './response-delivery.js'

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
  readonly systematicVersion: string
  readonly credential: CredentialDisposition
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
    /** Install DIRECTORY — what goes on PATH. Spawning it fails EACCES. */
    readonly opencodePath: string
    /** The executable inside `opencodePath`. Use this for anything that runs OpenCode. */
    readonly opencodeBinaryPath: string
    readonly opencodeVersion: string
  } | null>
  readonly addToPath: (toolPath: string) => void
}
