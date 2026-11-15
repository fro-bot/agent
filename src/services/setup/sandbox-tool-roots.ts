import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {isWithin} from '@fro-bot/runtime'

/**
 * Install roots under the runner home that the isolated agent may read and execute: `setup-bun` installs to `~/.bun` and
 * `pnpm/action-setup` to `~/setup-pnpm`. A root is granted only when it is a plain runner-owned directory reached without a
 * symlink and a directory of the agent's `PATH` lies inside it.
 *
 * The grant is `rX` applied with a physical walk, so a symlink inside a root receives nothing and its target keeps its own
 * permissions. A hard link would carry the grant (ACLs belong to inodes); supported installs make none.
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

/**
 * Where the agent's tools keep their caches: the agent's own home, set in the agent's environment.
 *
 * The agent's `XDG_*` variables point at the runner's directories, which are read-only for the agent apart from the
 * `opencode` subdirectory of each. `pnpm` and `uv` fail there, and `bun` falls back into the checkout, so their locations
 * are named outright. `uv` and `pip` run from the world-readable tool cache, so theirs are always set; pnpm's and bun's
 * only when their root is granted, since `npm` warns about `npm_config_*` names it does not know.
 */
export function toolCacheEnv(
  granted: readonly string[],
  runnerHome: string,
  agentHome: string,
): Record<string, string> {
  const has = (tool: string): boolean => {
    const entry = SANDBOX_TOOL_ROOTS.find(root => root.tool === tool)
    return entry !== undefined && granted.includes(path.join(runnerHome, entry.directory))
  }
  return {
    UV_CACHE_DIR: path.join(agentHome, '.cache', 'uv'),
    UV_PYTHON_INSTALL_DIR: path.join(agentHome, '.local', 'share', 'uv', 'python'),
    UV_TOOL_DIR: path.join(agentHome, '.local', 'share', 'uv', 'tools'),
    PIP_CACHE_DIR: path.join(agentHome, '.cache', 'pip'),
    ...(has('bun') ? {BUN_INSTALL_CACHE_DIR: path.join(agentHome, '.bun', 'install', 'cache')} : {}),
    ...(has('pnpm')
      ? {
          npm_config_store_dir: path.join(agentHome, '.pnpm-store'),
          npm_config_cache_dir: path.join(agentHome, '.cache', 'pnpm'),
          npm_config_state_dir: path.join(agentHome, '.local', 'state', 'pnpm'),
        }
      : {}),
  }
}
