import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const OMO_CONFIG_FILENAME = 'oh-my-opencode.json'

/**
 * Deep-merge two plain objects.
 *
 * Source values win over target values on conflict.
 * Arrays are replaced (not merged element-by-element).
 * Primitive source values always overwrite target.
 *
 * Neither the target nor the source is mutated.
 *
 * @param target - Base object (lower priority)
 * @param source - Override object (higher priority)
 * @returns New merged object
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {...target}

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key]

    if (
      sourceValue != null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue != null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>)
    } else {
      result[key] = sourceValue
    }
  }

  return result
}

/**
 * Write oMo configuration JSON to the oMo config file, deep-merging with any
 * existing configuration so that user-provided values take priority.
 *
 * The config file is written to `<configDir>/oh-my-opencode.json`.
 * If the directory does not exist it is created. If the existing file
 * contains invalid JSON, it is silently replaced with the user config.
 *
 * @param configJson  - Raw JSON string from the `omo-config` action input
 * @param configDir   - Directory containing `oh-my-opencode.json`
 *                      (typically `~/.config/opencode`)
 * @param logger      - Logger instance
 */
export async function writeOmoConfig(configJson: string, configDir: string, logger: Logger): Promise<void> {
  // Parse user-supplied JSON first — throw early if invalid
  const userConfig = JSON.parse(configJson) as Record<string, unknown>

  await fs.mkdir(configDir, {recursive: true})

  const filePath = path.join(configDir, OMO_CONFIG_FILENAME)

  // Attempt to read existing config; silently ignore missing / corrupt files
  let existingConfig: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existingConfig = parsed as Record<string, unknown>
    }
  } catch {
    // File absent or corrupt — start from empty base
  }

  const merged = deepMerge(existingConfig, userConfig)

  await fs.writeFile(filePath, JSON.stringify(merged, null, 2))

  logger.info('Wrote oMo config', {path: filePath, keyCount: Object.keys(userConfig).length})
}
