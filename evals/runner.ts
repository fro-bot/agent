import type {DiffFileSummary} from '../packages/runtime/src/agent/index.js'
import type {ParsedResponse, ResponseSurface} from '../packages/runtime/src/agent/response-file.js'
import type {TriggerContext} from '../packages/runtime/src/agent/types.js'
import type {OmoProviders} from '../packages/runtime/src/shared/types.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from '../src/features/agent/types.js'
import type {GitHubContext} from '../src/services/github/types.js'
import type {Logger} from '../src/shared/logger.js'
import type {EvalRunArtifacts, EvalRunReport, ResponseArtifacts, Scenario} from './types.js'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {buildResponseFilePath, parseResponseFile} from '../packages/runtime/src/agent/response-file.js'
import {buildAgentPrompt, executeOpenCode} from '../src/features/agent/index.js'
import {resolveResponseSurface} from '../src/features/agent/response-file.js'
import {buildTriggerContext} from '../src/features/triggers/context-builders.js'
import {normalizeEvent} from '../src/services/github/context.js'
import {cleanupFixtureRepo, createFixtureRepo} from './fixture-repo.js'
import {evaluateRun} from './gates.js'

const DEFAULT_EVAL_MODEL = 'opencode/big-pickle'

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
  try {
    restoreEnv(env.originalEnv)
  } finally {
    try {
      // Restore the working directory before removing anything: the process may still be inside
      // a directory that is about to be deleted.
      process.chdir(env.originalCwd)
    } finally {
      fs.rmSync(env.home, {recursive: true, force: true})
      fs.rmSync(env.runnerTemp, {recursive: true, force: true})
    }
  }
}

/**
 * Copy the agent's own logs out of the isolated home before cleanup destroys them.
 *
 * Without this, a run that fails to complete reports only an exit code and a timeout
 * message, so there is no way to tell a slow model from one that never issued a request.
 * That is precisely the run where evidence matters most.
 *
 * Copies only the log directory. The isolated `auth.json` sits beside it and must never be
 * captured into a diagnostics artifact.
 */
function captureDiagnostics(env: IsolatedEvalEnv, scenarioId: string): string | null {
  const sourceLogDir = path.join(env.home, '.local', 'share', 'opencode', 'log')
  if (fs.existsSync(sourceLogDir) === false) {
    return null
  }

  try {
    const targetDir = path.join(env.originalCwd, 'evals', 'output', 'diagnostics', scenarioId)
    fs.rmSync(targetDir, {recursive: true, force: true})
    fs.mkdirSync(targetDir, {recursive: true})
    fs.cpSync(sourceLogDir, targetDir, {recursive: true})
    return targetDir
  } catch {
    return null
  }
}

const MAX_DIAGNOSTIC_SCAN_BYTES = 65_536

function readBoundedDiagnosticFile(
  filePath: string,
  maxBytes: number,
): {readonly text: string; readonly bytesRead: number} {
  if (maxBytes === 0) {
    return {text: '', bytesRead: 0}
  }

  let fileDescriptor: number | null = null
  try {
    // Open first, then size the file through that same descriptor. Sizing by path and then
    // opening by path leaves a window where the entry can be swapped between the two calls,
    // and these logs are written by the agent under test. `O_NOFOLLOW` additionally refuses
    // a symlink outright rather than following it somewhere unintended.
    fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const bytesToRead = Math.min(fs.fstatSync(fileDescriptor).size, maxBytes)
    if (bytesToRead === 0) {
      return {text: '', bytesRead: 0}
    }
    const buffer = Buffer.alloc(bytesToRead)
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, bytesToRead, 0)
    return {text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead}
  } catch {
    return {text: '', bytesRead: 0}
  } finally {
    if (fileDescriptor != null) {
      try {
        fs.closeSync(fileDescriptor)
      } catch {
        // Diagnostics are fail-soft and must never change the eval result by throwing here.
      }
    }
  }
}

function readCapturedDiagnostics(diagnosticsPath: string | null): string {
  if (diagnosticsPath == null) {
    return ''
  }

  const chunks: string[] = []
  let remainingBytes = MAX_DIAGNOSTIC_SCAN_BYTES
  const visit = (directory: string): void => {
    if (remainingBytes === 0) {
      return
    }

    let entries: readonly fs.Dirent[]
    try {
      entries = fs
        .readdirSync(directory, {withFileTypes: true})
        .sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      return
    }

    for (const entry of entries) {
      if (remainingBytes === 0) {
        return
      }
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile()) {
        const result = readBoundedDiagnosticFile(entryPath, remainingBytes)
        if (result.bytesRead > 0) {
          chunks.push(result.text)
          remainingBytes -= result.bytesRead
        }
      }
    }
  }

  visit(diagnosticsPath)
  return chunks.join('\n')
}

function createIsolatedEvalEnv(repoPath: string, scenario: Scenario, headSha: string, model: string): IsolatedEvalEnv {
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
    provisionProviderAuth(dataDir, model, originalEnv)

    const opencodeBin = path.join(binDir, 'opencode')
    fs.writeFileSync(opencodeBin, `#!/bin/sh\nexec "${resolveHarnessBinary()}" "$@"\n`, {mode: 0o755})
    const authPlugin = PROVIDER_AUTH_PLUGINS[parseModel(model).providerID]
    fs.writeFileSync(
      path.join(configDir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model,
          ...(authPlugin == null ? {} : {plugin: [authPlugin]}),
          permission: {
            bash: 'allow',
            edit: 'allow',
            read: 'allow',
            webfetch: 'deny',
            external_directory: {[`${responseDir}/**`]: 'allow'},
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

    return {home, runnerTemp, responseDir, responseFilePath, opencodeBin, originalEnv, originalCwd}
  } catch (error) {
    const partialEnv: IsolatedEvalEnv = {
      home,
      runnerTemp,
      responseDir,
      responseFilePath,
      opencodeBin: path.join(binDir, 'opencode'),
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
function provisionProviderAuth(dataDir: string, model: string, originalEnv: Record<string, string | undefined>): void {
  const {providerID} = parseModel(model)
  const hostDataDir = originalEnv.XDG_DATA_HOME ?? path.join(originalEnv.HOME ?? os.homedir(), '.local', 'share')
  const hostAuthPath = path.join(hostDataDir, 'opencode', 'auth.json')

  if (fs.existsSync(hostAuthPath) === false) {
    if (providerID === CREDENTIAL_FREE_PROVIDER) return
    throw new Error(
      `Model ${model} requires provider credentials but no auth.json was found at ${hostAuthPath}. ` +
        `Use the credential-free default model, or authenticate that provider first.`,
    )
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(hostAuthPath, 'utf8'))
  const entry =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[providerID] : undefined

  if (entry === undefined) {
    if (providerID === CREDENTIAL_FREE_PROVIDER) return
    throw new Error(
      `Model ${model} requires a '${providerID}' credential but ${hostAuthPath} has no such entry. ` +
        `Authenticate that provider first, or use the credential-free default model.`,
    )
  }

  const isolatedAuthDir = path.join(dataDir, 'opencode')
  fs.mkdirSync(isolatedAuthDir, {recursive: true})
  fs.writeFileSync(path.join(isolatedAuthDir, 'auth.json'), JSON.stringify({[providerID]: entry}), {mode: 0o600})
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

export function buildPromptOptions(scenario: Scenario, headSha: string, responseFilePath: string): PromptOptions {
  const scenarioInput = buildScenarioInput(scenario)
  const triggerContext = buildTriggerContextForScenario(scenario, headSha, scenarioInput)
  const target = triggerContext.target
  const author = triggerContext.author

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
  }
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex')
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

function collectResponseArtifacts(
  env: IsolatedEvalEnv,
  agentResult: AgentResult,
  canary: string,
  configuredTimeoutMs: number,
  responseSurface: ResponseSurface,
  diagnosticsOutput: string,
): ResponseArtifacts {
  const responseFiles = fs.existsSync(env.responseDir)
    ? fs
        .readdirSync(env.responseDir, {withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
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
    responseFileExists,
    parsedResponse,
    responseFileError,
    deliveryCount: responseFiles.length,
    output: [rawResponse ?? '', agentResult.error ?? '', diagnosticsOutput].join('\n'),
    canary,
    executionSucceeded: agentResult.success,
    executionFailureReason: getExecutionFailureReason(agentResult),
    executionExitCode: agentResult.exitCode,
    executionDurationMs: agentResult.duration,
    configuredTimeoutMs,
  }
}

export type EvalExecution = typeof executeOpenCode

export async function runScenario(
  scenario: Scenario,
  logger: Logger,
  execution: EvalExecution = executeOpenCode,
): Promise<EvalRunReport> {
  const startedAt = Date.now()
  const model = resolveModel()
  const modelConfig = parseModel(model)
  const canary = createEvalCanary()
  const fixtureRepo = createFixtureRepo(createFixtureFiles(scenario, canary))
  let isolatedEnv: IsolatedEvalEnv | null = null

  try {
    const environment = createIsolatedEvalEnv(fixtureRepo.path, scenario, fixtureRepo.headSha, model)
    isolatedEnv = environment
    const promptOptions = buildPromptOptions(scenario, fixtureRepo.headSha, environment.responseFilePath)
    const responseSurface = resolveResponseSurface(promptOptions.context, promptOptions.triggerContext)
    const timeoutMs = resolveEvalTimeoutMs()
    const executionConfig: ExecutionConfig = {
      agent: 'build',
      model: modelConfig,
      timeoutMs,
      omoProviders: NO_OMO_PROVIDERS,
    }
    let agentResult: AgentResult
    const openCodeVersion = readOpenCodeVersion(environment.opencodeBin)
    try {
      agentResult = await execution(promptOptions, logger, executionConfig)
    } catch (error) {
      // Mutation detection and gates still run when the execution call itself throws.
      agentResult = createExecutionFailure(error)
    }
    const diagnosticsPath = agentResult.success ? null : captureDiagnostics(environment, scenario.id)
    const diagnosticsOutput = readCapturedDiagnostics(diagnosticsPath)
    const artifacts = collectResponseArtifacts(
      environment,
      agentResult,
      canary,
      timeoutMs,
      responseSurface,
      diagnosticsOutput,
    )
    const completeArtifacts: EvalRunArtifacts = {
      ...artifacts,
      scenarioId: scenario.id,
      expect: scenario.expect,
      forbiddenMutations: detectForbiddenMutations(fixtureRepo.path, fixtureRepo.headSha),
    }
    const promptResult = buildAgentPrompt({...promptOptions, sessionId: agentResult.sessionId ?? undefined}, logger)
    const evaluation = evaluateRun(completeArtifacts)
    return {
      scenarioId: scenario.id,
      model,
      openCodeVersion,
      promptHash: hashPrompt(promptResult.text),
      scenarioCommitSha: fixtureRepo.headSha,
      durationMs: Date.now() - startedAt,
      cost: agentResult.cost,
      state: evaluation.state,
      stateReason: evaluation.reason,
      execution: {
        completed: agentResult.success,
        reason: completeArtifacts.executionFailureReason,
        exitCode: agentResult.exitCode,
        durationMs: agentResult.duration,
        timeoutMs,
        diagnosticsPath,
      },
      gates: evaluation.gates,
      agentResult: {
        success: agentResult.success,
        exitCode: agentResult.exitCode,
        error: agentResult.error,
        tokenUsage: agentResult.tokenUsage,
      },
    }
  } finally {
    try {
      if (isolatedEnv != null) {
        cleanupIsolatedEvalEnv(isolatedEnv)
      }
    } finally {
      cleanupFixtureRepo(fixtureRepo)
    }
  }
}
