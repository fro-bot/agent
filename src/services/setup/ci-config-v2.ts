import type {Result} from '@bfra.me/es/result'
import type {BuiltConfigV2, CredentialDisposition} from '@fro-bot/runtime'
import type {Logger} from './types.js'

import * as path from 'node:path'
import {err, ok} from '@bfra.me/es/result'
import {
  buildAttachmentDir,
  buildConfigContentV2,
  buildPermissionRulesV2,
  buildResponseFileDir,
  buildResponseFileFallbackRoots,
  FORBIDDEN_TOOL_ACTIONS_V2,
  RESPONSE_FILE_DIR_SEGMENT,
  WEBSEARCH_ACTION_V2,
} from '@fro-bot/runtime'
import {applyOperatorMcpV2} from './mcp-servers-v2.js'

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
  /**
   * The installed Systematic `skills/` directory (`resolveSystematicSkillsDirsV2`), so a skill can read its own
   * references and run its own scripts under the outside-checkout deny (fro-bot/agent#2009). Becomes an authorized
   * exception of the permission gate. Empty or absent when unresolved: nothing is added.
   *
   * SECURITY: `external_directory` is not read-only, so this also lets a shell command write there during the run. The
   * `edit`, `write` and `patch` tools are denied for the directory (V2 asks `edit` about the absolute path outside the
   * checkout, so the absolute resource matches). On a hosted runner the tools cache is saved during setup, before the
   * agent runs, so a write does not persist; a persistent or self-hosted runner keeps it, as it is the plugin's real
   * install location.
   */
  readonly bundledSkillsDirectories?: readonly string[]
  /**
   * Provider id to the absolute path of the file holding that provider's API key (`credential-files-v2.ts`). Each is
   * referenced as `provider.<id>.options.apiKey: "{file:/path}"`. The V1-shaped `options` is what the server migrates
   * into V2 `settings`, including the V1-to-V2 provider id mapping, so a provider id from `auth-json` and one from
   * `model` mean the same thing as they do in V1. The path is never logged.
   */
  readonly providerKeyFiles?: Readonly<Record<string, string>>
  /**
   * The run's credential disposition (`resolveResponseDelivery`). Required, so a caller cannot omit it into the
   * permissive reading. On `withhold` (`pull_request`, `issue_comment`, `issues`) untrusted text drives the model, so
   * the operator's `mcp` is removed from the config (`applyOperatorMcpV2`).
   */
  readonly credential: CredentialDisposition
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  return path.resolve(filePath).startsWith(`${path.resolve(directoryPath)}${path.sep}`)
}

/** Upstream's `/\{env:([^}]+)\}/` (`core/src/config/variable.ts`), as the opening it needs: case-sensitive. */
const ENV_REFERENCE_OPENING = '{env:'

/**
 * Whether the operator's config holds a `{env:...}` reference anywhere: a key, a value or a nested string.
 *
 * Checked on the serialized object, which is the text the server substitutes into: a brace written as `\u007b` in the
 * input is `{` here, and a quote between `{` and `env:` (a key named `env:`) does not match, as upstream.
 */
function containsEnvReference(operator: Record<string, unknown>): boolean {
  return JSON.stringify(operator).includes(ENV_REFERENCE_OPENING)
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

/** The server's `{file:...}` substitution ends a reference at the first `}`. */
const KEY_FILE_PATH_PATTERN = /^\/[^}\n\r"\\]+$/

/**
 * `provider.<id>.options.apiKey` references for each key file, merged into the operator's `provider` block. The key
 * file wins over an inline operator key for the same provider; every other operator setting for it is kept.
 */
function withProviderKeyFiles(
  operatorProvider: unknown,
  keyFiles: Readonly<Record<string, string>>,
): Result<Record<string, unknown>, string> {
  const provider: Record<string, unknown> = isRecord(operatorProvider) ? {...operatorProvider} : {}
  for (const [providerId, keyFile] of Object.entries(keyFiles)) {
    if (!KEY_FILE_PATH_PATTERN.test(keyFile)) {
      return err(`The key file for provider "${providerId}" is not an absolute path that a {file:} reference can hold`)
    }
    const existing = isRecord(provider[providerId]) ? provider[providerId] : {}
    const existingOptions = isRecord(existing.options) ? existing.options : {}
    provider[providerId] = {...existing, options: {...existingOptions, apiKey: `{file:${keyFile}}`}}
  }
  return ok(provider)
}

/**
 * Build the V2 `OPENCODE_CONFIG_CONTENT` for an Action run, plus what the permission gate must find after spawn.
 *
 * Pure: the run identity and `RUNNER_TEMP` come in as inputs. The spawn sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
 * The response-file and attachment directories are run-scoped and live outside the checkout, so a hostile checkout
 * cannot plant or read them; every other external directory stays denied. Fails when `RUNNER_TEMP`, the run identity or
 * the integration workdir would make an exception directory contain `*` or `?`, which the server reads as wildcards.
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
    // Withheld runs: the server splices a `{env:}` value into the config text raw and escapes it only when the result
    // does not parse (`core/src/config/variable.ts:27-37`), so an attacker-influenced allowlisted value (a branch name in
    // `GITHUB_HEAD_REF`) could add JSON structure after the strips below. Our own generated config has no `{env:}`: this
    // inspects the operator's input alone. The message names the rule, never a value.
    if (inputs.credential === 'withhold' && containsEnvReference(parsed)) {
      return err(
        'opencode-config must not contain {env:} references on credential-withheld triggers (pull_request, issue_comment, issues): the server splices an environment value into the config text before it parses it',
      )
    }
    operator = stripOperatorPermissions(parsed, logger)
  }

  // Caller MCP servers (fro-bot/agent#1931): removed on a credential-withheld run, validated otherwise. No permission
  // rule is added: the default agents already allow `*`, and the read-only subagents deny it.
  const withMcpApplied = applyOperatorMcpV2(operator, inputs.credential, logger)
  if (!withMcpApplied.success) return err(withMcpApplied.error.message)
  operator = withMcpApplied.data

  const runnerTemp = inputs.runnerTemp?.trim()
  const hasRunnerTemp = runnerTemp != null && runnerTemp.length > 0
  if (hasRunnerTemp && !path.isAbsolute(runnerTemp)) {
    return err(`RUNNER_TEMP must be an absolute path, got: ${runnerTemp}`)
  }

  const allowedDirectories: string[] = []
  const editDenyResources: string[] = []

  if (hasRunnerTemp) {
    const identity = {runnerTemp, runId: inputs.runId, runAttempt: inputs.runAttempt}
    allowedDirectories.push(buildResponseFileDir(identity), buildAttachmentDir(identity))
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

  const bundledSkillsDirectories = inputs.bundledSkillsDirectories ?? []

  const rules = buildPermissionRulesV2({
    outsideEffect: 'deny',
    allowedExternalDirectories: allowedDirectories,
    bundledSkillsDirectories,
    editDenyResources,
    denyQuestion: true,
    denyWebsearch: true,
  })
  if (!rules.success) return err(rules.error)
  const base = buildConfigContentV2({plugins: [], rules: rules.data})

  const operatorPlugins = Array.isArray(operator.plugins)
    ? (operator.plugins as unknown[]).filter((plugin): plugin is string => typeof plugin === 'string')
    : []
  const operatorExperimental = isRecord(operator.experimental) ? operator.experimental : {}

  const keyFiles = inputs.providerKeyFiles ?? {}
  let provider: Record<string, unknown> | undefined
  if (Object.keys(keyFiles).length > 0) {
    const merged = withProviderKeyFiles(operator.provider, keyFiles)
    if (!merged.success) return err(merged.error)
    provider = merged.data
  }

  const content = {
    ...operator,
    ...(provider === undefined ? {} : {provider}),
    ...base,
    plugins: [...new Set([...inputs.plugins, ...operatorPlugins])],
    experimental: {...operatorExperimental, ...(base.experimental as Record<string, unknown>)},
  }

  logger.debug('Built CI OpenCode config', {
    hasUserConfig: inputs.opencodeConfig != null,
    pluginCount: content.plugins.length,
    keyFileProviders: Object.keys(keyFiles),
  })

  return ok({
    content,
    expectations: {
      outsidePolicy: 'deny',
      allowedDirectories: [...allowedDirectories, ...bundledSkillsDirectories],
      deniedActions: [...FORBIDDEN_TOOL_ACTIONS_V2, WEBSEARCH_ACTION_V2],
    },
  })
}
