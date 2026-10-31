import type {Buffer} from 'node:buffer'
import type {Result} from '@bfra.me/es/result'
import type {ExecAdapter, Logger} from './types.js'
import {mkdtemp, readdir, rm} from 'node:fs/promises'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {err, ok} from '@bfra.me/es/result'
import {
  DEFAULT_SYSTEMATIC_VERSION,
  filterAgentEnv,
  FRO_BOT_PLUGIN_PACKAGE,
  FRO_BOT_PLUGIN_VERSION,
  SYSTEMATIC_PACKAGE,
} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'

/**
 * The OpenCode V2 plugin install (TypeScript port of `deploy/scripts/install-opencode-v2-plugins.sh`, probe P10).
 *
 * The server finds a plugin by its spec in the npm cache. A plugin that is not cached is installed by the server at boot,
 * and `opencode plugin add` and that boot install have no timeout: a hung registry leaves `GET /api/agent` answering
 * 503 for as long as it hangs. So the Action installs both plugins itself, before the spawn, each under its own bound,
 * and a failure of any kind fails startup with a named error. Nothing is installed at boot unless setup was skipped.
 *
 * What the port keeps from the shell script, and how:
 * - exact `x.y.z` specs of the two fro.bot packages only (a floating spec would make the run depend on the registry);
 * - `plugin add` under a bound (420 s, as V1's Systematic install; `timeout -s KILL` there);
 * - a scrubbed environment (`filterAgentEnv`, which drops tokens, `AWS_*` and `INPUT_*`) with explicit XDG roots;
 * - an assertion that the npm cache directory of each spec is non-empty after a zero exit;
 * - the global `opencode.json` that `plugin add` writes never survives: the install gets a throwaway
 *   `XDG_CONFIG_HOME`, so the write lands in a directory that is removed afterwards. Only the cache is real.
 *   (The shell script deletes the file; here nothing real is ever written, so there is nothing to delete.)
 *
 * `--pure` is not passed: it is a V1 flag and V2 `plugin add` was never probed with it.
 */

/** Same bound as V1's Systematic install: it clears the 181-370 s tail measured on a registry install. */
export const PLUGIN_INSTALL_TIMEOUT_MS = 420_000
const STDERR_TAIL_LIMIT = 2_000

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

export type PluginInstallV2ErrorKind = 'cache-empty' | 'install-failed' | 'install-timeout' | 'invalid-version'

/** A plugin-install failure. `spec` is the package@version that failed; `message` never carries environment values. */
export interface PluginInstallV2Error {
  readonly kind: PluginInstallV2ErrorKind
  readonly spec: string
  readonly message: string
}

function fail(kind: PluginInstallV2ErrorKind, spec: string, message: string): PluginInstallV2Error {
  return {kind, spec, message}
}

/**
 * The specs the V2 Action installs and lists in its config. `latest` resolves to the version pinned in source
 * (`DEFAULT_SYSTEMATIC_VERSION`), the same version V2 images bake, so the resolved version is exact and reproducible
 * without a registry lookup. A range or tag is refused rather than guessed.
 */
export function resolvePluginSpecsV2(
  systematicVersionInput: string,
): Result<{readonly specs: readonly string[]; readonly systematicVersion: string}, PluginInstallV2Error> {
  const requested = systematicVersionInput.trim()
  const systematicVersion = requested === 'latest' || requested === '' ? DEFAULT_SYSTEMATIC_VERSION : requested
  if (!EXACT_VERSION_PATTERN.test(systematicVersion)) {
    return err(
      fail(
        'invalid-version',
        `${SYSTEMATIC_PACKAGE}@${systematicVersion}`,
        `systematic-version must be an exact x.y.z version (or "latest") on OpenCode V2, got: ${systematicVersion}`,
      ),
    )
  }
  return ok({
    specs: [`${SYSTEMATIC_PACKAGE}@${systematicVersion}`, `${FRO_BOT_PLUGIN_PACKAGE}@${FRO_BOT_PLUGIN_VERSION}`],
    systematicVersion,
  })
}

/** Where the server finds a spec: `<XDG_CACHE_HOME>/opencode/npm/<spec>`. */
export function pluginCacheDir(cacheHome: string, spec: string): string {
  return join(cacheHome, 'opencode', 'npm', spec)
}

async function isNonEmptyDirectory(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

/** True when every spec already has a non-empty cache directory, so an install would change nothing. */
export async function arePluginsCachedV2(cacheHome: string, specs: readonly string[]): Promise<boolean> {
  const present = await Promise.all(specs.map(async spec => isNonEmptyDirectory(pluginCacheDir(cacheHome, spec))))
  return present.every(Boolean)
}

/** The XDG cache home the spawned server reads: `XDG_CACHE_HOME` when set, else `~/.cache`. */
export function resolveCacheHome(env: NodeJS.ProcessEnv): string {
  const configured = env.XDG_CACHE_HOME?.trim() ?? ''
  return configured === '' ? join(homedir(), '.cache') : configured
}

export interface InstallPluginsV2Options {
  readonly logger: Logger
  readonly execAdapter: ExecAdapter
  /** The OpenCode executable, not its install directory. */
  readonly opencodeBinaryPath: string
  /** Exact specs from `resolvePluginSpecsV2`. */
  readonly specs: readonly string[]
  /** The cache home the server will read. Default: `resolveCacheHome(process.env)`. */
  readonly cacheHome?: string
  /** Bound on each install. Default `PLUGIN_INSTALL_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  /** Source environment for the scrubbed child. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

const EMPTY_CONFIG = JSON.stringify({plugins: []})

export async function installPluginsV2(options: InstallPluginsV2Options): Promise<Result<void, PluginInstallV2Error>> {
  const {logger, execAdapter, opencodeBinaryPath, specs} = options
  const timeoutMs = options.timeoutMs ?? PLUGIN_INSTALL_TIMEOUT_MS
  const env = options.env ?? process.env
  const cacheHome = options.cacheHome ?? resolveCacheHome(env)

  for (const spec of specs) {
    const [, version] = /^@fro\.bot\/[\w-]+@(.+)$/.exec(spec) ?? []
    if (version === undefined || !EXACT_VERSION_PATTERN.test(version)) {
      return err(
        fail('invalid-version', spec, `Refusing plugin spec: ${spec} (expected an exact @fro.bot package@x.y.z)`),
      )
    }
  }

  // One throwaway root for everything the install may write besides the npm cache: the global config `plugin add`
  // writes (P10), the data directory and the database that booting OpenCode creates.
  let isolatedRoot: string | undefined
  try {
    isolatedRoot = await mkdtemp(join(tmpdir(), 'fro-bot-plugin-install-'))
    const root = isolatedRoot
    for (const spec of specs) {
      const startedAt = Date.now()
      logger.info('Installing OpenCode V2 plugin', {spec, timeoutMs})
      let stderrTail = ''
      const execOptions = {
        cwd: root,
        env: {
          ...filterAgentEnv(env),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CACHE_HOME: cacheHome,
          OPENCODE_DB: join(root, 'opencode.db'),
          OPENCODE_CONFIG_CONTENT: EMPTY_CONFIG,
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DISABLE_AUTOUPDATE: '1',
        },
        ignoreReturnCode: true,
        silent: true,
        listeners: {
          stderr: (data: Buffer) => {
            stderrTail = `${stderrTail}${data.toString()}`.slice(-STDERR_TAIL_LIMIT)
          },
        },
      } as const
      const args = ['plugin', 'add', spec]

      let result: number | 'timed-out'
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        result =
          execAdapter.execWithTimeout === undefined
            ? await Promise.race<number | 'timed-out'>([
                execAdapter.exec(opencodeBinaryPath, args, execOptions),
                new Promise<'timed-out'>(resolve => {
                  timeoutId = setTimeout(() => resolve('timed-out'), timeoutMs)
                }),
              ])
            : await execAdapter.execWithTimeout(opencodeBinaryPath, args, timeoutMs, execOptions)
      } catch (error) {
        logger.warning('OpenCode V2 plugin install failed to run', {spec, error: toErrorMessage(error)})
        return err(fail('install-failed', spec, `Installing OpenCode plugin ${spec} failed to run`))
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      }

      const duration = Date.now() - startedAt
      if (result === 'timed-out') {
        logger.warning('OpenCode V2 plugin install timed out', {spec, timeoutMs, duration})
        return err(fail('install-timeout', spec, `Installing OpenCode plugin ${spec} exceeded ${timeoutMs / 1000}s`))
      }
      if (result !== 0) {
        logger.warning('OpenCode V2 plugin install failed', {spec, exitCode: result, duration, stderr: stderrTail})
        return err(fail('install-failed', spec, `Installing OpenCode plugin ${spec} failed (exit ${result})`))
      }

      // A zero exit that left nothing behind would hand the install to the server at boot, unbounded.
      const cacheDir = pluginCacheDir(cacheHome, spec)
      if (!(await isNonEmptyDirectory(cacheDir))) {
        logger.warning('OpenCode V2 plugin is not in the cache after a successful install', {spec})
        return err(fail('cache-empty', spec, `OpenCode plugin ${spec} is not in the cache after a successful install`))
      }
      logger.info('OpenCode V2 plugin installed', {spec, duration})
    }
    return ok(undefined)
  } finally {
    if (isolatedRoot !== undefined) {
      try {
        await rm(isolatedRoot, {recursive: true, force: true})
      } catch (cleanupError) {
        logger.debug('Failed to remove the temporary plugin-install directory', {error: toErrorMessage(cleanupError)})
      }
    }
  }
}
