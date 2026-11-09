/**
 * Repository skills for trusted OpenCode V2 runs (fro-bot/agent#2129).
 *
 * The repository's `.agents/skills` is never read in place, and the checkout is never a source. Project discovery stays
 * disabled (`OPENCODE_DISABLE_PROJECT_CONFIG=1`); what the model gets is a run-scoped COPY, built by this module, that
 * the CI config names through `skills.paths`:
 *
 * 1. `stageDefaultBranchSkills` fetches the default branch fresh from the base repository into a throwaway repository,
 *    lists `.agents/skills` in that exact commit, checks the listing against a size budget, and only then writes each
 *    listed blob to disk RAW (`git cat-file --batch`). Never `git archive`: it honours committed `.gitattributes`
 *    (`export-subst`, `ident`, `eol`) and can turn a few KiB of stored blobs into megabytes past the budget. No ref, config or object in the checkout
 *    is read or changed, so an earlier workflow step cannot plant or age the revision, and the PR head or a dispatched
 *    branch is never a source.
 * 2. `admitRepoSkills` copies only real skill directories: `<id>/SKILL.md` plus that directory's regular files. A symlink
 *    at any level rejects the skill and is never followed. Total size and file count are bounded. A skill whose
 *    directory name collides with a bundled Systematic skill or an OpenCode built-in is skipped, so a repository cannot
 *    shadow one. A skill is copied into a private scratch directory first and renamed into the directory handed to
 *    `skills.paths` only once complete, so a failed copy is never discoverable.
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
/** Where a skill is copied before it is renamed into the discoverable directory. Never under `skills.paths`. */
const SCRATCH_DIRECTORY_NAME = 'scratch'
/** Every staging root's directory name starts with this; removal refuses a path that does not. */
export const REPO_SKILLS_STAGING_PREFIX = 'fro-bot-repo-skills-'

export interface RepoSkillsLimits {
  /** Files copied across all admitted skills. */
  readonly maxFiles: number
  /**
   * Entries (files, symlinks, submodules AND directories) in the default branch's `.agents/skills` tree, counted before
   * anything is extracted and counting what admission would reject. Twice `maxFiles`: directories are entries here, and a
   * tree at the file limit still has a directory per skill.
   */
  readonly maxSourceEntries: number
  /** Bytes copied across all admitted skills, and the byte budget of the source tree (the same number). */
  readonly maxBytes: number
  /** Directory depth below a skill directory, for the source tree and for admission (OpenCode's scanner stops at 6). */
  readonly maxDepth: number
  /** Bound on each git command. */
  readonly commandTimeoutMs: number
}

export const DEFAULT_REPO_SKILLS_LIMITS: RepoSkillsLimits = {
  maxFiles: 500,
  maxSourceEntries: 1000,
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

/** `git ls-tree -r -l -z -t` bound on the stdout kept in memory: well above any tree within budget (~150 bytes an entry). */
const LISTING_STDOUT_CAP_BYTES = 4 * 1024 * 1024
/** `cat-file --batch` frames: `<oid> blob <size>\n` plus a trailing `\n`; 64-hex object ids and a 10-digit size fit in this. */
const CAT_FILE_FRAME_ALLOWANCE_BYTES = 128

export interface TreeEntry {
  /** Six-digit octal mode: `100644`, `120000` (symlink), `040000` (tree), `160000` (submodule). */
  readonly mode: string
  readonly type: 'blob' | 'commit' | 'tree'
  /** The object id, as git printed it. */
  readonly oid: string
  /** Blob size in bytes; null for trees and submodules (git prints a dash). */
  readonly size: number | null
  readonly path: string
}

const TREE_RECORD = /^(\d{6}) (blob|commit|tree) ([\da-f]{40}|[\da-f]{64}) +(\d+|-)\t([\s\S]+)$/

/**
 * Parses `git ls-tree -r -l -z -t` output: NUL-terminated records of `<mode> SP <type> SP <object> SP+ <size> TAB <path>`.
 * `-z` leaves the path raw (no quoting; it may hold spaces, tabs or newlines). Any record that does not parse fails the
 * whole listing: a partial reading is not a safe reading.
 */
export function parseTreeListing(stdout: string): Result<readonly TreeEntry[], string> {
  if (stdout === '') return ok([])
  if (!stdout.endsWith('\0')) return err('The default branch tree listing was cut short; repo skills are not loaded')
  const entries: TreeEntry[] = []
  for (const record of stdout.slice(0, -1).split('\0')) {
    const match = TREE_RECORD.exec(record)
    if (match === null) return err('The default branch tree listing could not be read; repo skills are not loaded')
    entries.push({
      mode: match[1] as string,
      type: match[2] as TreeEntry['type'],
      oid: match[3] as string,
      size: match[4] === '-' ? null : Number.parseInt(match[4] as string, 10),
      path: match[5] as string,
    })
  }
  return ok(entries)
}

/**
 * Checks the default branch's skills tree against the budget before a byte of it is written. Every entry under
 * `.agents/skills` counts, rejected ones included (a symlink admission will refuse still costs a write), and the
 * blob sizes are summed. Fails on: too many entries, too many bytes, a path deeper than admission walks (a file may sit
 * `maxDepth` directories below its skill directory), or a submodule, which has no blob to write and that
 * admission could never tell from a real directory. Messages carry counts and limits, never a path.
 */
export function checkSourceBudget(entries: readonly TreeEntry[], limits: RepoSkillsLimits): Result<void, string> {
  const root = `${SKILLS_GIT_PATH}/`
  let count = 0
  let bytes = 0
  let deepest = 0
  for (const entry of entries) {
    // `ls-tree` also prints the `.agents` and `.agents/skills` trees above the pathspec.
    if (!entry.path.startsWith(root)) continue
    if (entry.type === 'commit') return err('The default branch skills contain a submodule; repo skills are not loaded')
    count += 1
    bytes += entry.size ?? 0
    // Components below the skill directory: `<id>/a/b/file` has two directories, `a` and `b`.
    deepest = Math.max(deepest, entry.path.slice(root.length).split('/').length - 2)
  }
  if (count > limits.maxSourceEntries) {
    return err(
      `The default branch skills exceed the staging budget (${count} entries, limit ${limits.maxSourceEntries}); repo skills are not loaded`,
    )
  }
  if (bytes > limits.maxBytes) {
    return err(
      `The default branch skills exceed the staging budget (${bytes} bytes, limit ${limits.maxBytes}); repo skills are not loaded`,
    )
  }
  if (deepest > limits.maxDepth) {
    return err(
      `The default branch skills exceed the staging budget (${deepest} directories deep, limit ${limits.maxDepth}); repo skills are not loaded`,
    )
  }
  return ok(undefined)
}

/**
 * Validates a listed path before it is joined to the extract root: under `.agents/skills/`, no absolute path, and no empty,
 * `.` or `..` segment or NUL byte. Git does not produce these; this defends the write if a listing ever does. The
 * message never carries the path.
 */
export function safeRelativeSkillPath(entryPath: string): Result<string, string> {
  const unsafe = err('The default branch skills contain an unsafe path; repo skills are not loaded')
  // The prefix check also refuses every absolute path.
  if (entryPath.includes('\0') || !entryPath.startsWith(`${SKILLS_GIT_PATH}/`)) return unsafe
  const segments = entryPath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return unsafe
  return ok(entryPath)
}

export interface ExpectedBlob {
  readonly oid: string
  readonly size: number
}

/**
 * Parses `git cat-file --batch` output against the listing it was fed from: for each expected blob in order, a
 * `<oid> blob <size>\n` header, exactly `size` bytes, and a `\n`. Fails closed on anything that disagrees: another object
 * id, a type other than blob, a missing object, a size other than the listing's, a cut-off frame, or bytes after the last
 * frame. A running byte counter refuses any frame that would take the total past `maxBytes` or past the listing's own
 * total, before its body is read. Returns slices of `raw` (no copies). Messages never carry content.
 */
export function parseCatFileBatch(
  raw: Buffer,
  expected: readonly ExpectedBlob[],
  maxBytes: number,
): Result<readonly Buffer[], string> {
  const failure = (reason: string): Result<never, string> =>
    err(`The default branch blob read failed (${reason}); repo skills are not loaded`)
  const listedTotal = expected.reduce((sum, blob) => sum + blob.size, 0)
  const allowance = Math.min(maxBytes, listedTotal)
  const bodies: Buffer[] = []
  let position = 0
  let total = 0
  for (const blob of expected) {
    const newline = raw.indexOf(0x0a, position)
    if (newline === -1) return failure('truncated output')
    const header = raw.toString('latin1', position, newline)
    if (header === `${blob.oid} missing`) return failure('an object is missing')
    const match = /^([\da-f]{40}|[\da-f]{64}) (\w+) (\d+)$/.exec(header)
    if (match === null || match[1] !== blob.oid || match[2] !== 'blob') {
      return failure('an object mismatch with the listing')
    }
    const size = Number.parseInt(match[3] as string, 10)
    // The counter comes first: a claimed size is refused before any of its body is looked at.
    if (total + size > allowance) return failure('the total exceeds the staging budget')
    if (size !== blob.size) return failure('a size mismatch with the listing')
    const start = newline + 1
    const end = start + size
    if (raw.length < end + 1 || raw[end] !== 0x0a) return failure('truncated output')
    total += size
    bodies.push(raw.subarray(start, end))
    position = end + 1
  }
  if (position !== raw.length) return failure('trailing output')
  return ok(bodies)
}

const FILE_MODES = new Set(['100644', '100755'])
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0

/**
 * Writes the listed tree under `extractRoot` from the stored blobs, with no attribute, filter, eol or ident processing.
 * Directories are 0700; files are created exclusively and without following a symlink at the leaf, 0600 (0700 when the
 * blob is executable, so a skill's scripts keep working); a mode 120000 blob becomes a real symlink to the stored target,
 * never followed. Any other mode is an error. The caller removes `extractRoot` on failure.
 */
async function writeTree(
  extractRoot: string,
  entries: readonly TreeEntry[],
  bodies: readonly Buffer[],
): Promise<Result<void, string>> {
  const failure = err('Could not write the default branch skills; repo skills are not loaded')
  try {
    let blobIndex = 0
    for (const entry of entries) {
      const destination = path.join(extractRoot, entry.path)
      if (entry.type === 'tree') {
        await fsp.mkdir(destination, {recursive: true, mode: 0o700})
        continue
      }
      const body = bodies[blobIndex] as Buffer
      blobIndex += 1
      await fsp.mkdir(path.dirname(destination), {recursive: true, mode: 0o700})
      if (entry.mode === '120000') {
        const target = body.toString('utf8')
        if (target.length === 0 || target.includes('\0')) return failure
        await fsp.symlink(target, destination)
        continue
      }
      const handle = await fsp.open(
        destination,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        entry.mode === '100755' ? 0o700 : 0o600,
      )
      try {
        await handle.writeFile(body)
      } finally {
        await handle.close()
      }
    }
  } catch {
    return failure
  }
  return ok(undefined)
}

type CommandOutcome =
  | {
      readonly kind: 'exited'
      readonly code: number
      readonly stdout: string
      readonly raw: Buffer
      readonly truncated: boolean
    }
  | {readonly kind: 'timed-out'}

/**
 * Stages the default branch's `.agents/skills` into `<stagingRoot>/source-tree`. On every call it fetches the branch
 * afresh from the base repository into a private ref (`refs/fro-bot/repo-skills/<key>`) of a throwaway bare repository
 * under the staging root, writes that exact commit's skill blobs raw, and deletes the throwaway repository. It never runs git in the
 * checkout and never reads a ref that already exists there: the checkout's refs, config (`insteadOf`, hooks) and
 * shallow state are not trusted, and are not changed either.
 *
 * Returns the extracted skills directory, or null when the default branch has none. Before writing anything it lists the
 * subtree and refuses one over the entry, byte or depth budget (`checkSourceBudget`). Every git command is bounded by a
 * timeout; any failure is an error and the caller loads no repo skills.
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
    stdoutCapBytes = Number.POSITIVE_INFINITY,
    input?: Buffer,
  ): Promise<CommandOutcome> => {
    const chunks: Buffer[] = []
    let kept = 0
    let truncated = false
    const code = await execWithTimeout(command, args, limits.commandTimeoutMs, {
      cwd: stagingRoot,
      env: commandEnv,
      silent: true,
      ignoreReturnCode: true,
      ...(input === undefined ? {} : {input}),
      listeners: {
        stdout: data => {
          if (kept + data.length > stdoutCapBytes) {
            truncated = true
            return
          }
          kept += data.length
          chunks.push(Buffer.from(data))
        },
      },
    })
    return code === 'timed-out'
      ? {kind: 'timed-out'}
      : {kind: 'exited', code, stdout: Buffer.concat(chunks).toString('utf8'), raw: Buffer.concat(chunks), truncated}
  }

  const timedOut = (step: string): Result<never, string> =>
    err(`Reading the default branch skills timed out while ${step}`)

  let succeeded = false
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

    // List the subtree and check it against the budget BEFORE archiving: the fetch brought the objects, but nothing is
    // written to the staging root until the tree is known to be within bounds. `ls-tree` exits 0 for a missing path.
    const listed = await run(
      'git',
      git('ls-tree', '-r', '-l', '-z', '-t', privateRef, '--', SKILLS_GIT_PATH),
      baseEnv,
      LISTING_STDOUT_CAP_BYTES,
    )
    if (listed.kind === 'timed-out') return timedOut('listing the default branch tree')
    if (listed.code !== 0) return err('Could not list the default branch tree; repo skills are not loaded')
    if (listed.truncated) {
      return err(
        'The default branch skills exceed the staging budget (the tree listing is too large to read); repo skills are not loaded',
      )
    }
    const entries = parseTreeListing(listed.stdout)
    if (!entries.success) return entries
    if (!entries.data.some(entry => entry.path.startsWith(`${SKILLS_GIT_PATH}/`))) {
      logger.debug('The default branch has no .agents/skills', {defaultBranch})
      return ok(null)
    }
    const withinBudget = checkSourceBudget(entries.data, limits)
    if (!withinBudget.success) return withinBudget

    // Write the stored blobs, raw. `cat-file --batch` applies no attribute, filter, eol or ident processing, and the
    // listing that passed the budget decides what is read: no path is walked by git here.
    const extractRoot = path.join(stagingRoot, EXTRACT_DIRECTORY_NAME)
    const underRoot = entries.data.filter(entry => entry.path.startsWith(`${SKILLS_GIT_PATH}/`))
    for (const entry of underRoot) {
      const safe = safeRelativeSkillPath(entry.path)
      if (!safe.success) return safe
    }
    const blobs = underRoot.filter(entry => entry.type === 'blob')
    if (blobs.some(entry => entry.size === null || (entry.mode !== '120000' && !FILE_MODES.has(entry.mode)))) {
      return err('The default branch skills contain an entry with an unsupported mode; repo skills are not loaded')
    }
    const expected = blobs.map(entry => ({oid: entry.oid, size: entry.size as number}))
    // Output is the bodies plus one short header and newline each: capped at the listed bytes and a header allowance.
    const catFileCap =
      expected.reduce((sum, blob) => sum + blob.size, 0) + expected.length * CAT_FILE_FRAME_ALLOWANCE_BYTES
    const read = await run(
      'git',
      git('cat-file', '--batch'),
      baseEnv,
      catFileCap,
      Buffer.from(blobs.map(entry => `${entry.oid}\n`).join('')),
    )
    if (read.kind === 'timed-out') return timedOut('reading the default branch blobs')
    if (read.code !== 0) return err('Could not read the default branch blobs; repo skills are not loaded')
    if (read.truncated) {
      return err(
        'The default branch blob read failed (the output exceeds the staging budget); repo skills are not loaded',
      )
    }
    const bodies = parseCatFileBatch(read.raw, expected, limits.maxBytes)
    if (!bodies.success) return bodies

    await fsp.mkdir(path.join(extractRoot, ...SKILLS_SEGMENTS), {recursive: true, mode: 0o700})
    const written = await writeTree(extractRoot, underRoot, bodies.data)
    if (!written.success) return written
    succeeded = true
    return ok(path.join(extractRoot, ...SKILLS_SEGMENTS))
  } catch (error) {
    logger.debug('Reading the default branch skills threw', {error: error instanceof Error ? error.name : 'unknown'})
    return err('Reading the default branch skills failed; repo skills are not loaded')
  } finally {
    // The private ref lives only in this repository; removing it removes the ref and every fetched object.
    await removeQuietly(gitDir)
    // A failure leaves no partial tree: only a complete write is kept.
    if (!succeeded) await removeQuietly(path.join(stagingRoot, EXTRACT_DIRECTORY_NAME))
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
  await removeQuietly(path.join(stagingRoot, SCRATCH_DIRECTORY_NAME))
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
  const scratchRoot = path.join(stagingRoot, SCRATCH_DIRECTORY_NAME)
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

    // Copy into scratch, a sibling of the discoverable root, and rename into place only when the copy is complete. A copy
    // that fails, and a cleanup that also fails, leave debris in scratch: never in the directory `skills.paths` names.
    const scratch = path.join(scratchRoot, entry.name)
    try {
      for (const file of inventory.files) {
        await copyRegularFile(path.join(skillDir, file.relativePath), path.join(scratch, file.relativePath))
      }
      await fsp.mkdir(destinationRoot, {recursive: true, mode: 0o700})
      await fsp.rename(scratch, path.join(destinationRoot, entry.name))
    } catch {
      await removeQuietly(scratch)
      skip(id, 'copy-failed')
      continue
    }

    usedFiles += inventory.files.length
    usedBytes += inventory.bytes
    admitted.push(entry.name)
  }

  // The extracted default-branch tree and the scratch space have done their job; only the admitted copy stays.
  await removeQuietly(path.join(stagingRoot, EXTRACT_DIRECTORY_NAME))
  await removeQuietly(scratchRoot)
  if (admitted.length === 0) await removeQuietly(destinationRoot)

  return ok({directory: admitted.length === 0 ? null : destinationRoot, admitted, skipped})
}
