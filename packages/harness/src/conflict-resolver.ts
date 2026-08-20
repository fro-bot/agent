/**
 * Conflict repair is a bounded model-turn boundary, not a sandbox.
 *
 * The model runs inside the runner trust boundary with a short-lived,
 * model-scoped broker credential. Its checkout is disposable and its
 * filesystem is never artifact authority: code extracts only validated bytes
 * from the declared conflict paths, then applies those bytes to the real
 * integration merge state.
 */

import {execFile} from 'node:child_process'
import crypto from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'
import {formatPipelineError} from './format-error.js'

const execFileAsync = promisify(execFile)

// Runners have no global git identity, so every commit-producing invocation
// carries its own. Matches DEFAULT_AUTHOR in src/features/delegated/types.ts;
// the harness package is standalone and cannot import it.
export const HARNESS_GIT_IDENTITY = [
  '-c',
  'user.name=Fro Bot',
  '-c',
  'user.email=fro-bot[bot]@users.noreply.github.com',
] as const

export const MAX_CONFLICT_RESOLUTION_ATTEMPTS = 2
export const MAX_CONFLICT_FILE_BYTES = 1_048_576
export const MAX_CONFLICT_PAYLOAD_BYTES = 4 * 1_048_576
export const MAX_CONFLICT_CONTEXT_BYTES = 48 * 1024
export const MAX_CONFLICT_CONTEXT_FILES = 8
export const MAX_CONFLICT_CONTEXT_REQUESTS = 8
export const DEFAULT_CONFLICT_MODEL_TIMEOUT_MS = 30 * 60 * 1000
/** Default model timeout for conflict resolution during a dry run. */
export const DEFAULT_DRY_RUN_CONFLICT_MODEL_TIMEOUT_MS = 5 * 60 * 1000
const MODEL_OUTPUT_MAX_BUFFER = 8 * 1024 * 1024

const RUNTIME_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'CI',
  'RUNNER_TEMP',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NO_COLOR',
] as const

type PermissionAction = 'allow' | 'deny'

export interface ConflictReadOnlyContext {
  readonly path: string
  readonly content: string
}

export interface ConflictResolutionRequest {
  readonly integrationWorkDir: string
  readonly runnerTempDir?: string
  readonly preConflictCommit: string
  readonly mergeRef: string
  readonly sourceLabel: string
  readonly conflictPaths: readonly string[]
  readonly conflictMessage: string
  readonly agent: string
  readonly model: string
  readonly opencodeBin: string
  /** Short-lived broker-minted model auth JSON. Never passed through env. */
  readonly brokerAuthJson?: string
  readonly readOnlyContext?: readonly ConflictReadOnlyContext[]
}

export interface ConflictModelTurn {
  readonly attempt: number
  readonly workDir: string
  readonly prompt: string
  readonly env: NodeJS.ProcessEnv
  readonly allowedPaths: readonly string[]
  readonly authPath: string
  readonly configContent: string
}

export interface ConflictModelOutcome {
  readonly contextRequests?: readonly string[]
}

export type ConflictModelRunner = (turn: ConflictModelTurn) => Promise<ConflictModelOutcome | void>

export interface ConflictResolverLogger {
  readonly debug: (message: string, context?: Readonly<Record<string, unknown>>) => void
  readonly warning: (message: string, context?: Readonly<Record<string, unknown>>) => void
}

const silentLogger: ConflictResolverLogger = {
  debug: () => {},
  warning: () => {},
}

export interface ConflictResolverOptions {
  readonly runModel?: ConflictModelRunner
  readonly reassessReadOnlyContext?: (
    request: ConflictResolutionRequest,
    requests: readonly string[],
  ) => Promise<readonly ConflictReadOnlyContext[]>
  /** Test seam for proving cleanup failure is fail-closed. */
  readonly removeAttempt?: (attemptRoot: string) => Promise<void>
  readonly modelTimeoutMs?: number
  readonly logger?: ConflictResolverLogger
}

export interface ConflictResolverDiagnostics {
  readonly attempt: number
  readonly conflictPathCount: number
  readonly conflictSize: number
  readonly outOfScopeContextRequests: readonly string[]
  readonly validationViolations: readonly string[]
}

export type ConflictResolverResult =
  | {
      readonly ok: true
      readonly attempts: number
      readonly resolvedPaths: readonly string[]
      readonly resolvedDigests: Readonly<Record<string, string>>
      readonly diagnostics: readonly ConflictResolverDiagnostics[]
    }
  | {
      readonly ok: false
      readonly attempts: number
      readonly error: string
      readonly diagnostics: readonly ConflictResolverDiagnostics[]
    }

interface AttemptWorkspace {
  readonly root: string
  readonly workDir: string
  readonly home: string
  readonly xdgConfigHome: string
  readonly xdgDataHome: string
  readonly xdgStateHome: string
  readonly xdgCacheHome: string
  readonly authPath: string
}

interface AllowedBaseline {
  readonly path: string
  readonly digest: string
  readonly bytes: number
}

interface AcceptedBlob {
  readonly path: string
  readonly content: Uint8Array
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function normalizeRepositoryPath(value: string): string | null {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    path.posix.isAbsolute(value) ||
    /^[a-z]:(?:$|\/)/i.test(value)
  )
    return null
  const rawSegments = value.split('/')
  if (rawSegments.some(segment => segment === '.' || segment === '..' || segment === '.git')) return null
  const normalized = path.posix.normalize(value)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    normalized.split('/').includes('.git')
  ) {
    return null
  }
  return normalized
}

function safeRelativePath(value: string): string {
  const normalized = normalizeRepositoryPath(value)
  if (normalized === null) throw new Error(`unsafe conflict path: ${value}`)
  return normalized
}

function normalizedAllowedPaths(paths: readonly string[]): string[] {
  const normalized = paths.map(safeRelativePath)
  const unique = uniqueSorted(normalized)
  if (unique.length !== normalized.length) throw new Error('conflict paths must be unique')
  if (unique.length === 0) throw new Error('conflict resolver received an empty conflict path set')
  return unique
}

function digestBytes(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length === 0 || (!relative.startsWith('..') && path.isAbsolute(relative) === false)
}

async function assertRealDirectory(directory: string, label: string): Promise<string> {
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || stat.isDirectory() === false) throw new Error(`${label} must be a real directory`)
  return fs.realpath(directory)
}

function permissionRules(workDir: string, allowedPaths: readonly string[]): Record<string, PermissionAction> {
  const rules: Record<string, PermissionAction> = {}
  for (const relative of allowedPaths) {
    rules[relative] = 'allow'
    rules[path.join(workDir, relative)] = 'allow'
  }
  return rules
}

/**
 * Build the smallest OpenCode config used by the resolver.
 * Object insertion order is intentional: OpenCode resolves last-match-wins.
 */
export function buildConflictResolverConfig(
  workDir: string,
  allowedPaths: readonly string[],
  agent = 'build',
): Readonly<Record<string, unknown>> {
  const normalized = normalizedAllowedPaths(allowedPaths)
  const allowed = permissionRules(workDir, normalized)
  const permission = {
    '*': 'deny' as const,
    read: allowed,
    edit: allowed,
    glob: allowed,
    grep: allowed,
    bash: 'deny' as const,
    web: 'deny' as const,
    webfetch: 'deny' as const,
    websearch: 'deny' as const,
    task: 'deny' as const,
    skill: 'deny' as const,
    question: 'deny' as const,
    external_directory: 'deny' as const,
  }
  return {
    permission,
    agent: {[agent]: {permission}},
    plugin: [],
    autoupdate: false,
  }
}

function buildRuntimeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of RUNTIME_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

interface BuildEnvironmentOptions {
  readonly source: NodeJS.ProcessEnv
  readonly workspace: AttemptWorkspace
  readonly configContent: string
  readonly attempt: number
  readonly allowedPaths: readonly string[]
  readonly sourceLabel: string
}

/** Build env without copying provider keys or the caller's OpenCode config. */
export function buildConflictResolverEnv(options: BuildEnvironmentOptions): NodeJS.ProcessEnv {
  const result = buildRuntimeEnv(options.source)
  // Model turns use the private attempt sandbox as HOME.
  result.HOME = options.workspace.home
  result.XDG_CONFIG_HOME = options.workspace.xdgConfigHome
  result.XDG_DATA_HOME = options.workspace.xdgDataHome
  result.XDG_STATE_HOME = options.workspace.xdgStateHome
  result.XDG_CACHE_HOME = options.workspace.xdgCacheHome
  result.RUNNER_TEMP = options.workspace.root
  result.TMPDIR = options.workspace.root
  result.TMP = options.workspace.root
  result.TEMP = options.workspace.root
  result.PWD = options.workspace.workDir
  delete result.OPENCODE_CONFIG
  delete result.OPENCODE_CONFIG_DIR
  result.OPENCODE_CONFIG_CONTENT = options.configContent
  result.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
  result.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1'
  result.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1'
  result.OPENCODE_DISABLE_LSP_DOWNLOAD = '1'
  result.FRO_BOT_CONFLICT_ATTEMPT = String(options.attempt)
  result.FRO_BOT_CONFLICT_PATHS = options.allowedPaths.join('\n')
  result.FRO_BOT_CONFLICT_SOURCE = options.sourceLabel
  result.GIT_TERMINAL_PROMPT = '0'
  result.GIT_CONFIG_NOSYSTEM = '1'
  result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  result.GIT_OPTIONAL_LOCKS = '0'
  delete result.GIT_ASKPASS
  delete result.SSH_ASKPASS
  delete result.GIT_SSH_COMMAND
  return result
}

function resolverGitEnv(): NodeJS.ProcessEnv {
  const source = process.env
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? '',
    // Internal Git plumbing uses a nonexistent HOME to exclude ambient config.
    HOME: process.platform === 'win32' ? 'NUL' : '/nonexistent',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
  }
  return env
}

async function gitOutput(root: string | undefined, args: readonly string[], maxBuffer = 1_048_576): Promise<string> {
  const result = await execFileAsync(
    'git',
    ['-c', 'credential.helper=', '-c', 'core.askPass=', ...HARNESS_GIT_IDENTITY, ...args],
    {
      cwd: root,
      env: resolverGitEnv(),
      encoding: 'utf8',
      maxBuffer,
    },
  )
  return result.stdout
}

async function gitRun(root: string | undefined, args: readonly string[], cwd = root): Promise<void> {
  await execFileAsync('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', ...HARNESS_GIT_IDENTITY, ...args], {
    cwd,
    env: resolverGitEnv(),
    encoding: 'utf8',
    maxBuffer: 1_048_576,
  })
}

function lines(value: string): string[] {
  return uniqueSorted(
    value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0),
  )
}

async function unmergedPaths(root: string): Promise<string[]> {
  return lines(await gitOutput(root, ['diff', '--name-only', '--diff-filter=U']))
}

function isExecTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('killed' in error)) return false
  return error.killed === true
}

function buildConflictPrompt(
  request: ConflictResolutionRequest,
  allowedPaths: readonly string[],
  diffs: readonly string[],
): string {
  const context = [
    'Objective: repair the current merge conflict by editing only the listed native files.',
    'Do not produce a patch, shell transcript, release summary, push, or authentication action.',
    'The runner performs validation, staging, merge completion, build, provenance, and push.',
    'If more context is required, record one relative path per line in .harness-context-request and stop.',
    `source: ${request.sourceLabel}`,
    `pre-conflict commit: ${request.preConflictCommit}`,
    `merge ref: ${request.mergeRef}`,
    `merge diagnostic: ${request.conflictMessage}`,
    'conflict paths:',
    ...allowedPaths.map(value => `- ${value}`),
    ...diffs,
    ...(request.readOnlyContext === undefined || request.readOnlyContext.length === 0
      ? []
      : ['read-only context:', ...request.readOnlyContext.flatMap(file => [`--- ${file.path} ---`, file.content])]),
  ].join('\n')
  const bytes = new TextEncoder().encode(context).byteLength
  if (bytes > MAX_CONFLICT_CONTEXT_BYTES) throw new Error('conflict resolver context exceeds the configured cap')
  return context
}

async function buildConflictContext(
  request: ConflictResolutionRequest,
  workDir: string,
  allowedPaths: readonly string[],
): Promise<string> {
  if (request.readOnlyContext !== undefined && request.readOnlyContext.length > MAX_CONFLICT_CONTEXT_FILES) {
    throw new Error('read-only conflict context exceeds the file bound')
  }
  for (const file of request.readOnlyContext ?? []) safeRelativePath(file.path)
  const diffs: string[] = []
  for (const relative of allowedPaths) {
    const diff = await gitOutput(workDir, ['diff', '--cc', '--unified=40', '--', relative], MAX_CONFLICT_CONTEXT_BYTES)
    diffs.push(`--- ${relative} ---\n${diff}`)
  }
  return buildConflictPrompt(request, allowedPaths, diffs)
}

async function runOpenCodeModel(
  turn: ConflictModelTurn,
  request: ConflictResolutionRequest,
  timeoutMs: number,
): Promise<ConflictModelOutcome> {
  try {
    await execFileAsync(request.opencodeBin, ['run', '--agent', request.agent, '--model', request.model, turn.prompt], {
      cwd: turn.workDir,
      env: turn.env,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MODEL_OUTPUT_MAX_BUFFER,
    })
  } catch (error) {
    if (isExecTimeout(error)) throw new Error(`conflict resolver model timed out after ${timeoutMs}ms`)
    throw new Error(`conflict resolver model process failed: ${formatPipelineError(error)}`)
  }
  return {}
}

async function createAttemptRoot(request: ConflictResolutionRequest, attempt: number): Promise<string> {
  const runnerTemp = request.runnerTempDir ?? process.env.RUNNER_TEMP
  if (runnerTemp === undefined || runnerTemp.length === 0)
    throw new Error('RUNNER_TEMP is required for conflict resolution')
  const runnerTempReal = await assertRealDirectory(runnerTemp, 'RUNNER_TEMP')
  const integrationReal = await assertRealDirectory(request.integrationWorkDir, 'integration worktree')
  const attemptRoot = await fs.mkdtemp(path.join(runnerTempReal, `fro-bot-conflict-${attempt}-`))
  const attemptReal = await fs.realpath(attemptRoot)
  if (isPathWithin(integrationReal, attemptReal)) {
    await fs.rm(attemptRoot, {recursive: true, force: true})
    throw new Error('resolver scratch must be outside the integration worktree')
  }
  return attemptRoot
}

async function prepareAttemptWorkspace(attemptRoot: string, brokerAuthJson: string): Promise<AttemptWorkspace> {
  const workDir = path.join(attemptRoot, 'repo')
  const home = path.join(attemptRoot, 'home')
  const xdgConfigHome = path.join(attemptRoot, 'xdg-config')
  const xdgDataHome = path.join(attemptRoot, 'xdg-data')
  const xdgStateHome = path.join(attemptRoot, 'xdg-state')
  const xdgCacheHome = path.join(attemptRoot, 'xdg-cache')
  await Promise.all([
    fs.mkdir(home, {recursive: true}),
    fs.mkdir(xdgConfigHome, {recursive: true}),
    fs.mkdir(xdgDataHome, {recursive: true}),
    fs.mkdir(xdgStateHome, {recursive: true}),
    fs.mkdir(xdgCacheHome, {recursive: true}),
  ])
  await Promise.all(
    [home, xdgConfigHome, xdgDataHome, xdgStateHome, xdgCacheHome].map(async directory => fs.chmod(directory, 0o700)),
  )
  const authPath = path.join(xdgDataHome, 'opencode', 'auth.json')
  await fs.mkdir(path.dirname(authPath), {recursive: true})
  await fs.chmod(path.dirname(authPath), 0o700)
  await fs.writeFile(authPath, brokerAuthJson, {encoding: 'utf8', mode: 0o600})
  await fs.chmod(authPath, 0o600)
  return {root: attemptRoot, workDir, home, xdgConfigHome, xdgDataHome, xdgStateHome, xdgCacheHome, authPath}
}

async function recreateConflictAttempt(
  request: ConflictResolutionRequest,
  workspace: AttemptWorkspace,
  allowedPaths: readonly string[],
): Promise<ReadonlyMap<string, AllowedBaseline>> {
  const sourceMergeCommit = (
    await gitOutput(request.integrationWorkDir, ['rev-parse', `${request.mergeRef}^{commit}`])
  ).trim()
  await gitRun(
    undefined,
    [
      'clone',
      '--no-local',
      '--no-hardlinks',
      '--no-tags',
      '--no-checkout',
      request.integrationWorkDir,
      workspace.workDir,
    ],
    path.dirname(workspace.workDir),
  )
  await gitRun(workspace.workDir, [
    'fetch',
    '--no-tags',
    'origin',
    `${request.preConflictCommit}:refs/harness/pre-conflict`,
  ])
  await gitRun(workspace.workDir, ['fetch', '--no-tags', 'origin', `${sourceMergeCommit}:refs/harness/conflict-source`])
  await gitRun(workspace.workDir, ['checkout', '--quiet', '--detach', 'refs/harness/pre-conflict'])
  try {
    await gitRun(workspace.workDir, ['merge', '--no-ff', '--no-edit', 'refs/harness/conflict-source'])
  } catch (error) {
    if ((await unmergedPaths(workspace.workDir)).length === 0) throw error
  }

  const actualPaths = await unmergedPaths(workspace.workDir)
  if (actualPaths.length !== allowedPaths.length || actualPaths.some((value, index) => value !== allowedPaths[index])) {
    throw new Error(`recreated merge conflict set differs from the declared set: ${actualPaths.join(', ')}`)
  }
  await gitRun(workspace.workDir, ['remote', 'remove', 'origin'])

  const baselines = new Map<string, AllowedBaseline>()
  for (const relative of allowedPaths) {
    const bytes = await readRegularFile(workspace.workDir, relative)
    baselines.set(relative, {path: relative, digest: digestBytes(bytes), bytes: bytes.byteLength})
  }
  return baselines
}

async function openRegularFile(
  root: string,
  relative: string,
  flags: number,
): Promise<import('node:fs/promises').FileHandle> {
  const normalized = safeRelativePath(relative)
  const parts = normalized.split('/')
  let current = root
  // Node does not expose openat, so parent-component traversal remains a path-based
  // check with a residual race. The final component is opened with O_NOFOLLOW and
  // read or write through that handle to close the check-then-access gap at the boundary.
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`conflict path follows a symlink: ${relative}`)
    if (part !== parts.at(-1) && stat.isDirectory() === false) {
      throw new Error(`conflict path has a non-directory parent: ${relative}`)
    }
  }
  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await fs.open(current, flags, 0o666)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw new Error(`conflict path follows a symlink: ${relative}`)
    }
    throw error
  }
  try {
    const finalStat = await handle.stat()
    if (finalStat.isFile() === false) throw new Error(`conflict path is not a regular file: ${relative}`)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readRegularFile(root: string, relative: string): Promise<Uint8Array> {
  const handle = await openRegularFile(root, relative, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function writeRegularFile(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  const handle = await openRegularFile(
    root,
    relative,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
  )
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}

function hasConflictMarker(bytes: Uint8Array): boolean {
  const markers = [
    new Uint8Array([60, 60, 60, 60, 60, 60, 60]),
    new Uint8Array([61, 61, 61, 61, 61, 61, 61]),
    new Uint8Array([62, 62, 62, 62, 62, 62, 62]),
    new Uint8Array([124, 124, 124, 124, 124, 124, 124]),
  ]
  let lineStart = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 10) continue
    let contentStart = lineStart
    const contentEnd = index > lineStart && bytes[index - 1] === 13 ? index - 1 : index
    while (contentStart < contentEnd && (bytes[contentStart] === 32 || bytes[contentStart] === 9)) contentStart++
    for (const marker of markers) {
      if (contentEnd - contentStart < marker.length) continue
      let matches = true
      for (const [markerIndex, element] of marker.entries()) {
        if (bytes[contentStart + markerIndex] !== element) matches = false
      }
      if (
        matches &&
        (contentEnd - contentStart === marker.length ||
          bytes[contentStart + marker.length] === 32 ||
          bytes[contentStart + marker.length] === 9)
      ) {
        return true
      }
    }
    lineStart = index + 1
  }
  return false
}

function validateConflictBytes(relative: string, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_CONFLICT_FILE_BYTES) throw new Error(`conflict file exceeds size cap: ${relative}`)
  if (bytes.includes(0)) throw new Error(`conflict file contains NUL/binary content: ${relative}`)
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new Error(`conflict file is UTF-16: ${relative}`)
  }
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(bytes)
  } catch {
    throw new Error(`conflict file is not valid UTF-8: ${relative}`)
  }
  if (hasConflictMarker(bytes)) throw new Error(`conflict markers remain: ${relative}`)
}

async function extractAcceptedBlobs(
  workDir: string,
  allowedPaths: readonly string[],
  baselines: ReadonlyMap<string, AllowedBaseline>,
): Promise<{readonly blobs: readonly AcceptedBlob[]; readonly conflictSize: number}> {
  const blobs: AcceptedBlob[] = []
  let totalBytes = 0
  let conflictSize = 0
  for (const relative of allowedPaths) {
    const bytes = await readRegularFile(workDir, relative)
    const baseline = baselines.get(relative)
    if (baseline === undefined) throw new Error(`missing conflict baseline: ${relative}`)
    conflictSize += baseline.bytes
    if (digestBytes(bytes) === baseline.digest) throw new Error(`conflict path was not edited: ${relative}`)
    validateConflictBytes(relative, bytes)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_CONFLICT_PAYLOAD_BYTES) throw new Error('conflict payload exceeds size cap')
    blobs.push({path: relative, content: bytes})
  }
  return {blobs, conflictSize}
}

function normalizeContextRequestPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('context request path must be a string')
  const normalized = normalizeRepositoryPath(value.trim())
  if (normalized === null) throw new Error(`unsafe context request path: ${value}`)
  return normalized
}

function normalizeContextRequests(values: readonly unknown[]): string[] {
  const normalized = uniqueSorted(values.map(normalizeContextRequestPath))
  if (normalized.length > MAX_CONFLICT_CONTEXT_REQUESTS) {
    throw new Error('conflict context request count exceeds the configured cap')
  }
  return normalized
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

async function readContextRequests(workDir: string): Promise<string[]> {
  const requestPath = path.join(workDir, '.harness-context-request')
  try {
    const content = await fs.readFile(requestPath, 'utf8')
    return normalizeContextRequests(
      content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0),
    )
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

async function applyAcceptedBlobs(integrationWorkDir: string, blobs: readonly AcceptedBlob[]): Promise<void> {
  for (const blob of blobs) await writeRegularFile(integrationWorkDir, blob.path, blob.content)
}

function failure(
  attempts: number,
  error: string,
  diagnostics: readonly ConflictResolverDiagnostics[],
): ConflictResolverResult {
  return {ok: false, attempts, error, diagnostics}
}

/** Resolves one merge conflict with at most two fresh disposable attempts. */
export async function resolveConflict(
  request: ConflictResolutionRequest,
  options: ConflictResolverOptions = {},
): Promise<ConflictResolverResult> {
  let allowedPaths: string[]
  try {
    allowedPaths = normalizedAllowedPaths(request.conflictPaths)
  } catch (error) {
    return failure(0, formatPipelineError(error), [])
  }
  if (request.brokerAuthJson === undefined || request.brokerAuthJson.length === 0) {
    return failure(0, 'short-lived broker model auth JSON is required', [])
  }

  const logger = options.logger ?? silentLogger
  const removeAttempt =
    options.removeAttempt ?? (async (attemptRoot: string) => fs.rm(attemptRoot, {recursive: true, force: true}))
  const timeoutMs = options.modelTimeoutMs ?? DEFAULT_CONFLICT_MODEL_TIMEOUT_MS
  const diagnostics: ConflictResolverDiagnostics[] = []
  let readOnlyContext = request.readOnlyContext ?? []
  let lastError = 'conflict resolver did not produce a valid repair'

  for (let attempt = 1; attempt <= MAX_CONFLICT_RESOLUTION_ATTEMPTS; attempt++) {
    let attemptRoot: string | undefined
    let acceptedBlobs: readonly AcceptedBlob[] | undefined
    let conflictSize = 0
    let contextRequests: string[] = []
    let attemptError: string | undefined
    try {
      attemptRoot = await createAttemptRoot(request, attempt)
      const workspace = await prepareAttemptWorkspace(attemptRoot, request.brokerAuthJson)
      const attemptRequest: ConflictResolutionRequest = {...request, readOnlyContext}
      const baselines = await recreateConflictAttempt(attemptRequest, workspace, allowedPaths)
      const configContent = JSON.stringify(buildConflictResolverConfig(workspace.workDir, allowedPaths, request.agent))
      const env = buildConflictResolverEnv({
        source: process.env,
        workspace,
        configContent,
        attempt,
        allowedPaths,
        sourceLabel: request.sourceLabel,
      })
      const prompt = await buildConflictContext(attemptRequest, workspace.workDir, allowedPaths)
      const turn: ConflictModelTurn = {
        attempt,
        workDir: workspace.workDir,
        prompt,
        env,
        allowedPaths,
        authPath: workspace.authPath,
        configContent,
      }
      const modelOutcome =
        options.runModel === undefined
          ? await runOpenCodeModel(turn, attemptRequest, timeoutMs)
          : await options.runModel(turn)
      contextRequests = normalizeContextRequests([
        ...(modelOutcome?.contextRequests ?? []),
        ...(await readContextRequests(workspace.workDir)),
      ])
      if (contextRequests.length > 0) throw new Error(`out-of-scope context requested: ${contextRequests.join(', ')}`)
      const extracted = await extractAcceptedBlobs(workspace.workDir, allowedPaths, baselines)
      acceptedBlobs = extracted.blobs
      conflictSize = extracted.conflictSize
    } catch (error) {
      attemptError = formatPipelineError(error)
      lastError = attemptError
    }

    let cleanupError: string | undefined
    if (attemptRoot !== undefined) {
      try {
        await removeAttempt(attemptRoot)
      } catch (error) {
        cleanupError = `failed to destroy conflict resolver scratch: ${formatPipelineError(error)}`
        lastError = cleanupError
      }
    }
    if (cleanupError !== undefined) {
      diagnostics.push({
        attempt,
        conflictPathCount: allowedPaths.length,
        conflictSize,
        outOfScopeContextRequests: contextRequests,
        validationViolations: [cleanupError],
      })
      return failure(attempt, cleanupError, diagnostics)
    }

    const validationViolations = attemptError === undefined ? [] : [attemptError]
    diagnostics.push({
      attempt,
      conflictPathCount: allowedPaths.length,
      conflictSize,
      outOfScopeContextRequests: contextRequests,
      validationViolations,
    })

    if (acceptedBlobs !== undefined) {
      try {
        await applyAcceptedBlobs(request.integrationWorkDir, acceptedBlobs)
      } catch (error) {
        const applyError = `failed to apply validated conflict blobs: ${formatPipelineError(error)}`
        return failure(attempt, applyError, diagnostics)
      }
      logger.debug('validated conflict repair', {attempt, conflictPathCount: allowedPaths.length})
      return {
        ok: true,
        attempts: attempt,
        resolvedPaths: allowedPaths,
        resolvedDigests: Object.fromEntries(acceptedBlobs.map(blob => [blob.path, digestBytes(blob.content)])),
        diagnostics,
      }
    }

    if (contextRequests.length > 0 && attempt < MAX_CONFLICT_RESOLUTION_ATTEMPTS) {
      if (options.reassessReadOnlyContext === undefined) {
        lastError = `${lastError}; no trusted read-only context reassessment was provided`
      } else {
        try {
          readOnlyContext = await options.reassessReadOnlyContext(request, contextRequests)
        } catch (error) {
          lastError = formatPipelineError(error)
        }
      }
    }
    logger.warning('rejected conflict repair attempt', {attempt, violationCount: validationViolations.length})
  }

  return failure(
    MAX_CONFLICT_RESOLUTION_ATTEMPTS,
    `conflict resolver exhausted ${MAX_CONFLICT_RESOLUTION_ATTEMPTS} attempts: ${lastError}`,
    diagnostics,
  )
}
