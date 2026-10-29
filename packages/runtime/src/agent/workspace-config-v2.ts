import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {BuiltConfigV2} from './permission-rules-v2.js'

import {err, ok} from '@bfra.me/es/result'

import {buildConfigContentV2, buildPermissionRulesV2, FORBIDDEN_TOOL_ACTIONS_V2} from './permission-rules-v2.js'

export interface WorkspaceConfigV2Inputs {
  /** Plugin specs from the workspace installers. */
  readonly plugins: readonly string[]
  /** Literal absolute directories outside the checkout that stay reachable. `*` and `?` are rejected. */
  readonly allowedExternalDirectories?: readonly string[]
}

/**
 * The workspace `OPENCODE_CONFIG_CONTENT`. Unlike the Action it keeps `question`, which the gateway relays to Discord,
 * and it asks before tool access outside the checkout, which the gateway relays to Discord approval.
 * The caller sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` on the spawn.
 */
export function buildWorkspaceConfigV2(inputs: WorkspaceConfigV2Inputs, logger: Logger): Result<BuiltConfigV2, string> {
  const allowedExternalDirectories = (inputs.allowedExternalDirectories ?? []).map(directory => directory.trim())

  const rules = buildPermissionRulesV2({
    outsideEffect: 'ask',
    allowedExternalDirectories,
    editDenyResources: [],
    denyQuestion: false,
  })
  if (!rules.success) return err(`allowedExternalDirectories: ${rules.error}`)

  logger.debug('Built workspace OpenCode config', {
    pluginCount: inputs.plugins.length,
    allowedExternalDirectoryCount: allowedExternalDirectories.length,
  })

  return ok({
    content: buildConfigContentV2({plugins: inputs.plugins, rules: rules.data}),
    expectations: {
      outsidePolicy: 'ask-or-deny',
      allowedDirectories: allowedExternalDirectories,
      deniedActions: FORBIDDEN_TOOL_ACTIONS_V2,
    },
  })
}
