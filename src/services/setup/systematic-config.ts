import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {deepMerge} from './omo-config.js'

const SYSTEMATIC_CONFIG_FILENAME = 'systematic.json'

function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export async function writeSystematicConfig(configJson: string, configDir: string, logger: Logger): Promise<void> {
  const parsedUserConfig: unknown = JSON.parse(configJson)
  if (!isMergeableObject(parsedUserConfig)) {
    throw new Error('systematic-config must be a JSON object (non-null, non-array)')
  }

  await fs.mkdir(configDir, {recursive: true})
  const filePath = path.join(configDir, SYSTEMATIC_CONFIG_FILENAME)

  let existingConfig: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isMergeableObject(parsed)) {
      existingConfig = parsed
    }
  } catch (error) {
    logger.debug('Using empty base Systematic config', {path: filePath, error: String(error)})
  }

  const merged = deepMerge(existingConfig, parsedUserConfig)
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2))

  logger.info('Wrote Systematic config', {path: filePath, keyCount: Object.keys(parsedUserConfig).length})
}
