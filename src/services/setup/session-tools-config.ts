import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const SESSION_TOOLS_FILENAME = 'session.js'

/**
 * Default asset resolution: the action executes the committed `dist/main.js`
 * directly (action.yaml, node24), so inside the bundle `import.meta.url` is
 * `dist/main.js` and `session-tools.js` is a sibling file emitted by the
 * dedicated tsdown entry (see tsdown.config.ts). Under vitest the code runs
 * from `src/`, where no sibling exists — tests always inject `resolveAssetUrl`.
 */
function defaultAssetUrl(): URL {
  return new URL('./session-tools.js', import.meta.url)
}

/**
 * Copies the bundled session tools asset into the CI OpenCode config dir as
 * `tool/session.js`, so the OpenCode registry loads it as a file tool
 * (session_list / session_read / session_search / session_info).
 *
 * Fail-soft by design: if the asset is missing or unreadable, this warns and
 * returns without throwing. A run degrading to today's tools-absent state
 * (prompt promises tools that aren't there) is exactly the pre-fix reality —
 * never worse — so a missing asset must never fail setup.
 */
export async function writeSessionToolsFile(
  configDir: string,
  logger: Logger,
  resolveAssetUrl: () => URL = defaultAssetUrl,
): Promise<void> {
  const assetUrl = resolveAssetUrl()

  try {
    const contents = await fs.readFile(assetUrl)
    const toolDir = path.join(configDir, 'tool')
    await fs.mkdir(toolDir, {recursive: true})
    const filePath = path.join(toolDir, SESSION_TOOLS_FILENAME)
    await fs.writeFile(filePath, contents)
    logger.info('Wrote session tools file', {path: filePath, bytes: contents.byteLength})
  } catch (error) {
    logger.warning('Session tools asset unavailable, skipping (native session tools will be absent)', {
      path: assetUrl.toString(),
      error: String(error),
    })
  }
}
