import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {BuiltConfigV2} from './permission-rules-v2.js'

import {err, ok} from '@bfra.me/es/result'

import {buildConfigContentV2, buildPermissionRulesV2, FORBIDDEN_TOOL_ACTIONS_V2} from './permission-rules-v2.js'

/** The workspace server's per-location memory is released after 10 minutes idle (upstream default is 60). */
export const WORKSPACE_LOCATION_IDLE_TIMEOUT_V2 = '10 minutes'

export interface WorkspaceConfigV2Inputs {
  /** Plugin specs from the workspace installers. */
  readonly plugins: readonly string[]
  /** Literal absolute directories outside the checkout that stay reachable. `*` and `?` are rejected. */
  readonly allowedExternalDirectories?: readonly string[]
  /**
   * The image's installed Systematic `skills/` directory (`resolveSystematicSkillsDirsV2`). Reachable without an ask, so
   * a skill reading its own references does not raise a Discord approval per call, and denied for `edit`. The gate
   * treats it as an authorized exception. Unresolved: leave it out, and the ask stays.
   */
  readonly bundledSkillsDirectories?: readonly string[]
}

/**
 * The workspace `OPENCODE_CONFIG_CONTENT`. Unlike the Action it keeps `question`, which the gateway relays to Discord,
 * and it asks before tool access outside the checkout, which the gateway relays to Discord approval.
 * The caller sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` on the spawn.
 */
export function buildWorkspaceConfigV2(inputs: WorkspaceConfigV2Inputs, logger: Logger): Result<BuiltConfigV2, string> {
  const allowedExternalDirectories = (inputs.allowedExternalDirectories ?? []).map(directory => directory.trim())

  const bundledSkillsDirectories = (inputs.bundledSkillsDirectories ?? []).map(directory => directory.trim())

  const rules = buildPermissionRulesV2({
    outsideEffect: 'ask',
    allowedExternalDirectories,
    bundledSkillsDirectories,
    editDenyResources: [],
    denyQuestion: false,
    denyWebsearch: false,
  })
  if (!rules.success) return err(`allowedExternalDirectories/bundledSkillsDirectories: ${rules.error}`)

  logger.debug('Built workspace OpenCode config', {
    pluginCount: inputs.plugins.length,
    allowedExternalDirectoryCount: allowedExternalDirectories.length,
    bundledSkillsDirectoryCount: bundledSkillsDirectories.length,
  })

  const base = buildConfigContentV2({plugins: inputs.plugins, rules: rules.data})

  return ok({
    content: {
      ...base,
      experimental: {
        ...(base.experimental as Record<string, unknown>),
        location_idle_timeout: WORKSPACE_LOCATION_IDLE_TIMEOUT_V2,
      },
    },
    expectations: {
      outsidePolicy: 'ask-or-deny',
      allowedDirectories: [...allowedExternalDirectories, ...bundledSkillsDirectories],
      deniedActions: FORBIDDEN_TOOL_ACTIONS_V2,
    },
  })
}
