import type {Logger} from './types.js'

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
 * Extract the package prefix from a plugin specifier.
 * Handles scoped packages (@scope/name) and unscoped packages (name).
 */
function pluginPrefix(plugin: string): string {
  if (plugin.startsWith('@')) {
    const parts = plugin.split('@')
    return parts.length >= 3 ? `@${parts[1]}/${parts[2]!.split('@')[0]!}` : plugin
  }
  return plugin.split('@')[0]!
}

/**
 * Check whether a plugin specifier matches any known oMo plugin prefix.
 */
function isOmoPlugin(plugin: string): boolean {
  const prefix = pluginPrefix(plugin)
  return OMO_PLUGIN_PREFIXES.includes(prefix)
}

/**
 * Filter oMo plugin entries from a plugin array, returning cleaned array and a flag indicating whether anything was removed.
 */
function stripOmoPlugins(plugins: unknown[]): {cleaned: unknown[]; removed: boolean} {
  const removedCount = plugins.filter(p => typeof p === 'string' && isOmoPlugin(p)).length
  const cleaned = plugins.filter(p => typeof p !== 'string' || !isOmoPlugin(p))
  return {cleaned, removed: removedCount > 0}
}

export function buildCIConfig(
  inputs: {opencodeConfig: string | null; systematicVersion: string; enableOmo: boolean},
  logger: Logger,
): CIConfigResult {
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

  const systematicPlugin = `@fro.bot/systematic@${inputs.systematicVersion}`
  const rawPlugins: unknown[] = Array.isArray(ciConfig.plugin) ? (ciConfig.plugin as unknown[]) : []
  const hasSystematic = rawPlugins.some(
    (p): p is string => typeof p === 'string' && p.startsWith('@fro.bot/systematic'),
  )
  if (!hasSystematic) {
    ciConfig.plugin = [...rawPlugins, systematicPlugin]
  }

  // Disabled mode: strip oMo plugins, strip legacy plugins key, pin default_agent to build
  if (!inputs.enableOmo) {
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
    if (userAgent != null && userAgent !== 'build') {
      rewrittenFields.push('default_agent')
    }

    if (rewrittenFields.length > 0) {
      logger.warning(
        `OpenCode config rewritten for disabled oMo mode (enable-omo: false): ${rewrittenFields.join(', ')}. oMo plugin entries are stripped and default_agent is pinned to "build". Set enable-omo: true to use oMo features.`,
      )
    }
  }

  logger.debug('Built CI OpenCode config', {
    hasUserConfig: inputs.opencodeConfig != null,
    pluginCount: Array.isArray(ciConfig.plugin) ? ciConfig.plugin.length : 0,
  })

  return {config: ciConfig, error: null}
}
