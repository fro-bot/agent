import type {CredentialDisposition} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {OmoSlimPreset} from '../../shared/types.js'
import type {EnsureOpenCodeResult} from './types.js'
import {
  bootstrapOpenCodeServer as bootstrapRuntimeOpenCodeServer,
  ensureOpenCodeAvailable as ensureRuntimeOpenCodeAvailable,
} from '@fro-bot/runtime'
import {defaultOpenCodeConfigDir, provisionTaskReuseGuard} from '../../services/setup/no-task-reuse-config.js'
import {runtimeSetupAdapter} from '../../services/setup/runtime-setup-adapter.js'
import {toErrorMessage} from '../../shared/errors.js'
import {err} from '../../shared/types.js'

export type {OpenCodeServerHandle} from '@fro-bot/runtime'

/**
 * The single choke point every Action OpenCode server start passes through (`runCacheRestore` is the only
 * caller). Provisions the task-reuse guard (#1757) first, whether or not `runSetup` ran: a runner with OpenCode
 * already installed returns early from `ensureOpenCodeAvailable` (`didSetup: false`) and would otherwise start a
 * server whose global config knows nothing of the guard. Fail-closed: if the guard file or its registration
 * cannot be written, no server starts. Action-only by construction — the gateway uses the runtime bootstrap
 * directly and loads the same plugin through its managed config instead.
 */
export async function bootstrapOpenCodeServer(
  signal: AbortSignal,
  logger: Logger,
  workspacePath: string,
  timeoutMs?: number,
  readinessTimeoutMs?: number,
) {
  try {
    await provisionTaskReuseGuard(defaultOpenCodeConfigDir(), logger)
  } catch (error) {
    return err(
      new Error(`Refusing to start OpenCode without the task-reuse guard: ${toErrorMessage(error)}`, {cause: error}),
    )
  }
  return bootstrapRuntimeOpenCodeServer(signal, logger, workspacePath, timeoutMs, readinessTimeoutMs)
}

export async function ensureOpenCodeAvailable(options: {
  readonly logger: Logger
  readonly opencodeVersion: string
  readonly githubToken: string
  readonly authJson: string
  readonly enableOmo: boolean
  readonly omoVersion: string
  readonly systematicVersion: string
  readonly omoProviders: {
    readonly claude: 'no' | 'yes' | 'max20'
    readonly copilot: 'no' | 'yes'
    readonly gemini: 'no' | 'yes'
    readonly openai: 'no' | 'yes'
    readonly opencodeZen: 'no' | 'yes'
    readonly zaiCodingPlan: 'no' | 'yes'
    readonly kimiForCoding: 'no' | 'yes'
  }
  readonly opencodeConfig: string | null
  readonly systematicConfig: string | null
  readonly enableOmoSlim: boolean
  readonly omoSlimVersion: string
  readonly omoSlimPreset: OmoSlimPreset
  readonly credential: CredentialDisposition
}): Promise<EnsureOpenCodeResult> {
  return ensureRuntimeOpenCodeAvailable(options, runtimeSetupAdapter)
}
