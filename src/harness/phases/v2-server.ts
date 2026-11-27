import type {Result} from '@bfra.me/es/result'
import type {
  BuiltConfigV2,
  CredentialDisposition,
  KeyProxyMcpRouteConfig,
  OpenCodeV2SandboxLaunch,
  OpenCodeV2ServerHandle,
  OpenCodeV2TracingDecision,
  StartOpenCodeV2ServerOptions,
} from '@fro-bot/runtime'
import type {ProviderKeyEntryV2} from '../../services/setup/credential-files-v2.js'
import type {KeyProxyProviderPlan} from '../../services/setup/key-proxy-providers.js'
import type {BrokeredMcpV2, McpBrokerPlanV2} from '../../services/setup/mcp-servers-v2.js'
import type {InstallPluginsV2Options, PluginInstallV2Error} from '../../services/setup/plugin-install-v2.js'
import type {RepoSkillsSource} from '../../services/setup/repo-skills.js'
import type {ActionTracingSource} from '../../services/setup/tracing.js'
import type {LifecycleSpan} from '../../shared/lifecycle-tracer.js'
import type {Logger} from '../../shared/logger.js'
import type {KeyProxyProcess, KeyProxyStartError, StartKeyProxyProcessOptions} from './key-proxy-process.js'
import type {SandboxLifecycle} from './sandbox-lifecycle.js'
import type {V1DatabaseFacts, V1ImportWaitError, WaitForV1ImportOptions} from './v1-import-wait.js'
import * as path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {err, ok} from '@bfra.me/es/result'
import {
  ACTION_TRACING_OFF,
  clearHeldClaims,
  FRO_BOT_PLUGIN_ID,
  KEY_PROXY_MCP_PATH_PREFIX,
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
import {buildCIConfigV2, prepareOperatorConfigV2} from '../../services/setup/ci-config-v2.js'
import {
  parseProviderKeysV2,
  removeStaleAuthJsonV2,
  resolveCredentialBaseDir,
  writeCredentialFilesV2,
} from '../../services/setup/credential-files-v2.js'
import {checkConfigForKeys, resolveKeyProxyProviders} from '../../services/setup/key-proxy-providers.js'
import {planMcpBrokerV2} from '../../services/setup/mcp-servers-v2.js'
import {
  arePluginsCachedV2,
  installPluginsV2,
  resolveCacheHome,
  resolvePluginSpecsV2,
} from '../../services/setup/plugin-install-v2.js'
import {admitRepoSkills, discardRepoSkillsStaging} from '../../services/setup/repo-skills.js'
import {resolveActionTracing} from '../../services/setup/tracing.js'
import {isRunCancelled} from '../../shared/cancellation.js'
import {toErrorMessage} from '../../shared/errors.js'
import {NOOP_SPAN, withSpan} from '../../shared/lifecycle-tracer.js'
import {logDefaultModelNotice, suppliedProviderIds, verifyDefaultModelProvider} from './default-model.js'
import {probeKeyProxy} from './key-proxy-probe.js'
import {startKeyProxyProcess} from './key-proxy-process.js'
import {readV1DatabaseFacts, waitForV1Import} from './v1-import-wait.js'

/**
 * Starts the OpenCode V2 server for an Action run and gates it: the part of the V2 cache-restore phase after the
 * restored database is repaired and before any prompt.
 *
 * Order, and why:
 * 1. Credentials. `auth-json` is narrowed to API-key entries, each written to its own 0600 file outside every cached
 *    path (`credential-files-v2.ts`), and any `auth.json` already at the XDG path (a restore, an earlier run) is deleted so
 *    V2's m39 migration has nothing to import into the database the post hook saves.
 * 2. Plugin preparation. Setup installs both plugins under their own bound, but a missing plugin would otherwise
 *    install during server readiness, whose deadline is shorter than the healthy install tail (181-370 s measured; the
 *    bound is 420 s). So this runs before every spawn, whatever setup or the tools cache did: a cache that already holds both exact specs costs two directory reads, and
 *    anything else gets the bounded installer.
 * 2b. MCP broker (`isolate-agent`). Each remote MCP server that has `headers` is planned as a route on the key-proxy child, and
 *    an entry the broker cannot protect fails the run, before anything is started. The order is fixed: plan the routes,
 *    start the child, rewrite the entries to its loopback routes (in both config variants), scan both configs for every
 *    value the child holds, then hand off. The child starts when there are provider routes or MCP routes.
 * 3. Config. `buildCIConfigV2` (the outside-directory deny with run-scoped exceptions, `question` denied, the plugins)
 *    plus a `{file:}` reference per key file. After the plugins, because one exception is the installed Systematic
 *    skills directory (fro-bot/agent#2009), and its generation directory only exists once the plugin is cached. For a
 *    trusted run with `repo-skills` on (fro-bot/agent#2129) the admission filter also runs here, for the same reason: it
 *    checks repo skill names against that directory, and the admitted copy joins the config as `skills.paths`.
 * 4. Held claims. `clearHeldClaims` runs on the restored database before the spawn: a V2 server resumes a claim a
 *    killed run left behind. A fresh database, a V1 database (no claim tables) and a database no V2 server opened are
 *    no-ops.
 * 5. Spawn. `startOpenCodeV2Server` scrubs the environment itself (`filterAgentEnv`), so the process environment is
 *    passed as-is and not filtered twice. Its plugin gate requires `systematic` and `fro-bot.opencode-plugin` active.
 * 6. Permission gate over the effective per-agent rules; with no `model` input, a check that the default model's provider is
 *    on the server; then the credential gate for the provider the run needs. A `{file:}` reference counts as
 *    authentication.
 * 7. Import wait: no prompt until the V1 history import reports `completed`.
 *
 * Any failure after the spawn shuts the server down before returning, so a failed start leaves no process behind. The
 * caller decides what a failure means for persistence (it means no save).
 */

/** Fixed text: the stage is `spawn` because that is the one thing a cancelled run must not do. */
const CANCELLED_START_MESSAGE = 'The run was cancelled, so the OpenCode server was not started'

export type V2StartStage =
  | 'config'
  | 'credential-gate'
  | 'credentials'
  | 'held-claims'
  | 'import-wait'
  | 'key-proxy'
  | 'permission-gate'
  | 'plugins'
  | 'sandbox'
  | 'spawn'

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
  /** The run's credential disposition; `withhold` drops caller MCP servers an untrusted trigger could reach. */
  readonly credential: CredentialDisposition
  /**
   * Candidate repository skills for a run the trust predicate admitted (`repo-skills`, fro-bot/agent#2129); null or
   * absent otherwise. Admitted here, after the plugin install, because collisions with the installed bundled skills are
   * checked against the plugin's own skills directory.
   */
  readonly repoSkills?: RepoSkillsSource | null
  /**
   * `isolate-agent`: when present, the account and handoff happen after the held-claim clear and before the spawn, the
   * server launches through sudo and setpriv, and every failure path releases it. The caller releases it on every later
   * path. Null or absent leaves the launch exactly as it was.
   */
  readonly sandbox?: SandboxLifecycle | null
  readonly runId: string | number
  readonly runAttempt: string | number
  /**
   * What the plugin is told about tracing: off, or on with the running relay's port and the run's identity, as a host or as a
   * source read at each use. Required, with no default, so a caller cannot start the server without deciding. The Action's own
   * host only: this surface is never the workspace. A source is read once while the start is prepared, only to know whether a
   * traced config could be needed, and then once per spawn, after the runtime's port allocation and immediately before the
   * child exists: that reading is the decision, and both the launcher document and the plugin list come from it. A relay that
   * died in between is never named to the plugin, and the child then gets exactly what a run that never traced gets.
   */
  readonly tracing: ActionTracingSource
  readonly logger: Logger
  readonly signal?: AbortSignal
  /** Masks the server password in the Action's log (`core.setSecret`). */
  readonly maskSecret?: (value: string) => void
  /**
   * The lifecycle trace's server start span: the isolation handoff is its child and every gate decision an event on it.
   * Names a gate and its result only, never a value.
   */
  readonly traceSpan?: LifecycleSpan
  readonly deps?: Partial<StartActionOpenCodeV2Deps>
}

export interface StartActionOpenCodeV2Deps {
  readonly startServer: typeof startOpenCodeV2Server
  /** The bounded plugin installer (`installPluginsV2`), minus its exec adapter. */
  readonly installPlugins: (
    options: Omit<InstallPluginsV2Options, 'execAdapter'>,
  ) => Promise<Result<void, PluginInstallV2Error>>
  readonly clearClaims: typeof clearHeldClaims
  readonly admitRepoSkills: typeof admitRepoSkills
  readonly waitForImport: (options: WaitForV1ImportOptions) => Promise<Result<unknown, V1ImportWaitError>>
  readonly readDatabaseFacts: (dbPath: string) => V1DatabaseFacts
  readonly startOptions?: Partial<StartOpenCodeV2ServerOptions>
  /** Starts the key proxy child of an `isolate-agent` run. */
  readonly startKeyProxy: typeof startKeyProxyProcess
  /** The start-up probe of the selected provider through the key proxy (isolated runs only). */
  readonly probeKeyProxy: typeof probeKeyProxy
  /**
   * Test seams for the key proxy supervisor (launcher, upstream CA, timeouts). Production never sets them: nothing reachable
   * from an input, the environment or `opencode-config` can.
   */
  readonly keyProxyOptions?: Partial<Pick<StartKeyProxyProcessOptions, 'deps' | 'launcher' | 'testing' | 'timeouts'>>
  /** Overrides the permission gate's agent-list retry timing (tests). */
  readonly agentListRetry?: Partial<AgentListRetryPolicy>
}

const GATE_REQUEST_TIMEOUT_MS = 5_000

/** A logger that says nothing, for a build whose warnings a later build repeats. */
const QUIET_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warning: () => undefined,
  error: () => undefined,
}

/**
 * Up to OpenCode 2.2.6, `GET /api/agent` waits for plugin activation, and the server gives up on that wait after 5 s
 * with a 503 (2.2.7 and later answer at once; the plugin gate in `startOpenCodeV2Server` covers activation there). A
 * client attempt bound above that lets the server's own 503 arrive first; a gate that failed on a slow activation (measured
 * 4.0-4.2 s on a healthy run) then retries instead of failing the run. The deadline bounds every attempt and backoff:
 * the gate has no other outer timeout (the spawn's readiness waits end before it), only the caller's `signal`.
 */
interface AgentListRetryPolicy {
  readonly attemptTimeoutMs: number
  readonly retryDelayMs: number
  readonly deadlineMs: number
}

const DEFAULT_AGENT_LIST_RETRY: AgentListRetryPolicy = {
  attemptTimeoutMs: 7_000,
  retryDelayMs: 500,
  deadlineMs: 30_000,
}

function isTimeoutOrAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Reads `GET /api/agent`, retrying only while the server is not ready: an HTTP 503, or a client timeout/abort. Any other
 * status, any other thrown error (including a caller-requested abort) and a body that is not JSON fail at once, as they
 * always did, so the gate stays fail-closed. A retry starts only when a full attempt still fits before the deadline.
 */
async function readAgentList(
  fetchRoute: OpenCodeV2ServerHandle['fetch'],
  policy: AgentListRetryPolicy,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const startedAt = Date.now()
  for (let attempt = 1; ; attempt++) {
    const bound = AbortSignal.timeout(policy.attemptTimeoutMs)
    let cause: string
    try {
      const response = await fetchRoute('/api/agent', {
        signal: signal === undefined ? bound : AbortSignal.any([signal, bound]),
      })
      if (response.status === 503) {
        await response.body?.cancel().catch(() => undefined)
        cause = 'HTTP 503'
      } else if (response.ok) {
        return await response.json()
      } else {
        throw new Error(`GET /api/agent answered HTTP ${response.status}`)
      }
    } catch (error) {
      if (!isTimeoutOrAbort(error) || signal?.aborted === true) throw error
      cause = 'timed out'
    }

    const elapsedMs = Date.now() - startedAt
    if (elapsedMs + policy.retryDelayMs + policy.attemptTimeoutMs > policy.deadlineMs) {
      throw new Error(
        `GET /api/agent was not ready after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'} over ${elapsedMs}ms ` +
          `(retried on HTTP 503 or timeout); last cause: ${cause}`,
      )
    }
    logger.debug('OpenCode V2 agent list not ready, retrying the permission gate read', {
      attempt,
      cause,
      elapsedMs,
      retryDelayMs: policy.retryDelayMs,
    })
    await delay(policy.retryDelayMs, undefined, signal === undefined ? undefined : {signal})
  }
}

const defaultDeps: StartActionOpenCodeV2Deps = {
  startServer: startOpenCodeV2Server,
  startKeyProxy: startKeyProxyProcess,
  probeKeyProxy,
  installPlugins: async installOptions => installPluginsV2({...installOptions, execAdapter: createExecAdapter()}),
  clearClaims: clearHeldClaims,
  admitRepoSkills,
  waitForImport: waitForV1Import,
  readDatabaseFacts: readV1DatabaseFacts,
}

export async function startActionOpenCodeV2(
  options: StartActionOpenCodeV2Options,
): Promise<Result<OpenCodeV2ServerHandle, V2StartError>> {
  const {logger} = options
  const deps = {...defaultDeps, ...options.deps}
  const stageError = (stage: V2StartStage, message: string): Result<never, V2StartError> => err({stage, message})
  // A cancelled run starts no server: nothing is written, installed or spawned after the first signal.
  const cancelledStart = (): Result<never, V2StartError> => stageError('spawn', CANCELLED_START_MESSAGE)
  if (isRunCancelled()) return cancelledStart()
  // No `model` input: the session is created on `DEFAULT_MODEL` (`executeOpenCodeV2`), whatever the credentials and the
  // config say. Decided once here; the notice and the provider check below both read it.
  const usesDefaultModel = options.model == null

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

  // `isolate-agent`: the keys stay with the key proxy and never reach a file the sandbox could read. Which providers it can
  // serve, and which operator settings would bypass it, are decided before anything is written or started.
  let proxyPlans: readonly KeyProxyProviderPlan[] = []
  if (options.sandbox != null) {
    const resolved = resolveKeyProxyProviders({keys: keys.data, opencodeConfig: options.opencodeConfig})
    if (!resolved.success) {
      return stageError(
        'config',
        resolved.error.kind === 'invalid-config'
          ? `Invalid OpenCode configuration: ${resolved.error.message}`
          : resolved.error.message,
      )
    }
    proxyPlans = resolved.data
  }

  // `isolate-agent`: remote MCP servers with `headers` are brokered by the same child, so they are planned here, from what the
  // trigger's filter keeps, with the key plans: a server the broker cannot protect refuses the run before anything starts or
  // is written. Each value the child will hold is masked now, before any later line could carry it.
  let brokerPlan: McpBrokerPlanV2 = {routes: [], stripped: [], secrets: []}
  if (options.sandbox != null) {
    const planned = planBrokeredMcp(options, proxyPlans)
    if (!planned.success) return stageError('config', planned.error)
    brokerPlan = planned.data
    for (const secret of brokerPlan.secrets) options.maskSecret?.(secret.value)
    if (brokerPlan.routes.length > 0 || brokerPlan.stripped.length > 0) {
      logger.info('Remote MCP servers with headers are brokered under isolate-agent', {
        brokered: brokerPlan.routes.length,
        disabledWithHeaders: brokerPlan.stripped.length,
      })
    }
  }

  const specs = resolvePluginSpecsV2(options.systematicVersion)
  if (!specs.success) return stageError('plugins', specs.error.message)

  try {
    await removeStaleAuthJsonV2(options.authPath, logger)
  } catch (error) {
    return stageError('credentials', toErrorMessage(error))
  }
  let keyFiles: Readonly<Record<string, string>> = {}
  if (options.sandbox == null) {
    const files = await writeCredentialFilesV2({
      entries: keys.data,
      baseDir: resolveCredentialBaseDir(options.env),
      logger,
    })
    if (!files.success) return stageError('credentials', files.error.message)
    keyFiles = files.data.keyFiles
  }

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
  const bundledSkillsDirectories = await resolveSystematicSkillsDirsV2(cacheHome, specs.data.systematicVersion, logger)
  if (bundledSkillsDirectories.length === 0) {
    logger.warning(
      'Bundled Systematic skills directory not found; skills cannot read their own references under the external_directory deny',
      {systematicVersion: specs.data.systematicVersion},
    )
  }

  // Repository skills: a run-scoped copy of the admissible ones, never the checkout in place. Fail soft: a refusal logs
  // why and the run proceeds exactly as a run without the input.
  let repoSkillsDirectory: string | undefined
  if (options.repoSkills != null) {
    try {
      const admission = await deps.admitRepoSkills({
        sourceDir: options.repoSkills.sourceDir,
        stagingRoot: options.repoSkills.stagingRoot,
        bundledSkillsDirectories,
        symlinkedSkillIds: options.repoSkills.symlinkedSkillIds,
        logger,
      })
      if (admission.success) {
        repoSkillsDirectory = admission.data.directory ?? undefined
        logger.info('Repository skills admitted', {
          admitted: admission.data.admitted.length,
          skipped: admission.data.skipped.map(skill => skill.id),
        })
      } else {
        logger.warning(`Repository skills are not loaded: ${admission.error}`)
      }
    } catch (error) {
      // Admission reads and copies a checkout-derived tree; nothing it throws may fail the run. Warn with the error code
      // only (a message can carry a path), drop what was staged, and start as a run without the input.
      logger.warning('Repository skills are not loaded: admission failed unexpectedly', {
        error: (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'unknown'),
      })
      repoSkillsDirectory = undefined
      await discardRepoSkillsStaging(options.repoSkills.stagingRoot)
    }
  }

  // With a sandbox, the key proxy starts first (its port is in the config) and belongs to the lifecycle from before it
  // spawns: a signal, a failure or a throw anywhere below releases the lifecycle, which stops the proxy. Without one this is
  // exactly the config and held-claim work it always was.
  // Set by `prepareRun` once the lifecycle owns a proxy; read below for the run's signal.
  const owned: {proxy: KeyProxyProcess | null; facts: V1DatabaseFacts} = {
    proxy: null,
    facts: {bytes: null, sessions: null},
  }
  const prepareRun = async (): Promise<
    Result<
      {readonly built: BuiltConfigV2; readonly builtTraced: BuiltConfigV2 | null; readonly childEnv: NodeJS.ProcessEnv},
      V2StartError
    >
  > => {
    let proxied: Record<string, {baseURL: string; apiKey: string}> = {}
    let brokeredMcp: BrokeredMcpV2 | undefined
    if (options.sandbox != null) {
      const stripped = brokerPlan.stripped.map(entry => ({...entry, action: 'strip'}) as const)
      brokeredMcp = {servers: stripped}
      // The one child serves provider routes and MCP routes: it starts when either set is non-empty, and not otherwise.
      if (proxyPlans.length > 0 || brokerPlan.routes.length > 0) {
        const started = await startProxyUnderLifecycle(
          options.sandbox,
          proxyPlans,
          brokerPlan.routes.map(entry => entry.route),
          keys.data,
          deps,
          options,
          logger,
        )
        if (!started.success) return started
        owned.proxy = started.data
        options.maskSecret?.(started.data.placeholder)
        proxied = Object.fromEntries(
          proxyPlans.map(plan => [
            plan.providerId,
            {baseURL: started.data.baseUrl(plan.providerId), apiKey: started.data.placeholder},
          ]),
        )
        // Only now is the child's port known: each brokered entry is rewritten to its route on it.
        const proxy = started.data
        brokeredMcp = {
          servers: [
            ...brokerPlan.routes.map(
              entry =>
                ({name: entry.name, layout: entry.layout, action: 'route', url: proxy.mcpUrl(entry.route.id)}) as const,
            ),
            ...stripped,
          ],
        }
      }
    }

    const configInputs = {
      opencodeConfig: options.opencodeConfig,
      credential: options.credential,
      plugins: specs.data.specs,
      runnerTemp: options.env.RUNNER_TEMP,
      runId: options.runId,
      runAttempt: options.runAttempt,
      ...(options.env.FRO_BOT_INTEGRATION_WORK_DIR === undefined
        ? {}
        : {integrationWorkDir: options.env.FRO_BOT_INTEGRATION_WORK_DIR}),
      ...(options.sandbox == null ? {providerKeyFiles: keyFiles} : {proxiedProviders: proxied}),
      ...(brokeredMcp === undefined ? {} : {brokeredMcp}),
      bundledSkillsDirectories,
      ...(repoSkillsDirectory === undefined ? {} : {repoSkillsDirectory}),
    }
    // The config a run that does not trace gets. This is the start's own config, and the one the child receives unless the
    // spawn-time decision says tracing is on.
    const builtConfig = buildCIConfigV2({...configInputs, tracing: false}, logger)
    if (!builtConfig.success) return stageError('config', `Invalid OpenCode configuration: ${builtConfig.error}`)
    // The config a traced run would get (the plugin order and the dedupe of operator entries are the only differences), built
    // only when the relay is up now. Whether it is used is decided later, once, at the spawn: a relay that is down now never
    // comes back, so no traced variant is needed then. Built quietly, since the traced run's other warnings are the same ones.
    const tracedConfig =
      resolveActionTracing(options.tracing).tracing === 'on'
        ? buildCIConfigV2({...configInputs, tracing: true}, QUIET_LOGGER)
        : null
    const builtTraced = tracedConfig?.success === true ? tracedConfig.data : null
    if (usesDefaultModel) {
      logDefaultModelNotice({
        logger,
        suppliedProviders: suppliedProviderIds({
          keyProviderIds: keys.data.map(entry => entry.providerId),
          config: builtConfig.data.content,
        }),
      })
    }

    // Last check before anything is handed to the sandbox user: no auth-json key value and no brokered MCP header value may be
    // in the config it will read. `OPENCODE_CONFIG_CONTENT` is the only config the sandbox gets (the child holds the keys and
    // the headers, not a file).
    if (options.sandbox != null) {
      const clean = checkConfigForKeys({
        keys: keys.data,
        mcpSecrets: brokerPlan.secrets,
        configs: [
          {label: 'the OpenCode config (OPENCODE_CONFIG_CONTENT)', text: JSON.stringify(builtConfig.data.content)},
          // Either may be the one the child receives, so both are held to the same rule.
          ...(builtTraced === null
            ? []
            : [
                {
                  label: 'the traced OpenCode config (OPENCODE_CONFIG_CONTENT)',
                  text: JSON.stringify(builtTraced.content),
                },
              ]),
        ],
      })
      if (!clean.success) return stageError('config', clean.error)
    }

    // --- 4. Held claims ----------------------------------------------------------------------------------------
    owned.facts = deps.readDatabaseFacts(options.dbPath)
    const cleared = await deps.clearClaims(options.dbPath, logger)
    if (!cleared.success) {
      return stageError('held-claims', 'Could not clear held execution claims in the restored OpenCode database')
    }

    // --- 4b. Sandbox account and handoff (isolate-agent) -----------------------------------------------------
    //
    // After the last runner-side write to the restored database (the claim clear) and before the spawn. A failure here
    // has already rolled itself back inside `prepare`.
    let sandboxEnv = options.env
    if (options.sandbox != null) {
      const ghConfigDir = provisionedGhConfigDir(options.env)
      // A `GH_CONFIG_DIR` that is not the provisioned temp dir (an ambient one from an earlier step) is not handed over,
      // so it must not reach the child as a path the sandbox cannot read.
      sandboxEnv = withoutKey(options.env, 'GH_CONFIG_DIR')
      const sandbox = options.sandbox
      const prepared = await withSpan(
        (options.traceSpan ?? NOOP_SPAN).startChild('isolation handoff'),
        async handoffSpan =>
          sandbox.prepare({
            // Nothing to hand over: the keys are in the proxy, not in files.
            keyFilePaths: Object.values(keyFiles),
            ghConfigDir,
            repoSkills:
              options.repoSkills == null
                ? null
                : {stagingRoot: options.repoSkills.stagingRoot, admittedDir: repoSkillsDirectory ?? null},
            traceSpan: handoffSpan,
          }),
        result => (result.success ? {outcome: 'succeeded'} : {outcome: 'failed', reason: 'handoff-failed'}),
      )
      if (!prepared.success) return stageError('sandbox', `isolate-agent setup failed: ${prepared.error}`)
      if (ghConfigDir !== null) sandboxEnv = {...sandboxEnv, GH_CONFIG_DIR: ghConfigDir}
    }
    return ok({built: builtConfig.data, builtTraced, childEnv: sandboxEnv})
  }

  let prepared: Awaited<ReturnType<typeof prepareRun>>
  try {
    prepared = await prepareRun()
  } catch (error) {
    await releaseSandboxAfterFailure(options.sandbox, logger)
    throw error
  }
  if (!prepared.success) {
    await releaseSandboxAfterFailure(options.sandbox, logger)
    return prepared
  }
  const builtUntraced = prepared.data.built
  const builtTraced = prepared.data.builtTraced
  const childEnv = prepared.data.childEnv
  // The config the child actually received, for the gates that read it after the spawn (permission rules, model, providers).
  // The tracing-off one until the spawn-time decision says otherwise, and set by that decision alone.
  let built = builtUntraced
  // The caller's signal, plus the proxy's: a proxy that dies on its own aborts the server and the gates.
  const runSignal =
    owned.proxy === null
      ? options.signal
      : options.signal === undefined
        ? owned.proxy.died
        : AbortSignal.any([options.signal, owned.proxy.died])

  // --- 5. Spawn (plugin gate inside) -------------------------------------------------------------------------
  //
  // With a sandbox the spawn goes through `sandbox.launch`, which records the attempt before port allocation begins and is
  // refused once the teardown has begun. `release` waits for the attempt to settle (and aborts it) before it verifies the
  // sandbox uid is empty, so a signal can no longer slip between this check and the privileged launch.
  // The one tracing decision of a spawn. The runtime start calls it after its port allocation, right before the child exists:
  // the relay is read here and nowhere else, and everything that depends on the answer comes from it: the launcher document
  // (the host) and the plugin list and operator-entry dedupe (the traced config). An answer of off, or any failure to decide,
  // gives the exact off document and the exact config of a run that never traced (the start's own config, which the decision
  // leaves alone).
  const decideTracing = (): OpenCodeV2TracingDecision => {
    try {
      const host = resolveActionTracing(options.tracing)
      if (host.tracing === 'on' && builtTraced !== null) {
        built = builtTraced
        return {host, config: builtTraced.content}
      }
    } catch {
      // Tracing never fails a start: fall through to off.
    }
    built = builtUntraced
    return {host: ACTION_TRACING_OFF}
  }

  const spawnOptions = (extra: {
    readonly sandbox?: OpenCodeV2SandboxLaunch
    readonly signal?: AbortSignal
    readonly onSpawn?: (pid: number) => void
  }) => ({
    binaryPath: options.binaryPath,
    directory: options.workspacePath,
    expectedPluginIds: [SYSTEMATIC_V2_PLUGIN_ID, FRO_BOT_PLUGIN_ID],
    config: builtUntraced.content,
    env: childEnv,
    // Where the guard for the agent's `opencode` command goes when the spawn makes it (no sandbox; #2369): the runner's temp
    // directory, which the runner removes with the job. Unset: the spawn's default.
    ...(options.env.RUNNER_TEMP === undefined || options.env.RUNNER_TEMP === ''
      ? {}
      : {cliShimParentDirectory: options.env.RUNNER_TEMP}),
    ...(extra.sandbox === undefined ? {} : {sandbox: extra.sandbox}),
    ...(extra.signal === undefined ? {} : {signal: extra.signal}),
    ...(extra.onSpawn === undefined ? {} : {onSpawn: extra.onSpawn}),
    ...(options.maskSecret === undefined ? {} : {maskSecret: options.maskSecret}),
    ...deps.startOptions,
    // After the test seam's spread, so the decision is always the one the spawn applies.
    tracingHost: decideTracing,
  })

  // After every await of the preparation above (installs, the import wait, the gates): the last point before the spawn.
  if (isRunCancelled()) return cancelledStart()

  let started: Awaited<ReturnType<typeof deps.startServer>>
  try {
    if (options.sandbox == null) {
      started = await deps.startServer(spawnOptions({...(runSignal === undefined ? {} : {signal: runSignal})}), logger)
    } else {
      const launched = await options.sandbox.launch(async context => {
        const result = await deps.startServer(
          spawnOptions({
            sandbox: context.spec,
            signal: runSignal === undefined ? context.signal : AbortSignal.any([runSignal, context.signal]),
            onSpawn: context.noteSpawn,
          }),
          logger,
        )
        // A start that failed and could not confirm its own child exited leaves the uid sweep untrustworthy.
        return {value: result, unconfirmed: !result.success && result.error.cleanup === 'unconfirmed'}
      })
      if (!launched.success) {
        await releaseSandboxAfterFailure(options.sandbox, logger)
        return stageError('sandbox', `isolate-agent launch refused: ${launched.error}`)
      }
      started = launched.data
    }
  } catch (error) {
    await releaseSandboxAfterFailure(options.sandbox, logger)
    throw error
  }
  if (!started.success) {
    const failure = started.error
    // The runtime already terminated the child; this confirms no sandbox process is left, then takes everything back.
    await releaseSandboxAfterFailure(options.sandbox, logger)
    return stageError(
      failure.kind === 'plugin-gate' ? 'plugins' : 'spawn',
      `OpenCode V2 server failed to start: ${failure.message}`,
    )
  }
  const handle = started.data

  // The handle and the sandbox are owned here until every gate below has passed. Any failure, returned or thrown, stops
  // the server first (so nothing writes while files are taken back) and then releases the sandbox.
  const stopAfterFailure = async (): Promise<void> => {
    try {
      const shutdown = await handle.shutdown()
      if (shutdown.exit.outcome === 'unconfirmed') {
        logger.error('OpenCode V2 server exit could not be confirmed after a failed start')
      }
    } catch (error) {
      logger.error('OpenCode V2 server shutdown after a failed start threw', {error: toErrorMessage(error)})
    }
    await releaseSandboxAfterFailure(options.sandbox, logger)
  }

  const failAfterSpawn = async (stage: V2StartStage, message: string): Promise<Result<never, V2StartError>> => {
    await stopAfterFailure()
    return stageError(stage, message)
  }

  // One event per gate on the server start span, with the gate's name and its result: how a run's start was decided.
  const gateDecision = (gate: string, result: 'failed' | 'passed' | 'skipped'): void => {
    options.traceSpan?.addEvent('gate.decision', {'fro_bot.gate': gate, 'fro_bot.result': result})
  }

  const runGates = async (): Promise<Result<OpenCodeV2ServerHandle, V2StartError>> => {
    // --- 6. Permission gate, default model's provider, then credential gate ---------------------------------
    const permissions = await verifyPermissionRules(
      {
        // A 503 is not-ready, never "no agents" and never a pass: it is retried to the deadline and then fails.
        listAgents: async () =>
          readAgentList(handle.fetch, {...DEFAULT_AGENT_LIST_RETRY, ...deps.agentListRetry}, logger, runSignal),
      },
      built.expectations,
      logger,
    )
    gateDecision('permission', permissions.success ? 'passed' : 'failed')
    if (!permissions.success) {
      return failAfterSpawn('permission-gate', `OpenCode permission gate failed: ${permissions.error.message}`)
    }

    // --- 6a. Default model's provider ---------------------------------------------------------------------
    //
    // Before the key proxy probe and the credential gate, which ask about `options.model ?? <config model>`: with no model
    // input the session is created on the default model whatever the config's top-level `model` says, so a key for that
    // provider cannot help when the default model's own provider is gone. This is the cause to report first. The default
    // model is free and needs no credential, so no later gate covers it; without this check a caller config that removes
    // its provider fails the first turn with a bare `provider.no-route`.
    if (usesDefaultModel) {
      const available = await verifyDefaultModelProvider({
        handle,
        requestTimeoutMs: GATE_REQUEST_TIMEOUT_MS,
        ...(runSignal === undefined ? {} : {signal: runSignal}),
      })
      gateDecision('default-model-provider', available.success ? 'passed' : 'failed')
      if (!available.success) return failAfterSpawn('config', available.error)
    }

    const spawnConfig = spawnConfigFromConfig(built.content)
    const modelProvider = modelProviderId(options.model ?? spawnConfig.model)

    // --- 6b. Key proxy probe (isolate-agent) ---------------------------------------------------------------
    //
    // The credential gate above is satisfied by the placeholder, so for an isolated run this is the real check of the key.
    // Only the selected model's provider is probed: another provider's bad key must not block a run that never uses it. A
    // child that serves MCP routes alone has no provider to probe, and an MCP server gets no start-up probe: it connects in
    // the background, and one that is unreachable or rejects its credential is only that server's failure.
    if (owned.proxy !== null && proxyPlans.length === 0) {
      gateDecision('key-proxy-probe', 'skipped')
      logger.info('Key proxy probe skipped: no provider is proxied (the key proxy serves MCP routes only)', {
        provider: modelProvider ?? null,
      })
    } else if (owned.proxy !== null) {
      const plan =
        modelProvider === undefined ? undefined : proxyPlans.find(entry => entry.providerId === modelProvider)
      if (plan === undefined) {
        gateDecision('key-proxy-probe', 'skipped')
        logger.info('Key proxy probe skipped: the selected model is not on a provider the key proxy serves', {
          provider: modelProvider ?? null,
        })
      } else {
        const probe = await deps.probeKeyProxy({
          plan,
          proxy: {baseUrl: owned.proxy.baseUrl, placeholder: owned.proxy.placeholder},
          logger,
          ...(runSignal === undefined ? {} : {signal: runSignal}),
        })
        const probeFailed = probe.status === 'failed' || probe.status === 'aborted'
        gateDecision('key-proxy-probe', probeFailed ? 'failed' : 'passed')
        if (probeFailed) {
          return failAfterSpawn('key-proxy', probe.message)
        }
      }
    }

    const requiredProviders = modelProvider === undefined ? keys.data.map(entry => entry.providerId) : [modelProvider]
    if (requiredProviders.length === 0) {
      gateDecision('credential', 'skipped')
      logger.info('No model or provider credentials configured, credential gate skipped')
    } else {
      const credentials = await verifyCredentialGate({
        handle,
        requestTimeoutMs: GATE_REQUEST_TIMEOUT_MS,
        ...(runSignal === undefined ? {} : {signal: runSignal}),
        providers: requiredProviders,
        configuredAuth: spawnConfig.authenticatedProviders,
        remedy: 'Add an API-key entry for it to the auth-json input.',
      })
      gateDecision('credential', credentials.success ? 'passed' : 'failed')
      if (!credentials.success) {
        return failAfterSpawn('credential-gate', `OpenCode credential gate failed: ${credentials.error.message}`)
      }
    }

    // --- 7. Import wait ----------------------------------------------------------------------------------------
    const imported = await deps.waitForImport({
      fetch: handle.fetch,
      logger,
      facts: owned.facts,
      ...(runSignal === undefined ? {} : {signal: runSignal}),
    })
    gateDecision('import-wait', imported.success ? 'passed' : 'failed')
    if (!imported.success) return failAfterSpawn('import-wait', imported.error.message)

    logger.info('OpenCode V2 server is started and gated', {
      providers: keys.data.map(entry => entry.providerId),
      plugins: specs.data.specs,
    })
    return ok(handle)
  }

  try {
    return await runGates()
  } catch (error) {
    await stopAfterFailure()
    throw error
  }
}

/**
 * Plans the brokered MCP routes from the operator's config as the trigger's filter leaves it, and refuses what cannot be
 * brokered. Built quietly: the build that follows logs what the filter dropped, once.
 */
function planBrokeredMcp(
  options: StartActionOpenCodeV2Options,
  proxyPlans: readonly KeyProxyProviderPlan[],
): Result<McpBrokerPlanV2, string> {
  const operator = prepareOperatorConfigV2(
    {opencodeConfig: options.opencodeConfig, credential: options.credential},
    QUIET_LOGGER,
  )
  if (!operator.success) return err(`Invalid OpenCode configuration: ${operator.error}`)
  const planned = planMcpBrokerV2(operator.data.mcp)
  if (!planned.success) return err(planned.error.message)
  if (planned.data.routes.length > 0) {
    // The child serves a provider at `/<provider id>/...` and an MCP server at `/mcp/<route id>`: a provider called `mcp`
    // would own that prefix.
    const clash = proxyPlans.find(plan => plan.providerId.toLowerCase() === KEY_PROXY_MCP_PATH_PREFIX)
    if (clash !== undefined) {
      return err(
        `isolate-agent: provider "${clash.providerId}" would own the \`/${KEY_PROXY_MCP_PATH_PREFIX}/\` route prefix the key proxy serves MCP servers under. ` +
          'Fix: rename the provider (its id in the auth-json input and in opencode-config).',
      )
    }
  }
  return ok(planned.data)
}

/**
 * Starts the key proxy as the lifecycle's: the lifecycle takes signal ownership and records the attempt before the child is
 * spawned, so a signal or a release that begins mid-start aborts it and stops what it produced. The caller releases the
 * lifecycle on any failure returned from here.
 */
async function startProxyUnderLifecycle(
  sandbox: SandboxLifecycle,
  plans: readonly KeyProxyProviderPlan[],
  mcpRoutes: readonly KeyProxyMcpRouteConfig[],
  keys: readonly ProviderKeyEntryV2[],
  deps: StartActionOpenCodeV2Deps,
  options: StartActionOpenCodeV2Options,
  logger: Logger,
): Promise<Result<KeyProxyProcess, V2StartError>> {
  const keyById = new Map(keys.map(entry => [entry.providerId, entry.key]))
  const failure: {error: KeyProxyStartError | null} = {error: null}
  const started = await sandbox.startKeyProxy(async context => {
    const result = await deps.startKeyProxy({
      ...deps.keyProxyOptions,
      logger,
      providers: plans.map(plan => ({...plan, key: keyById.get(plan.providerId) ?? ''})),
      mcpRoutes,
      signal: options.signal === undefined ? context.signal : AbortSignal.any([options.signal, context.signal]),
    })
    if (result.success) return {proxy: result.data, unconfirmed: false}
    failure.error = result.error
    return {proxy: null, unconfirmed: result.error.cleanup === 'unconfirmed'}
  })
  if (!started.success) return err({stage: 'key-proxy', message: `isolate-agent key proxy refused: ${started.error}`})
  if (started.data === null) {
    return err({
      stage: 'key-proxy',
      message: `isolate-agent key proxy failed to start: ${failure.error?.message ?? 'no reason given'}`,
    })
  }
  return ok(started.data)
}

/**
 * The temp `GH_CONFIG_DIR` provision mode writes (`gh-config-*` directly under `RUNNER_TEMP`), or null. Anything else is
 * ambient state from an earlier step and is not handed to the sandbox.
 */
function provisionedGhConfigDir(env: NodeJS.ProcessEnv): string | null {
  const dir = env.GH_CONFIG_DIR
  const runnerTemp = env.RUNNER_TEMP
  if (dir === undefined || dir.length === 0 || runnerTemp === undefined || runnerTemp.length === 0) return null
  return path.dirname(dir) === path.resolve(runnerTemp) && path.basename(dir).startsWith('gh-config-') ? dir : null
}

function withoutKey(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy = {...env}
  delete copy[key]
  return copy
}

/**
 * Stops every sandbox process and takes everything back after a failed start. An unsafe outcome is logged here; the
 * start already failed, so the caller declines persistence for the run either way.
 */
async function releaseSandboxAfterFailure(sandbox: SandboxLifecycle | null | undefined, logger: Logger): Promise<void> {
  if (sandbox == null) return
  try {
    const outcome = await sandbox.release()
    if (outcome.restore === 'unsafe') {
      logger.error('The sandbox could not be restored after a failed start', {reason: outcome.reason})
    }
  } catch (error) {
    logger.error('Releasing the sandbox after a failed start threw', {error: toErrorMessage(error)})
  }
}
