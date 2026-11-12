import {execFile} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {readTextNoFollow} from '@fro-bot/runtime'

/**
 * Audit of the "trusted" `.git` metadata (`config`, `config.worktree`, `hooks/`, `info/`) before it is snapshotted.
 *
 * Take-back restores these items from a copy taken at handoff, and the runner-side git calls that follow trust the restored
 * files. "Restored from the snapshot" is only as trustworthy as the snapshot, so it is held to two fail-closed rules:
 *
 * 1. The metadata contains no symlink and no special file. A restored `.git/config` that is a symlink into the checkout is the
 *    model's config, whatever the copy says.
 * 2. The config contains only keys that `actions/checkout` writes (the allowlist below). Everything else fails closed and is
 *    named: include and includeIf, filter, diff and merge drivers, aliases, `core.hooksPath`, `attributesFile`, `excludesFile`,
 *    `fsmonitor`, `sshCommand`, credential and http settings, submodules. An allowlist replaces reasoning about which keys make
 *    git run a command or read a file: a key nobody listed is not trusted.
 *
 * The config is parsed by git itself (`git config --file <copy> --list --null --no-includes`), never by a parser of ours.
 * That reads one file, follows no include, runs no hook and needs no repository.
 *
 * Supported baseline: the repo-local config of a hosted checkout (`persist-credentials: false`, no submodules). A checkout
 * that needs other keys is outside it and is refused, not repaired.
 */

const MAX_CONFIG_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const METADATA_ITEMS = ['config', 'config.worktree', 'hooks', 'info'] as const
const CONFIG_FILES = ['config', 'config.worktree'] as const

/** Keys written by actions/checkout, lower-cased the way `git config --list` prints them. */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'extensions.worktreeconfig',
  'gc.auto',
  'safe.directory',
])

/** `<section>.<name>.<variable>`: the name keeps its case in git's output, the section and variable are lower-cased. */
const ALLOWED_KEY_PATTERNS: readonly RegExp[] = [
  /^remote\..+\.(?:url|fetch|promisor|partialclonefilter)$/,
  /^branch\..+\.(?:remote|merge)$/,
]

export interface SnapshotAuditInput {
  /** The directory that holds the copies of `config`, `config.worktree`, `hooks/` and `info/`. */
  readonly gitDir: string
  /** The absolute path of the git binary (from the preflight). */
  readonly git: string
}

/** Rule 1: no symlink and no special file anywhere in the metadata. Returns the reason, or `null`. */
export async function auditGitMetadataEntries(gitDir: string): Promise<string | null> {
  for (const item of METADATA_ITEMS) {
    const problem = await findUnsafeEntry(path.join(gitDir, item), item)
    if (problem !== null) return problem
  }
  return null
}

/** Rule 2: every key of `config` and `config.worktree` is on the allowlist. Returns the reason, or `null`. */
export async function auditGitConfigKeys(input: SnapshotAuditInput): Promise<string | null> {
  for (const name of CONFIG_FILES) {
    const file = path.join(input.gitDir, name)
    const text = await readConfigText(file)
    if (text === null) continue
    if (text.problem !== undefined) return `.git/${name} cannot be audited: ${text.problem}`
    const listed = await listKeys(input.git, file)
    if (listed.problem !== undefined) return `.git/${name} could not be parsed by git: ${listed.problem}`
    for (const [key, value] of listed.entries) {
      const refusal = refuseKey(key, value)
      if (refusal !== null) return `.git/${name} ${refusal}`
    }
  }
  return null
}

async function findUnsafeEntry(target: string, relative: string): Promise<string | null> {
  let stats
  try {
    stats = await fs.lstat(target)
  } catch {
    return null
  }
  if (stats.isSymbolicLink()) {
    return `.git/${relative} is a symlink: the snapshot would restore the link, and git would follow it`
  }
  if (stats.isDirectory()) {
    for (const entry of (await fs.readdir(target)).toSorted()) {
      const problem = await findUnsafeEntry(path.join(target, entry), `${relative}/${entry}`)
      if (problem !== null) return problem
    }
    return null
  }
  if (!stats.isFile()) return `.git/${relative} is not a regular file or directory`
  return null
}

/** Absent is `null`. The read is bounded and never follows a symlink (a regular file only), so git is not handed a link. */
async function readConfigText(
  file: string,
): Promise<
  {readonly text: string; readonly problem?: undefined} | {readonly text?: undefined; readonly problem: string} | null
> {
  try {
    return {text: await readTextNoFollow(file, {maxBytes: MAX_CONFIG_BYTES})}
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    return {
      problem:
        code === 'EFBIG' ? `it is larger than ${MAX_CONFIG_BYTES} bytes` : `it could not be read (${code ?? 'error'})`,
    }
  }
}

type KeyList =
  | {readonly entries: readonly (readonly [string, string])[]; readonly problem?: undefined}
  | {readonly entries?: undefined; readonly problem: string}

/** `git config --file <file> --list --null --no-includes`: entries are `key\nvalue\0` (`key\0` for a valueless key). */
async function listKeys(git: string, file: string): Promise<KeyList> {
  const env = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
  return new Promise<KeyList>(resolve => {
    execFile(
      git,
      ['config', '--file', file, '--list', '--null', '--no-includes'],
      {cwd: '/', env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * MAX_CONFIG_BYTES, encoding: 'utf8'},
      (error, stdout, stderr) => {
        if (error !== null) {
          const firstLine = stderr.split('\n').find(line => line.trim().length > 0)
          resolve({problem: (firstLine ?? error.message).trim().slice(0, 200)})
          return
        }
        const entries = stdout
          .split('\0')
          .filter(entry => entry.length > 0)
          .map((entry): readonly [string, string] => {
            const newline = entry.indexOf('\n')
            return newline === -1 ? [entry, ''] : [entry.slice(0, newline), entry.slice(newline + 1)]
          })
        resolve({entries})
      },
    )
  })
}

/** The reason a key is refused, or `null`. Names the key, never its value (a value can hold a secret). */
function refuseKey(key: string, value: string): string | null {
  const allowed = ALLOWED_KEYS.has(key) || ALLOWED_KEY_PATTERNS.some(pattern => pattern.test(key))
  if (!allowed) {
    return `sets ${key}, which is not on the allowlist of keys a checkout writes; git could read or run what it names`
  }
  // A url can name a transport helper that runs a command on use (`ext::sh -c ...`, `fd::...`).
  if (/^remote\..+\.url$/.test(key) && value.includes('::')) {
    return `sets ${key} to a transport helper (a value with "::"), which can run a command`
  }
  return null
}
