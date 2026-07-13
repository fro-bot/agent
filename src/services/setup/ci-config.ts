import type {OmoSlimPreset} from '../../shared/types.js'
import type {Logger} from './types.js'
import * as path from 'node:path'
import process from 'node:process'
import {RESPONSE_FILE_DIR_SEGMENT} from '@fro-bot/runtime'
import {DEFAULT_OMO_SLIM_VERSION} from '../../shared/constants.js'

export interface CIConfigResult {
  readonly config: Record<string, unknown>
  readonly error: string | null
}

/**
 * Known oMo plugin specifier prefixes to strip in disabled mode.
 * Matches bare names and versioned variants (e.g., oh-my-openagent, oh-my-openagent@latest, oh-my-openagent@3.7.4).
 */
const OMO_PLUGIN_PREFIXES = ['oh-my-openagent']

/**
 * Known OMO Slim plugin specifier prefixes.
 */
const OMO_SLIM_PLUGIN_PREFIXES = ['oh-my-opencode-slim']

/**
 * R19: Versions of oh-my-opencode-slim that are verified to register the orchestrator agent.
 * Updated deliberately when Renovate bumps the pinned version and the orchestrator is confirmed.
 */
export const OMO_SLIM_ORCHESTRATOR_VERIFIED_VERSIONS = ['1.1.1']

/**
 * Returns true if the given OMO Slim version is in the R19 verified allowlist.
 */
export function isOmoSlimVersionVerified(version: string): boolean {
  return OMO_SLIM_ORCHESTRATOR_VERIFIED_VERSIONS.includes(version)
}

/**
 * Extract the package prefix from a plugin specifier.
 * Handles scoped packages (@scope/name) and unscoped packages (name).
 */
export function pluginPrefix(plugin: string): string {
  const versionSeparator = plugin.lastIndexOf('@')
  return versionSeparator > 0 ? plugin.slice(0, versionSeparator) : plugin
}

/**
 * Check whether a plugin specifier matches any known oMo plugin prefix.
 */
function isOmoPlugin(plugin: string): boolean {
  const prefix = pluginPrefix(plugin)
  return OMO_PLUGIN_PREFIXES.includes(prefix)
}

/**
 * Check whether a plugin specifier matches any known OMO Slim plugin prefix.
 */
function isOmoSlimPlugin(plugin: string): boolean {
  const prefix = pluginPrefix(plugin)
  return OMO_SLIM_PLUGIN_PREFIXES.includes(prefix)
}

/**
 * Filter oMo plugin entries from a plugin array, returning cleaned array and a flag indicating whether anything was removed.
 */
function stripOmoPlugins(plugins: unknown[]): {cleaned: unknown[]; removed: boolean} {
  const removedCount = plugins.filter(p => typeof p === 'string' && isOmoPlugin(p)).length
  const cleaned = plugins.filter(p => typeof p !== 'string' || !isOmoPlugin(p))
  return {cleaned, removed: removedCount > 0}
}

/**
 * Filter OMO Slim plugin entries from a plugin array.
 */
function stripOmoSlimPlugins(plugins: unknown[]): {cleaned: unknown[]; removed: boolean} {
  const removedCount = plugins.filter(p => typeof p === 'string' && isOmoSlimPlugin(p)).length
  const cleaned = plugins.filter(p => typeof p !== 'string' || !isOmoSlimPlugin(p))
  return {cleaned, removed: removedCount > 0}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Scope the build agent's `external_directory` permission so the harness's
 * own response-file delivery (see `packages/runtime/src/agent/response-file.ts`
 * `buildResponseFileDir` — a run-scoped dir under `RUNNER_TEMP`, deliberately
 * OUTSIDE the checkout so a compromised checkout can never plant/tamper with
 * the file the harness reads back) is allowed, while every other external
 * directory stays denied fail-closed.
 *
 * Without this, OpenCode's shell-command scanner and the write/edit tools'
 * external-file check both raise an `external_directory` "ask" for any
 * external directory a command/tool touches (vendored source:
 * `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/shell.ts:263-280`,
 * `.../src/tool/external-directory.ts:15-45`) — and a flat `'deny'` blocks
 * even the model's write to its own designated response-file dir, so
 * finalize fails fail-closed reading it back (ENOENT).
 *
 * Pattern semantics (verified against
 * `.slim/clonedeps/repos/anomalyco__opencode/packages/core/src/util/wildcard.ts:3-14`):
 * a config pattern's `*` compiles to regex `.*`, which matches `/` too (not
 * just a single path segment) — so a single `<runnerTemp>/fro-bot-response/*`
 * pattern matches BOTH asks: the shell scan's `<runId-attempt-dir>/*` glob
 * (`shell.ts:266-269`, dir = the run-scoped subdir) and the write/edit tool's
 * `<parentDir>/*` glob (`external-directory.ts:29-33`, parentDir = the same
 * run-scoped subdir) — no separate nested-level pattern is needed. This
 * mirrors the vendored native-agent defaults' own whitelisted-dir shape
 * (`agent/agent.ts:108-117`, `path.join(dir, "*")` keys).
 *
 * Rule-evaluation order matters: `Permission.evaluate` (`permission/index.ts:29-39`)
 * does `rulesets.flat().findLast(...)` — the LAST matching entry wins. Since
 * `'*'` matches every pattern (including our specific one), `'*'` MUST come
 * first in the object and the specific allow entry MUST come after it, or
 * the deny would shadow the allow.
 */
function scopeExternalDirectoryPermission(config: Record<string, unknown>, runnerTemp: string | undefined): void {
  const agent = isRecord(config.agent) ? config.agent : {}
  const build = isRecord(agent.build) ? agent.build : {}
  const permission = isRecord(build.permission) ? build.permission : {}

  // Fail safe: if RUNNER_TEMP isn't set (e.g. local/non-Actions runs), we
  // can't know where the response-file dir will be, so keep the flat deny
  // rather than guessing a broad allow pattern.
  const externalDirectory: Record<string, 'allow' | 'deny'> | 'deny' =
    runnerTemp != null && runnerTemp.length > 0
      ? {
          '*': 'deny',
          [path.join(runnerTemp, RESPONSE_FILE_DIR_SEGMENT, '*')]: 'allow',
        }
      : 'deny'

  config.agent = {
    ...agent,
    build: {
      ...build,
      permission: {
        ...permission,
        external_directory: externalDirectory,
      },
    },
  }
}

export function buildCIConfig(
  inputs: {
    opencodeConfig: string | null
    systematicVersion: string
    enableOmo: boolean
    enableOmoSlim?: boolean
    omoSlimVersion?: string
    omoSlimPreset?: OmoSlimPreset
  },
  logger: Logger,
): CIConfigResult {
  const enableOmoSlim = inputs.enableOmoSlim ?? false
  const omoSlimVersion = inputs.omoSlimVersion ?? DEFAULT_OMO_SLIM_VERSION
  const omoSlimPreset = inputs.omoSlimPreset ?? 'openai'

  const ciConfig: Record<string, unknown> = {autoupdate: false}

  if (inputs.opencodeConfig != null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(inputs.opencodeConfig)
    } catch {
      return {config: ciConfig, error: 'opencode-config must be valid JSON'}
    }

    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {config: ciConfig, error: 'opencode-config must be a JSON object'}
    }
    Object.assign(ciConfig, parsed)
  }

  // Dual-plugin guard: detect conflict before any mode-specific assembly
  const rawPluginsForGuard: unknown[] = Array.isArray(ciConfig.plugin) ? (ciConfig.plugin as unknown[]) : []
  const hasOmoInConfig = rawPluginsForGuard.some(p => typeof p === 'string' && isOmoPlugin(p))
  const hasOmoSlimInConfig = rawPluginsForGuard.some(p => typeof p === 'string' && isOmoSlimPlugin(p))
  if (hasOmoInConfig && hasOmoSlimInConfig) {
    return {config: ciConfig, error: 'oMo and OMO Slim plugins cannot both be present'}
  }

  // R19: Version-gated allowlist for OMO Slim
  if (enableOmoSlim && !OMO_SLIM_ORCHESTRATOR_VERIFIED_VERSIONS.includes(omoSlimVersion)) {
    return {
      config: ciConfig,
      error: `OMO Slim version ${omoSlimVersion} is not verified to register the orchestrator agent (known-good: ${OMO_SLIM_ORCHESTRATOR_VERIFIED_VERSIONS.join(', ')})`,
    }
  }

  const systematicPlugin = `@fro.bot/systematic@${inputs.systematicVersion}`
  const rawPlugins: unknown[] = Array.isArray(ciConfig.plugin) ? (ciConfig.plugin as unknown[]) : []
  const hasSystematic = rawPlugins.some(
    (p): p is string => typeof p === 'string' && p.startsWith('@fro.bot/systematic'),
  )
  if (!hasSystematic) {
    ciConfig.plugin = [...rawPlugins, systematicPlugin]
  }

  if (enableOmoSlim) {
    // Slim mode: strip OMO plugins, add slim plugin, pin orchestrator
    const currentPlugins: unknown[] = Array.isArray(ciConfig.plugin) ? (ciConfig.plugin as unknown[]) : []
    const {cleaned: withoutOmo} = stripOmoPlugins(currentPlugins)
    const {cleaned: withoutOmoSlim} = stripOmoSlimPlugins(withoutOmo)
    const slimPlugin = `oh-my-opencode-slim@${omoSlimVersion}`
    ciConfig.plugin = [...withoutOmoSlim, slimPlugin]
    // Strip legacy 'plugins' (plural) key — mirrors disabled mode (PR #449 bug)
    if ('plugins' in ciConfig) {
      delete ciConfig.plugins
    }
    // Pin default_agent to orchestrator unconditionally — load-bearing
    ciConfig.default_agent = 'orchestrator'
    // Do NOT call denyBuildExternalDirectoryPermission in slim mode
    logger.debug('Built CI OpenCode config (slim mode)', {
      hasUserConfig: inputs.opencodeConfig != null,
      pluginCount: Array.isArray(ciConfig.plugin) ? ciConfig.plugin.length : 0,
      preset: omoSlimPreset,
    })
  } else if (inputs.enableOmo) {
    // OMO enabled mode: no modifications beyond systematic plugin injection
    logger.debug('Built CI OpenCode config', {
      hasUserConfig: inputs.opencodeConfig != null,
      pluginCount: Array.isArray(ciConfig.plugin) ? ciConfig.plugin.length : 0,
    })
  } else {
    // Disabled mode: strip oMo plugins, strip legacy plugins key, pin default_agent to build
    const rewrittenFields: string[] = []

    // Strip oMo entries from 'plugin' array
    const currentPlugins: unknown[] = Array.isArray(ciConfig.plugin) ? (ciConfig.plugin as unknown[]) : []
    const {cleaned: cleanedPlugins, removed: removedOmo} = stripOmoPlugins(currentPlugins)
    if (removedOmo) {
      rewrittenFields.push('plugin')
      ciConfig.plugin = cleanedPlugins
    }

    // Strip legacy 'plugins' (plural) key entirely
    if ('plugins' in ciConfig) {
      delete ciConfig.plugins
      rewrittenFields.push('plugins')
    }

    // Pin default_agent to "build" — overrides any user-provided value
    const userAgent: unknown = ciConfig.default_agent
    ciConfig.default_agent = 'build'
    scopeExternalDirectoryPermission(ciConfig, process.env.RUNNER_TEMP)
    if (userAgent != null && userAgent !== 'build') {
      rewrittenFields.push('default_agent')
    }

    if (rewrittenFields.length > 0) {
      logger.warning(
        `OpenCode config rewritten for disabled oMo mode (enable-omo: false): ${rewrittenFields.join(', ')}. oMo plugin entries are stripped and default_agent is pinned to "build". Set enable-omo: true to use oMo features.`,
      )
    }

    logger.debug('Built CI OpenCode config', {
      hasUserConfig: inputs.opencodeConfig != null,
      pluginCount: Array.isArray(ciConfig.plugin) ? ciConfig.plugin.length : 0,
    })
  }

  return {config: ciConfig, error: null}
}
