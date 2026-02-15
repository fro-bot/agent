// Setup module public exports
export {parseAuthJsonInput, populateAuthJson} from './auth-json.js'
export {configureGhAuth, configureGitIdentity, getBotUserId} from './gh-auth.js'
export {installOmo, verifyOmoInstallation} from './omo.js'
export type {OmoInstallDeps, OmoInstallOptions} from './omo.js'
export {getLatestVersion, installOpenCode} from './opencode.js'
export {restoreToolsCache, saveToolsCache} from './tools-cache.js'
export type {ToolsCacheAdapter, ToolsCacheResult} from './tools-cache.js'

// Types
export type {
  ApiAuth,
  AuthConfig,
  AuthInfo,
  ExecAdapter,
  ExecOptions,
  ExecOutput,
  GhAuthResult,
  Logger,
  OAuthAuth,
  OmoInstallResult,
  OpenCodeInstallResult,
  PlatformInfo,
  PromptContext,
  SetupInputs,
  SetupResult,
  ToolCacheAdapter,
  WellKnownAuth,
} from './types.js'
