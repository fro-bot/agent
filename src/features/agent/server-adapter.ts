import type {CredentialDisposition} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {OmoSlimPreset} from '../../shared/types.js'
import type {EnsureOpenCodeResult} from './types.js'
import {
  bootstrapOpenCodeServer as bootstrapRuntimeOpenCodeServer,
  ensureOpenCodeAvailable as ensureRuntimeOpenCodeAvailable,
} from '@fro-bot/runtime'
import {
  defaultOpenCodeConfigDir,
  taskReuseGuardServerConfig,
  writeNoTaskReuseFile,
} from '../../services/setup/no-task-reuse-config.js'
import {runtimeSetupAdapter} from '../../services/setup/runtime-setup-adapter.js'
import {toErrorMessage} from '../../shared/errors.js'
import {err} from '../../shared/types.js'

export type {OpenCodeServerHandle} from '@fro-bot/runtime'

/**
 * The single choke point every Action OpenCode server start passes through (`runCacheRestore` is the only
 * caller). Before each start it writes the task-reuse guard plugin file (#1757) and passes the guard to the
 * server as spawn-time config, whether or not `runSetup` ran: a runner with OpenCode already installed returns
 * early from `ensureOpenCodeAvailable` (`didSetup: false`) and never reaches setup.
 *
 * The guard travels in the SDK's `OPENCODE_CONFIG_CONTENT` layer, not in any file: that layer loads after the
 * global config, project config and `.opencode` dirs, and plugin lists from separate layers concatenate, so
 * nothing the operator or repository ships can drop it, and no user config file is read or rewritten. Fail-
 * closed: if the plugin file cannot be written, no server starts. Action-only by construction — the gateway
 * uses the runtime bootstrap directly (no config) and loads the same plugin through its managed config.
 */
export async function bootstrapOpenCodeServer(
  signal: AbortSignal,
  logger: Logger,
  workspacePath: string,
  timeoutMs?: number,
  readinessTimeoutMs?: number,
) {
  const configDir = defaultOpenCodeConfigDir()
  try {
    await writeNoTaskReuseFile(configDir, logger)
  } catch (error) {
    return err(
      new Error(`Refusing to start OpenCode without the task-reuse guard: ${toErrorMessage(error)}`, {cause: error}),
    )
  }
  return bootstrapRuntimeOpenCodeServer(signal, logger, workspacePath, timeoutMs, readinessTimeoutMs, {
    config: taskReuseGuardServerConfig(configDir),
  })
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
