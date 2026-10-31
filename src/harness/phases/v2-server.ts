import type {Result} from '@bfra.me/es/result'
import type {OpenCodeV2ServerHandle, StartOpenCodeV2ServerOptions} from '@fro-bot/runtime'
import type {InstallPluginsV2Options, PluginInstallV2Error} from '../../services/setup/plugin-install-v2.js'
import type {Logger} from '../../shared/logger.js'
import type {V1DatabaseFacts, V1ImportWaitError, WaitForV1ImportOptions} from './v1-import-wait.js'
import {err, ok} from '@bfra.me/es/result'
import {
  clearHeldClaims,
  FRO_BOT_PLUGIN_ID,
  modelProviderId,
  resolveSystematicSkillsDirsV2,
  spawnConfigFromConfig,
  startOpenCodeV2Server,
  SYSTEMATIC_V2_PLUGIN_ID,
  verifyCredentialGate,
  verifyPermissionRules,
} from '@fro-bot/runtime'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {parseAuthJsonInput} from '../../services/setup/auth-json.js'
import {buildCIConfigV2} from '../../services/setup/ci-config-v2.js'
import {
  parseProviderKeysV2,
  removeStaleAuthJsonV2,
  resolveCredentialBaseDir,
  writeCredentialFilesV2,
} from '../../services/setup/credential-files-v2.js'
import {
  arePluginsCachedV2,
  installPluginsV2,
  resolveCacheHome,
  resolvePluginSpecsV2,
} from '../../services/setup/plugin-install-v2.js'
import {toErrorMessage} from '../../shared/errors.js'
import {readV1DatabaseFacts, waitForV1Import} from './v1-import-wait.js'

/**
 * Starts the OpenCode V2 server for an Action run and gates it: the part of the V2 cache-restore phase after the
 * restored database is repaired and before any prompt.
 *
 * Order, and why:
 * 1. Credentials. `auth-json` is narrowed to API-key entries, each written to its own 0600 file outside every cached
 *    path (`credential-files-v2.ts`), and any `auth.json` already at the XDG path (a restore, an earlier run) is deleted so
 *    V2's m39 migration has nothing to import into the database the post hook saves.
 * 2. Plugin preparation. Setup installs both plugins under their own bound, but a matching binary that is already
 *    installed skips setup, and a missing plugin would then install during server readiness, whose deadline is shorter
 *    than the healthy install tail (181-370 s measured; the bound is 420 s). So this runs before every spawn,
 *    whatever setup or the tools cache did: a cache that already holds both exact specs costs two directory reads, and
 *    anything else gets the bounded installer.
 * 3. Config. `buildCIConfigV2` (the outside-directory deny with run-scoped exceptions, `question` denied, the plugins)
 *    plus a `{file:}` reference per key file. After the plugins, because one exception is the installed Systematic
 *    skills directory (fro-bot/agent#2009), and its generation directory only exists once the plugin is cached.
 * 4. Held claims. `clearHeldClaims` runs on the restored database before the spawn: a V2 server resumes a claim a
 *    killed run left behind. A fresh database, a V1 database (no claim tables) and a database no V2 server opened are
 *    no-ops.
 * 5. Spawn. `startOpenCodeV2Server` scrubs the environment itself (`filterAgentEnv`), so the process environment is
 *    passed as-is and not filtered twice. Its plugin gate requires `systematic` and `fro-bot.opencode-plugin` active.
 * 6. Permission gate over the effective per-agent rules, then the credential gate for the provider the run needs. A
 *    `{file:}` reference counts as authentication.
 * 7. Import wait: no prompt until the V1 history import reports `completed`.
 *
 * Any failure after the spawn shuts the server down before returning, so a failed start leaves no process behind. The
 * caller decides what a failure means for persistence (it means no save).
 */

export type V2StartStage =
  'config' | 'credential-gate' | 'credentials' | 'held-claims' | 'import-wait' | 'permission-gate' | 'plugins' | 'spawn'

export interface V2StartError {
  readonly stage: V2StartStage
  /** Names a stage and a provider id or a gate result at most. Never a key, a key path or a config value. */
  readonly message: string
}

export interface StartActionOpenCodeV2Options {
  /** The verified OpenCode V2 executable. */
  readonly binaryPath: string
  /** The checkout the server runs in: the location every gate asks about. */
  readonly workspacePath: string
  /** `auth-json` input, as given. */
  readonly authJson: string
  /** `opencode-config` input, or null. */
  readonly opencodeConfig: string | null
  /** `systematic-version` input. */
  readonly systematicVersion: string
  /** `model` input (`provider/model`), or null. It decides which provider the credential gate asks about. */
  readonly model: string | null
  /** Where the restored database sits (`<data dir>/opencode.db`). */
  readonly dbPath: string
  /** Where V1 and the XDG path would put `auth.json`. */
  readonly authPath: string
  readonly env: NodeJS.ProcessEnv
  readonly runId: string | number
  readonly runAttempt: string | number
  readonly logger: Logger
  readonly signal?: AbortSignal
  /** Masks the server password in the Action's log (`core.setSecret`). */
  readonly maskSecret?: (value: string) => void
  readonly deps?: Partial<StartActionOpenCodeV2Deps>
}

export interface StartActionOpenCodeV2Deps {
  readonly startServer: typeof startOpenCodeV2Server
  /** The bounded plugin installer (`installPluginsV2`), minus its exec adapter. */
  readonly installPlugins: (
    options: Omit<InstallPluginsV2Options, 'execAdapter'>,
  ) => Promise<Result<void, PluginInstallV2Error>>
  readonly clearClaims: typeof clearHeldClaims
  readonly waitForImport: (options: WaitForV1ImportOptions) => Promise<Result<unknown, V1ImportWaitError>>
  readonly readDatabaseFacts: (dbPath: string) => V1DatabaseFacts
  readonly startOptions?: Partial<StartOpenCodeV2ServerOptions>
}

const GATE_REQUEST_TIMEOUT_MS = 5_000

const defaultDeps: StartActionOpenCodeV2Deps = {
  startServer: startOpenCodeV2Server,
  installPlugins: async installOptions => installPluginsV2({...installOptions, execAdapter: createExecAdapter()}),
  clearClaims: clearHeldClaims,
  waitForImport: waitForV1Import,
  readDatabaseFacts: readV1DatabaseFacts,
}

export async function startActionOpenCodeV2(
  options: StartActionOpenCodeV2Options,
): Promise<Result<OpenCodeV2ServerHandle, V2StartError>> {
  const {logger} = options
  const deps = {...defaultDeps, ...options.deps}
  const stageError = (stage: V2StartStage, message: string): Result<never, V2StartError> => err({stage, message})

  // --- 1. Credentials ----------------------------------------------------------------------------------------
  let authConfig: ReturnType<typeof parseAuthJsonInput>
  try {
    authConfig = parseAuthJsonInput(options.authJson)
  } catch (error) {
    // The parse error of a JSON syntax failure can quote the input, so only that it failed is reported.
    logger.debug('auth-json could not be parsed', {error: error instanceof SyntaxError ? 'syntax' : 'shape'})
    return stageError('credentials', 'Invalid auth-json: the input is not a JSON object')
  }
  const keys = parseProviderKeysV2(authConfig)
  if (!keys.success) return stageError('credentials', `Invalid auth-json for OpenCode V2: ${keys.error.message}`)

  const specs = resolvePluginSpecsV2(options.systematicVersion)
  if (!specs.success) return stageError('plugins', specs.error.message)

  try {
    await removeStaleAuthJsonV2(options.authPath, logger)
  } catch (error) {
    return stageError('credentials', toErrorMessage(error))
  }
  const files = await writeCredentialFilesV2({
    entries: keys.data,
    baseDir: resolveCredentialBaseDir(options.env),
    logger,
  })
  if (!files.success) return stageError('credentials', files.error.message)

  // --- 2. Plugin preparation ---------------------------------------------------------------------------------
  const cacheHome = resolveCacheHome(options.env)
  if (await arePluginsCachedV2(cacheHome, specs.data.specs)) {
    logger.info('OpenCode V2 plugins already in the cache', {specs: specs.data.specs})
  } else {
    const installed = await deps.installPlugins({
      logger,
      opencodeBinaryPath: options.binaryPath,
      specs: specs.data.specs,
      cacheHome,
      env: options.env,
    })
    if (!installed.success) return stageError('plugins', `OpenCode plugin install failed: ${installed.error.message}`)
  }

  // --- 3. Config ---------------------------------------------------------------------------------------------
  //
  // After the plugins on purpose: the config names the installed Systematic skills directory, which does not exist
  // until the plugin is in the cache.
  const bundledSkillsDirectories = await resolveSystematicSkillsDirsV2(cacheHome, specs.data.systematicVersion)
  if (bundledSkillsDirectories.length === 0) {
    logger.warning(
      'Bundled Systematic skills directory not found; skills cannot read their own references under the external_directory deny',
      {systematicVersion: specs.data.systematicVersion},
    )
  }
  const built = buildCIConfigV2(
    {
      opencodeConfig: options.opencodeConfig,
      plugins: specs.data.specs,
      runnerTemp: options.env.RUNNER_TEMP,
      runId: options.runId,
      runAttempt: options.runAttempt,
      ...(options.env.FRO_BOT_INTEGRATION_WORK_DIR === undefined
        ? {}
        : {integrationWorkDir: options.env.FRO_BOT_INTEGRATION_WORK_DIR}),
      providerKeyFiles: files.data.keyFiles,
      bundledSkillsDirectories,
    },
    logger,
  )
  if (!built.success) return stageError('config', `Invalid OpenCode configuration: ${built.error}`)

  // --- 4. Held claims ----------------------------------------------------------------------------------------
  const facts = deps.readDatabaseFacts(options.dbPath)
  const cleared = await deps.clearClaims(options.dbPath, logger)
  if (!cleared.success) {
    return stageError('held-claims', 'Could not clear held execution claims in the restored OpenCode database')
  }

  // --- 5. Spawn (plugin gate inside) -------------------------------------------------------------------------
  const started = await deps.startServer(
    {
      binaryPath: options.binaryPath,
      directory: options.workspacePath,
      expectedPluginIds: [SYSTEMATIC_V2_PLUGIN_ID, FRO_BOT_PLUGIN_ID],
      config: built.data.content,
      env: options.env,
      ...(options.signal === undefined ? {} : {signal: options.signal}),
      ...(options.maskSecret === undefined ? {} : {maskSecret: options.maskSecret}),
      ...deps.startOptions,
    },
    logger,
  )
  if (!started.success) {
    const failure = started.error
    return stageError(
      failure.kind === 'plugin-gate' ? 'plugins' : 'spawn',
      `OpenCode V2 server failed to start: ${failure.message}`,
    )
  }
  const handle = started.data

  const failAfterSpawn = async (stage: V2StartStage, message: string): Promise<Result<never, V2StartError>> => {
    try {
      const shutdown = await handle.shutdown()
      if (shutdown.exit.outcome === 'unconfirmed') {
        logger.error('OpenCode V2 server exit could not be confirmed after a failed start')
      }
    } catch (error) {
      logger.error('OpenCode V2 server shutdown after a failed start threw', {error: toErrorMessage(error)})
    }
    return stageError(stage, message)
  }

  // --- 6. Permission gate, then credential gate -------------------------------------------------------------
  const permissions = await verifyPermissionRules(
    {
      listAgents: async () => {
        // `GET /api/agent` answering 503 is not-ready, not "no agents"; the spawn's own readiness gate has already
        // waited it out, so a non-200 here is a failure to read, not a pass.
        const response = await handle.fetch('/api/agent', {signal: AbortSignal.timeout(GATE_REQUEST_TIMEOUT_MS)})
        if (!response.ok) throw new Error(`GET /api/agent answered HTTP ${response.status}`)
        return response.json()
      },
    },
    built.data.expectations,
    logger,
  )
  if (!permissions.success) {
    return failAfterSpawn('permission-gate', `OpenCode permission gate failed: ${permissions.error.message}`)
  }

  const spawnConfig = spawnConfigFromConfig(built.data.content)
  const modelProvider = modelProviderId(options.model ?? spawnConfig.model)
  const requiredProviders = modelProvider === undefined ? keys.data.map(entry => entry.providerId) : [modelProvider]
  if (requiredProviders.length === 0) {
    logger.info('No model or provider credentials configured, credential gate skipped')
  } else {
    const credentials = await verifyCredentialGate({
      handle,
      requestTimeoutMs: GATE_REQUEST_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : {signal: options.signal}),
      providers: requiredProviders,
      configuredAuth: spawnConfig.authenticatedProviders,
      remedy: 'Add an API-key entry for it to the auth-json input.',
    })
    if (!credentials.success) {
      return failAfterSpawn('credential-gate', `OpenCode credential gate failed: ${credentials.error.message}`)
    }
  }

  // --- 7. Import wait ----------------------------------------------------------------------------------------
  const imported = await deps.waitForImport({
    fetch: handle.fetch,
    logger,
    facts,
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  })
  if (!imported.success) return failAfterSpawn('import-wait', imported.error.message)

  logger.info('OpenCode V2 server is started and gated', {
    providers: keys.data.map(entry => entry.providerId),
    plugins: specs.data.specs,
  })
  return ok(handle)
}
