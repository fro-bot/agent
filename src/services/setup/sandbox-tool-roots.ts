import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {isWithin} from '@fro-bot/runtime'

/**
 * Install roots of tools that live under the runner home, which the sandbox cannot otherwise enter (`isolate-agent`).
 *
 * `setup-bun` installs to `~/.bun` and `pnpm/action-setup` to `~/setup-pnpm`, and both put a directory inside that root on
 * `PATH`. The agent's `PATH` already names those directories, but the home is default-deny, so the tools do not resolve. A
 * root on this fixed list is granted read and execute (never write) when it is really there and really a tool install: it
 * exists, is a plain runner-owned directory reached without a symlink, and a directory of the agent's `PATH` lies inside it.
 *
 * What the grant is, and is not:
 * - It is `rX` on the root's inodes, applied with a physical walk (`setfacl -P`, `find -P`): it never follows a symlink, so
 *   a link inside a root that points outside it receives nothing. What the agent can do through such a link is decided by
 *   the target's own mode and ACL, and the handoff already denies every other entry of the home. A link therefore cannot
 *   widen the grant, and a root that holds one is still granted.
 * - It reaches every inode of the root, including a hard link to a file outside it (an ACL belongs to the inode). Nothing
 *   in a supported install makes one, and everything inside a granted root is readable by the agent: the docs say so.
 * - It is never write access. The read-only view already keeps the root read-only for the agent.
 */

/** The supported tools and where their setup actions install them, relative to the runner home. */
export const SANDBOX_TOOL_ROOTS = [
  {tool: 'bun', directory: '.bun'},
  {tool: 'pnpm', directory: 'setup-pnpm'},
] as const

export interface ToolRootInput {
  readonly runnerHome: string
  readonly runnerUid: number
  /** The agent's `PATH` (the mirrored one). */
  readonly agentPath: string
  readonly runnerTemp: string
  /** `<work>/_actions`, which the runner executes at post time. */
  readonly actionsDir: string
  readonly workspace: string
  /** Every root the sandbox may write: handed-over directories and its home. */
  readonly writableRoots: readonly string[]
}

export interface SkippedToolRoot {
  readonly tool: string
  readonly root: string
  readonly reason: string
}

export interface ToolRootResult {
  /** Real paths, in the fixed order. */
  readonly granted: readonly string[]
  readonly skipped: readonly SkippedToolRoot[]
}

export interface ToolRootDeps {
  readonly lstat: (target: string) => Promise<{
    readonly isDirectory: () => boolean
    readonly isSymbolicLink: () => boolean
    readonly uid: number
  }>
  readonly realpath: (target: string) => Promise<string>
}

const realDeps: ToolRootDeps = {lstat: async target => fs.lstat(target), realpath: async target => fs.realpath(target)}

function overlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a)
}

/** What the root may not equal, contain or lie inside, by name. */
function overlapProblem(root: string, input: ToolRootInput): string | null {
  // A root that is, or contains, the home would open every sibling in it.
  if (isWithin(root, input.runnerHome)) return 'is or contains the runner home'
  if (overlaps(root, input.runnerTemp)) return 'overlaps RUNNER_TEMP'
  if (overlaps(root, input.actionsDir)) return 'overlaps the actions directory'
  if (overlaps(root, input.workspace)) return 'overlaps the checkout'
  if (input.writableRoots.some(writable => overlaps(root, writable))) return 'overlaps a writable root'
  return null
}

export async function resolveToolRoots(input: ToolRootInput, deps: ToolRootDeps = realDeps): Promise<ToolRootResult> {
  const pathEntries = input.agentPath.split(':').filter(entry => path.isAbsolute(entry))
  const granted: string[] = []
  const skipped: SkippedToolRoot[] = []

  for (const {tool, directory} of SANDBOX_TOOL_ROOTS) {
    const root = path.join(input.runnerHome, directory)
    const skip = (reason: string): void => {
      skipped.push({tool, root, reason})
    }

    let stats
    try {
      stats = await deps.lstat(root)
    } catch {
      skip('does not exist')
      continue
    }
    if (stats.isSymbolicLink()) {
      skip('is a symlink')
      continue
    }
    if (!stats.isDirectory()) {
      skip('is not a directory')
      continue
    }
    if (stats.uid !== input.runnerUid) {
      skip('is not owned by the runner')
      continue
    }
    let real: string
    try {
      real = await deps.realpath(root)
    } catch {
      skip('does not exist')
      continue
    }
    if (real !== root) {
      skip('is reached through a symlink')
      continue
    }
    if (!pathEntries.some(entry => isWithin(root, entry))) {
      skip('no PATH entry lies inside it')
      continue
    }
    const problem = overlapProblem(root, input)
    if (problem !== null) {
      skip(problem)
      continue
    }
    granted.push(root)
  }
  return {granted, skipped}
}
