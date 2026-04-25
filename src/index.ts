export {parseActionInputs} from './harness/config/inputs.js'

export {setActionOutputs} from './harness/config/outputs.js'

// Public API - lib exports
export {
  CACHE_EXCLUSIONS,
  CACHE_PREFIX,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_SESSION_RETENTION,
  OPENCODE_AUTH_PATH,
  OPENCODE_STORAGE_PATH,
  STORAGE_VERSION,
} from './shared/constants.js'
// Public API - utils exports
export {getOpenCodeAuthPath, getOpenCodeStoragePath, getRunnerOS, getXdgDataHome} from './shared/env.js'

export {createLogger} from './shared/logger.js'

export type {LogContext, Logger} from './shared/logger.js'
export {ALLOWED_ASSOCIATIONS, err, isErr, isOk, ok} from './shared/types.js'

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
} from './shared/types.js'

export {validateJsonString, validateNonEmptyString, validatePositiveInteger} from './shared/validation.js'
