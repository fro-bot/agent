/**
 * The OpenCode V2 pieces the workspace agent runs on, published as the `@fro-bot/runtime/workspace-v2` subpath so the
 * agent skips the full barrel (and with it the V1 SDK).
 */

export {
  DEFAULT_SYSTEMATIC_VERSION,
  FRO_BOT_PLUGIN_ID,
  FRO_BOT_PLUGIN_PACKAGE,
  FRO_BOT_PLUGIN_VERSION,
  SYSTEMATIC_PACKAGE,
  SYSTEMATIC_V2_PLUGIN_ID,
} from '../shared/constants.js'

export type {Logger} from '../shared/logger.js'

export {verifyPermissionRules} from './permission-gate-v2.js'

export type {AgentListSource, PermissionGateError, PermissionGateExpectations} from './permission-gate-v2.js'

export type {BuiltConfigV2} from './permission-rules-v2.js'

export {DEFAULT_OPENCODE_V2_TIMEOUTS, startOpenCodeV2Server} from './server-v2.js'

export type {
  OpenCodeV2ExitInfo,
  OpenCodeV2ServerHandle,
  OpenCodeV2ShutdownOptions,
  OpenCodeV2ShutdownResult,
  OpenCodeV2StartError,
  OpenCodeV2Timeouts,
  StartOpenCodeV2ServerOptions,
} from './server-v2.js'

export {buildWorkspaceConfigV2} from './workspace-config-v2.js'

export type {WorkspaceConfigV2Inputs} from './workspace-config-v2.js'
