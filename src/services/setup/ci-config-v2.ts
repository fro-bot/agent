import type {Result} from '@bfra.me/es/result'
import type {BuiltConfigV2} from '@fro-bot/runtime'
import type {Logger} from './types.js'

import * as path from 'node:path'
import {err, ok} from '@bfra.me/es/result'
import {
  ATTACHMENT_DIR_SEGMENT,
  buildAttachmentDir,
  buildConfigContentV2,
  buildPermissionRulesV2,
  buildResponseFileDir,
  buildResponseFileFallbackRoots,
  FORBIDDEN_TOOL_ACTIONS_V2,
  OUTSIDE_SENTINEL_DIRECTORY,
  RESPONSE_FILE_DIR_SEGMENT,
} from '@fro-bot/runtime'

/** Sibling run id the gate evaluates to prove an exception stays scoped to this run. */
const OTHER_RUN_SENTINEL = 'gate-sentinel-other-run'

export interface CIConfigV2Inputs {
  /** The `opencode-config` action input, or null. */
  readonly opencodeConfig: string | null
  /** Plugin specs from the surface installers. */
  readonly plugins: readonly string[]
  /** `RUNNER_TEMP`. Without it only the flat outside deny is emitted. */
  readonly runnerTemp: string | undefined
  readonly runId: string | number
  readonly runAttempt: string | number
  readonly integrationWorkDir?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  return path.resolve(filePath).startsWith(`${path.resolve(directoryPath)}${path.sep}`)
}

/** Keys that carry permission rules in either spelling. Any of them in operator config could undo the deny. */
const PERMISSION_KEYS = ['permission', 'permissions', 'tools'] as const
const AGENT_MAP_KEYS = ['agent', 'agents', 'mode'] as const

/**
 * Remove the operator-supplied keys that carry permission rules, and the V1 keys V2 rejects or double-reads.
 * A V1-spelled `agent.build.permission` allow in the same content overrides the top-level deny for that agent (P4).
 */
function stripOperatorPermissions(operator: Record<string, unknown>, logger: Logger): Record<string, unknown> {
  const result: Record<string, unknown> = {...operator}
  const removed: string[] = []

  for (const key of [...PERMISSION_KEYS, 'autoupdate', 'subagent_depth']) {
    if (key in result) {
      delete result[key]
      removed.push(key)
    }
  }

  for (const mapKey of AGENT_MAP_KEYS) {
    const entries = result[mapKey]
    if (!isRecord(entries)) continue
    const cleaned: Record<string, unknown> = {}
    for (const [name, definition] of Object.entries(entries)) {
      if (!isRecord(definition)) {
        cleaned[name] = definition
        continue
      }
      const copy = {...definition}
      for (const key of PERMISSION_KEYS) {
        if (key in copy) {
          delete copy[key]
          removed.push(`${mapKey}.${name}.${key}`)
        }
      }
      cleaned[name] = copy
    }
    result[mapKey] = cleaned
  }

  if (removed.length > 0) {
    logger.warning(
      `OpenCode config rewritten: removed ${removed.join(', ')}. Permission rules and the update and subagent depth settings are set by the harness.`,
    )
  }
  return result
}

/**
 * Build the V2 `OPENCODE_CONFIG_CONTENT` for an Action run, plus what the permission gate must find after spawn.
 *
 * Pure: the run identity and `RUNNER_TEMP` come in as inputs. The spawn sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
 * The response-file and attachment directories are run-scoped and live outside the checkout, so a hostile checkout
 * cannot plant or read them; every other external directory stays denied.
 */
export function buildCIConfigV2(inputs: CIConfigV2Inputs, logger: Logger): Result<BuiltConfigV2, string> {
  let operator: Record<string, unknown> = {}
  if (inputs.opencodeConfig != null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(inputs.opencodeConfig)
    } catch {
      return err('opencode-config must be valid JSON')
    }
    if (!isRecord(parsed)) {
      return err('opencode-config must be a JSON object')
    }
    operator = stripOperatorPermissions(parsed, logger)
  }

  const runnerTemp = inputs.runnerTemp?.trim()
  const hasRunnerTemp = runnerTemp != null && runnerTemp.length > 0
  if (hasRunnerTemp && !path.isAbsolute(runnerTemp)) {
    return err(`RUNNER_TEMP must be an absolute path, got: ${runnerTemp}`)
  }

  const allowedDirectories: string[] = []
  const outsideDirectories = [OUTSIDE_SENTINEL_DIRECTORY]
  const editDenyResources: string[] = []

  if (hasRunnerTemp) {
    const identity = {runnerTemp, runId: inputs.runId, runAttempt: inputs.runAttempt}
    allowedDirectories.push(buildResponseFileDir(identity), buildAttachmentDir(identity))
    outsideDirectories.push(
      path.join(runnerTemp, RESPONSE_FILE_DIR_SEGMENT, OTHER_RUN_SENTINEL),
      path.join(runnerTemp, ATTACHMENT_DIR_SEGMENT, OTHER_RUN_SENTINEL),
    )
    // Workspace-relative shadows of the response-file directory: the model must write the real one, never a copy in
    // the checkout.
    for (const root of buildResponseFileFallbackRoots(runnerTemp)) {
      editDenyResources.push(path.join(root, RESPONSE_FILE_DIR_SEGMENT, '*'))
    }

    const workDir = inputs.integrationWorkDir?.trim()
    if (workDir != null && workDir.length > 0) {
      if (isPathInsideDirectory(workDir, runnerTemp)) {
        allowedDirectories.push(workDir)
      } else {
        logger.warning('Ignoring integration workdir outside RUNNER_TEMP', {integrationWorkDir: workDir, runnerTemp})
      }
    }
  } else {
    logger.debug('Skipping response-file and attachment exceptions: RUNNER_TEMP is not set')
  }

  const rules = buildPermissionRulesV2({
    allowedExternalDirectories: allowedDirectories,
    editDenyResources,
    denyQuestion: true,
  })
  const base = buildConfigContentV2({plugins: [], rules})

  const operatorPlugins = Array.isArray(operator.plugins)
    ? (operator.plugins as unknown[]).filter((plugin): plugin is string => typeof plugin === 'string')
    : []
  const operatorExperimental = isRecord(operator.experimental) ? operator.experimental : {}

  const content = {
    ...operator,
    ...base,
    plugins: [...new Set([...inputs.plugins, ...operatorPlugins])],
    experimental: {...operatorExperimental, ...(base.experimental as Record<string, unknown>)},
  }

  logger.debug('Built CI OpenCode config', {
    hasUserConfig: inputs.opencodeConfig != null,
    pluginCount: content.plugins.length,
  })

  return ok({
    content,
    expectations: {
      outsideDirectories,
      allowedDirectories,
      deniedActions: FORBIDDEN_TOOL_ACTIONS_V2,
    },
  })
}
