import type {AuthConfig, Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Parse and validate auth-json input string.
 *
 * @param input - JSON string containing provider auth configurations
 * @returns Parsed AuthConfig object
 * @throws Error if input is not valid JSON or not an object
 */
export function parseAuthJsonInput(input: string): AuthConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid auth-json format: ${error.message}`)
    }
    throw error
  }

  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
    throw new Error('auth-json must be a JSON object')
  }

  return parsed as AuthConfig
}

/**
 * Populate auth.json with LLM provider credentials.
 *
 * This file is written fresh each run from secrets and NEVER cached.
 * File is written with mode 0600 (owner read/write only) for security.
 *
 * @param authConfig - Provider auth configurations
 * @param opencodeDir - Directory to write auth.json (typically XDG_DATA_HOME/opencode)
 * @param logger - Logger instance
 * @returns Path to written auth.json file
 */
export async function populateAuthJson(authConfig: AuthConfig, opencodeDir: string, logger: Logger): Promise<string> {
  const authPath = path.join(opencodeDir, 'auth.json')

  await fs.mkdir(opencodeDir, {recursive: true})

  const content = JSON.stringify(authConfig, null, 2)
  await fs.writeFile(authPath, content, {mode: 0o600})

  logger.info('Populated auth.json', {
    path: authPath,
    providers: Object.keys(authConfig).length,
  })

  return authPath
}
