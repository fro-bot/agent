/**
 * Repository skills for trusted OpenCode V2 runs (fro-bot/agent#2129).
 *
 * The repository's `.agents/skills` is never read in place, and the checkout is never a source. Project discovery stays
 * disabled (`OPENCODE_DISABLE_PROJECT_CONFIG=1`); what the model gets is a run-scoped COPY, built by this module, that
 * the CI config names through `skills.paths`:
 *
 * 1. `stageDefaultBranchSkills` fetches the default branch fresh from the base repository into a throwaway repository
 *    and extracts `.agents/skills` from that exact commit with `git archive`. No ref, config or object in the checkout
 *    is read or changed, so an earlier workflow step cannot plant or age the revision, and the PR head or a dispatched
 *    branch is never a source.
 * 2. `admitRepoSkills` copies only real skill directories: `<id>/SKILL.md` plus that directory's regular files. A symlink
 *    at any level rejects the skill and is never followed. Total size and file count are bounded. A skill whose
 *    directory name collides with a bundled Systematic skill or an OpenCode built-in is skipped, so a repository cannot
 *    shadow one.
 * 3. The copy lives under `RUNNER_TEMP`, outside the checkout and every cached path, and the run removes it at the end.
 *
 * Nothing here logs file contents. A skipped skill is named by its id only.
 */

import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../../shared/logger.js'
import type {ExecAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {err, ok} from '@bfra.me/es/result'

/** Where the repository keeps its skills, relative to the repository root. */
const SKILLS_SEGMENTS = ['.agents', 'skills'] as const
const SKILLS_GIT_PATH = SKILLS_SEGMENTS.join('/')

/** The directory inside a staging root that `skills.paths` points at. */
export const REPO_SKILLS_DIRECTORY_NAME = 'skills'
const EXTRACT_DIRECTORY_NAME = 'source-tree'
const FETCH_REPOSITORY_NAME = 'fetch.git'
const ARCHIVE_FILE_NAME = 'source.tar'
/** Every staging root's directory name starts with this; removal refuses a path that does not. */
export const REPO_SKILLS_STAGING_PREFIX = 'fro-bot-repo-skills-'

export interface RepoSkillsLimits {
  /** Files copied across all admitted skills. */
  readonly maxFiles: number
  /** Bytes copied across all admitted skills. */
  readonly maxBytes: number
  /** Directory depth below a skill directory (OpenCode's scanner stops at 6). */
  readonly maxDepth: number
  /** Bound on each git or tar command. */
  readonly commandTimeoutMs: number
}

export const DEFAULT_REPO_SKILLS_LIMITS: RepoSkillsLimits = {
  maxFiles: 500,
  maxBytes: 5 * 1024 * 1024,
  maxDepth: 6,
  commandTimeoutMs: 60_000,
}

/**
 * Skills the OpenCode server registers itself (`GET /api/skill` on the pinned 2.2.6, before any repo skill). Like the
 * bundled Systematic skills, a repo skill registered under one of these ids would replace it, so they are reserved too.
 * The integration test checks this list against the live server, so a pin bump that adds one fails there.
 */
export const OPENCODE_BUILTIN_SKILL_IDS = ['browser', 'opencode', 'report'] as const

/**
 * A skill id is its directory name: a plain identifier with nothing a path, a glob or a log line could misread. OpenCode
 * registers a `skills.paths` skill under this directory name and never under the frontmatter `name`, which is display
 * text only (verified on 2.2.6 by the real-binary test), so the frontmatter is not read for repo skills.
 */
const SAFE_SKILL_ID = /^[A-Z0-9][\w.-]{0,63}$/i

/** Git ref name characters the default branch may use. Anything else is refused before git runs. */
const SAFE_BRANCH_NAME = /^\w[\w./-]{0,199}$/
const SAFE_REPOSITORY = /^\w[\w.-]*\/\w[\w.-]*$/
const SAFE_REF_KEY = /^[\w.-]+$/

function isWildcardFree(directory: string): boolean {
  return !/[*?]/.test(directory)
}

/** A directory name as it may appear in a log: the plain-identifier characters only, so a hostile name cannot add lines. */
function displayId(name: string): string {
  return name.replaceAll(/[^\w.-]/g, '?').slice(0, 64)
}

/** Skill ids compared the way a human reads them: `ce:review` and `ce-review` are one skill. */
function canonicalName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fsp.rm(target, {recursive: true, force: true})
  } catch {
    // Best effort: the staging root is removed again at the end of the run.
  }
}

// --- Staging root -----------------------------------------------------------------------------------------------------

/**
 * A fresh run-scoped directory (mode 0700) under the real `RUNNER_TEMP`. The path is the real one, so the skill base
 * directory the server reports matches the permission exception built from it. Refuses a path with `*` or `?`: the
 * permission rules read those as wildcards.
 */
export function createRepoSkillsStagingRoot(runnerTemp: string | undefined): Result<string, string> {
  const trimmed = runnerTemp?.trim() ?? ''
  if (trimmed.length === 0) return err('RUNNER_TEMP is not set; repo skills have no safe place to be staged')
  if (!path.isAbsolute(trimmed)) return err('RUNNER_TEMP must be an absolute path; repo skills have no safe place')
  let realTemp: string
  try {
    realTemp = fs.realpathSync(trimmed)
  } catch {
    return err('RUNNER_TEMP does not exist; repo skills have no safe place to be staged')
  }
  if (!isWildcardFree(realTemp)) {
    return err('RUNNER_TEMP contains a wildcard character (* or ?), which the permission rules would misread')
  }
  try {
    const created = fs.mkdtempSync(path.join(realTemp, REPO_SKILLS_STAGING_PREFIX))
    fs.chmodSync(created, 0o700)
    return ok(created)
  } catch {
    return err('Could not create the repo skills staging directory under RUNNER_TEMP')
  }
}

/**
 * Removes a staging root at the end of a run. Never throws: a failure is a warning, since the runner's own temp cleanup
 * is the backstop. Refuses any path that is not a staging root, so a bad value cannot delete something else.
 */
export async function removeRepoSkillsStagingRoot(
  stagingRoot: string | null,
  logger: Logger,
  remove: (target: string) => Promise<void> = async target => fsp.rm(target, {recursive: true, force: true}),
): Promise<void> {
  if (stagingRoot === null) return
  if (!path.basename(stagingRoot).startsWith(REPO_SKILLS_STAGING_PREFIX)) {
    logger.warning('Refusing to remove a repo skills staging directory with an unexpected name')
    return
  }
  try {
    await remove(stagingRoot)
  } catch (error) {
    logger.warning('Could not remove the repo skills staging directory', {
      error: (error as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
}

// --- Source -----------------------------------------------------------------------------------------------------------

export interface StageDefaultBranchSkillsOptions {
  readonly exec: ExecAdapter
  /** The base repository, `owner/repo`. */
  readonly repository: string
  /** The repository's default branch name, from the API. Validated before it reaches git. */
  readonly defaultBranch: string
  /** The run-scoped root from `createRepoSkillsStagingRoot`. Also names the private ref, so it is unique per run. */
  readonly stagingRoot: string
  readonly logger: Logger
  /** The environment git runs with. Defaults to the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The server the repository lives on. Defaults to `GITHUB_SERVER_URL`, else `https://github.com`. */
  readonly serverUrl?: string
  /** Authenticates the fetch from a private repository. Sent in the environment, never argv. */
  readonly githubToken?: string
  readonly limits?: Partial<RepoSkillsLimits>
}

/** Variables that would point git at a repository other than the one named on the command line. */
const REDIRECTING_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
] as const

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !(REDIRECTING_GIT_ENV as readonly string[]).includes(key)) result[key] = value
  }
  return result
}

function isSafeBranchName(branch: string): boolean {
  return (
    SAFE_BRANCH_NAME.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.includes('@{') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.lock') &&
    !branch.endsWith('.')
  )
}

/** `GIT_CONFIG_*` entries that add one scoped `Authorization` header, appended after any the runner already set. */
function withAuthHeader(env: Record<string, string>, origin: string, token: string): Record<string, string> {
  const parsedCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10)
  const index = Number.isNaN(parsedCount) || parsedCount < 0 ? 0 : parsedCount
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${origin}/.extraheader`,
    [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

type CommandOutcome =
  {readonly kind: 'exited'; readonly code: number; readonly stdout: string} | {readonly kind: 'timed-out'}

/**
 * Stages the default branch's `.agents/skills` into `<stagingRoot>/source-tree`. On every call it fetches the branch
 * afresh from the base repository into a private ref (`refs/fro-bot/repo-skills/<key>`) of a throwaway bare repository
 * under the staging root, archives that exact commit, and deletes the throwaway repository. It never runs git in the
 * checkout and never reads a ref that already exists there: the checkout's refs, config (`insteadOf`, hooks) and
 * shallow state are not trusted, and are not changed either.
 *
 * Returns the extracted skills directory, or null when the default branch has none. Every git and tar command is bounded
 * by a timeout; any failure is an error and the caller loads no repo skills.
 */
export async function stageDefaultBranchSkills(
  options: StageDefaultBranchSkillsOptions,
): Promise<Result<string | null, string>> {
  const {exec, repository, defaultBranch, stagingRoot, logger} = options
  const limits = {...DEFAULT_REPO_SKILLS_LIMITS, ...options.limits}
  const execWithTimeout = exec.execWithTimeout
  if (execWithTimeout === undefined) {
    return err('The exec adapter cannot bound commands with a timeout; the default branch skills are not read')
  }
  if (!isSafeBranchName(defaultBranch)) {
    return err('The default branch name is not a plain git branch name; the default branch skills are not read')
  }
  if (!SAFE_REPOSITORY.test(repository)) {
    return err('The repository name is not a plain owner/repo; the default branch skills are not read')
  }
  const refKey = path.basename(stagingRoot)
  if (!SAFE_REF_KEY.test(refKey)) {
    return err('The staging directory name is not usable as a ref name; the default branch skills are not read')
  }

  const env = options.env ?? process.env
  const serverUrl = (options.serverUrl ?? env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/+$/, '')
  let origin: string | null = null
  try {
    const parsed = new URL(serverUrl)
    origin = parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return err('The GitHub server URL is not a valid URL; the default branch skills are not read')
  }

  const baseEnv = {...definedEnv(env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'}
  const fetchEnv =
    options.githubToken !== undefined && options.githubToken.length > 0 && origin !== null
      ? withAuthHeader(baseEnv, origin, options.githubToken)
      : baseEnv
  const remoteUrl = `${serverUrl}/${repository}.git`
  const privateRef = `refs/fro-bot/repo-skills/${refKey}`
  const gitDir = path.join(stagingRoot, FETCH_REPOSITORY_NAME)

  // Always from the staging root: never the workspace.
  const run = async (
    command: string,
    args: string[],
    commandEnv: Record<string, string> = baseEnv,
  ): Promise<CommandOutcome> => {
    const chunks: Buffer[] = []
    const code = await execWithTimeout(command, args, limits.commandTimeoutMs, {
      cwd: stagingRoot,
      env: commandEnv,
      silent: true,
      ignoreReturnCode: true,
      listeners: {stdout: data => chunks.push(Buffer.from(data))},
    })
    return code === 'timed-out'
      ? {kind: 'timed-out'}
      : {kind: 'exited', code, stdout: Buffer.concat(chunks).toString('utf8')}
  }

  const timedOut = (step: string): Result<never, string> =>
    err(`Reading the default branch skills timed out while ${step}`)

  try {
    const initialized = await run('git', ['init', '--bare', '--quiet', gitDir])
    if (initialized.kind === 'timed-out') return timedOut('preparing the fetch')
    if (initialized.code !== 0) return err('Could not prepare the default branch fetch; repo skills are not loaded')

    const git = (...args: string[]): string[] => [`--git-dir=${gitDir}`, ...args]

    const fetched = await run(
      'git',
      git(
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--depth=1',
        remoteUrl,
        `+refs/heads/${defaultBranch}:${privateRef}`,
      ),
      fetchEnv,
    )
    if (fetched.kind === 'timed-out') return timedOut('fetching the default branch')
    if (fetched.code !== 0) return err('Could not fetch the default branch; repo skills are not loaded')

    // Does the default branch have the directory at all? `ls-tree` exits 0 either way.
    const listed = await run('git', git('ls-tree', '--name-only', privateRef, '--', SKILLS_GIT_PATH))
    if (listed.kind === 'timed-out') return timedOut('listing the default branch tree')
    if (listed.code !== 0) return err('Could not list the default branch tree; repo skills are not loaded')
    if (listed.stdout.trim().length === 0) {
      logger.debug('The default branch has no .agents/skills', {defaultBranch})
      return ok(null)
    }

    const archivePath = path.join(stagingRoot, ARCHIVE_FILE_NAME)
    const extractRoot = path.join(stagingRoot, EXTRACT_DIRECTORY_NAME)
    const archived = await run(
      'git',
      git('archive', '--format=tar', `--output=${archivePath}`, privateRef, SKILLS_GIT_PATH),
    )
    if (archived.kind === 'timed-out') return timedOut('archiving the default branch skills')
    if (archived.code !== 0) return err('Could not archive the default branch skills; repo skills are not loaded')

    await fsp.mkdir(extractRoot, {recursive: true, mode: 0o700})
    const extracted = await run('tar', ['-xf', archivePath, '-C', extractRoot])
    if (extracted.kind === 'timed-out') return timedOut('extracting the default branch skills')
    if (extracted.code !== 0) {
      return err('Could not extract the default branch skills archive; repo skills are not loaded')
    }
    return ok(path.join(extractRoot, ...SKILLS_SEGMENTS))
  } catch (error) {
    logger.debug('Reading the default branch skills threw', {error: error instanceof Error ? error.name : 'unknown'})
    return err('Reading the default branch skills failed; repo skills are not loaded')
  } finally {
    // The private ref lives only in this repository; removing it removes the ref and every fetched object.
    await removeQuietly(gitDir)
    await removeQuietly(path.join(stagingRoot, ARCHIVE_FILE_NAME))
  }
}

// --- Admission --------------------------------------------------------------------------------------------------------

export type RepoSkillSkipReason =
  | 'collides-with-bundled'
  | 'copy-failed'
  | 'invalid-id'
  | 'missing-skill-md'
  | 'symlink'
  | 'too-large'
  | 'too-many-files'
  | 'unreadable'
  | 'unsupported-entry'

export interface SkippedRepoSkill {
  readonly id: string
  readonly reason: RepoSkillSkipReason
}

/**
 * What a trusted run hands the V2 server start: where the candidate skills are, and the run-scoped root they are copied
 * into. Admission happens at server start because it needs the installed bundled skills, which exist only after the
 * plugin install.
 */
export interface RepoSkillsSource {
  readonly sourceDir: string
  readonly stagingRoot: string
}

export interface AdmitRepoSkillsOptions {
  /** A directory of `<id>/SKILL.md` candidates: the extracted default-branch tree. */
  readonly sourceDir: string
  /** The run-scoped root from `createRepoSkillsStagingRoot`. Admitted skills land in `<root>/skills`. */
  readonly stagingRoot: string
  /** The installed Systematic skills directory (`resolveSystematicSkillsDirsV2`). Empty refuses the whole feature. */
  readonly bundledSkillsDirectories: readonly string[]
  readonly logger: Logger
  readonly limits?: Partial<RepoSkillsLimits>
}

export interface AdmitRepoSkillsResult {
  /** The directory `skills.paths` should name; null when nothing was admitted. */
  readonly directory: string | null
  /** Admitted skill ids, in order. */
  readonly admitted: readonly string[]
  readonly skipped: readonly SkippedRepoSkill[]
}

/**
 * The `name:` value of a SKILL.md frontmatter block, if any. Used only to read the trusted bundled skills' names; repo
 * skills are checked by directory name.
 */
export function parseFrontmatterName(content: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1]
  if (block === undefined) return undefined
  const value = /^name:(.*)$/m
    .exec(block)?.[1]
    ?.trim()
    .replaceAll(/^["']|["']$/g, '')
  return value === undefined || value.length === 0 ? undefined : value
}

const MAX_SKILL_MD_BYTES = 256 * 1024

async function readSkillName(skillMdPath: string): Promise<string | undefined> {
  try {
    const handle = await fsp.open(skillMdPath, 'r')
    try {
      const buffer = Buffer.alloc(16 * 1024)
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0)
      return parseFrontmatterName(buffer.subarray(0, bytesRead).toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** Canonical ids and names of the bundled and built-in skills; a repo skill matching any of them is refused. */
async function readReservedNames(bundledDirectories: readonly string[]): Promise<Result<ReadonlySet<string>, string>> {
  const reserved = new Set<string>(OPENCODE_BUILTIN_SKILL_IDS.map(canonicalName))
  for (const directory of bundledDirectories) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(directory, {withFileTypes: true})
    } catch {
      return err('The bundled Systematic skills directory is unreadable; repo skills are not loaded')
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      reserved.add(canonicalName(entry.name))
      const name = await readSkillName(path.join(directory, entry.name, 'SKILL.md'))
      if (name !== undefined) reserved.add(canonicalName(name))
    }
  }
  if (reserved.size === OPENCODE_BUILTIN_SKILL_IDS.length) {
    return err('No bundled Systematic skills were found to check repo skill names against; repo skills are not loaded')
  }
  return ok(reserved)
}

interface InventoryFile {
  readonly relativePath: string
  readonly size: number
}

type Inventory =
  | {readonly ok: true; readonly files: readonly InventoryFile[]; readonly bytes: number}
  | {readonly ok: false; readonly reason: RepoSkillSkipReason}

/**
 * Every regular file below a skill directory. Anything that is not a regular file or a directory (a symlink, a socket,
 * a device) rejects the skill; dot entries are skipped like OpenCode's scanner does. Stops early past the bounds so a
 * hostile tree cannot make the walk itself expensive. A directory that cannot be read rejects the skill.
 */
async function inventorySkill(
  skillDir: string,
  limits: RepoSkillsLimits,
  fileCeiling: number,
  byteCeiling: number,
): Promise<Inventory> {
  const files: InventoryFile[] = []
  let bytes = 0

  const walk = async (directory: string, depth: number): Promise<RepoSkillSkipReason | null> => {
    const entries = (await fsp.readdir(directory, {withFileTypes: true})).toSorted((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) return 'symlink'
      if (entry.isDirectory()) {
        if (depth >= limits.maxDepth) return 'too-large'
        const nested = await walk(full, depth + 1)
        if (nested !== null) return nested
        continue
      }
      if (!entry.isFile()) return 'unsupported-entry'
      const {size} = await fsp.lstat(full)
      files.push({relativePath: path.relative(skillDir, full), size})
      bytes += size
      if (files.length > fileCeiling) return 'too-many-files'
      if (bytes > byteCeiling) return 'too-large'
    }
    return null
  }

  try {
    const reason = await walk(skillDir, 0)
    return reason === null ? {ok: true, files, bytes} : {ok: false, reason}
  } catch {
    return {ok: false, reason: 'unreadable'}
  }
}

/** Copies one regular file without following a symlink at the leaf (a swap since the inventory is refused). */
async function copyRegularFile(source: string, destination: string): Promise<void> {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const handle = await fsp.open(source, fs.constants.O_RDONLY | noFollow)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('not a regular file')
    const content = await handle.readFile()
    await fsp.mkdir(path.dirname(destination), {recursive: true, mode: 0o700})
    await fsp.writeFile(destination, content, {flag: 'wx', mode: stats.mode & 0o777})
  } finally {
    await handle.close()
  }
}

/** Removes what a failed admission left behind: the admitted copy and any extracted source tree. */
export async function discardRepoSkillsStaging(stagingRoot: string): Promise<void> {
  await removeQuietly(path.join(stagingRoot, REPO_SKILLS_DIRECTORY_NAME))
  await removeQuietly(path.join(stagingRoot, EXTRACT_DIRECTORY_NAME))
}

/**
 * Copies the admissible skills from `sourceDir` into `<stagingRoot>/skills`. Per skill, in sorted id order: a plain id
 * that collides with no bundled or built-in skill; a real `SKILL.md`; no symlink or special file anywhere; and room left
 * in the file and byte budgets. A refused or unreadable skill is skipped whole and named by id; the rest proceed.
 *
 * Errors (the whole feature is refused, and nothing partial is left) when the source root is a symlink or unreadable, or
 * the bundled skills cannot be listed: without them a shadowing skill cannot be ruled out. Every filesystem call below is
 * guarded, so it does not throw; the caller (`startActionOpenCodeV2`) still catches anything unforeseen.
 */
export async function admitRepoSkills(options: AdmitRepoSkillsOptions): Promise<Result<AdmitRepoSkillsResult, string>> {
  const admitted = await admit(options)
  if (!admitted.success) await discardRepoSkillsStaging(options.stagingRoot)
  return admitted
}

async function admit(options: AdmitRepoSkillsOptions): Promise<Result<AdmitRepoSkillsResult, string>> {
  const {sourceDir, stagingRoot, logger} = options
  const limits = {...DEFAULT_REPO_SKILLS_LIMITS, ...options.limits}

  let sourceStats: fs.Stats
  try {
    sourceStats = await fsp.lstat(sourceDir)
  } catch {
    return err('The repo skills source directory is not readable; repo skills are not loaded')
  }
  if (sourceStats.isSymbolicLink()) return err('The repo skills source is a symbolic link; repo skills are not loaded')
  if (!sourceStats.isDirectory()) return err('The repo skills source is not a directory; repo skills are not loaded')

  const reserved = await readReservedNames(options.bundledSkillsDirectories)
  if (!reserved.success) return reserved

  let entries: fs.Dirent[]
  try {
    entries = (await fsp.readdir(sourceDir, {withFileTypes: true})).toSorted((a, b) => (a.name < b.name ? -1 : 1))
  } catch {
    return err('The repo skills source directory is not readable; repo skills are not loaded')
  }

  const destinationRoot = path.join(stagingRoot, REPO_SKILLS_DIRECTORY_NAME)
  const admitted: string[] = []
  const skipped: SkippedRepoSkill[] = []
  let usedFiles = 0
  let usedBytes = 0

  const skip = (id: string, reason: RepoSkillSkipReason): void => {
    skipped.push({id, reason})
    logger.warning('Skipped a repository skill', {id, reason})
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const id = displayId(entry.name)
    if (entry.isSymbolicLink()) {
      skip(id, 'symlink')
      continue
    }
    // Stray files and OpenCode's flat `*.md` form are not skills here.
    if (!entry.isDirectory()) continue
    // Checked before the id shape: a bundled skill's id is its frontmatter name (`ce:review`), and OpenCode registers a
    // repo skill under its directory name, so a directory named like that would replace the bundled skill.
    if (reserved.data.has(canonicalName(entry.name))) {
      skip(id, 'collides-with-bundled')
      continue
    }
    if (!SAFE_SKILL_ID.test(entry.name)) {
      skip(id, 'invalid-id')
      continue
    }

    const skillDir = path.join(sourceDir, entry.name)
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    let skillMdStats: fs.Stats
    try {
      skillMdStats = await fsp.lstat(skillMdPath)
    } catch {
      skip(id, 'missing-skill-md')
      continue
    }
    if (skillMdStats.isSymbolicLink()) {
      skip(id, 'symlink')
      continue
    }
    if (!skillMdStats.isFile()) {
      skip(id, 'unsupported-entry')
      continue
    }
    if (skillMdStats.size > MAX_SKILL_MD_BYTES) {
      skip(id, 'too-large')
      continue
    }

    const inventory = await inventorySkill(skillDir, limits, limits.maxFiles - usedFiles, limits.maxBytes - usedBytes)
    if (!inventory.ok) {
      skip(id, inventory.reason)
      continue
    }

    const destination = path.join(destinationRoot, entry.name)
    try {
      for (const file of inventory.files) {
        await copyRegularFile(path.join(skillDir, file.relativePath), path.join(destination, file.relativePath))
      }
    } catch {
      await removeQuietly(destination)
      skip(id, 'copy-failed')
      continue
    }

    usedFiles += inventory.files.length
    usedBytes += inventory.bytes
    admitted.push(entry.name)
  }

  // The extracted default-branch tree has done its job; only the admitted copy stays.
  await removeQuietly(path.join(stagingRoot, EXTRACT_DIRECTORY_NAME))
  if (admitted.length === 0) await removeQuietly(destinationRoot)

  return ok({directory: admitted.length === 0 ? null : destinationRoot, admitted, skipped})
}
