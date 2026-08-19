/**
 * Code-owned release integration engine.
 *
 * The driver owns the deterministic procedure: anonymous source resolution and
 * fetch, ordered no-ff merges, squash, workflow stripping, build, verification,
 * provenance, final-tree validation, and the late push boundary. A merge conflict
 * is returned as a typed boundary for the conflict-resolver unit; this module does
 * not invoke a model to perform deterministic work.
 */

import type {ConflictResolutionRequest, ConflictResolverResult} from './conflict-resolver.js'
import type {IntegrationRefRecord} from './provenance.js'
import type {CarryManifest, IntegrationSource, ResolvedIntegrationSource} from './sources.js'
import {Buffer} from 'node:buffer'
import {execFile} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'
import {HARNESS_GIT_IDENTITY, resolveConflict as resolveConflictAttempt} from './conflict-resolver.js'
import {formatPipelineError} from './format-error.js'
import {
  carrySourceChangedError,
  carrySourceFetchError,
  isValidCarryManifest,
  resolveCarryManifest,
  sourcesFromCarryManifest,
} from './sources.js'

/** Driver deadline: leaves the workflow backstop time to record a named failure and upload evidence. */
export const DEFAULT_INTEGRATION_PIPELINE_TIMEOUT_MS = 75 * 60 * 1000
/** Git command deadline: generous for a large hosted-runner clone/fetch, short enough to fail a wedged process. */
export const GIT_SUBPROCESS_TIMEOUT_MS = 10 * 60 * 1000
/** Error name used when the trusted integration ref changed after lease capture. */
export const TRUSTED_PUSH_LEASE_REJECTED_ERROR_NAME = 'TrustedPushLeaseRejectedError'

// Re-export so callers that previously imported from integrate.ts still work.
export type {IntegrationRefRecord} from './provenance.js'

// ---------------------------------------------------------------------------
// Provenance manifest types
// ---------------------------------------------------------------------------

export interface ProvenanceManifest {
  readonly baseVersion: string
  /** Required on manifests emitted by the current integration pipeline; optional for legacy test/build scaffolds. */
  readonly carryManifest?: CarryManifest
  readonly integrationRefs: readonly IntegrationRefRecord[]
  readonly integrationCommit: string
  readonly buildSha: string
}

// ---------------------------------------------------------------------------
// Integration config and typed boundaries
// ---------------------------------------------------------------------------

export interface IntegrationPushTarget {
  readonly repository: string
  readonly ref: string
}

/**
 * Optional legacy model fields remain accepted for the U6 resolver boundary,
 * but the U5 driver never uses them to perform deterministic integration work.
 */
export interface IntegrationConfig {
  readonly baseVersion: string
  readonly releaseRepo: string
  readonly sourceRepo?: string
  readonly integrationRefs: readonly string[]
  readonly carryManifest?: CarryManifest
  readonly workDir: string
  readonly dryRun?: boolean
  readonly pushTarget?: IntegrationPushTarget
  readonly agent?: string
  readonly model?: string
  readonly opencodeBin?: string
  /** Short-lived broker-minted model auth JSON; U7 wires the production input. */
  readonly brokerAuthJson?: string
  readonly runnerTempDir?: string
  readonly promptPath?: string
  /** Overall driver deadline; callers may shorten it for fail-soft shadow evidence. */
  readonly pipelineTimeoutMs?: number
}

export type MergeOutcome =
  | {readonly kind: 'clean'}
  | {readonly kind: 'conflict'; readonly conflictPaths: readonly string[]; readonly message?: string}

export interface IntegrationConflict {
  readonly source: IntegrationSource
  readonly mergeRef: string
  readonly preMergeCommit: string
  readonly conflictPaths: readonly string[]
  readonly message: string
  readonly resolver?: ConflictResolverResult
}

export interface PushCredential {
  readonly token: string
}

export interface TrustedPushRepository {
  readonly workDir: string
  readonly integrationCommit: string
  readonly cleanup: () => Promise<void>
}

export interface FinalTreeExpectation {
  readonly baseTag: string
  readonly integrationCommit: string
  readonly squashed: boolean
  readonly workflowsStripped: boolean
}

export type IntegrationStage =
  | 'sources'
  | 'clone'
  | 'fetch-tags'
  | 'branch'
  | 'fetch'
  | 'merge'
  | 'squash'
  | 'workflow-strip'
  | 'commit'
  | 'build'
  | 'version'
  | 'tree'
  | 'provenance'
  | 'cleanup'
  | 'push'
  | 'deadline'

export type IntegrationResult =
  | {
      readonly ok: true
      readonly manifest: ProvenanceManifest
      readonly dryRun?: boolean
      readonly pushed?: boolean
      readonly conflictDiagnostics?: readonly ConflictResolverResult[]
    }
  | {readonly ok: false; readonly kind?: 'failure'; readonly stage?: IntegrationStage; readonly error: string}
  | {
      readonly ok: false
      readonly kind: 'conflict'
      readonly stage: 'merge'
      readonly error: string
      readonly conflict: IntegrationConflict
    }

// ---------------------------------------------------------------------------
// Injectable adapters (dependency injection for testability)
// ---------------------------------------------------------------------------

export interface IntegrationAdapters {
  /** Clone the release repo into workDir using anonymous public access. */
  readonly cloneRepo: (repoUrl: string, workDir: string, tag?: string) => Promise<void>
  /** Fetch tags from the anonymous origin. */
  readonly fetchTags: (workDir: string) => Promise<void>
  /** Fetch one public integration ref into a local tracking ref and verify its frozen SHA. */
  readonly fetchRef: (
    workDir: string,
    remoteUrl: string,
    fetchRef: string,
    localRef: string,
    expectedSha?: string,
  ) => Promise<void>
  /** Resolve one public integration ref to its current SHA before any carry fetches. */
  readonly resolveRefSha?: (remoteUrl: string, fetchRef: string) => Promise<string>
  /** Capture the resolved upstream SHA immediately after fetchRef. */
  readonly captureRefSha: (workDir: string) => Promise<string | null>
  /** Create/reset the integration branch to the release tag. */
  readonly createBranch: (workDir: string, branch: string, tag: string) => Promise<void>
  /** Run one deterministic no-ff merge. Conflicts are returned, not thrown. */
  readonly mergeRef: (workDir: string, mergeRef: string) => Promise<MergeOutcome>
  /** Resolve one actual merge conflict in a disposable broker-scoped checkout. */
  readonly resolveConflict?: (request: ConflictResolutionRequest) => Promise<ConflictResolverResult>
  /** Stage only the validated regular-file conflict paths. */
  readonly stagePaths?: (workDir: string, paths: readonly string[]) => Promise<void>
  /** Verify each staged blob is byte-identical to the resolver's accepted bytes. */
  readonly verifyStagedPaths?: (workDir: string, expectedDigests: Readonly<Record<string, string>>) => Promise<void>
  /** Require the target merge index to contain no unmerged entries after staging. */
  readonly assertNoUnmerged: (workDir: string) => Promise<void>
  /** Complete the code-owned merge after validated paths are staged. */
  readonly completeMerge?: (workDir: string) => Promise<void>
  /** @deprecated U5 never calls the legacy model-owned merge path. */
  readonly runMerge?: (
    workDir: string,
    opencodeBin: string,
    agent: string,
    model: string,
    prompt: string,
  ) => Promise<void>
  /** Flatten the merge history back to the release tag while retaining the tree. */
  readonly resetToBase: (workDir: string, tag: string) => Promise<void>
  /** Remove workflow files from the index while retaining them on disk. */
  readonly stripWorkflowFiles: (workDir: string) => Promise<void>
  /** Commit the current index as the single integration commit. */
  readonly commitIntegration: (workDir: string, message: string) => Promise<void>
  /** Build the native CLI in the integrated work repo. */
  readonly buildCli: (workDir: string, version: string, channel: string) => Promise<void>
  /** Install the frozen checkout's locked dependencies before building it. */
  readonly installDependencies?: (workDir: string) => Promise<void>
  /** Verify the built CLI --version matches the expected base version exactly. */
  readonly verifyVersion: (workDir: string, expectedVersion: string) => Promise<void>
  /** Get the current HEAD commit SHA of the work repo. */
  readonly getCommitSha: (workDir: string) => Promise<string>
  /** Resolve a local candidate ref to its commit SHA. */
  readonly getRefSha?: (workDir: string, ref: string) => Promise<string>
  /** Validate the final commit/tree before and immediately before push. */
  readonly validateFinalTree: (workDir: string, expectation: FinalTreeExpectation) => Promise<void>
  /** Materialize and revalidate the frozen commit in a fresh trusted repository. */
  readonly prepareTrustedPushRepository: (
    sourceWorkDir: string,
    integrationCommit: string,
    manifest: ProvenanceManifest,
    expectation: FinalTreeExpectation,
  ) => Promise<TrustedPushRepository>
  /** Acquire the push credential only after artifact packaging and trusted revalidation succeed. */
  readonly acquirePushCredential: () => Promise<PushCredential>
  /** Push the already-validated commit from the trusted repository to the configured target. */
  readonly pushIntegration: (
    trustedRepository: TrustedPushRepository,
    sourceRef: string,
    target: IntegrationPushTarget,
    credential: PushCredential,
  ) => Promise<void>
  /** Dispose integration-owned subprocess state after every run outcome. */
  readonly dispose?: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Provenance manifest I/O (single source of truth)
// ---------------------------------------------------------------------------

const MANIFEST_FILENAME = 'provenance.json'

/** Writes the manifest only after the integration pipeline has passed its gates. */
export async function writeProvenanceManifest(dir: string, manifest: ProvenanceManifest): Promise<void> {
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(path.join(dir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isValidIntegrationRefRecord(value: unknown): value is IntegrationRefRecord {
  if (!isRecord(value)) return false
  if (typeof value.ref !== 'string' || value.ref.length === 0) return false
  if (typeof value.resolvedSha !== 'string' || value.resolvedSha.length === 0) return false
  if (value.reason !== undefined && typeof value.reason !== 'string') return false
  if (value.upstreamStatus !== undefined && typeof value.upstreamStatus !== 'string') return false
  return true
}

/** Type guard for complete, non-partial integration provenance. */
export function isValidProvenanceManifest(value: unknown): value is ProvenanceManifest {
  if (!isRecord(value)) return false
  if (typeof value.baseVersion !== 'string' || value.baseVersion.length === 0) return false
  if (isValidCarryManifest(value.carryManifest) === false) return false
  if (!Array.isArray(value.integrationRefs)) return false
  if (!value.integrationRefs.every(isValidIntegrationRefRecord)) return false
  if (typeof value.integrationCommit !== 'string' || value.integrationCommit.length === 0) return false
  if (typeof value.buildSha !== 'string' || value.buildSha.length === 0) return false
  return true
}

/** Reads a complete manifest, returning null for missing or malformed data. */
export async function readProvenanceManifest(dir: string): Promise<ProvenanceManifest | null> {
  const manifestPath = path.join(dir, MANIFEST_FILENAME)
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidProvenanceManifest(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Real adapters
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)
const PUBLIC_GIT_DENY_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_APP_TOKEN',
  'APPLICATION_PRIVATE_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH_COMMAND',
] as const

const TRUSTED_GIT_DENY_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_REPLACE_REF_BASE',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'GIT_WORK_TREE',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'GIT_CURL_VERBOSE',
  'GIT_TRACE',
  'GIT_TRACE2',
  'GIT_TRACE2_BRIEF',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_PERF',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_SETUP',
] as const

const GIT_NON_GIT_DENY_KEYS = new Set(['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSH_AUTH_SOCK'])

function publicGitEnv(): NodeJS.ProcessEnv {
  const env = {...process.env}
  for (const key of PUBLIC_GIT_DENY_KEYS) delete env[key]
  for (const key of Object.keys(env)) {
    const uppercase = key.toUpperCase()
    if (uppercase.startsWith('GIT_') || GIT_NON_GIT_DENY_KEYS.has(uppercase)) delete env[key]
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return env
}

function trustedGitEnv(): NodeJS.ProcessEnv {
  const env = publicGitEnv()
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_')) delete env[key]
  }
  for (const key of TRUSTED_GIT_DENY_KEYS) delete env[key]
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return env
}

export interface RealAdapterOptions {
  readonly hooksRoot?: string
  /** Test seam for exercising subprocess timeout handling without network access. */
  readonly gitBin?: string
  /** Test seam; production uses GIT_SUBPROCESS_TIMEOUT_MS. */
  readonly gitTimeoutMs?: number
  /** Shadow callers may shorten model attempts without changing authoritative integration. */
  readonly conflictModelTimeoutMs?: number
}

interface GitSubprocess {
  readonly exec: (args: readonly string[], cwd: string | undefined, env: NodeJS.ProcessEnv) => Promise<string>
  readonly execBytes: (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<Buffer>
  readonly authExec: (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>
  readonly dispose: () => Promise<void>
}

function isGitSubprocessTimeout(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  return record.code === 'ETIMEDOUT' || (record.killed === true && record.signal === 'SIGTERM')
}

function gitSubprocessError(error: unknown, args: readonly string[], timeoutMs: number): unknown {
  if (isGitSubprocessTimeout(error) === false) return error
  const timeoutError = new Error(`git subprocess timed out after ${timeoutMs}ms: git ${args.join(' ')}`)
  timeoutError.name = 'GitSubprocessTimeoutError'
  return timeoutError
}

function makeGitSubprocess(hooksRoot: string, gitBin = 'git', timeoutMs = GIT_SUBPROCESS_TIMEOUT_MS): GitSubprocess {
  let hooksPathPromise: Promise<string> | undefined
  let disposePromise: Promise<void> | undefined
  let disposeRequested = false
  let disposed = false
  let inFlight = 0
  let resolveDrain: (() => void) | undefined

  const begin = (): void => {
    if (disposeRequested || disposed) throw new Error('integration Git lifecycle is already disposed')
    inFlight += 1
  }

  const end = (): void => {
    inFlight -= 1
    if (inFlight === 0 && resolveDrain !== undefined) {
      const resolve = resolveDrain
      resolveDrain = undefined
      resolve()
    }
  }

  const hooksPath = async (): Promise<string> => {
    hooksPathPromise ??= fs.mkdtemp(path.join(hooksRoot, 'fro-bot-integrate-hooks-'))
    return hooksPathPromise
  }

  const exec = async (args: readonly string[], cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<string> => {
    begin()
    try {
      const disabledHooksPath = await hooksPath()
      try {
        const result = await execFileAsync(
          gitBin,
          [
            '-c',
            'credential.helper=',
            '-c',
            'core.askPass=',
            ...HARNESS_GIT_IDENTITY,
            '-c',
            `core.hooksPath=${disabledHooksPath}`,
            ...args,
          ],
          {cwd, encoding: 'utf8', env, timeout: timeoutMs},
        )
        return result.stdout.trim()
      } catch (error) {
        throw gitSubprocessError(error, args, timeoutMs)
      }
    } finally {
      end()
    }
  }

  const execBytes = async (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Buffer> => {
    begin()
    try {
      const disabledHooksPath = await hooksPath()
      try {
        const result = await execFileAsync(
          gitBin,
          [
            '-c',
            'credential.helper=',
            '-c',
            'core.askPass=',
            ...HARNESS_GIT_IDENTITY,
            '-c',
            `core.hooksPath=${disabledHooksPath}`,
            ...args,
          ],
          {cwd, encoding: 'buffer', env, timeout: timeoutMs},
        )
        return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
      } catch (error) {
        throw gitSubprocessError(error, args, timeoutMs)
      }
    } finally {
      end()
    }
  }

  const authExec = async (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> => {
    begin()
    try {
      const disabledHooksPath = await hooksPath()
      try {
        const result = await execFileAsync(
          gitBin,
          ['-c', 'credential.helper=', ...HARNESS_GIT_IDENTITY, '-c', `core.hooksPath=${disabledHooksPath}`, ...args],
          {cwd, encoding: 'utf8', env, timeout: timeoutMs},
        )
        return result.stdout.trim()
      } catch (error) {
        throw gitSubprocessError(error, args, timeoutMs)
      }
    } finally {
      end()
    }
  }

  const dispose = async (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    disposeRequested = true
    disposePromise = (async () => {
      if (inFlight > 0) await new Promise<void>(resolve => (resolveDrain = resolve))
      if (hooksPathPromise !== undefined) await fs.rm(await hooksPathPromise, {recursive: true, force: true})
      disposed = true
    })()
    return disposePromise
  }

  return {exec, execBytes, authExec, dispose}
}

async function verifyStagedPathsReal(
  git: GitSubprocess,
  workDir: string,
  expectedDigests: Readonly<Record<string, string>>,
): Promise<void> {
  const entries = Object.entries(expectedDigests)
  if (entries.length === 0) throw new Error('cannot verify an empty staged path set')
  for (const [relative, expectedDigest] of entries) {
    const staged = await git.execBytes(['show', `:${relative}`], workDir, publicGitEnv())
    const actualDigest = crypto.createHash('sha256').update(staged).digest('hex')
    if (actualDigest !== expectedDigest) {
      throw new Error(`staged bytes mismatch for ${relative}: expected ${expectedDigest}, received ${actualDigest}`)
    }
  }
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

async function listUnmergedPaths(git: GitSubprocess, workDir: string): Promise<string[]> {
  try {
    return splitLines(await git.exec(['diff', '--name-only', '--diff-filter=U'], workDir, publicGitEnv()))
  } catch {
    return []
  }
}

async function listTreePaths(git: GitSubprocess, workDir: string, commit: string, prefix: string): Promise<string[]> {
  return splitLines(await git.exec(['ls-tree', '-r', '--name-only', commit, '--', prefix], workDir, publicGitEnv()))
}

async function copyGitObjects(sourceWorkDir: string, trustedWorkDir: string): Promise<void> {
  const sourceObjects = path.join(sourceWorkDir, '.git', 'objects')
  const trustedObjects = path.join(trustedWorkDir, '.git', 'objects')
  const sourceStat = await fs.lstat(sourceObjects)
  if (!sourceStat.isDirectory()) throw new Error('integration checkout has no usable Git object database')

  const copyTree = async (sourceDir: string, targetDir: string, relativeDir: string): Promise<void> => {
    await fs.mkdir(targetDir, {recursive: true})
    const entries = await fs.readdir(sourceDir, {withFileTypes: true})
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name)
      const targetPath = path.join(targetDir, entry.name)
      const relativePath = path.join(relativeDir, entry.name)
      if (relativePath === path.join('info', 'alternates')) continue
      if (entry.isDirectory()) {
        await copyTree(sourcePath, targetPath, relativePath)
      } else if (entry.isFile()) {
        await fs.copyFile(sourcePath, targetPath)
      } else {
        throw new Error(`integration checkout contains unsupported Git object entry: ${relativePath}`)
      }
    }
  }

  await copyTree(sourceObjects, trustedObjects, '')
}

function resolveCliPath(workDir: string): string {
  const osName = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch
  const name = `opencode-${osName}-${arch}`
  const binary = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  return path.join(workDir, 'packages', 'opencode', 'dist', name, 'bin', binary)
}

async function validateCommitTree(
  git: GitSubprocess,
  workDir: string,
  expectation: FinalTreeExpectation,
): Promise<void> {
  const unmergedPaths = await listUnmergedPaths(git, workDir)
  if (unmergedPaths.length > 0) {
    throw new Error(`final integration tree contains unmerged paths: ${unmergedPaths.join(', ')}`)
  }

  const tagCommit = await git.exec(['rev-parse', `refs/tags/${expectation.baseTag}^{commit}`], workDir, trustedGitEnv())
  const integrationCommit = await git.exec(
    ['rev-parse', `${expectation.integrationCommit}^{commit}`],
    workDir,
    trustedGitEnv(),
  )

  if (expectation.squashed) {
    const parentLine = await git.exec(['rev-list', '--parents', '-n', '1', integrationCommit], workDir, trustedGitEnv())
    const parents = parentLine.split(' ').filter(value => value.length > 0)
    if (parents.length !== 2 || parents[1] !== tagCommit) {
      throw new Error(`final integration commit is not one squash commit on ${expectation.baseTag}`)
    }
  } else if (integrationCommit !== tagCommit) {
    throw new Error(`stock-tag integration changed HEAD from ${expectation.baseTag}`)
  }

  if (expectation.workflowsStripped) {
    const workflowPaths = splitLines(
      await git.exec(
        ['ls-tree', '-r', '--name-only', integrationCommit, '--', '.github/workflows'],
        workDir,
        trustedGitEnv(),
      ),
    )
    if (workflowPaths.length > 0) {
      throw new Error('final integration commit still contains .github/workflows files')
    }
  }
}

async function validateFinalTreeReal(
  git: GitSubprocess,
  workDir: string,
  expectation: FinalTreeExpectation,
): Promise<void> {
  await validateCommitTree(git, workDir, expectation)

  if (expectation.workflowsStripped) {
    const tagCommit = await git.exec(
      ['rev-parse', `refs/tags/${expectation.baseTag}^{commit}`],
      workDir,
      publicGitEnv(),
    )

    const sourceWorkflowPaths = await listTreePaths(git, workDir, tagCommit, '.github/workflows')
    if (sourceWorkflowPaths.length > 0) {
      const workflowDir = path.join(workDir, '.github', 'workflows')
      const stat = await fs.stat(workflowDir)
      if (!stat.isDirectory()) throw new Error('.github/workflows was not retained on disk for the build')
    }
  }
}

function assertPushTarget(target: IntegrationPushTarget): void {
  if (target.repository.trim().length === 0) throw new Error('push target repository is empty')
  if (target.ref.trim().length === 0) throw new Error('push target ref is empty')
  const url = new URL(target.repository)
  if (url.protocol !== 'https:') throw new Error('push target must use anonymous-source-compatible HTTPS')
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('push target must not contain URL credentials')
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const record = error as Error & {readonly stderr?: unknown}
    const stderr = typeof record.stderr === 'string' ? record.stderr : ''
    return `${error.message}\n${stderr}`
  }
  return String(error)
}

function isTrustedPushLeaseRejection(error: unknown): boolean {
  const text = errorText(error)
  return /stale info/i.test(text) || /cannot lock ref .*expected [0-9a-f]{40}/i.test(text)
}

function trustedPushLeaseRejectedError(targetRef: string, cause: unknown): Error {
  const error = new Error(
    `trusted integration ref moved underneath this run: ${targetRef}; ${formatPipelineError(cause)}`,
  )
  error.name = TRUSTED_PUSH_LEASE_REJECTED_ERROR_NAME
  return error
}

async function resolvePushLeaseExpectation(
  git: GitSubprocess,
  target: IntegrationPushTarget,
  workDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const output = await git.authExec(['ls-remote', '--refs', target.repository, target.ref], workDir, env)
  const firstLine = splitLines(output)[0]
  if (firstLine === undefined || firstLine.length === 0) return ''
  const [sha, ref] = firstLine.split(/\s+/)
  if (sha === undefined || ref !== target.ref || /^[0-9a-f]{40}$/i.test(sha) === false) {
    throw new Error(`push target ref ${target.ref} did not resolve to a commit SHA`)
  }
  return sha.toLowerCase()
}

function assertCommitSha(commit: string): void {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('integration commit must be a full hexadecimal SHA')
}

async function prepareTrustedPushRepositoryReal(
  git: GitSubprocess,
  sourceWorkDir: string,
  integrationCommit: string,
  manifest: ProvenanceManifest,
  expectation: FinalTreeExpectation,
): Promise<TrustedPushRepository> {
  assertCommitSha(integrationCommit)
  if (manifest.integrationCommit !== integrationCommit) {
    throw new Error('trusted push repository commit does not match provenance')
  }
  if (expectation.integrationCommit !== integrationCommit) {
    throw new Error('trusted push repository commit does not match tree expectation')
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-trusted-push-'))
  const trustedWorkDir = path.join(tempRoot, 'repo')

  try {
    await fs.mkdir(trustedWorkDir, {recursive: true})
    await git.exec(['init', '--quiet', trustedWorkDir], undefined, trustedGitEnv())

    const baseCommit = await git.exec(
      ['rev-parse', `refs/tags/${expectation.baseTag}^{commit}`],
      sourceWorkDir,
      publicGitEnv(),
    )
    await copyGitObjects(sourceWorkDir, trustedWorkDir)
    await git.exec(['update-ref', `refs/tags/${expectation.baseTag}`, baseCommit], trustedWorkDir, trustedGitEnv())
    await git.exec(['update-ref', 'refs/harness/frozen', integrationCommit], trustedWorkDir, trustedGitEnv())
    await git.exec(['symbolic-ref', 'HEAD', 'refs/harness/frozen'], trustedWorkDir, trustedGitEnv())
    await git.exec(['checkout', '--quiet', '--detach', 'refs/harness/frozen'], trustedWorkDir, trustedGitEnv())
    await fs.mkdir(path.join(trustedWorkDir, '.github', 'workflows'), {recursive: true})

    const actualCommit = await git.exec(['rev-parse', 'refs/harness/frozen^{commit}'], trustedWorkDir, trustedGitEnv())
    if (actualCommit !== integrationCommit) {
      throw new Error(`trusted push repository resolved ${actualCommit}, expected ${integrationCommit}`)
    }
    await validateCommitTree(git, trustedWorkDir, expectation)

    const sourceManifest = await readProvenanceManifest(sourceWorkDir)
    if (sourceManifest === null || JSON.stringify(sourceManifest) !== JSON.stringify(manifest)) {
      throw new Error('trusted push repository provenance does not match the frozen integration manifest')
    }
    await writeProvenanceManifest(trustedWorkDir, manifest)
    const trustedManifest = await readProvenanceManifest(trustedWorkDir)
    if (trustedManifest === null || JSON.stringify(trustedManifest) !== JSON.stringify(manifest)) {
      throw new Error('trusted push repository provenance verification failed')
    }

    let cleaned = false
    return {
      workDir: trustedWorkDir,
      integrationCommit,
      cleanup: async () => {
        if (cleaned) return
        cleaned = true
        await fs.rm(tempRoot, {recursive: true, force: true})
      },
    }
  } catch (error) {
    await fs.rm(tempRoot, {recursive: true, force: true})
    throw error
  }
}

export function makeRealAdapters(options: RealAdapterOptions = {}): IntegrationAdapters {
  const git = makeGitSubprocess(options.hooksRoot ?? os.tmpdir(), options.gitBin, options.gitTimeoutMs)
  return {
    cloneRepo: async (repoUrl, workDir, tag) => {
      await fs.rm(workDir, {recursive: true, force: true})
      await fs.mkdir(path.dirname(workDir), {recursive: true})
      const cloneArgs = tag === undefined ? ['clone', repoUrl, workDir] : ['clone', '--branch', tag, repoUrl, workDir]
      await git.exec(cloneArgs, undefined, publicGitEnv())
    },

    fetchTags: async workDir => {
      await git.exec(['fetch', 'origin', '--tags'], workDir, publicGitEnv())
    },

    fetchRef: async (workDir, remoteUrl, fetchRef, localRef, expectedSha) => {
      try {
        await git.exec(['fetch', '--no-tags', remoteUrl, `${fetchRef}:${localRef}`], workDir, publicGitEnv())
      } catch (error) {
        if (expectedSha !== undefined) throw carrySourceFetchError({label: fetchRef}, error)
        throw error
      }
      if (expectedSha !== undefined) {
        const actualSha = await git.exec(['rev-parse', `${localRef}^{commit}`], workDir, publicGitEnv())
        if (actualSha !== expectedSha) {
          throw carrySourceChangedError({label: fetchRef}, expectedSha, actualSha)
        }
      }
    },

    resolveRefSha: async (remoteUrl, fetchRef) => {
      const output = await git.exec(['ls-remote', remoteUrl, fetchRef], undefined, publicGitEnv())
      const firstLine = splitLines(output)[0]
      const resolvedSha = firstLine?.split(/\s+/)[0]
      if (resolvedSha === undefined || /^[0-9a-f]{40}$/i.test(resolvedSha) === false) {
        const error = new Error(`remote ref ${fetchRef} did not resolve to a commit SHA`)
        error.name = 'CarrySourceResolutionError'
        throw error
      }
      return resolvedSha.toLowerCase()
    },

    captureRefSha: async workDir => {
      try {
        return await git.exec(['rev-parse', 'FETCH_HEAD'], workDir, publicGitEnv())
      } catch {
        return null
      }
    },

    createBranch: async (workDir, branch, tag) => {
      await git.exec(['checkout', '-B', branch, `refs/tags/${tag}`], workDir, publicGitEnv())
    },

    mergeRef: async (workDir, mergeRef) => {
      try {
        await git.exec(['merge', '--no-ff', '--no-edit', mergeRef], workDir, publicGitEnv())
        return {kind: 'clean'}
      } catch (error) {
        const conflictPaths = await listUnmergedPaths(git, workDir)
        if (conflictPaths.length === 0) throw error
        return {
          kind: 'conflict',
          conflictPaths,
          message: formatPipelineError(error),
        }
      }
    },

    resolveConflict: async request =>
      resolveConflictAttempt(
        request,
        options.conflictModelTimeoutMs === undefined ? {} : {modelTimeoutMs: options.conflictModelTimeoutMs},
      ),

    stagePaths: async (workDir, paths) => {
      if (paths.length === 0) throw new Error('cannot stage an empty conflict path set')
      await git.exec(['add', '--', ...paths], workDir, publicGitEnv())
    },

    verifyStagedPaths: async (workDir, expectedDigests) => verifyStagedPathsReal(git, workDir, expectedDigests),

    assertNoUnmerged: async workDir => {
      const unresolved = await git.exec(['ls-files', '-u'], workDir, publicGitEnv())
      if (unresolved.length > 0) throw new Error(`merge still contains unmerged entries: ${unresolved}`)
    },

    completeMerge: async workDir => {
      await git.exec(['commit', '--no-verify', '--no-edit'], workDir, publicGitEnv())
    },

    resetToBase: async (workDir, tag) => {
      await git.exec(['reset', '--soft', `refs/tags/${tag}`], workDir, publicGitEnv())
    },

    stripWorkflowFiles: async workDir => {
      await git.exec(
        ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '.github/workflows'],
        workDir,
        publicGitEnv(),
      )
    },

    commitIntegration: async (workDir, message) => {
      await git.exec(['commit', '--no-verify', '--allow-empty', '-m', message], workDir, publicGitEnv())
    },

    buildCli: async (workDir, version, channel) => {
      await execFileAsync('bun', ['./packages/opencode/script/build.ts', '--single'], {
        cwd: workDir,
        encoding: 'utf8',
        env: {
          ...publicGitEnv(),
          OPENCODE_CHANNEL: channel,
          OPENCODE_VERSION: version,
        },
        timeout: 20 * 60 * 1000,
      })
    },

    installDependencies: async workDir => {
      await execFileAsync('bun', ['install', '--frozen-lockfile'], {
        cwd: workDir,
        encoding: 'utf8',
        env: publicGitEnv(),
        timeout: 20 * 60 * 1000,
      })
    },

    verifyVersion: async (workDir, expectedVersion) => {
      const cliPath = resolveCliPath(workDir)
      const {stdout} = await execFileAsync(cliPath, ['--version'], {
        encoding: 'utf8',
        env: publicGitEnv(),
        timeout: 30_000,
      })
      const actual = stdout.trim()
      if (actual !== expectedVersion) {
        throw new Error(`Built CLI reported version ${actual}, expected ${expectedVersion}`)
      }
    },

    getCommitSha: async workDir => git.exec(['rev-parse', 'HEAD'], workDir, publicGitEnv()),

    getRefSha: async (workDir, ref) => git.exec(['rev-parse', `${ref}^{commit}`], workDir, publicGitEnv()),

    validateFinalTree: async (workDir, expectation) => validateFinalTreeReal(git, workDir, expectation),

    prepareTrustedPushRepository: async (sourceWorkDir, integrationCommit, manifest, expectation) =>
      prepareTrustedPushRepositoryReal(git, sourceWorkDir, integrationCommit, manifest, expectation),

    acquirePushCredential: async () => {
      const ghToken = process.env.GH_TOKEN
      const githubToken = process.env.GITHUB_TOKEN
      const token = ghToken !== undefined && ghToken.length > 0 ? ghToken : githubToken
      if (token === undefined || token.length === 0) {
        throw new Error('GH_TOKEN or GITHUB_TOKEN is required for harness push')
      }
      return {token}
    },

    pushIntegration: async (trustedRepository, sourceRef, target, credential) => {
      assertPushTarget(target)
      assertCommitSha(sourceRef)
      if (sourceRef !== trustedRepository.integrationCommit) {
        throw new Error('push source does not match the trusted integration commit')
      }
      if (credential.token.length === 0) throw new Error('push credential is empty')

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-push-'))
      try {
        const askpass = path.join(tempDir, 'askpass')
        await fs.writeFile(
          askpass,
          '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" x-access-token ;;\n*Password*) printf "%s\\n" "$HARNESS_PUSH_TOKEN" ;;\nesac\n',
          {encoding: 'utf8', mode: 0o700},
        )
        const env = trustedGitEnv()
        env.HARNESS_PUSH_TOKEN = credential.token
        env.GIT_ASKPASS = askpass
        env.GIT_TERMINAL_PROMPT = '0'
        const expectedOldValue = await resolvePushLeaseExpectation(git, target, trustedRepository.workDir, env)
        const pushArgs = [
          'push',
          '--no-verify',
          `--force-with-lease=${target.ref}:${expectedOldValue}`,
          target.repository,
          `${sourceRef}:${target.ref}`,
        ] as const
        try {
          await git.authExec(pushArgs, trustedRepository.workDir, env)
        } catch (error) {
          if (isTrustedPushLeaseRejection(error)) throw trustedPushLeaseRejectedError(target.ref, error)
          throw error
        }
      } finally {
        await fs.rm(tempDir, {recursive: true, force: true})
      }
    },

    dispose: git.dispose,
  }
}

// ---------------------------------------------------------------------------
// Core integration orchestration
// ---------------------------------------------------------------------------

function failure(stage: IntegrationStage, error: unknown): IntegrationResult {
  return {ok: false, kind: 'failure', stage, error: formatPipelineError(error)}
}

interface IntegrationDeadlineError extends Error {
  readonly integrationStage: IntegrationStage
  readonly timeoutMs: number
}

function integrationDeadlineError(stage: IntegrationStage, timeoutMs: number): IntegrationDeadlineError {
  const error = new Error(`integration pipeline deadline exceeded during ${stage} after ${timeoutMs}ms`)
  error.name = 'IntegrationDeadlineError'
  Object.defineProperty(error, 'integrationStage', {value: stage})
  Object.defineProperty(error, 'timeoutMs', {value: timeoutMs})
  return error as IntegrationDeadlineError
}

function isIntegrationDeadlineError(error: unknown): error is IntegrationDeadlineError {
  return error instanceof Error && error.name === 'IntegrationDeadlineError'
}

async function withIntegrationDeadline<T>(
  operation: Promise<T>,
  stage: () => IntegrationStage,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(integrationDeadlineError(stage(), timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function treeExpectationFor(config: IntegrationConfig, integrationCommit: string): FinalTreeExpectation {
  return {
    baseTag: `v${config.baseVersion}`,
    integrationCommit,
    squashed: config.integrationRefs.length > 0,
    workflowsStripped: config.integrationRefs.length > 0,
  }
}

async function assertFrozenIntegrationHead(
  adapters: IntegrationAdapters,
  workDir: string,
  integrationCommit: string,
): Promise<void> {
  const currentCommit = await adapters.getCommitSha(workDir)
  if (currentCommit !== integrationCommit) {
    throw new Error(`integration HEAD drifted: expected frozen commit ${integrationCommit}, found ${currentCommit}`)
  }
}

function sourceRefForManifest(source: IntegrationSource, configuredRef: string | undefined): string {
  return configuredRef === undefined ? source.label : configuredRef
}

function validateCarryManifestInput(
  manifest: CarryManifest,
  expectedBase: string,
  configuredRefs: readonly string[],
): string | null {
  if (isValidCarryManifest(manifest) === false) return 'immutable carry manifest shape is invalid'
  if (manifest.base !== expectedBase) return 'immutable carry manifest base does not match configuration'
  if (manifest.carries.length !== configuredRefs.length)
    return 'immutable carry manifest ref count does not match configuration'
  for (const [index, carry] of manifest.carries.entries()) {
    const configuredRef = configuredRefs[index]
    if (configuredRef === undefined || carry.ref !== configuredRef) {
      return `immutable carry manifest ref ${index} identity does not match configuration`
    }
  }
  return null
}

function resolveReleaseRepoUrl(releaseRepo: string): string {
  const candidate = releaseRepo.startsWith('https://')
    ? releaseRepo.endsWith('.git')
      ? releaseRepo
      : `${releaseRepo}.git`
    : `https://github.com/${releaseRepo}.git`
  const url = new URL(candidate)
  if (url.protocol !== 'https:') throw new Error('release/source repository must use HTTPS')
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('release/source repository must not contain URL credentials')
  }
  return candidate
}

function validateManifest(
  manifest: ProvenanceManifest,
  config: IntegrationConfig,
  sources: readonly IntegrationSource[],
  resolvedShas: readonly string[],
  integrationCommit: string,
): string | null {
  if (!isValidProvenanceManifest(manifest)) return 'provenance manifest shape is invalid'
  if (manifest.baseVersion !== config.baseVersion) return 'provenance base version does not match configuration'
  if (manifest.carryManifest === undefined) return 'provenance immutable carry manifest is missing'
  const carryManifestError = validateCarryManifestInput(
    manifest.carryManifest,
    `v${config.baseVersion}`,
    config.integrationRefs,
  )
  if (carryManifestError !== null) return carryManifestError
  if (manifest.integrationCommit !== integrationCommit) return 'provenance integration commit does not match HEAD'
  if (manifest.integrationRefs.length !== sources.length) {
    return 'provenance ref count does not match configured sources'
  }

  for (const [index, source] of sources.entries()) {
    const record = manifest.integrationRefs[index]
    const expectedSha = resolvedShas[index]
    if (source === undefined || record === undefined || expectedSha === undefined) {
      return `provenance ref ${index} is missing`
    }
    const expectedRef = sourceRefForManifest(source, config.integrationRefs[index])
    if (record.ref !== expectedRef) return `provenance ref ${index} identity does not match configuration`
    if (record.resolvedSha !== expectedSha) return `provenance ref ${index} SHA does not match the fetched source`
    const carry = manifest.carryManifest.carries[index]
    if (carry === undefined || carry.ref !== record.ref || carry.resolvedSha !== record.resolvedSha) {
      return `provenance carry ${index} does not match the immutable carry manifest`
    }
  }

  return null
}

/**
 * Runs the deterministic local integration pipeline through a validated pending result.
 *
 * A clean merge never crosses the model boundary. A conflict returns before
 * squash/build so U6 can own the bounded contextual repair contract. Artifact
 * packaging and the credentialed trusted push are owned by the command layer.
 */
async function runIntegrationPipeline(
  config: IntegrationConfig,
  adapters: IntegrationAdapters,
  setStage: (stage: IntegrationStage) => void,
): Promise<IntegrationResult> {
  const {baseVersion, releaseRepo, integrationRefs, workDir} = config
  // Callers on the pre-U5 API did not have a push target. Preserve their local
  // characterization behavior as an implicit dry run; the CLI now always sets
  // dryRun explicitly, so a real non-dry-run invocation still fails closed when
  // its push target or credential boundary is missing.
  const dryRun = config.dryRun === true || (config.dryRun === undefined && config.pushTarget === undefined)
  const tag = `v${baseVersion}`
  const branch = `integrate/v${baseVersion}`
  const channel = 'latest'

  let releaseRepoUrl: string
  let sourceRepoUrl: string
  try {
    setStage('sources')
    releaseRepoUrl = resolveReleaseRepoUrl(releaseRepo)
    sourceRepoUrl = config.sourceRepo === undefined ? releaseRepoUrl : resolveReleaseRepoUrl(config.sourceRepo)
  } catch (error) {
    return failure('sources', error)
  }

  let sources: ResolvedIntegrationSource[]
  let carryManifest: CarryManifest
  try {
    setStage('sources')
    if (config.carryManifest === undefined) {
      if (integrationRefs.length > 0 && adapters.resolveRefSha === undefined) {
        throw new Error('immutable carry manifest resolution is unavailable')
      }
      carryManifest = await resolveCarryManifest(tag, integrationRefs, sourceRepoUrl, async source => {
        if (adapters.resolveRefSha === undefined) throw new Error('immutable carry manifest resolution is unavailable')
        return adapters.resolveRefSha(source.repo, source.fetchRef)
      })
    } else {
      const manifestError = validateCarryManifestInput(config.carryManifest, tag, integrationRefs)
      if (manifestError !== null) throw new Error(manifestError)
      carryManifest = config.carryManifest
    }
    sources = sourcesFromCarryManifest(carryManifest, sourceRepoUrl)
  } catch (error) {
    return failure('sources', error)
  }

  try {
    setStage('clone')
    await adapters.cloneRepo(releaseRepoUrl, workDir, tag)
  } catch (error) {
    return failure('clone', error)
  }

  try {
    setStage('fetch-tags')
    await adapters.fetchTags(workDir)
  } catch (error) {
    return failure('fetch-tags', error)
  }

  try {
    setStage('branch')
    await adapters.createBranch(workDir, branch, tag)
  } catch (error) {
    return failure('branch', error)
  }

  const resolvedShas = carryManifest.carries.map(carry => carry.resolvedSha)
  const conflictDiagnostics: ConflictResolverResult[] = []
  for (const source of sources) {
    try {
      setStage('fetch')
      await adapters.fetchRef(workDir, source.repo, source.fetchRef, source.fetch, source.resolvedSha)
    } catch (error) {
      return failure('fetch', `fetch ref ${source.label} failed: ${formatPipelineError(error)}`)
    }

    let resolvedSha: string | null
    try {
      setStage('provenance')
      resolvedSha = await adapters.captureRefSha(workDir)
    } catch (error) {
      return failure('provenance', `capture SHA for ${source.label} failed: ${formatPipelineError(error)}`)
    }
    if (resolvedSha === null || resolvedSha.length === 0) {
      return failure('provenance', `capture SHA for ${source.label} returned no resolved source SHA`)
    }
    if (resolvedSha.toLowerCase() !== source.resolvedSha) {
      return failure('fetch', carrySourceChangedError(source, source.resolvedSha, resolvedSha).message)
    }

    let preMergeCommit: string
    try {
      setStage('merge')
      preMergeCommit = await adapters.getCommitSha(workDir)
    } catch (error) {
      return failure('merge', `capture pre-merge commit for ${source.label} failed: ${formatPipelineError(error)}`)
    }

    let mergeOutcome: MergeOutcome
    try {
      setStage('merge')
      mergeOutcome = await adapters.mergeRef(workDir, source.merge)
    } catch (error) {
      return failure('merge', `merge ref ${source.label} failed: ${formatPipelineError(error)}`)
    }

    if (mergeOutcome.kind === 'conflict') {
      const conflict: IntegrationConflict = {
        source,
        mergeRef: source.merge,
        preMergeCommit,
        conflictPaths: mergeOutcome.conflictPaths,
        message: mergeOutcome.message ?? `merge ref ${source.label} reported conflicts`,
      }

      // Keep the pre-U6 typed boundary for injected adapters that do not opt
      // into model repair. Production adapters always provide the resolver.
      if (adapters.resolveConflict === undefined) {
        return {
          ok: false,
          kind: 'conflict',
          stage: 'merge',
          error: `merge ref ${source.label} requires conflict resolution: ${formatPipelineError(conflict.message)}`,
          conflict,
        }
      }

      let resolution: ConflictResolverResult
      try {
        setStage('merge')
        resolution = await adapters.resolveConflict({
          integrationWorkDir: workDir,
          preConflictCommit: preMergeCommit,
          mergeRef: source.merge,
          sourceLabel: source.label,
          conflictPaths: conflict.conflictPaths,
          conflictMessage: conflict.message,
          agent: config.agent ?? 'build',
          model: config.model ?? '',
          opencodeBin: config.opencodeBin ?? 'opencode',
          brokerAuthJson: config.brokerAuthJson,
          runnerTempDir: config.runnerTempDir,
        })
      } catch (error) {
        return {
          ok: false,
          kind: 'conflict',
          stage: 'merge',
          error: `merge ref ${source.label} conflict resolver failed: ${formatPipelineError(error)}`,
          conflict,
        }
      }

      conflictDiagnostics.push(resolution)
      if (resolution.ok === false) {
        return {
          ok: false,
          kind: 'conflict',
          stage: 'merge',
          error: `merge ref ${source.label} conflict resolver failed: ${formatPipelineError(resolution.error)}`,
          conflict: {...conflict, resolver: resolution},
        }
      }

      if (
        adapters.stagePaths === undefined ||
        adapters.verifyStagedPaths === undefined ||
        adapters.completeMerge === undefined
      ) {
        return {
          ok: false,
          kind: 'conflict',
          stage: 'merge',
          error: `merge ref ${source.label} resolved but the code-owned staging boundary is unavailable`,
          conflict: {...conflict, resolver: resolution},
        }
      }

      try {
        setStage('merge')
        await adapters.stagePaths(workDir, resolution.resolvedPaths)
        await adapters.verifyStagedPaths(workDir, resolution.resolvedDigests)
        await adapters.assertNoUnmerged(workDir)
        await adapters.completeMerge(workDir)
      } catch (error) {
        return {
          ok: false,
          kind: 'conflict',
          stage: 'merge',
          error: `merge ref ${source.label} completion failed: ${formatPipelineError(error)}`,
          conflict: {...conflict, resolver: resolution},
        }
      }
    }
  }

  const squashed = sources.length > 0
  if (squashed) {
    try {
      setStage('squash')
      await adapters.resetToBase(workDir, tag)
    } catch (error) {
      return failure('squash', error)
    }

    try {
      setStage('workflow-strip')
      await adapters.stripWorkflowFiles(workDir)
    } catch (error) {
      return failure('workflow-strip', error)
    }

    try {
      setStage('commit')
      await adapters.commitIntegration(
        workDir,
        `harness: integrate OpenCode ${baseVersion} carrying ${sources.map(s => s.label).join(', ')}`,
      )
    } catch (error) {
      return failure('commit', error)
    }
  }

  let integrationCommit: string
  try {
    setStage('commit')
    integrationCommit = await adapters.getCommitSha(workDir)
  } catch (error) {
    return failure('commit', error)
  }

  const treeExpectation = treeExpectationFor(config, integrationCommit)

  try {
    setStage('tree')
    await adapters.validateFinalTree(workDir, treeExpectation)
  } catch (error) {
    return failure('tree', error)
  }

  try {
    setStage('build')
    await adapters.buildCli(workDir, baseVersion, channel)
  } catch (error) {
    return failure('build', error)
  }

  try {
    setStage('version')
    await adapters.verifyVersion(workDir, baseVersion)
  } catch (error) {
    return failure('version', error)
  }

  // Recheck the frozen commit/tree after build and version verification. This is
  // the first point at which a build hook could have moved HEAD.
  try {
    setStage('tree')
    await assertFrozenIntegrationHead(adapters, workDir, integrationCommit)
    await adapters.validateFinalTree(workDir, treeExpectation)
    await assertFrozenIntegrationHead(adapters, workDir, integrationCommit)
  } catch (error) {
    return failure('tree', error)
  }

  const manifest: ProvenanceManifest = {
    baseVersion,
    carryManifest,
    integrationRefs: sources.map((source, index) => ({
      ref: sourceRefForManifest(source, integrationRefs[index]),
      resolvedSha: resolvedShas[index] ?? '',
    })),
    integrationCommit,
    buildSha: 'dev',
  }

  const manifestError = validateManifest(manifest, config, sources, resolvedShas, integrationCommit)
  if (manifestError !== null) return failure('provenance', manifestError)

  try {
    setStage('provenance')
    await writeProvenanceManifest(workDir, manifest)
  } catch (error) {
    return failure('provenance', error)
  }

  const persistedManifest = await readProvenanceManifest(workDir)
  if (persistedManifest === null) return failure('provenance', 'written provenance manifest is invalid or missing')
  const persistedError = validateManifest(persistedManifest, config, sources, resolvedShas, integrationCommit)
  if (persistedError !== null) return failure('provenance', persistedError)

  return {ok: true, manifest: persistedManifest, dryRun, pushed: false, conflictDiagnostics}
}

export async function runIntegration(
  config: IntegrationConfig,
  adapters: IntegrationAdapters,
): Promise<IntegrationResult> {
  let pipelineResult: IntegrationResult | undefined
  let pipelineError: unknown
  let pipelineThrew = false
  let disposeError: unknown
  let disposeThrew = false
  let deadlineExceeded = false
  try {
    try {
      let activeStage: IntegrationStage = 'sources'
      const timeoutMs = config.pipelineTimeoutMs ?? DEFAULT_INTEGRATION_PIPELINE_TIMEOUT_MS
      pipelineResult = await withIntegrationDeadline(
        runIntegrationPipeline(config, adapters, stage => {
          activeStage = stage
        }),
        () => activeStage,
        timeoutMs,
      )
    } catch (error) {
      if (isIntegrationDeadlineError(error)) {
        deadlineExceeded = true
        pipelineResult = failure('deadline', error)
      } else {
        pipelineThrew = true
        pipelineError = error
      }
    }
  } finally {
    if (deadlineExceeded) {
      // Do not let cleanup of an already-bounded subprocess hide the deadline
      // record; the adapter owns its own subprocess timeout and best-effort cleanup.
      const dispose = adapters.dispose
      if (dispose !== undefined) dispose().catch(() => undefined)
    } else {
      try {
        await adapters.dispose?.()
      } catch (error) {
        disposeThrew = true
        disposeError = error
      }
    }
  }

  if (pipelineThrew) throw pipelineError
  if (pipelineResult === undefined) throw new Error('integration pipeline returned no result')
  if (disposeThrew && pipelineResult.ok) return failure('cleanup', disposeError)
  return pipelineResult
}
