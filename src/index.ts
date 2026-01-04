// Public API - lib exports
export {
  CACHE_EXCLUSIONS,
  CACHE_PREFIX,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_SESSION_RETENTION,
  LLM_RETRY_DELAY_MS,
  OPENCODE_AUTH_PATH,
  OPENCODE_STORAGE_PATH,
  RETRY_DELAYS_MS,
  STORAGE_VERSION,
} from './lib/constants.js'

export {parseActionInputs} from './lib/inputs.js'

export {createLogger} from './lib/logger.js'
export type {LogContext, Logger} from './lib/logger.js'

export {setActionOutputs} from './lib/outputs.js'

export {ALLOWED_ASSOCIATIONS, err, isErr, isOk, ok} from './lib/types.js'
export type {
  ActionInputs,
  ActionOutputs,
  AgentIdentity,
  AuthorAssociation,
  CacheResult,
  Err,
  Ok,
  ParseResult,
  PruningConfig,
  Result,
  RunContext,
  RunSummary,
  TokenUsage,
  ValidationResult,
} from './lib/types.js'

// Public API - utils exports
export {getOpenCodeAuthPath, getOpenCodeStoragePath, getRunnerOS, getXdgDataHome} from './utils/env.js'

export {validateJsonString, validateNonEmptyString, validatePositiveInteger} from './utils/validation.js'
