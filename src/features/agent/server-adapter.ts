import type {Logger} from '../../shared/logger.js'
import type {EnsureOpenCodeResult} from './types.js'
import {
  bootstrapOpenCodeServer as bootstrapRuntimeOpenCodeServer,
  ensureOpenCodeAvailable as ensureRuntimeOpenCodeAvailable,
} from '@fro-bot/runtime'
import {runtimeSetupAdapter} from '../../services/setup/runtime-setup-adapter.js'

export type {OpenCodeServerHandle} from '@fro-bot/runtime'

export async function bootstrapOpenCodeServer(signal: AbortSignal, logger: Logger) {
  return bootstrapRuntimeOpenCodeServer(signal, logger)
}

export async function ensureOpenCodeAvailable(options: {
  readonly logger: Logger
  readonly opencodeVersion: string
  readonly githubToken: string
  readonly authJson: string
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
}): Promise<EnsureOpenCodeResult> {
  return ensureRuntimeOpenCodeAvailable(options, runtimeSetupAdapter)
}
