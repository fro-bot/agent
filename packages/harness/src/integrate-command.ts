/**
 * integrate-command.ts — `harness integrate` subcommand implementation.
 *
 * Reads harness.config.json for: baseVersion, releaseRepo, integrationRefs,
 * agent, model, opencodeBin. Parses deterministic driver flags from argv.
 * Assembles IntegrationConfig, runs the local integration, packages the artifact,
 * then calls the explicit finalize/push boundary.
 *
 * On {ok:true}: packages a clean merged source snapshot (via git archive) plus
 * provenance.json into a single artifact at --out using atomic staging.
 *
 * Exit codes: 0 on {ok:true} + artifact written, 1 on {ok:false} or exception.
 * Error output: one-line message only — no stack traces, no secrets.
 *
 * No classes; functions only; explicit boolean checks; no as-any.
 */

import type {
  FinalTreeExpectation,
  IntegrationAdapters,
  IntegrationConfig,
  IntegrationResult,
  IntegrationStage,
  TrustedPushRepository,
} from './integrate.js'
import type {CarryManifest} from './sources.js'
import {execFileSync, execSync} from 'node:child_process'
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {formatPipelineError} from './format-error.js'
import {buildIntegrationOutcomeFile, writeIntegrationOutcomeFile} from './forward-shadow.js'
import {makeRealAdapters, runIntegration, writeProvenanceManifest} from './integrate.js'
import {resolveSources} from './sources.js'

// ---------------------------------------------------------------------------
// Config file shape
// ---------------------------------------------------------------------------

interface HarnessConfig {
  readonly release_repo: string
  readonly source_repo?: string
  readonly base_version: string
  readonly integrationRefs: readonly string[]
  readonly agent?: string
  readonly model?: string
  readonly opencode_bin?: string
}

function isValidHarnessConfig(value: unknown): value is HarnessConfig {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.release_repo !== 'string' || v.release_repo.length === 0) return false
  if (v.source_repo !== undefined && (typeof v.source_repo !== 'string' || v.source_repo.length === 0)) return false
  if (typeof v.base_version !== 'string' || v.base_version.length === 0) return false
  if (!Array.isArray(v.integrationRefs)) return false
  if (!v.integrationRefs.every((el: unknown) => typeof el === 'string' && el.length > 0)) return false
  if (v.agent !== undefined && (typeof v.agent !== 'string' || v.agent.length === 0)) return false
  if (v.model !== undefined && (typeof v.model !== 'string' || v.model.length === 0)) return false
  if (v.opencode_bin !== undefined && typeof v.opencode_bin !== 'string') return false
  return true
}

// ---------------------------------------------------------------------------
// Default config path (relative to this file's package root)
// ---------------------------------------------------------------------------

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_PATH = path.join(packageRoot, 'harness.config.json')

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface ParsedFlags {
  readonly baseVersion: string | undefined
  readonly workDir: string | undefined
  readonly promptPath: string | undefined
  readonly out: string | undefined
  readonly resultOut: string | undefined
  readonly dryRun: boolean | undefined
  readonly candidate: boolean
  readonly pushRepo: string | undefined
  readonly pushRef: string | undefined
}

export function isValidBaseVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(value)
}

function parseFlags(argv: readonly string[]): ParsedFlags | null {
  let baseVersion: string | undefined
  let workDir: string | undefined
  let promptPath: string | undefined
  let out: string | undefined
  let resultOut: string | undefined
  let dryRun: boolean | undefined
  let candidate = false
  let pushRepo: string | undefined
  let pushRef: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--candidate') {
      candidate = true
      continue
    }
    if (
      arg === '--work-dir' ||
      arg === '--base-version' ||
      arg === '--prompt-path' ||
      arg === '--out' ||
      arg === '--result-out' ||
      arg === '--push-repo' ||
      arg === '--push-ref'
    ) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        console.error(`[integrate] ${arg} requires a value`)
        return null
      }
      if (arg === '--base-version') {
        baseVersion = next
      } else if (arg === '--work-dir') {
        workDir = next
      } else if (arg === '--prompt-path') {
        promptPath = next
      } else if (arg === '--push-repo') {
        pushRepo = next
      } else if (arg === '--push-ref') {
        pushRef = next
      } else if (arg === '--result-out') {
        resultOut = next
      } else {
        out = next
      }
      i++
    }
  }

  return {baseVersion, workDir, promptPath, out, resultOut, dryRun, candidate, pushRepo, pushRef}
}

// ---------------------------------------------------------------------------
// Artifact packaging
// ---------------------------------------------------------------------------

/**
 * Packages a clean merged source snapshot plus provenance.json into a single
 * tar artifact at outPath using atomic staging.
 *
 * Steps:
 *   1. Create a temp staging dir.
 *   2. Run `git archive --format=tar --output=<tmp>/source.tar <integrationCommit>` in workDir.
 *   3. Extract source.tar into <tmp>/tree, copy provenance.json into <tmp>/tree.
 *   4. Re-tar <tmp>/tree → <tmp>/artifact.tar.
 *   5. Ensure outPath parent dir exists, then atomically rename <tmp>/artifact.tar → outPath.
 *   6. Clean the temp dir in a finally block.
 *
 * ATOMIC: the rename only happens after the artifact is fully built. Any error
 * before the rename leaves outPath untouched.
 *
 * @param workDir           - The integration work directory (contains the git repo + provenance.json).
 * @param integrationCommit - The commit SHA to archive (the frozen integration commit).
 * @param outPath           - Destination path for the final artifact tar.
 */
export async function packageArtifact(workDir: string, integrationCommit: string, outPath: string): Promise<void> {
  // Belt-and-suspenders guard: fail loudly if the working tree has uncommitted tracked changes.
  // After FIX 1 commits the merge, tracked changes should always be committed.
  // Untracked files (e.g. provenance.json written by the harness) are intentionally excluded
  // from this check — they are copied into the artifact separately.
  // `git status --porcelain` lines starting with '??' are untracked; we only care about the rest.
  const statusOutput = execSync('git status --porcelain', {cwd: workDir, encoding: 'utf8'})
  const trackedDirtyLines = statusOutput.split('\n').filter(line => line.length > 0 && !line.startsWith('??'))
  if (trackedDirtyLines.length > 0) {
    throw new Error(
      `[integrate] Working tree has uncommitted tracked changes before git archive — these would be excluded from the artifact:\n${trackedDirtyLines.join('\n')}`,
    )
  }

  const tmpStaging = mkdtempSync(path.join(os.tmpdir(), 'harness-artifact-'))
  try {
    const sourceTar = path.join(tmpStaging, 'source.tar')
    const treeDir = path.join(tmpStaging, 'tree')
    const artifactTar = path.join(tmpStaging, 'artifact.tar')

    // Step 2: Extract the clean merged source tree from the integration commit.
    execFileSync('git', ['archive', '--format=tar', `--output=${sourceTar}`, integrationCommit], {
      cwd: workDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    // Step 3a: Extract source.tar into tree dir.
    mkdirSync(treeDir, {recursive: true})
    execFileSync('tar', ['xf', sourceTar, '-C', treeDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    // Step 3b: Copy provenance.json from workDir into the tree.
    copyFileSync(path.join(workDir, 'provenance.json'), path.join(treeDir, 'provenance.json'))

    // Step 4: Re-tar the tree (with provenance.json included) into artifact.tar.
    execFileSync('tar', ['cf', artifactTar, '-C', treeDir, '.'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    // Step 5: Ensure outPath parent exists, then atomically promote the artifact.
    mkdirSync(path.dirname(outPath), {recursive: true})
    renameSync(artifactTar, outPath)
  } finally {
    // Always clean the temp dir, even on error. Ignore cleanup failures.
    try {
      rmSync(tmpStaging, {recursive: true, force: true})
    } catch {
      // Intentionally swallowed — cleanup failure must not mask the real error.
    }
  }
}

const artifactCompletion = Symbol('artifact-completion')
type ArtifactCompletion = typeof artifactCompletion

export interface IntegrateLogger {
  readonly warning: (message: string, context?: Readonly<Record<string, unknown>>) => void
}

const silentIntegrateLogger: IntegrateLogger = {
  warning: () => {},
}

function integrationFailure(stage: IntegrationStage, error: unknown): IntegrationResult {
  return {ok: false, kind: 'failure', stage, error: formatPipelineError(error)}
}

function treeExpectationFor(config: IntegrationConfig, integrationCommit: string): FinalTreeExpectation {
  const squashed = config.integrationRefs.length > 0
  return {
    baseTag: `v${config.baseVersion}`,
    integrationCommit,
    squashed,
    workflowsStripped: squashed,
  }
}

function assertPushTarget(
  target: IntegrationConfig['pushTarget'],
): asserts target is NonNullable<IntegrationConfig['pushTarget']> {
  if (target === undefined) throw new Error('push target is required for a non-dry-run integration')
  if (target.repository.trim().length === 0) throw new Error('push target repository is empty')
  if (target.ref.trim().length === 0) throw new Error('push target ref is empty')
  const url = new URL(target.repository)
  if (url.protocol !== 'https:') throw new Error('push target must use anonymous-source-compatible HTTPS')
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('push target must not contain URL credentials')
  }
}

async function finalizeLocalIntegration(
  config: IntegrationConfig,
  adapters: IntegrationAdapters,
  result: IntegrationResult,
  completion: ArtifactCompletion,
  logger: IntegrateLogger,
  preparedTrustedRepository?: TrustedPushRepository,
): Promise<IntegrationResult> {
  if (completion !== artifactCompletion) return integrationFailure('provenance', 'artifact completion proof is invalid')
  if (result.ok !== true) return result

  const {manifest} = result
  const integrationCommit = manifest.integrationCommit
  const expectation = treeExpectationFor(config, integrationCommit)
  const dryRun = config.dryRun === true || (config.dryRun === undefined && config.pushTarget === undefined)

  if (dryRun) {
    if (preparedTrustedRepository !== undefined) await preparedTrustedRepository.cleanup()
    return {ok: true, manifest, dryRun: true, pushed: false}
  }

  try {
    // Candidate finalization has already materialized the frozen authority; the
    // code-owned path still validates its original integration checkout here.
    const validationWorkDir = preparedTrustedRepository?.workDir ?? config.workDir
    const currentCommit = await adapters.getCommitSha(validationWorkDir)
    if (currentCommit !== integrationCommit) {
      throw new Error(`integration HEAD drifted: expected frozen commit ${integrationCommit}, found ${currentCommit}`)
    }
    await adapters.validateFinalTree(validationWorkDir, expectation)
    const finalCommit = await adapters.getCommitSha(validationWorkDir)
    if (finalCommit !== integrationCommit) {
      throw new Error(`integration HEAD drifted: expected frozen commit ${integrationCommit}, found ${finalCommit}`)
    }
  } catch (error) {
    return integrationFailure('tree', error)
  }

  let target: NonNullable<IntegrationConfig['pushTarget']>
  try {
    assertPushTarget(config.pushTarget)
    target = config.pushTarget
  } catch (error) {
    return integrationFailure('push', error)
  }

  let trustedRepository: TrustedPushRepository
  try {
    trustedRepository =
      preparedTrustedRepository ??
      (await adapters.prepareTrustedPushRepository(config.workDir, integrationCommit, manifest, expectation))
  } catch (error) {
    return integrationFailure('tree', error)
  }

  let primaryResult: IntegrationResult
  try {
    const credential = await adapters.acquirePushCredential()
    if (credential.token.length === 0) {
      primaryResult = integrationFailure('push', 'push credential is empty')
    } else {
      await adapters.pushIntegration(trustedRepository, integrationCommit, target, credential)
      primaryResult = {ok: true, manifest, dryRun: false, pushed: true}
    }
  } catch (error) {
    primaryResult = integrationFailure('push', error)
  }

  try {
    await trustedRepository.cleanup()
  } catch (error) {
    try {
      logger.warning('trusted push repository cleanup failed after finalization', {error: formatPipelineError(error)})
    } catch {
      // Logger failures must not change the push or credential outcome.
    }
  }

  return primaryResult
}

function candidateDirtyPaths(workDir: string): string[] {
  const statusOutput = execSync('git status --porcelain=v1 --untracked-files=all', {cwd: workDir, encoding: 'utf8'})
  return statusOutput
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
}

async function withBlankedPushTokens<T>(operation: () => Promise<T>): Promise<T> {
  const savedGhToken = process.env.GH_TOKEN
  const savedGithubToken = process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    return await operation()
  } finally {
    if (savedGhToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGhToken
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGithubToken
  }
}

/**
 * Freezes a model-produced local candidate, then delegates build, packaging,
 * validation, and push to the existing trusted repository machinery.
 */
export async function finalizeCandidateIntegration(
  config: IntegrationConfig,
  outPath: string,
  adapters: IntegrationAdapters,
  _packageArtifact: typeof packageArtifact = packageArtifact,
  logger: IntegrateLogger = silentIntegrateLogger,
): Promise<IntegrationResult> {
  let dirtyPaths: string[]
  try {
    dirtyPaths = candidateDirtyPaths(config.workDir)
  } catch (error) {
    return integrationFailure('tree', error)
  }
  if (dirtyPaths.length > 0) {
    return integrationFailure(
      'tree',
      `candidate working tree is dirty at freeze time; refusing to freeze:\n${dirtyPaths.join('\n')}`,
    )
  }

  let integrationCommit: string
  try {
    integrationCommit = await adapters.getCommitSha(config.workDir)
  } catch (error) {
    return integrationFailure('commit', error)
  }
  const expectation = treeExpectationFor(config, integrationCommit)

  try {
    await adapters.validateFinalTree(config.workDir, expectation)
  } catch (error) {
    return integrationFailure('tree', error)
  }

  const sourceRepo = config.sourceRepo ?? `https://github.com/${config.releaseRepo}.git`
  let sources: ReturnType<typeof resolveSources>
  try {
    sources = resolveSources(config.integrationRefs, sourceRepo)
  } catch (error) {
    return integrationFailure('sources', error)
  }
  const resolvedShas: string[] = []
  for (const source of sources) {
    if (adapters.getRefSha === undefined) {
      return integrationFailure('provenance', 'candidate ref resolution is unavailable')
    }
    try {
      resolvedShas.push(await adapters.getRefSha(config.workDir, source.merge))
    } catch (error) {
      return integrationFailure(
        'provenance',
        `candidate source ${source.label} SHA resolution failed: ${formatPipelineError(error)}`,
      )
    }
  }

  const manifest = {
    baseVersion: config.baseVersion,
    carryManifest: {
      base: `v${config.baseVersion}`,
      carries: sources.map((source, index) => ({
        ref: config.integrationRefs[index] ?? source.label,
        resolvedSha: resolvedShas[index] ?? '',
      })),
    } satisfies CarryManifest,
    integrationRefs: sources.map((source, index) => ({
      ref: config.integrationRefs[index] ?? source.label,
      resolvedSha: resolvedShas[index] ?? '',
    })),
    integrationCommit,
    buildSha: 'dev',
  }

  let trustedRepository: TrustedPushRepository
  try {
    await writeProvenanceManifest(config.workDir, manifest)
    trustedRepository = await adapters.prepareTrustedPushRepository(
      config.workDir,
      integrationCommit,
      manifest,
      expectation,
    )
  } catch (error) {
    return integrationFailure('provenance', error)
  }

  let handedOff = false
  try {
    const installDependencies = adapters.installDependencies
    if (installDependencies === undefined) {
      throw new Error('trusted frozen checkout dependency installation is unavailable')
    }

    await withBlankedPushTokens(async () => {
      await installDependencies(trustedRepository.workDir)
      await adapters.buildCli(trustedRepository.workDir, config.baseVersion, 'latest')
      await adapters.verifyVersion(trustedRepository.workDir, config.baseVersion)
      const trustedCommit = await adapters.getCommitSha(trustedRepository.workDir)
      if (trustedCommit !== integrationCommit) {
        throw new Error(
          `trusted build HEAD drifted: expected frozen commit ${integrationCommit}, found ${trustedCommit}`,
        )
      }
      await adapters.validateFinalTree(trustedRepository.workDir, expectation)
      await _packageArtifact(trustedRepository.workDir, integrationCommit, outPath)
    })

    const finalized = await finalizeLocalIntegration(
      config,
      adapters,
      {ok: true, manifest, dryRun: false, pushed: false},
      artifactCompletion,
      logger,
      trustedRepository,
    )
    handedOff = true
    return finalized
  } catch (error) {
    return integrationFailure('build', error)
  } finally {
    if (handedOff === false) {
      try {
        await trustedRepository.cleanup()
      } catch (error) {
        try {
          logger.warning('trusted candidate repository cleanup failed after candidate failure', {
            error: formatPipelineError(error),
          })
        } catch {
          // Cleanup diagnostics must not mask the candidate failure.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Implements `harness integrate`.
 *
 * @param argv              - CLI arguments (everything after "integrate").
 * @param configPath        - Path to harness.config.json (defaults to package root; injectable for tests).
 * @param _packageArtifact  - Injectable override for packageArtifact (for unit tests; defaults to the real impl).
 * @param logger             - Injectable warning logger for post-push cleanup failures.
 * @returns Exit code: 0 on success, 1 on failure.
 */
export async function cmdIntegrate(
  argv: readonly string[],
  configPath: string = DEFAULT_CONFIG_PATH,
  _packageArtifact: typeof packageArtifact = packageArtifact,
  logger: IntegrateLogger = silentIntegrateLogger,
): Promise<number> {
  const startedAt = new Date().toISOString()
  const brokerAuthJson = process.env.HARNESS_BROKER_AUTH_JSON
  delete process.env.HARNESS_BROKER_AUTH_JSON

  // Parse flags.
  const flags = parseFlags(argv)
  if (flags === null) return 1

  // Validate required flags.
  if (flags.workDir === undefined) {
    console.error('[integrate] Missing required flag: --work-dir <dir>')
    return 1
  }
  if (flags.baseVersion !== undefined && isValidBaseVersion(flags.baseVersion) === false) {
    console.error(`[integrate] Invalid --base-version: ${flags.baseVersion}`)
    return 1
  }
  if (flags.out === undefined) {
    console.error('[integrate] Missing required flag: --out <path>')
    return 1
  }
  if ((flags.pushRepo === undefined) !== (flags.pushRef === undefined)) {
    console.error('[integrate] --push-repo and --push-ref must be provided together')
    return 1
  }

  const workDir = flags.workDir
  const outPath = flags.out
  const pushTarget =
    flags.pushRepo !== undefined && flags.pushRef !== undefined
      ? {repository: flags.pushRepo, ref: flags.pushRef}
      : undefined

  // Read harness.config.json.
  let rawConfig: unknown
  try {
    const raw = readFileSync(configPath, 'utf8')
    rawConfig = JSON.parse(raw)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[integrate] Failed to read config: ${msg}`)
    return 1
  }

  if (!isValidHarnessConfig(rawConfig)) {
    console.error('[integrate] Invalid harness.config.json shape')
    return 1
  }

  const config: IntegrationConfig = {
    baseVersion: flags.baseVersion ?? rawConfig.base_version,
    releaseRepo: rawConfig.release_repo,
    sourceRepo: rawConfig.source_repo,
    integrationRefs: rawConfig.integrationRefs,
    agent: rawConfig.agent,
    model: rawConfig.model,
    opencodeBin: rawConfig.opencode_bin ?? 'opencode',
    brokerAuthJson,
    workDir,
    promptPath: flags.promptPath,
    dryRun: flags.dryRun,
    pushTarget,
  }

  const writeOutcome = async (
    result: IntegrationResult,
    failure?: {readonly stage: string; readonly error: string},
  ): Promise<boolean> => {
    if (flags.resultOut === undefined) return true
    try {
      await writeIntegrationOutcomeFile(
        flags.resultOut,
        buildIntegrationOutcomeFile(result, startedAt, new Date().toISOString(), failure),
      )
      return true
    } catch (error) {
      console.error(`[integrate] Failed to write result file: ${formatPipelineError(error)}`)
      return false
    }
  }

  // Run the integration and package the artifact.
  try {
    const adapters = makeRealAdapters()
    if (flags.candidate) {
      const result = await finalizeCandidateIntegration(config, outPath, adapters, _packageArtifact, logger)
      if (result.ok === true) {
        const written = await writeOutcome(result)
        return written ? 0 : 1
      }
      const written = await writeOutcome(result)
      if (written === false) return 1
      console.error(`[integrate] ${result.error}`)
      return 1
    }

    const result = await runIntegration(config, adapters)
    if (result.ok === true) {
      try {
        await _packageArtifact(workDir, result.manifest.integrationCommit, outPath)
      } catch (error) {
        const packaged = await writeOutcome(result, {stage: 'artifact', error: formatPipelineError(error)})
        if (packaged === false) return 1
        console.error(`[integrate] ${formatPipelineError(error)}`)
        return 1
      }
      const finalized = await finalizeLocalIntegration(config, adapters, result, artifactCompletion, logger)
      if (finalized.ok === true) {
        const written = await writeOutcome(finalized)
        return written ? 0 : 1
      }
      const written = await writeOutcome(result, {
        stage: finalized.stage ?? 'finalize',
        error: finalized.error,
      })
      if (written === false) return 1
      console.error(`[integrate] ${finalized.error}`)
      return 1
    }
    const written = await writeOutcome(result)
    if (written === false) return 1
    console.error(`[integrate] ${result.error}`)
    return 1
  } catch (error) {
    const failed: IntegrationResult = {ok: false, stage: 'provenance', error: formatPipelineError(error)}
    await writeOutcome(failed, {stage: 'command', error: formatPipelineError(error)})
    console.error(`[integrate] ${formatPipelineError(error)}`)
    return 1
  }
}
