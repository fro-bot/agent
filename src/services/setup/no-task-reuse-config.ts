import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import {homedir} from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {pathToFileURL} from 'node:url'

// A subdirectory OpenCode does not scan. It auto-loads `<configDir>/{plugin,plugins}/*.{ts,js}`
// (packages/opencode/src/config/plugin.ts:18-30), so keeping the guard out of those directories means
// the explicit `plugin` entry buildCIConfig writes is the ONLY way it loads.
const NO_TASK_REUSE_DIRNAME = 'fro-bot'
const NO_TASK_REUSE_FILENAME = 'no-task-reuse.mjs'

/**
 * The global OpenCode config dir the server reads: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
 *
 * Upstream derives it from `xdg-basedir` (`packages/core/src/global.ts:13`) and `config/config.ts:413` merges
 * `<that dir>/opencode.json` into every server's config. `OPENCODE_CONFIG_DIR` does NOT move this layer
 * (`Global.Path.config` is the plain XDG path, `global.ts:21`); it only adds another directory. `filterAgentEnv`
 * lets `XDG_*` through to the server child, so a runner that sets `XDG_CONFIG_HOME` reads from there and a
 * hard-coded `~/.config` would register the guard in a file the server never loads.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Returns `plugins` with every entry that names the guard (a bare string or a `[spec, options]` tuple) removed
 * and exactly one bare guard spec appended last. The single normalizer for every writer of the `plugin` list
 * (`buildCIConfig`, the oMo-enabled merge in `runSetup`, and `provisionTaskReuseGuard`), so they cannot drift.
 *
 * Last matters: plugin hooks run in registration order, so a hook registered after the guard could rewrite a
 * `task` call's args after the guard has checked them. A tuple form is dropped for its bare form so no option
 * can neuter the guard; that is reported, since the operator asked for something that is not honored.
 */
export function normalizeTaskReuseGuardPlugins(plugins: unknown, guardSpec: string, logger: Logger): unknown[] {
  const entries: unknown[] = Array.isArray(plugins) ? (plugins as unknown[]) : []
  const specifierOf = (entry: unknown): unknown => (Array.isArray(entry) ? (entry as unknown[])[0] : entry)
  if (entries.some(entry => specifierOf(entry) === guardSpec && entry !== guardSpec)) {
    logger.warning(
      'OpenCode config supplied options for the task-reuse guard plugin; they are discarded and the guard is enforced unmodified.',
    )
  }
  return [...entries.filter(entry => specifierOf(entry) !== guardSpec), guardSpec]
}

/**
 * Registers the guard in `<configDir>/opencode.json`: parses the existing file (if any), applies
 * `normalizeTaskReuseGuardPlugins`, and writes the result atomically (temp file + rename) only when it changed.
 * Everything else in the file is preserved. An unreadable or non-object file throws: OpenCode itself discards a
 * global config it cannot parse, so overwriting it would lose the operator's settings and leaving it would
 * run the server unguarded.
 */
async function registerTaskReuseGuard(configDir: string, logger: Logger): Promise<void> {
  const configPath = path.join(configDir, 'opencode.json')

  let raw: string | null = null
  let mode: number | undefined
  try {
    raw = await fs.readFile(configPath, 'utf8')
    mode = (await fs.stat(configPath)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not read ${configPath} to register the task-reuse guard: ${String(error)}`, {cause: error})
    }
  }

  let config: Record<string, unknown> = {}
  if (raw != null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Could not register the task-reuse guard: ${configPath} is not valid JSON`, {cause: error})
    }
    if (!isRecord(parsed)) {
      throw new Error(`Could not register the task-reuse guard: ${configPath} is not a JSON object`)
    }
    config = parsed
  }

  if (config.plugin != null && !Array.isArray(config.plugin)) {
    logger.warning(
      'OpenCode config plugin must be an array; the supplied value is discarded and the task-reuse guard plugin is enforced.',
      {
        receivedType: typeof config.plugin,
      },
    )
  }

  const next = JSON.stringify(
    {...config, plugin: normalizeTaskReuseGuardPlugins(config.plugin, noTaskReusePluginSpec(configDir), logger)},
    null,
    2,
  )
  if (next === raw) return

  await fs.mkdir(configDir, {recursive: true})
  const tempPath = `${configPath}.${process.pid}.tmp`
  try {
    await fs.writeFile(tempPath, next, mode === undefined ? undefined : {mode})
    await fs.rename(tempPath, configPath)
  } catch (error) {
    await fs.rm(tempPath, {force: true})
    throw new Error(`Could not register the task-reuse guard in ${configPath}: ${String(error)}`, {cause: error})
  }
  logger.info('Registered task-reuse guard in OpenCode config', {path: configPath})
}

/**
 * Makes the task-reuse guard load on the next OpenCode server start: writes the plugin file, then ensures the
 * global config the server reads lists exactly one bare guard spec, last. Idempotent and fail-CLOSED (throws).
 *
 * Every Action server start goes through this, not just a fresh `runSetup`: a runner with OpenCode already
 * installed never runs setup, and its global config knows nothing of the guard.
 */
export async function provisionTaskReuseGuard(
  configDir: string,
  logger: Logger,
  resolveAssetUrl: () => URL = defaultAssetUrl,
): Promise<void> {
  await writeNoTaskReuseFile(configDir, logger, resolveAssetUrl)
  await registerTaskReuseGuard(configDir, logger)
}
