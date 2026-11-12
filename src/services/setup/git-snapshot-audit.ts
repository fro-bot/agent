import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {isWithin} from '@fro-bot/runtime'

/**
 * Audit of the "trusted" `.git` metadata (`config`, `config.worktree`, `hooks/`, `info/`) before it is snapshotted.
 *
 * Take-back restores these items from a copy taken at handoff, and the runner-side git calls that follow trust the
 * restored files. The copy preserves symlinks, and a config can name files by path, so "restored from the snapshot" is only
 * trustworthy when the snapshot itself leads nowhere the sandbox can write. Two rules, both fail-closed:
 *
 * 1. The snapshot contains no symlink and no special file. A restored `.git/config` that is a symlink into the checkout is
 *    the model's config, whatever the copy says.
 * 2. The config does not reference a path inside a sandbox-writable root through a key that makes git read or run it
 *    (`include.path`, `core.attributesFile`, a filter, an alias, ...). A relative `include.path` resolves against `.git/`,
 *    which is inside the checkout.
 *
 * Supported baseline: a hosted checkout's repo-local config, which has a remote, branches, an identity and `safe.directory`.
 * A repo-local config that points at files under the checkout is outside it and is refused, not repaired.
 */

const MAX_CONFIG_BYTES = 1024 * 1024
const METADATA_ITEMS = ['config', 'config.worktree', 'hooks', 'info'] as const

export interface SnapshotAuditInput {
  /** The checkout's `.git` directory. */
  readonly gitDir: string
  /** The checkout (the working directory of runner-side git). */
  readonly workspace: string
  /** The runner's home, for `~` in values. */
  readonly runnerHome: string
  /** Every directory the sandbox can write once handoff has run. */
  readonly writableRoots: readonly string[]
}

/** Why the metadata cannot be trusted, or `null` when it can. Names a key or a path, never a value's content. */
export async function auditTrustedGitMetadata(input: SnapshotAuditInput): Promise<string | null> {
  for (const item of METADATA_ITEMS) {
    const problem = await findUnsafeEntry(path.join(input.gitDir, item), item)
    if (problem !== null) return problem
  }
  for (const name of ['config', 'config.worktree'] as const) {
    const config = await readConfig(path.join(input.gitDir, name))
    if (config === null) continue
    if (config === 'oversize') return `.git/${name} is larger than ${MAX_CONFIG_BYTES} bytes and cannot be audited`
    const problem = findWritableReference(config, name, input)
    if (problem !== null) return problem
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

async function readConfig(file: string): Promise<string | 'oversize' | null> {
  let handle
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return null
  }
  try {
    const stats = await handle.stat()
    if (stats.size > MAX_CONFIG_BYTES) return 'oversize'
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

interface ConfigEntry {
  /** `section.variable` or `section.subsection.variable`, section and variable lower-cased. */
  readonly key: string
  readonly value: string
}

/** A small reader for git's config syntax: sections, subsections, quoting, comments and backslash continuation. */
export function parseGitConfig(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = []
  let section = ''
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    let line = (lines[index] ?? '').trim()
    while (line.endsWith('\\') && index + 1 < lines.length) {
      index += 1
      line = `${line.slice(0, -1)}${(lines[index] ?? '').trim()}`
    }
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[\s*([\w.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line)
    if (header !== null) {
      const name = (header[1] ?? '').toLowerCase()
      section = header[2] === undefined ? name : `${name}.${header[2].replaceAll(/\\(.)/g, '$1')}`
      line = line.slice(header[0].length).trim()
      if (line.length === 0) continue
    }
    const equals = line.indexOf('=')
    const name = (equals === -1 ? line : line.slice(0, equals)).trim()
    if (!/^[A-Z][\w-]*$/i.test(name)) continue
    const variable = name.toLowerCase()
    entries.push({
      key: section.length === 0 ? variable : `${section}.${variable}`,
      value: equals === -1 ? '' : unquote(line.slice(equals + 1)),
    })
  }
  return entries
}

function unquote(raw: string): string {
  let out = ''
  let quoted = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] ?? ''
    if (char === '\\' && index + 1 < raw.length) {
      index += 1
      out += raw[index] ?? ''
    } else if (char === '"') {
      quoted = !quoted
    } else if (!quoted && (char === '#' || char === ';')) {
      break
    } else {
      out += char
    }
  }
  return out.trim()
}

/** Keys whose value is a path git reads. A relative value resolves against `.git/` (inside the checkout). */
const PATH_KEYS: readonly RegExp[] = [
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^core\.(?:attributesfile|excludesfile|hookspath)$/,
  /^http\.(?:cookiefile|sslcainfo|sslcert|sslkey)$/,
]

/** Keys whose value is a command line git runs. Only absolute paths and `./`-relative paths are checked. */
const COMMAND_KEYS: readonly RegExp[] = [
  /^core\.(?:fsmonitor|sshcommand|askpass|editor|pager|gitproxy)$/,
  /^credential\.(?:.+\.)?helper$/,
  /^gpg\.(?:.+\.)?program$/,
  /^diff\.external$/,
  /^diff\..+\.(?:textconv|command)$/,
  /^filter\..+\.(?:clean|smudge|process)$/,
  /^merge\..+\.driver$/,
  /^(?:difftool|mergetool)\..+\.(?:cmd|path)$/,
  /^alias\..+$/,
  /^pager\..+$/,
  /^sequence\.editor$/,
  /^uploadpack\.packobjectshook$/,
]

function findWritableReference(text: string, file: string, input: SnapshotAuditInput): string | null {
  const roots = input.writableRoots.map(root => path.resolve(root))
  for (const {key, value} of parseGitConfig(text)) {
    const isPath = PATH_KEYS.some(pattern => pattern.test(key))
    const isCommand = COMMAND_KEYS.some(pattern => pattern.test(key))
    if (!isPath && !isCommand) continue
    for (const token of value.match(/[^\s'"`;|&()<>=!]+/g) ?? []) {
      const resolved = resolveToken(token, isPath, input)
      if (resolved === null) continue
      const root = roots.find(candidate => isWithin(candidate, resolved))
      if (root !== undefined) {
        return `${file} sets ${key} to a path inside the sandbox-writable ${root}; git would read or run what the sandbox can change`
      }
    }
  }
  return null
}

/** The absolute path a token names, or `null` when it does not name a path. */
function resolveToken(token: string, isPathKey: boolean, input: SnapshotAuditInput): string | null {
  if (token.startsWith('~/')) return path.resolve(input.runnerHome, token.slice(2))
  if (token.startsWith('$HOME/')) return path.resolve(input.runnerHome, token.slice(6))
  if (path.isAbsolute(token)) return path.resolve(token)
  if (isPathKey) return path.resolve(input.gitDir, token)
  if (token.startsWith('./') || token.startsWith('../')) return path.resolve(input.workspace, token)
  return null
}
