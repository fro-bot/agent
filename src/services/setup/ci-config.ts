import type {Logger, SetupInputs} from './types.js'

export interface CIConfigResult {
  readonly config: Record<string, unknown>
  readonly error: string | null
}

export function buildCIConfig(
  inputs: Pick<SetupInputs, 'opencodeConfig' | 'systematicVersion'>,
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
  const rawPlugins: unknown[] = Array.isArray(ciConfig.plugins) ? (ciConfig.plugins as unknown[]) : []
  const hasSystematic = rawPlugins.some(
    (plugin): plugin is string => typeof plugin === 'string' && plugin.startsWith('@fro.bot/systematic'),
  )
  if (!hasSystematic) {
    ciConfig.plugins = [...rawPlugins, systematicPlugin]
  }

  logger.debug('Built CI OpenCode config', {
    hasUserConfig: inputs.opencodeConfig != null,
    pluginCount: Array.isArray(ciConfig.plugins) ? ciConfig.plugins.length : 0,
  })

  return {config: ciConfig, error: null}
}
