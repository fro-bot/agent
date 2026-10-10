import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import {homedir} from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {pathToFileURL} from 'node:url'

// A subdirectory OpenCode does not scan. It auto-loads `<configDir>/{plugin,plugins}/*.{ts,js}`
// (packages/opencode/src/config/plugin.ts:18-30), so keeping the guard out of those directories means
// the explicit `plugin` entry in the config the Action passes the server is the ONLY way it loads.
const NO_TASK_REUSE_DIRNAME = 'fro-bot'
const NO_TASK_REUSE_FILENAME = 'no-task-reuse.mjs'

/**
 * The global OpenCode config dir the server reads: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
 *
 * Upstream derives it from `xdg-basedir` (`packages/core/src/global.ts:13`) and `config/config.ts:413` merges
 * `<that dir>/opencode.json` into every server's config. `OPENCODE_CONFIG_DIR` does NOT move this layer
 * (`Global.Path.config` is the plain XDG path, `global.ts:21`); it only adds another directory. `filterAgentEnv`
 * lets `XDG_*` through to the server child, so a runner that sets `XDG_CONFIG_HOME` reads from there and a
 * hard-coded `~/.config` would put everything setup writes (`opencode.json`, Systematic config, session tools)
 * where the server never looks. The guard plugin file lives here too, but it is loaded by explicit path.
 */
export function defaultOpenCodeConfigDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() ?? ''
  return xdgConfigHome.length > 0 ? path.join(xdgConfigHome, 'opencode') : path.join(homedir(), '.config', 'opencode')
}

/** Absolute path the guard plugin is written to inside the CI OpenCode config dir. */
export function noTaskReusePluginPath(configDir: string): string {
  return path.join(configDir, NO_TASK_REUSE_DIRNAME, NO_TASK_REUSE_FILENAME)
}

/**
 * The `plugin` config entry for the guard: an absolute `file://` URL. OpenCode keeps `file://` specs as
 * written (config/plugin.ts:51) and de-duplicates plugin origins by exact URL, keeping the LAST occurrence
 * (config/plugin.ts:64-77), so listing the same URL in any earlier layer is harmless: this layer's entry wins.
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

/**
 * The OpenCode config the Action hands the server at spawn (`createOpencode({config})`, which the SDK sends as
 * `OPENCODE_CONFIG_CONTENT`): just the guard plugin. Upstream merges that env var as its own layer after the
 * global file, `OPENCODE_CONFIG`, project config and `.opencode` dirs (`config/config.ts:482-490`), and plugin
 * origins from separate layers concatenate and can only be de-duplicated, never removed (`:344-367`), so no
 * earlier file (a global `opencode.jsonc` with `plugin: []` included) can drop it. No user file is read or
 * edited. Only the managed-config dir and macOS MDM layers load after it (`:530-548`), and those are
 * administrator-controlled. `OPENCODE_PURE` is the one switch that skips it, and `filterAgentEnv` denies that.
 */
export function taskReuseGuardServerConfig(configDir: string): {plugin: string[]} {
  return {plugin: [noTaskReusePluginSpec(configDir)]}
}
