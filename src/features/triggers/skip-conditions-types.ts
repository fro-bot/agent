import type {Logger} from '../../shared/logger.js'
import type {SkipReason, TriggerConfig, TriggerContext} from './types.js'

export type SkipCheckResult = {shouldSkip: false} | {shouldSkip: true; reason: SkipReason; message: string}

export interface SkipCheckArgs {
  readonly context: TriggerContext
  readonly config: TriggerConfig
  readonly logger: Logger
}
