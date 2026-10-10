import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import {homedir} from 'node:os'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

// A subdirectory OpenCode does not scan. It auto-loads `<configDir>/{plugin,plugins}/*.{ts,js}`
// (packages/opencode/src/config/plugin.ts:18-30), so keeping the guard out of those directories means
// the explicit `plugin` entry buildCIConfig writes is the ONLY way it loads.
const NO_TASK_REUSE_DIRNAME = 'fro-bot'
const NO_TASK_REUSE_FILENAME = 'no-task-reuse.mjs'

/** The CI OpenCode global config dir (`~/.config/opencode`), where setup writes `opencode.json`. */
export function defaultOpenCodeConfigDir(): string {
  return path.join(homedir(), '.config', 'opencode')
}

/** Absolute path the guard plugin is written to inside the CI OpenCode config dir. */
export function noTaskReusePluginPath(configDir: string): string {
  return path.join(configDir, NO_TASK_REUSE_DIRNAME, NO_TASK_REUSE_FILENAME)
}

/**
 * The `plugin` config entry for the guard: an absolute `file://` URL. OpenCode keeps `file://` specs as
 * written (config/plugin.ts:51) and de-duplicates them by exact URL (config/plugin.ts:64-75), so the
 * same entry in the global config file and in `OPENCODE_CONFIG_CONTENT` loads once.
 */
export function noTaskReusePluginSpec(configDir: string): string {
  return pathToFileURL(noTaskReusePluginPath(configDir)).href
}

/**
 * Default asset resolution: the action executes the committed `dist/main.js` directly, so inside the
 * bundle `import.meta.url` is `dist/main.js` and `no-task-reuse.js` is a sibling emitted by the dedicated
 * tsdown entry (see tsdown.config.ts), built from the same `deploy/plugins/no-task-reuse.mjs` the gateway
 * image bakes. Under vitest the code runs from `src/`, where no sibling exists — tests inject
 * `resolveAssetUrl`.
 */
function defaultAssetUrl(): URL {
  return new URL('./no-task-reuse.js', import.meta.url)
}

/**
 * Copies the bundled task-reuse guard into the CI OpenCode config dir and returns its path.
 *
 * Fail-CLOSED, unlike `writeSessionToolsFile`: OpenCode logs a plugin that cannot load and carries on, so
 * a guard whose file is missing would silently turn the protection off while `buildCIConfig` still claimed
 * it. A missing or unreadable asset is a packaging fault, so this throws and setup fails visibly instead.
 */
export async function writeNoTaskReuseFile(
  configDir: string,
  logger: Logger,
  resolveAssetUrl: () => URL = defaultAssetUrl,
): Promise<string> {
  const assetUrl = resolveAssetUrl()
  const filePath = noTaskReusePluginPath(configDir)

  try {
    const contents = await fs.readFile(assetUrl)
    await fs.mkdir(path.dirname(filePath), {recursive: true})
    await fs.writeFile(filePath, contents)
    logger.info('Wrote task-reuse guard plugin', {path: filePath, bytes: contents.byteLength})
    return filePath
  } catch (error) {
    throw new Error(
      `Could not install the task-reuse guard plugin from ${assetUrl.toString()} to ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {cause: error},
    )
  }
}
