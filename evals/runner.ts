import type {ParsedResponse} from '../packages/runtime/src/agent/response-file.js'
import type {TriggerContext} from '../packages/runtime/src/agent/types.js'
import type {OmoProviders} from '../packages/runtime/src/shared/types.js'
import type {AgentResult, ExecutionConfig, PromptOptions} from '../src/features/agent/types.js'
import type {GitHubContext} from '../src/services/github/types.js'
import type {Logger} from '../src/shared/logger.js'
import type {EvalRunArtifacts, EvalRunReport, ResponseArtifacts, Scenario} from './types.js'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {buildResponseFilePath, parseResponseFile} from '../packages/runtime/src/agent/response-file.js'
import {buildAgentPrompt, executeOpenCode} from '../src/features/agent/index.js'
import {buildTriggerContext} from '../src/features/triggers/context-builders.js'
import {normalizeEvent} from '../src/services/github/context.js'
import {cleanupFixtureRepo, createFixtureRepo} from './fixture-repo.js'
import {evaluateRun} from './gates.js'

const DEFAULT_EVAL_MODEL = 'opencode/big-pickle'
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

function resolveEvalTimeoutMs(): number {
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
}

const EVAL_SECRET_PLACEHOLDER = 'FRO_BOT_EVAL_SECRET_PLACEHOLDER'

function resolveBunBinary(): string {
  const realHome = os.homedir()
  const misePaths = [
    path.join(realHome, '.local', 'share', 'mise', 'installs', 'bun', '1.3.14', 'bin', 'bun'),
    path.join(realHome, '.local', 'share', 'mise', 'installs', 'bun', '1.3', 'bin', 'bun'),
    path.join(realHome, '.local', 'share', 'mise', 'installs', 'bun', 'latest', 'bin', 'bun'),
  ]

  for (const candidate of misePaths) {
    if (fs.existsSync(candidate)) {
      try {
        const version = execFileSync(candidate, ['--version'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
        if (version.length > 0) return candidate
      } catch {
        // Try the next known installation.
      }
    }
  }

  try {
    return execFileSync('which', ['bun'], {encoding: 'utf8'}).trim()
  } catch {
    throw new Error('Cannot find bun binary for the eval OpenCode wrapper')
  }
}

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
  restoreEnv(env.originalEnv)
  fs.rmSync(env.home, {recursive: true, force: true})
  fs.rmSync(env.runnerTemp, {recursive: true, force: true})
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

  fs.mkdirSync(binDir, {recursive: true})
  fs.mkdirSync(configDir, {recursive: true})
  fs.mkdirSync(responseDir, {recursive: true})

  const bunBinary = resolveBunBinary()
  const opencodeBin = path.join(binDir, 'opencode')
  fs.writeFileSync(opencodeBin, `#!/bin/sh\nexec "${bunBinary}" x opencode-ai@1.17.20 "$@"\n`, {mode: 0o755})
  fs.writeFileSync(
    path.join(configDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model,
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
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_RUN_ID = runId
  process.env.GITHUB_RUN_ATTEMPT = runAttempt
  process.env.GITHUB_ACTOR = 'fro-bot-eval'
  process.env.RUNNER_TEMP = runnerTemp
  process.env.CI = '1'
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN

  return {home, runnerTemp, responseDir, responseFilePath, opencodeBin, originalEnv}
}

function parseModel(model: string): {readonly providerID: string; readonly modelID: string} {
  const parts = model.split('/')
  const providerID = parts[0]
  const modelID = parts[1]
  if (parts.length !== 2 || providerID == null || modelID == null || providerID.length === 0 || modelID.length === 0) {
    throw new Error(`FRO_BOT_EVAL_MODEL must use provider/model format, got: ${model}`)
  }

  return {providerID, modelID}
}

function resolveModel(): string {
  const configuredModel = process.env.FRO_BOT_EVAL_MODEL
  if (configuredModel == null || configuredModel.trim().length === 0) {
    return DEFAULT_EVAL_MODEL
  }
  return configuredModel.trim()
}

function buildDiffContext(scenario: Scenario) {
  return {
    changedFiles: scenario.diffFiles.length,
    additions: scenario.diffFiles.reduce((total, file) => total + file.additions, 0),
    deletions: scenario.diffFiles.reduce((total, file) => total + file.deletions, 0),
    truncated: false,
    files: scenario.diffFiles,
  }
}

function buildTriggerContextForScenario(scenario: Scenario, headSha: string): TriggerContext {
  const event = normalizeEvent('pull_request', scenario.event)
  const githubContext: GitHubContext = {
    eventName: 'pull_request',
    eventType: 'pull_request',
    repo: {owner: 'fro-bot-eval', repo: scenario.id},
    ref: 'refs/heads/main',
    sha: headSha,
    runId: 1,
    actor: 'fro-bot-eval',
    payload: scenario.event,
    event,
  }

  return buildTriggerContext(githubContext, null, null)
}

function buildPromptOptions(scenario: Scenario, headSha: string, responseFilePath: string): PromptOptions {
  const triggerContext = buildTriggerContextForScenario(scenario, headSha)
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
      diffContext: buildDiffContext(scenario),
      hydratedContext: null,
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

function createEvalSecret(): string {
  return `ghp_${crypto.randomBytes(24).toString('hex')}`
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

function createFixtureFiles(scenario: Scenario, secret: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {}
  let secretPlanted = false

  for (const [filePath, content] of Object.entries(scenario.files)) {
    if (content.includes(EVAL_SECRET_PLACEHOLDER)) {
      secretPlanted = true
    }
    files[filePath] = content.replaceAll(EVAL_SECRET_PLACEHOLDER, secret)
  }

  if (secretPlanted === false) {
    throw new Error(`Scenario ${scenario.id} does not contain the eval secret placeholder`)
  }

  return files
}

function collectResponseArtifacts(
  env: IsolatedEvalEnv,
  agentResult: AgentResult,
  secret: string,
  configuredTimeoutMs: number,
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
      const parsed = parseResponseFile(rawResponse, {surface: 'pr-review'})
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
    output: [rawResponse ?? '', agentResult.error ?? ''].join('\n'),
    secret,
    executionSucceeded: agentResult.success,
    executionFailureReason: getExecutionFailureReason(agentResult),
    executionExitCode: agentResult.exitCode,
    executionDurationMs: agentResult.duration,
    configuredTimeoutMs,
  }
}

export async function runScenario(scenario: Scenario, logger: Logger): Promise<EvalRunReport> {
  const startedAt = Date.now()
  const model = resolveModel()
  const modelConfig = parseModel(model)
  const secret = createEvalSecret()
  const fixtureRepo = createFixtureRepo(createFixtureFiles(scenario, secret))
  const isolatedEnv = createIsolatedEvalEnv(fixtureRepo.path, scenario, fixtureRepo.headSha, model)
  const promptOptions = buildPromptOptions(scenario, fixtureRepo.headSha, isolatedEnv.responseFilePath)
  const timeoutMs = resolveEvalTimeoutMs()
  const executionConfig: ExecutionConfig = {
    agent: 'build',
    model: modelConfig,
    timeoutMs,
    omoProviders: NO_OMO_PROVIDERS,
  }
  let agentResult: AgentResult
  let openCodeVersion = 'unknown'

  try {
    openCodeVersion = readOpenCodeVersion(isolatedEnv.opencodeBin)
    try {
      agentResult = await executeOpenCode(promptOptions, logger, executionConfig)
    } catch (error) {
      // Mutation detection and gates still run when the execution call itself throws.
      agentResult = createExecutionFailure(error)
    }
    const artifacts = collectResponseArtifacts(isolatedEnv, agentResult, secret, timeoutMs)
    const completeArtifacts: EvalRunArtifacts = {
      ...artifacts,
      scenarioId: scenario.id,
      expectedVerdict: scenario.expectedVerdict,
      expectedDefectFile: scenario.expectedDefectFile,
      forbiddenMutations: detectForbiddenMutations(fixtureRepo.path, fixtureRepo.headSha),
    }
    const promptResult = buildAgentPrompt({...promptOptions, sessionId: agentResult.sessionId ?? undefined}, logger)
    const evaluation = evaluateRun(completeArtifacts)

    return {
      scenarioId: scenario.id,
      model,
      openCodeVersion,
      pluginVersions: [],
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
    cleanupIsolatedEvalEnv(isolatedEnv)
    cleanupFixtureRepo(fixtureRepo)
  }
}
