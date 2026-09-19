import type {OmoSlimPreset} from '../../shared/types.js'
import type {Logger} from './types.js'
import * as path from 'node:path'
import process from 'node:process'
import {ATTACHMENT_DIR_SEGMENT, buildResponseFileFallbackRoots, RESPONSE_FILE_DIR_SEGMENT} from '@fro-bot/runtime'
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

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const resolvedFile = path.resolve(filePath)
  const resolvedDirectory = path.resolve(directoryPath)
  return resolvedFile.startsWith(`${resolvedDirectory}${path.sep}`)
}

/**
 * Scope the build agent's `external_directory` permission so the harness's
 * own response-file delivery (see `packages/runtime/src/agent/response-file.ts`
 * `buildResponseFileDir` — a run-scoped dir under `RUNNER_TEMP`, deliberately
 * OUTSIDE the checkout so a compromised checkout can never plant/tamper with
 * the file the harness reads back) and any explicitly designated integration
 * workdir are allowed, while every other external directory stays denied
 * fail-closed.
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
 * (`agent/agent.ts:108-117`, `path.join(dir, "*")` keys). The same shape is
 * used for the explicitly supplied integration workdir.
 *
 * Rule-evaluation order matters: `Permission.evaluate` (`permission/index.ts:29-39`)
 * does `rulesets.flat().findLast(...)` — the LAST matching entry wins. Since
 * `'*'` matches every pattern (including our specific one), `'*'` MUST come
 * first in the object and the specific allow entry MUST come after it, or
 * the deny would shadow the allow. The edit deny is deleted and re-added
 * below so an existing key is moved to the end rather than retaining its
 * original insertion position.
 */
function scopeExternalDirectoryPermission(
  config: Record<string, unknown>,
  runnerTemp: string | undefined,
  integrationWorkDir: string | undefined,
  logger: Logger,
): void {
  const agent = isRecord(config.agent) ? config.agent : {}
  const build = isRecord(agent.build) ? agent.build : {}
  const permission = isRecord(build.permission) ? build.permission : {}

  // Fail safe: if RUNNER_TEMP isn't set (e.g. local/non-Actions runs), we
  // can't know where the response-file dir will be, so keep the flat deny
  // rather than guessing a broad allow pattern.
  let externalDirectory: Record<string, 'allow' | 'deny'> | 'deny' = 'deny'
  const editPermission: Record<string, unknown> = isRecord(permission.edit)
    ? {...permission.edit}
    : typeof permission.edit === 'string'
      ? {'*': permission.edit}
      : {}
  const readPermission: Record<string, unknown> = isRecord(permission.read) ? {...permission.read} : {}
  const deniedReadPatterns = {
    '*.env': 'deny',
    '*.env.*': 'deny',
    '*.env.example': 'allow',
  } as const

  for (const [pattern, rule] of Object.entries(deniedReadPatterns)) {
    delete readPermission[pattern]
    readPermission[pattern] = rule
  }

  const buildPermission: Record<string, unknown> = {...permission}
  delete buildPermission.doom_loop
  buildPermission.doom_loop = 'deny'
  delete buildPermission.read
  buildPermission.read = readPermission

  if (runnerTemp != null && runnerTemp.trim().length > 0) {
    const deniedEditPatterns = buildResponseFileFallbackRoots(runnerTemp.trim()).map(root =>
      path.join(root, RESPONSE_FILE_DIR_SEGMENT, '*'),
    )
    for (const deniedEditPattern of deniedEditPatterns) {
      delete editPermission[deniedEditPattern]
    }
    for (const deniedEditPattern of deniedEditPatterns) {
      editPermission[deniedEditPattern] = 'deny'
    }

    // NOTE: unlike the response-file directory's edit-deny above (which guards a
    // WORKSPACE-RELATIVE shadow of that segment name, not the real external directory --
    // the model is explicitly meant to WRITE its response file there), this attachment
    // directory gets no equivalent `edit` entry. Per upstream, an out-of-workspace edit is
    // gated by `external_directory` itself (`packages/opencode/src/tool/edit.ts` -- see
    // `attachment-dir.ts`'s doc comment), not a separate `edit` permission keyed on the
    // absolute external path -- so an `edit` entry here would be a no-op for the actual
    // external path and would only add a dead, unverifiable config key. The residual risk
    // (the model could in principle edit its own already-consumed attachment copies) is
    // accepted: the SDK reads file content once when building the message, so a later edit
    // cannot retroactively change what was already injected.
    const attachmentPattern = path.join(runnerTemp, ATTACHMENT_DIR_SEGMENT, '*')

    externalDirectory = {
      '*': 'deny',
      [path.join(runnerTemp, RESPONSE_FILE_DIR_SEGMENT, '*')]: 'allow',
      // Same segment-level pattern shape as the response-file grant above: `*` compiles to
      // regex `.*`, which matches the run-scoped subdirectory the ask is actually raised
      // against (`<attachmentDir>/*`) without needing a separate per-run pattern. This is
      // ALSO layered onto the top-level, global `permission.external_directory` key by
      // `scopeAttachmentDirectoryPermission` below -- that global grant is what reaches a
      // dispatched subagent or an oMo/OMO-Slim orchestrator session, neither of which is the
      // `build` agent this function scopes. This entry exists because the `build` agent's own
      // permission block (built below) fully re-asserts `external_directory`, which would
      // otherwise shadow the global grant for the `build` agent specifically (its `'*': 'deny'`
      // sorts after the global grant in upstream's flattened, `findLast`-evaluated ruleset).
      [attachmentPattern]: 'allow',
    }

    if (integrationWorkDir != null && integrationWorkDir.trim().length > 0) {
      const trimmedRunnerTemp = runnerTemp.trim()
      const trimmedIntegrationWorkDir = integrationWorkDir.trim()
      if (isPathInsideDirectory(trimmedIntegrationWorkDir, trimmedRunnerTemp)) {
        externalDirectory[path.join(trimmedIntegrationWorkDir, '*')] = 'allow'
      } else {
        logger.warning('Ignoring integration workdir outside RUNNER_TEMP', {
          integrationWorkDir: trimmedIntegrationWorkDir,
          runnerTemp: trimmedRunnerTemp,
        })
      }
    }
  }

  config.agent = {
    ...agent,
    build: {
      ...build,
      permission: {
        ...buildPermission,
        edit: editPermission,
        external_directory: externalDirectory,
      },
    },
  }
}

/**
 * Grant the run-scoped reference-file ATTACHMENT directory (`buildAttachmentDir` /
 * `ATTACHMENT_DIR_SEGMENT`, `@fro-bot/runtime`) at the TOP-LEVEL, GLOBAL `permission` key --
 * deliberately NOT `agent.build.permission`, and called unconditionally in every oMo mode
 * (disabled, oMo, OMO Slim), unlike `scopeExternalDirectoryPermission` above (which only
 * runs in disabled mode and only ever reaches the `build` agent).
 *
 * Why the mode-agnostic, global placement is required: subagent dispatch (the `task` tool --
 * the actual trigger for the hang this exists to prevent) only happens through an
 * orchestrator agent, which only exists in oMo / OMO Slim mode. A grant that only reached
 * the `build` agent (as `scopeExternalDirectoryPermission` does) would never reach a
 * dispatched subagent at all in the modes where dispatch actually occurs.
 *
 * Why the global key reaches a dispatched subagent (verified against the pinned tag,
 * `packages/harness/harness.config.json`'s `base_version`, since the vendored clone this
 * project's other comments cite is not present on this host):
 *
 * 1. `packages/opencode/src/agent/agent.ts` builds each of upstream's BUILT-IN agents'
 *    permission ruleset as `Permission.merge(defaults, <agent-specific defaults>, user)`,
 *    where `user = Permission.fromConfig(cfg.permission ?? {})` -- i.e. this config's
 *    top-level `permission` key, appended LAST.
 * 2. `packages/opencode/src/permission/index.ts`'s `merge` is a bare `.flat()`, and its
 *    `evaluate` resolves a request with `rulesets.flat().findLast(...)` -- the LAST array
 *    entry matching BOTH the requested permission name and pattern (via wildcard) wins. A
 *    later-appended `user` rule therefore overrides an earlier built-in default for any
 *    pattern it also names, and does not disturb rules for OTHER patterns.
 * 3. `packages/opencode/src/agent/subagent-permissions.ts`'s `deriveSubagentSessionPermission`
 *    has a dispatched subagent's SESSION inherit the PARENT SESSION's own resolved
 *    `external_directory` (and deny) rules directly -- not recomputed from the subagent's
 *    own named agent. So once this global grant reaches whichever agent is running the root
 *    session, every subagent it dispatches inherits it too, regardless of which named agent
 *    (e.g. an OMO Slim reviewer/implementer persona) that subagent runs as.
 *
 * The gap this does NOT close, and cannot close from this project's own config: a
 * plugin-defined agent (e.g. OMO Slim's orchestrator, or one of its own named subagents)
 * that ships its OWN `external_directory` rule for pattern `'*'` in ITS OWN agent-specific
 * config block would have that rule appended AFTER this global grant in THAT agent's own
 * ruleset (mirroring exactly how `agent.build.permission` shadows this same global grant for
 * the `build` agent above, which is why that block re-asserts the attachment pattern
 * itself) -- and would win for that agent's OWN session, before it ever dispatches anything.
 * This project's CI config has no visibility into a plugin's own agent definitions, and this
 * has NOT been verified against the pinned OMO Slim version's actual agent config (out of
 * scope: that package is not vendored in this repo, unlike the OpenCode core clone). What IS
 * verified is the dispatch/inheritance step itself (points 1-3 above): once ANY session
 * reaches the point of calling the `task` tool, its child inherits from it directly.
 *
 * Mirrors `scopeExternalDirectoryPermission`'s own fail-safe: when RUNNER_TEMP isn't set
 * (e.g. local/non-Actions runs), this makes no change at all rather than guessing a broad
 * allow pattern -- the harness's own materialization falls back to the (unscoped, as before
 * this fix) OpenCode log directory in that same case (see `execution.ts`).
 */
function scopeAttachmentDirectoryPermission(
  config: Record<string, unknown>,
  runnerTemp: string | undefined,
  logger: Logger,
): void {
  if (runnerTemp == null || runnerTemp.trim().length === 0) {
    logger.debug('Skipping attachment directory permission grant: RUNNER_TEMP is not set')
    return
  }

  const trimmedRunnerTemp = runnerTemp.trim()
  const attachmentPattern = path.join(trimmedRunnerTemp, ATTACHMENT_DIR_SEGMENT, '*')
  const existingPermission = isRecord(config.permission) ? config.permission : {}
  const existingExternalDirectory: Record<string, unknown> = isRecord(existingPermission.external_directory)
    ? {...existingPermission.external_directory}
    : typeof existingPermission.external_directory === 'string'
      ? {'*': existingPermission.external_directory}
      : {}

  delete existingExternalDirectory['*']
  delete existingExternalDirectory[attachmentPattern]

  // No corresponding `edit` entry -- see the matching note in `scopeExternalDirectoryPermission`
  // above: an out-of-workspace edit is gated by `external_directory` itself upstream, not a
  // separate `edit` permission keyed on the absolute external path.
  config.permission = {
    ...existingPermission,
    external_directory: {
      '*': 'deny',
      ...existingExternalDirectory,
      [attachmentPattern]: 'allow',
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
    integrationWorkDir?: string
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

  // R12: pin subagent_depth to one, unconditionally, across every mode below.
  // Upstream checks depth before execution against real session ancestry
  // (`.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/tool/task.ts:104-117`)
  // — a depth value this project supplied would be a guess a client is in no
  // position to make, so we pin the upstream setting instead of building a
  // depth check of our own.
  //
  // Verified evidence (the `.slim/clonedeps/` checkout this cites is not present
  // in the CI checkout, so this is recorded here for a reader without the clone):
  // `subagent_depth` is a top-level key in the v1 config schema, defined as
  // `subagent_depth: Schema.optional(NonNegativeInt)` at
  // `packages/core/src/v1/config/config.ts:84`, and read at the exact site this
  // pin is defending against, `packages/opencode/src/tool/task.ts:111`, as
  // `depth >= (cfg.subagent_depth ?? 1)`. Both confirmed against the clone at
  // `base_version` (`packages/harness/harness.config.json`) as of this comment;
  // re-verify against the pinned tag if `base_version` moves.
  //
  // Depth matters because upstream cancellation walks RUNNING jobs only: a
  // completed child that links the root session to a still-running
  // grandchild is never walked, so the grandchild can outlive the
  // cancellation meant to stop it. Depth one makes that path unreachable
  // rather than handled.
  //
  // This project's general convention (established by the file-watcher
  // config work) is that an explicit operator value wins. That convention
  // is deliberately NOT followed here: depth one is closing a specific,
  // unsolved correctness gap (grandchild traversal), not a stylistic
  // default, so an operator override is recorded via a warning rather than
  // honored. Raising it requires solving that traversal gap on its own
  // terms — see the plan's Scope Boundaries — which is out of scope here.
  const operatorSubagentDepth: unknown = ciConfig.subagent_depth
  ciConfig.subagent_depth = 1
  if (operatorSubagentDepth != null && operatorSubagentDepth !== 1) {
    logger.warning(
      `OpenCode config subagent_depth overridden to 1 (operator supplied ${String(operatorSubagentDepth)}). Nested subagent depth is pinned to avoid an unreachable grandchild-cancellation gap; see plan docs/plans/2026-09-14-001-feat-background-subagent-ownership-plan.md.`,
    )
  }

  // Grant the reference-file attachment directory unconditionally, in every mode -- unlike
  // `scopeExternalDirectoryPermission` below, which only runs (and only ever reaches the
  // `build` agent) in disabled mode. See `scopeAttachmentDirectoryPermission`'s doc comment.
  scopeAttachmentDirectoryPermission(ciConfig, process.env.RUNNER_TEMP, logger)

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
    scopeExternalDirectoryPermission(ciConfig, process.env.RUNNER_TEMP, inputs.integrationWorkDir, logger)
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
