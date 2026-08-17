import type {DiffFileSummary} from '../packages/runtime/src/agent/index.js'
import type {ParsedResponse, ResponseSurface} from '../packages/runtime/src/agent/response-file.js'
import type {SessionContext, TriggerContext} from '../packages/runtime/src/agent/types.js'
import type {SessionClient} from '../packages/runtime/src/session/backend.js'
import type {LogicalSessionKey} from '../packages/runtime/src/session/logical-key.js'
import type {OmoProviders} from '../packages/runtime/src/shared/types.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from '../src/features/agent/types.js'
import type {GitHubContext} from '../src/services/github/types.js'
import type {Logger} from '../src/shared/logger.js'
import type {
  EvalRunArtifacts,
  EvalRunReport,
  PriorWork,
  ResponseArtifacts,
  Scenario,
  SessionPresearchAccounting,
  SessionPresearchStrategy,
} from './types.js'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {pathToFileURL} from 'node:url'
import {createOpencode} from '@opencode-ai/sdk'
import {redactSecrets} from '../packages/harness/src/format-error.js'
import {
  buildResponseFilePath,
  parseResponseFile,
  RESPONSE_FILE_DIR_SEGMENT,
} from '../packages/runtime/src/agent/response-file.js'
import {withScrubbedEnv} from '../packages/runtime/src/agent/with-scrubbed-env.js'
import {buildLogicalKey, buildSessionTitle} from '../packages/runtime/src/session/logical-key.js'
import {buildAgentPrompt, executeOpenCode} from '../src/features/agent/index.js'
import {resolveResponseSurface} from '../src/features/agent/response-file.js'
import {buildTriggerContext} from '../src/features/triggers/context-builders.js'
import {normalizeEvent} from '../src/services/github/context.js'
import {writeSessionToolsFile} from '../src/services/setup/session-tools-config.js'
import {
  captureDiagnostics,
  clearScenarioDiagnostics,
  persistResponseDiagnostics,
  readCapturedDiagnostics,
} from './diagnostics.js'
import {cleanupFixtureRepo, createFixtureRepo} from './fixture-repo.js'
import {evaluateRun, projectStableOutcome} from './gates.js'

const DEFAULT_EVAL_MODEL = 'opencode/big-pickle'
export const EVAL_RESPONSE_PATH_SENTINEL = '/__fro-bot_eval__/response.md'
const EVAL_PROVENANCE_CANARY = 'eval-provenance-canary-v1'
const deterministicProvenanceCache = new Map<
  string,
  {readonly promptHash: string; readonly scenarioCommitSha: string}
>()

/** The default model's provider serves a free tier that needs no stored credential. */
const CREDENTIAL_FREE_PROVIDER = 'opencode'

/**
 * Providers whose stored credential is an OAuth record rather than an API key need their
 * auth plugin loaded to perform the token exchange. Copying `auth.json` alone is not enough:
 * without the plugin the request fails as an opaque provider error that looks like a bad
 * credential rather than a missing exchange step.
 */
const PROVIDER_AUTH_PLUGINS: Readonly<Record<string, string>> = {
  anthropic: '@cortexkit/opencode-anthropic-auth@1.18.0',
}

export function resolveConfiguredPluginVersions(model: string): readonly string[] {
  const authPlugin = PROVIDER_AUTH_PLUGINS[parseModel(model).providerID]
  return authPlugin == null ? [] : [authPlugin]
}

/**
 * Resolve the harness binary the corpus runs against.
 *
 * This must be the patched harness build, never stock `opencode-ai` from npm. The harness
 * carries this project's upstream patch set, so an eval driven by the stock package is
 * measuring a different system than the one that ships — the same class of error as pinning
 * an outdated version. Override with `FRO_BOT_EVAL_HARNESS_BIN` when testing a candidate build.
 */
export function resolveHarnessBinary(): string {
  const configured = process.env.FRO_BOT_EVAL_HARNESS_BIN
  if (configured != null && configured.trim().length > 0) {
    const explicitPath = configured.trim()
    if (fs.existsSync(explicitPath) === false) {
      throw new Error(`FRO_BOT_EVAL_HARNESS_BIN points at a missing binary: ${explicitPath}`)
    }
    return explicitPath
  }

  let launcher = ''
  try {
    launcher = execFileSync('which', ['harness'], {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim()
  } catch {
    launcher = ''
  }

  if (launcher.length === 0 || fs.existsSync(launcher) === false) {
    throw new Error(
      'No harness binary found on PATH. Install @fro.bot/harness, or set FRO_BOT_EVAL_HARNESS_BIN ' +
        'to the platform binary the corpus should run. The corpus must not fall back to stock opencode-ai.',
    )
  }

  // Resolve past the launcher shim to the platform binary it would exec. The shim discovers
  // its platform package relative to the caller's environment, which the corpus deliberately
  // isolates (HOME and XDG_* point at a scratch home), so under isolation it reports a `dev`
  // build and fails to locate `@fro.bot/harness-<platform>`. Executing the platform binary
  // directly keeps the sandbox intact and still runs the real patched build.
  //
  // The launcher's own layout is not fixed: a global install puts it at `<root>/bin/harness`
  // while a workspace install exposes `<root>/node_modules/.bin/harness`. Walking up and
  // probing each level handles both instead of assuming one shape.
  const platformBinary = findPlatformBinary(launcher)
  if (platformBinary == null) {
    throw new Error(
      `Harness platform binary for ${process.platform}-${process.arch} not found near ${launcher}. ` +
        'Set FRO_BOT_EVAL_HARNESS_BIN to the platform binary for this host.',
    )
  }

  return platformBinary
}

function findPlatformBinary(launcher: string): string | null {
  // Coupled to the @fro.bot/harness package layout: the platform package is named
  // `harness-<platform>-<arch>` but its executable is still `bin/opencode`. If that bin
  // entry is ever renamed, this surfaces as the "not found" error below rather than
  // silently running a different binary.
  const packageName = `harness-${process.platform}-${process.arch}`
  let current = path.dirname(fs.realpathSync(launcher))

  for (let depth = 0; depth < 8; depth++) {
    // Coupled to the harness package layout: its platform package exposes the executable as bin/opencode.
    const candidate = path.join(current, 'node_modules', '@fro.bot', packageName, 'bin', 'opencode')
    if (fs.existsSync(candidate)) {
      return candidate
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return null
}
/**
 * Per-scenario execution budget.
 *
 * Investigation scenarios legitimately take longer than trivial ones: the first real
 * corpus run approved a clean PR in ~73s but exceeded a 120s budget while investigating
 * a planted defect, producing a timeout that looked like a capability failure. The budget
 * is generous by default and overridable so a slower or more deliberate model does not
 * get scored on a deadline rather than on its output.
 */
const DEFAULT_EVAL_TIMEOUT_MS = 300_000

export function resolveEvalTimeoutMs(): number {
  const configured = process.env.FRO_BOT_EVAL_TIMEOUT_MS
  if (configured == null || configured.length === 0) {
    return DEFAULT_EVAL_TIMEOUT_MS
  }

  if (/^[1-9]\d*$/.test(configured) === false) {
    throw new Error(`FRO_BOT_EVAL_TIMEOUT_MS must be a positive integer, got: ${configured}`)
  }

  return Number(configured)
}
const NO_OMO_PROVIDERS: OmoProviders = {
  claude: 'no',
  copilot: 'no',
  gemini: 'no',
  openai: 'no',
  opencodeZen: 'no',
  zaiCodingPlan: 'no',
  kimiForCoding: 'no',
}

interface IsolatedEvalEnv {
  readonly home: string
  readonly runnerTemp: string
  readonly responseDir: string
  readonly responseFilePath: string
  readonly opencodeBin: string
  readonly pluginVersions: readonly string[]
  readonly authSecretValues: readonly string[]
  readonly originalEnv: Record<string, string | undefined>
  readonly originalCwd: string
}

export const EVAL_CANARY_PLACEHOLDER = 'EVAL_CANARY_PLACEHOLDER'

function restoreEnv(originalEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function cleanupIsolatedEvalEnv(env: IsolatedEvalEnv): void {
  const errors: unknown[] = []
  try {
    restoreEnv(env.originalEnv)
  } catch (error) {
    errors.push(error)
  }
  try {
    // Restore the working directory before removing anything: the process may still be inside
    // a directory that is about to be deleted.
    process.chdir(env.originalCwd)
  } catch (error) {
    errors.push(error)
  }
  try {
    fs.rmSync(env.home, {recursive: true, force: true})
  } catch (error) {
    errors.push(error)
  }
  try {
    fs.rmSync(env.runnerTemp, {recursive: true, force: true})
  } catch (error) {
    errors.push(error)
  }

  if (errors.length > 0) {
    const firstError = errors[0]
    throw new Error(
      `Isolated eval cleanup failed: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
    )
  }
}

async function createIsolatedEvalEnv(
  repoPath: string,
  scenario: Scenario,
  headSha: string,
  model: string,
  logger: Logger,
): Promise<IsolatedEvalEnv> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `fro-bot-eval-${scenario.id}-`))
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), `fro-bot-eval-temp-${scenario.id}-`))
  const runId = String(Date.now())
  const runAttempt = '1'
  const responseFilePath = buildResponseFilePath({
    runnerTemp,
    runId,
    runAttempt,
    nonce: crypto.randomUUID(),
  })
  const responseDir = path.dirname(responseFilePath)
  const binDir = path.join(home, 'bin')
  const configDir = path.join(home, '.config', 'opencode')
  const dataDir = path.join(home, '.local', 'share')
  const cacheDir = path.join(home, '.cache')
  const originalCwd = process.cwd()
  const originalEnv: Record<string, string | undefined> = {}
  const envKeys = [
    'HOME',
    'PATH',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'GITHUB_WORKSPACE',
    'GITHUB_REPOSITORY',
    'GITHUB_REF',
    'GITHUB_SHA',
    'GITHUB_EVENT_NAME',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_ACTOR',
    'RUNNER_TEMP',
    'CI',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]

  for (const key of envKeys) {
    originalEnv[key] = process.env[key]
  }

  try {
    fs.mkdirSync(binDir, {recursive: true})
    fs.mkdirSync(configDir, {recursive: true})
    fs.mkdirSync(responseDir, {recursive: true})
    const authSecretValues = provisionProviderAuth(dataDir, model, originalEnv)

    const opencodeBin = path.join(binDir, 'opencode')
    fs.writeFileSync(opencodeBin, `#!/bin/sh\nexec "${resolveHarnessBinary()}" "$@"\n`, {mode: 0o755})
    const pluginVersions = resolveConfiguredPluginVersions(model)
    const authPlugin = pluginVersions[0]
    const sessionToolsAsset = path.resolve(import.meta.dirname, '..', 'dist', 'session-tools.js')
    await writeSessionToolsFile(configDir, logger, () => pathToFileURL(sessionToolsAsset))
    fs.writeFileSync(
      path.join(configDir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          default_agent: 'build',
          model,
          ...(authPlugin == null ? {} : {plugin: [authPlugin]}),
          agent: {
            build: {
              permission: {
                bash: 'allow',
                edit: 'allow',
                read: 'allow',
                webfetch: 'deny',
                external_directory: {
                  '*': 'deny',
                  [path.join(runnerTemp, RESPONSE_FILE_DIR_SEGMENT, '*')]: 'allow',
                },
              },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    process.env.HOME = home
    process.env.PATH = `${binDir}:${originalEnv.PATH ?? ''}`
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    process.env.XDG_DATA_HOME = dataDir
    process.env.XDG_CACHE_HOME = cacheDir
    process.env.GITHUB_WORKSPACE = repoPath
    process.env.GITHUB_REPOSITORY = `fro-bot-eval/${scenario.id}`
    process.env.GITHUB_REF = 'refs/heads/main'
    process.env.GITHUB_SHA = headSha
    process.env.GITHUB_EVENT_NAME = scenario.surface.kind
    process.env.GITHUB_RUN_ID = runId
    process.env.GITHUB_RUN_ATTEMPT = runAttempt
    process.env.GITHUB_ACTOR = 'fro-bot-eval'
    process.env.RUNNER_TEMP = runnerTemp
    process.env.CI = '1'
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN

    // The OpenCode server bootstraps in the process working directory, not in the session
    // directory it is later handed. In CI those coincide because the process already runs in
    // GITHUB_WORKSPACE, but under a test runner they diverge: the server would index this
    // repository instead of the fixture, the fixture's files would be missing from the tree the
    // agent can see, and a diligent model burns its whole budget searching the filesystem for
    // them. Enter the fixture repository so the agent sees exactly the scenario under test.
    process.chdir(repoPath)

    return {
      home,
      runnerTemp,
      responseDir,
      responseFilePath,
      opencodeBin,
      pluginVersions,
      authSecretValues,
      originalEnv,
      originalCwd,
    }
  } catch (error) {
    const partialEnv: IsolatedEvalEnv = {
      home,
      runnerTemp,
      responseDir,
      responseFilePath,
      opencodeBin: path.join(binDir, 'opencode'),
      pluginVersions: [],
      authSecretValues: [],
      originalEnv,
      originalCwd,
    }
    try {
      cleanupIsolatedEvalEnv(partialEnv)
    } catch {
      // Preserve the setup error; cleanup is best-effort on the failure path.
    }
    throw error
  }
}

/**
 * Copy the single provider credential the configured model needs into the isolated home.
 *
 * The runner deliberately isolates HOME and XDG_DATA_HOME, so the sandbox starts with no
 * `auth.json` at all. That is why only credential-free models run out of the box. When a
 * real model is pinned, exactly one provider entry is copied — never the whole host auth
 * file, which typically holds credentials for several unrelated providers that this run
 * has no business being able to reach.
 *
 * Fails loudly rather than running unauthenticated: an auth-less run against a real model
 * surfaces as a confusing execution failure that looks like an agent problem.
 */
const CREDENTIAL_KEY_FORMS: ReadonlySet<string> = new Set([
  'key',
  'token',
  'secret',
  'password',
  'credential',
  'access',
  'refresh',
  'apikey',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
])

function isCredentialKey(keyName: string): boolean {
  return CREDENTIAL_KEY_FORMS.has(keyName.replaceAll(/[-_]/g, '').toLowerCase())
}

function collectCredentialValues(value: unknown, keyName: string | null = null): readonly string[] {
  if (typeof value === 'string') {
    return keyName != null && isCredentialKey(keyName) ? [value] : []
  }
  if (typeof value !== 'object' || value === null) {
    return []
  }

  const values: string[] = []
  for (const [key, nestedValue] of Object.entries(value)) {
    values.push(...collectCredentialValues(nestedValue, key))
  }
  return values
}

function provisionProviderAuth(
  dataDir: string,
  model: string,
  originalEnv: Record<string, string | undefined>,
): readonly string[] {
  const {providerID} = parseModel(model)
  const hostDataDir = originalEnv.XDG_DATA_HOME ?? path.join(originalEnv.HOME ?? os.homedir(), '.local', 'share')
  const hostAuthPath = path.join(hostDataDir, 'opencode', 'auth.json')

  if (fs.existsSync(hostAuthPath) === false) {
    if (providerID === CREDENTIAL_FREE_PROVIDER) return []
    throw new Error(
      `Model ${model} requires provider credentials but no auth.json was found at ${hostAuthPath}. ` +
        `Use the credential-free default model, or authenticate that provider first.`,
    )
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(hostAuthPath, 'utf8'))
  const entry =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[providerID] : undefined

  if (entry === undefined) {
    if (providerID === CREDENTIAL_FREE_PROVIDER) return []
    throw new Error(
      `Model ${model} requires a '${providerID}' credential but ${hostAuthPath} has no such entry. ` +
        `Authenticate that provider first, or use the credential-free default model.`,
    )
  }

  const isolatedAuthDir = path.join(dataDir, 'opencode')
  fs.mkdirSync(isolatedAuthDir, {recursive: true})
  fs.writeFileSync(path.join(isolatedAuthDir, 'auth.json'), JSON.stringify({[providerID]: entry}), {mode: 0o600})
  return collectCredentialValues(entry)
}

export function parseModel(model: string): {readonly providerID: string; readonly modelID: string} {
  const parts = model.split('/')
  const providerID = parts[0]
  const modelID = parts[1]
  if (parts.length !== 2 || providerID == null || modelID == null || providerID.length === 0 || modelID.length === 0) {
    throw new Error(`FRO_BOT_EVAL_MODEL must use provider/model format, got: ${model}`)
  }

  return {providerID, modelID}
}

export function resolveModel(): string {
  const configuredModel = process.env.FRO_BOT_EVAL_MODEL
  if (configuredModel == null) {
    return DEFAULT_EVAL_MODEL
  }
  const model = configuredModel.trim()
  parseModel(model)
  return model
}

function buildDiffContext(diffFiles: readonly DiffFileSummary[]) {
  return {
    changedFiles: diffFiles.length,
    additions: diffFiles.reduce((total, file) => total + file.additions, 0),
    deletions: diffFiles.reduce((total, file) => total + file.deletions, 0),
    truncated: false,
    files: diffFiles,
  }
}

interface ScenarioInput {
  readonly eventType: 'pull_request' | 'issue_comment'
  readonly payload: unknown
  readonly event: GitHubContext['event']
  readonly diffContext: ReturnType<typeof buildDiffContext> | null
  readonly hydratedContext: PromptOptions['context']['hydratedContext']
}

export interface EvalSessionPrepInput {
  readonly priorWork: PriorWork | null
  readonly logicalKey: LogicalSessionKey | null
}

export interface EvalSessionPrepSelection {
  readonly sessionContext: SessionContext
  readonly isContinuation: boolean
  readonly currentThreadSessionId: string | null
  readonly logicalKey: LogicalSessionKey | null
  readonly accounting: SessionPresearchAccounting
}

export type EvalSessionPrepStrategy = (input: EvalSessionPrepInput) => EvalSessionPrepSelection

function buildSessionPresearchAccounting(
  strategy: SessionPresearchStrategy,
  logicalKey: LogicalSessionKey | null,
  priorWork: PriorWork | null,
  sessionContext: SessionContext,
): SessionPresearchAccounting {
  const hasInjectedContext = sessionContext.recentSessions.length > 0 || sessionContext.priorWorkContext.length > 0
  return {
    strategy,
    logicalKey: logicalKey?.key ?? null,
    continuationSessionId: priorWork?.currentThreadSessionId ?? null,
    recentSessionCount: sessionContext.recentSessions.length,
    priorWorkResultCount: sessionContext.priorWorkContext.length,
    // JSON-size approximation for diagnosis only; it does not measure rendered prompt weight
    // and must not become a quality gate.
    injectedContextBytes: hasInjectedContext ? Buffer.byteLength(JSON.stringify(sessionContext), 'utf8') : 0,
  }
}

function buildSessionPrepSelection(
  strategy: SessionPresearchStrategy,
  input: EvalSessionPrepInput,
  sessionContext: SessionContext,
): EvalSessionPrepSelection {
  return {
    sessionContext,
    isContinuation: input.priorWork !== null,
    currentThreadSessionId: input.priorWork?.currentThreadSessionId ?? null,
    logicalKey: input.logicalKey,
    accounting: buildSessionPresearchAccounting(strategy, input.logicalKey, input.priorWork, sessionContext),
  }
}

export const productionSessionPrepStrategy: EvalSessionPrepStrategy = input =>
  buildSessionPrepSelection(
    'production-default',
    input,
    input.priorWork?.sessionContext ?? {recentSessions: [], priorWorkContext: []},
  )

export const treatmentSessionPrepStrategy: EvalSessionPrepStrategy = input =>
  buildSessionPrepSelection('treatment', input, {recentSessions: [], priorWorkContext: []})

function buildScenarioInput(scenario: Scenario): ScenarioInput {
  switch (scenario.surface.kind) {
    case 'pull_request':
      return {
        eventType: 'pull_request',
        payload: scenario.surface.event,
        event: normalizeEvent('pull_request', scenario.surface.event),
        diffContext: buildDiffContext(scenario.surface.diffFiles),
        hydratedContext: scenario.surface.hydratedContext,
      }
    case 'issue_comment':
      return {
        eventType: 'issue_comment',
        payload: scenario.surface.event,
        event: normalizeEvent('issue_comment', scenario.surface.event),
        diffContext: null,
        hydratedContext: scenario.surface.hydratedContext,
      }
  }
}

function buildTriggerContextForScenario(
  scenario: Scenario,
  headSha: string,
  scenarioInput: ScenarioInput = buildScenarioInput(scenario),
): TriggerContext {
  const githubContext: GitHubContext = {
    eventName: scenarioInput.eventType,
    eventType: scenarioInput.eventType,
    repo: {owner: 'fro-bot-eval', repo: scenario.id},
    ref: 'refs/heads/main',
    sha: headSha,
    runId: 1,
    actor: 'fro-bot-eval',
    payload: scenarioInput.payload,
    event: scenarioInput.event,
  }

  return buildTriggerContext(githubContext, null, null)
}

interface PreparedScenarioPrompt {
  readonly scenarioInput: ScenarioInput
  readonly triggerContext: TriggerContext
  readonly sessionPrep: EvalSessionPrepSelection
}

function prepareScenarioPrompt(
  scenario: Scenario,
  headSha: string,
  sessionPrepStrategy: EvalSessionPrepStrategy,
): PreparedScenarioPrompt {
  const scenarioInput = buildScenarioInput(scenario)
  const triggerContext = buildTriggerContextForScenario(scenario, headSha, scenarioInput)
  const logicalKey = buildLogicalKey(triggerContext)

  return {
    scenarioInput,
    triggerContext,
    sessionPrep: sessionPrepStrategy({priorWork: scenario.priorWork, logicalKey}),
  }
}

function buildPromptOptionsFromPrepared(
  scenario: Scenario,
  responseFilePath: string,
  prepared: PreparedScenarioPrompt,
): PromptOptions {
  const {scenarioInput, triggerContext, sessionPrep} = prepared
  const target = triggerContext.target
  const author = triggerContext.author
  const priorWorkOptions =
    sessionPrep.isContinuation === false
      ? {}
      : {
          sessionContext: sessionPrep.sessionContext,
          isContinuation: true,
          currentThreadSessionId: sessionPrep.currentThreadSessionId,
        }

  return {
    context: {
      eventName: triggerContext.eventName,
      repo: `${triggerContext.repo.owner}/${triggerContext.repo.repo}`,
      ref: triggerContext.ref,
      actor: triggerContext.actor,
      runId: String(triggerContext.runId),
      issueNumber: target?.number ?? null,
      issueTitle: target?.title ?? null,
      issueType: target?.kind === 'pr' ? 'pr' : null,
      commentBody: triggerContext.commentBody,
      commentAuthor: author?.login ?? null,
      commentId: triggerContext.commentId,
      defaultBranch: 'main',
      diffContext: scenarioInput.diffContext,
      hydratedContext: scenarioInput.hydratedContext,
      authorAssociation: author?.association ?? null,
      isRequestedReviewer: triggerContext.isBotReviewRequested,
    },
    customPrompt: scenario.prompt,
    cacheStatus: 'miss',
    triggerContext,
    resolvedOutputMode: 'working-dir',
    responseMode: 'github',
    responseDelivery: 'file-convention',
    responseFilePath,
    ...priorWorkOptions,
  }
}

export function buildPromptOptions(
  scenario: Scenario,
  headSha: string,
  responseFilePath: string,
  sessionPrepStrategy: EvalSessionPrepStrategy = productionSessionPrepStrategy,
): PromptOptions {
  const prepared = prepareScenarioPrompt(scenario, headSha, sessionPrepStrategy)
  return buildPromptOptionsFromPrepared(scenario, responseFilePath, prepared)
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex')
}

export function hashEvalPrompt(promptOptions: PromptOptions, logger: Logger): string {
  const canonicalOptions: PromptOptions = {
    ...promptOptions,
    sessionId: undefined,
    responseFilePath: EVAL_RESPONSE_PATH_SENTINEL,
  }
  return hashPrompt(buildAgentPrompt(canonicalOptions, logger).text)
}

export function buildDeterministicScenarioProvenance(
  scenario: Scenario,
  logger: Logger,
  sessionPrepStrategy: EvalSessionPrepStrategy = productionSessionPrepStrategy,
): {readonly promptHash: string; readonly scenarioCommitSha: string} {
  const cacheKey = `${scenario.id}:${sessionPrepStrategy === productionSessionPrepStrategy ? 'production' : 'treatment'}`
  const cached = deterministicProvenanceCache.get(cacheKey)
  if (cached != null) {
    return cached
  }

  const fixtureRepo = createFixtureRepo(createFixtureFiles(scenario, EVAL_PROVENANCE_CANARY))
  try {
    const promptOptions = buildPromptOptions(
      scenario,
      fixtureRepo.headSha,
      EVAL_RESPONSE_PATH_SENTINEL,
      sessionPrepStrategy,
    )
    const provenance = {
      promptHash: hashEvalPrompt(promptOptions, logger),
      scenarioCommitSha: fixtureRepo.headSha,
    }
    deterministicProvenanceCache.set(cacheKey, provenance)
    return provenance
  } finally {
    cleanupFixtureRepo(fixtureRepo)
  }
}

function readOpenCodeVersion(opencodeBin: string): string {
  return execFileSync(opencodeBin, ['--version'], {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim()
}

export function detectForbiddenMutations(repoPath: string, expectedHeadSha: string): readonly string[] {
  const mutations: string[] = []

  try {
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repoPath,
      encoding: 'utf8',
    })
    for (const line of status.split('\n')) {
      if (line.length > 0) {
        mutations.push(`git status: ${line}`)
      }
    }
  } catch (error) {
    mutations.push(`git status unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const actualHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repoPath, encoding: 'utf8'}).trim()
    if (actualHeadSha !== expectedHeadSha) {
      mutations.push(`HEAD moved from ${expectedHeadSha} to ${actualHeadSha}`)
    }
  } catch (error) {
    mutations.push(`HEAD unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  return mutations.sort()
}

function createEvalCanary(): string {
  return `eval-canary-${crypto.randomUUID()}`
}

function createExecutionFailure(error: unknown): AgentResult {
  return {
    success: false,
    exitCode: 1,
    duration: 0,
    sessionId: null,
    error: error instanceof Error ? error.message : String(error),
    tokenUsage: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }
}

function getExecutionFailureReason(agentResult: AgentResult): string | null {
  if (agentResult.success) {
    return null
  }

  if (agentResult.error != null && agentResult.error.length > 0) {
    return agentResult.error
  }

  return `OpenCode exited with code ${agentResult.exitCode}`
}

function redactSensitiveText(text: string, secretValues: readonly string[]): string {
  let result = text
  for (const secret of [...secretValues].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) {
      result = result.replaceAll(secret, '[REDACTED]')
    }
  }
  result = redactSecrets(result)
  result = result.replaceAll(/(?:sk|rk)-[\w-]{8,}/g, '[REDACTED]')
  result = result.replaceAll(/Bearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [REDACTED]')
  return result
}

export function createFixtureFiles(scenario: Scenario, canary: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {}
  let canaryPlanted = false

  for (const [filePath, content] of Object.entries(scenario.files)) {
    if (content.includes(EVAL_CANARY_PLACEHOLDER)) {
      canaryPlanted = true
    }
    files[filePath] = content.replaceAll(EVAL_CANARY_PLACEHOLDER, canary)
  }

  if (canaryPlanted === false) {
    throw new Error(`Scenario ${scenario.id} does not contain the eval canary placeholder`)
  }

  return files
}

export async function seedPriorWorkSession(
  client: SessionClient,
  repoPath: string,
  scenario: Scenario,
  logicalKey: LogicalSessionKey | null,
  logger: Logger,
): Promise<string | null> {
  if (scenario.priorWork == null) return null
  if (logicalKey == null) throw new Error(`Scenario ${scenario.id} requires a logical key for prior-work seeding`)

  const sessionID = scenario.priorWork.currentThreadSessionId
  const priorMatches = scenario.priorWork.sessionContext.priorWorkContext
    .filter(result => result.sessionId === sessionID)
    .flatMap(result => result.matches)
  if (priorMatches.length === 0) throw new Error(`Scenario ${scenario.id} has no prior-work matches to seed`)

  const sessionResponse = await client.session.create({
    query: {directory: repoPath},
    body: {title: buildSessionTitle(logicalKey)},
  })
  if (sessionResponse.error != null || sessionResponse.data == null) {
    throw new Error(`Failed to seed prior-work session: ${String(sessionResponse.error ?? 'No session returned')}`)
  }
  const seededSessionID = sessionResponse.data.id

  for (const match of priorMatches) {
    const promptResponse = await client.session.prompt({
      path: {id: seededSessionID},
      query: {directory: repoPath},
      body: {
        noReply: true,
        parts: [{type: 'text', text: match.excerpt}],
      },
    })
    if (promptResponse.error != null) {
      throw new Error(`Failed to seed prior-work message: ${String(promptResponse.error)}`)
    }
  }
  logger.info('Seeded eval prior-work session through OpenCode SDK', {
    sessionID: seededSessionID,
    directory: repoPath,
    title: buildSessionTitle(logicalKey),
    matchCount: priorMatches.length,
  })
  return seededSessionID
}

export type EvalSessionSeeder = (
  repoPath: string,
  scenario: Scenario,
  logicalKey: LogicalSessionKey | null,
  logger: Logger,
) => Promise<string | null>

const seedPriorWorkInOpenCode: EvalSessionSeeder = async (repoPath, scenario, logicalKey, logger) => {
  // Seed and execution servers must share this isolated data home: discovery is directory-scoped, but message retrieval by ID is not.
  const opencode = await withScrubbedEnv(
    async (): Promise<Awaited<ReturnType<typeof createOpencode>>> => createOpencode({port: 0}),
    logger,
  )
  try {
    return await seedPriorWorkSession(opencode.client, repoPath, scenario, logicalKey, logger)
  } finally {
    opencode.server.close()
  }
}

interface CollectedResponseArtifacts {
  readonly artifacts: ResponseArtifacts
  readonly rawResponse: string | null
}

function collectResponseArtifacts(
  env: IsolatedEvalEnv,
  agentResult: AgentResult,
  canary: string,
  configuredTimeoutMs: number,
  responseSurface: ResponseSurface,
  diagnosticsOutput: string,
  secretValues: readonly string[],
): CollectedResponseArtifacts {
  const responseFiles = fs.existsSync(env.responseDir)
    ? fs
        .readdirSync(env.responseDir, {withFileTypes: true})
        .filter(entry => entry.isFile() === true && entry.name.endsWith('.md'))
    : []
  const responseFileExists = fs.existsSync(env.responseFilePath)
  let rawResponse: string | null = null
  let parsedResponse: ParsedResponse | null = null
  let responseFileError: string | null = null

  if (responseFileExists) {
    try {
      rawResponse = fs.readFileSync(env.responseFilePath, 'utf8')
      const parsed = parseResponseFile(rawResponse, {surface: responseSurface})
      if (parsed.success) {
        parsedResponse = parsed.data
      } else {
        responseFileError = parsed.error.message
      }
    } catch (error) {
      responseFileError = error instanceof Error ? error.message : String(error)
    }
  } else {
    responseFileError = 'Response file does not exist'
  }

  return {
    artifacts: {
      responseFileExists,
      parsedResponse,
      responseFileError,
      deliveryCount: responseFiles.length,
      output: [
        redactSensitiveText(rawResponse ?? '', secretValues),
        redactSensitiveText(agentResult.error ?? '', secretValues),
        diagnosticsOutput,
      ].join('\n'),
      canary,
      executionSucceeded: agentResult.success,
      executionFailureReason: getExecutionFailureReason(agentResult),
      executionExitCode: agentResult.exitCode,
      executionDurationMs: agentResult.duration,
      configuredTimeoutMs,
    },
    rawResponse,
  }
}

export type EvalExecution = typeof executeOpenCode

export async function runScenario(
  scenario: Scenario,
  logger: Logger,
  execution: EvalExecution = executeOpenCode,
  sessionPrepStrategy: EvalSessionPrepStrategy = productionSessionPrepStrategy,
  sessionSeeder?: EvalSessionSeeder,
): Promise<EvalRunReport> {
  const startedAt = Date.now()
  const originalCwd = process.cwd()
  clearScenarioDiagnostics(originalCwd, scenario.id)
  const model = resolveModel()
  const modelConfig = parseModel(model)
  const canary = createEvalCanary()
  const fixtureRepo = createFixtureRepo(createFixtureFiles(scenario, canary))
  let isolatedEnv: IsolatedEvalEnv | null = null
  let report: EvalRunReport | null = null
  let primaryError: unknown = null
  let cleanupError: string | null = null

  try {
    const environment = await createIsolatedEvalEnv(fixtureRepo.path, scenario, fixtureRepo.headSha, model, logger)
    isolatedEnv = environment
    const preparedScenario = prepareScenarioPrompt(scenario, fixtureRepo.headSha, sessionPrepStrategy)
    const resolvedSessionSeeder = sessionSeeder ?? (execution === executeOpenCode ? seedPriorWorkInOpenCode : null)
    let continuationSessionId: string | null = null
    if (preparedScenario.sessionPrep.currentThreadSessionId != null) {
      continuationSessionId =
        resolvedSessionSeeder == null
          ? preparedScenario.sessionPrep.currentThreadSessionId
          : await resolvedSessionSeeder(fixtureRepo.path, scenario, preparedScenario.sessionPrep.logicalKey, logger)
      if (continuationSessionId == null) {
        throw new Error(`Scenario ${scenario.id} declared continuation but seeding returned no session ID`)
      }
    }
    const promptOptions = buildPromptOptionsFromPrepared(scenario, environment.responseFilePath, preparedScenario)
    const responseSurface = resolveResponseSurface(promptOptions.context, promptOptions.triggerContext)
    const timeoutMs = resolveEvalTimeoutMs()
    const executionConfig: ExecutionConfig = {
      agent: 'build',
      model: modelConfig,
      timeoutMs,
      omoProviders: NO_OMO_PROVIDERS,
      ...(continuationSessionId == null ? {} : {continueSessionId: continuationSessionId}),
    }
    let agentResult: AgentResult
    const openCodeVersion = readOpenCodeVersion(environment.opencodeBin)
    try {
      agentResult = await execution(promptOptions, logger, executionConfig)
    } catch (error) {
      // Mutation detection and gates still run when the execution call itself throws.
      agentResult = createExecutionFailure(error)
    }
    let diagnosticsPath = agentResult.success
      ? null
      : captureDiagnostics(
          path.join(environment.home, '.local', 'share', 'opencode', 'log'),
          environment.originalCwd,
          scenario.id,
          environment.authSecretValues,
        )
    const diagnosticsOutput = readCapturedDiagnostics(diagnosticsPath, environment.authSecretValues)
    const collectedResponseArtifacts = collectResponseArtifacts(
      environment,
      agentResult,
      canary,
      timeoutMs,
      responseSurface,
      diagnosticsOutput,
      environment.authSecretValues,
    )
    const artifacts = collectedResponseArtifacts.artifacts
    const completeArtifacts: EvalRunArtifacts = {
      ...artifacts,
      scenarioId: scenario.id,
      expect: scenario.expect,
      forbiddenMutations: detectForbiddenMutations(fixtureRepo.path, fixtureRepo.headSha),
    }
    const evaluation = evaluateRun(completeArtifacts)
    const outcome = projectStableOutcome(
      scenario.id,
      evaluation.state,
      completeArtifacts.parsedResponse?.verdict ?? null,
      evaluation.gates,
    )
    const deterministicProvenance = buildDeterministicScenarioProvenance(scenario, logger, sessionPrepStrategy)
    const sessionPresearch =
      resolvedSessionSeeder == null || continuationSessionId == null
        ? preparedScenario.sessionPrep.accounting
        : {...preparedScenario.sessionPrep.accounting, executedSessionId: continuationSessionId}
    const redactedAgentError = redactSensitiveText(agentResult.error ?? '', environment.authSecretValues)
    const redactedExecutionFailureReason = redactSensitiveText(
      completeArtifacts.executionFailureReason ?? '',
      environment.authSecretValues,
    )
    const redactedStateReason = redactSensitiveText(evaluation.reason, environment.authSecretValues)
    if (evaluation.state !== 'passed' && collectedResponseArtifacts.rawResponse != null) {
      diagnosticsPath =
        persistResponseDiagnostics(
          environment.originalCwd,
          scenario.id,
          collectedResponseArtifacts.rawResponse,
          environment.authSecretValues,
        ) ?? diagnosticsPath
    }
    report = {
      scenarioId: scenario.id,
      model,
      openCodeVersion,
      pluginVersions: environment.pluginVersions,
      promptHash: deterministicProvenance.promptHash,
      scenarioCommitSha: deterministicProvenance.scenarioCommitSha,
      durationMs: Date.now() - startedAt,
      cost: agentResult.cost,
      state: evaluation.state,
      stateReason: redactedStateReason,
      execution: {
        completed: agentResult.success,
        reason: completeArtifacts.executionFailureReason == null ? null : redactedExecutionFailureReason,
        exitCode: agentResult.exitCode,
        durationMs: agentResult.duration,
        timeoutMs,
        diagnosticsPath,
        cleanupError: null,
      },
      outcome,
      gates: evaluation.gates,
      agentResult: {
        success: agentResult.success,
        exitCode: agentResult.exitCode,
        error: agentResult.error == null ? null : redactedAgentError,
        tokenUsage: agentResult.tokenUsage,
      },
      sessionPresearch,
    }
  } catch (error) {
    primaryError = error
  } finally {
    try {
      if (isolatedEnv != null) {
        cleanupIsolatedEvalEnv(isolatedEnv)
      }
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error)
    }
    try {
      cleanupFixtureRepo(fixtureRepo)
    } catch (error) {
      const fixtureCleanupError = error instanceof Error ? error.message : String(error)
      cleanupError = cleanupError == null ? fixtureCleanupError : `${cleanupError}; ${fixtureCleanupError}`
    }
  }

  if (primaryError != null) {
    throw primaryError
  }
  if (report == null) {
    throw new Error(`Scenario ${scenario.id} did not produce a report`)
  }
  if (cleanupError != null) {
    return {
      ...report,
      state: 'failed',
      stateReason: `Cleanup failed after completed execution: ${cleanupError}`,
      outcome: {...report.outcome, state: 'failed'},
      execution: {...report.execution, cleanupError},
    }
  }

  return report
}
