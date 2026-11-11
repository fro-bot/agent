import type {Logger} from '../../shared/logger.js'
import type {ExecAdapter} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

/**
 * Fail-closed capability check for `isolate-agent: true`.
 *
 * Runs at the very top of bootstrap, before any setup, so a failed check leaves nothing to undo. The check trusts
 * `RUNNER_ENVIRONMENT` (a self-hosted runner that reports `github-hosted` is unsupported; the runner cannot attest
 * itself). Tool paths are resolved against a fixed list of root-owned directories, never the caller's `PATH`, so the
 * absolute paths later handed to `sudo` cannot be redirected by a planted binary.
 */

/** Every tool the sandbox needs, resolved to absolute paths. `sudo` runs the privileged steps. */
export const SANDBOX_TOOL_NAMES = [
  'sudo',
  'setpriv',
  'setfacl',
  'getfacl',
  'useradd',
  'userdel',
  'pkill',
  'pgrep',
  'find',
  'chown',
  'chmod',
  'mkdir',
  'env',
  'git',
] as const

export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number]
export type SandboxToolPaths = Readonly<Record<SandboxToolName, string>>

export type SandboxPreflightCheck =
  | 'runner-environment'
  | 'platform'
  | 'root-user'
  | 'container-job'
  | 'action-location'
  | 'sudo'
  | 'tool'
  | 'protected-links'

export type SandboxPreflightResult =
  | {readonly ok: true; readonly tools: SandboxToolPaths}
  | {readonly ok: false; readonly check: SandboxPreflightCheck; readonly message: string}

export interface SandboxPreflightDeps {
  readonly exec: ExecAdapter
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  /** The effective uid of the Action process; `null` where the platform has none. */
  readonly uid: number | null
  /** True when an executable regular file exists at the absolute path. */
  readonly isExecutable: (absolutePath: string) => Promise<boolean>
  readonly pathExists: (absolutePath: string) => Promise<boolean>
  readonly readText: (absolutePath: string) => Promise<string | null>
  /**
   * Where the running Action is installed: `GITHUB_ACTION_PATH` when the runner sets it, plus the directory of the
   * running bundle and its parent. Empty when it cannot be determined, which fails the check.
   */
  readonly actionPaths: readonly string[]
  readonly realpath: (absolutePath: string) => Promise<string>
  /** The working directory, the workspace when `GITHUB_WORKSPACE` is unset (the same fallback bootstrap uses). */
  readonly cwd: string
  readonly logger: Logger
}

/** Root-owned directories searched for the tools, in order. Deliberately not derived from `PATH`. */
export const TRUSTED_TOOL_DIRS = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
] as const

const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'] as const

function fail(check: SandboxPreflightCheck, message: string): SandboxPreflightResult {
  return {ok: false, check, message: `isolate-agent is not supported on this runner (${check}): ${message}`}
}

export async function runSandboxPreflight(deps: SandboxPreflightDeps): Promise<SandboxPreflightResult> {
  const {env, platform, uid} = deps

  if (platform !== 'linux' || env.RUNNER_OS !== 'Linux') {
    return fail('platform', `it needs a Linux runner (found RUNNER_OS=${env.RUNNER_OS ?? 'unset'})`)
  }

  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    return fail(
      'runner-environment',
      `it needs a GitHub-hosted runner (RUNNER_ENVIRONMENT=${env.RUNNER_ENVIRONMENT ?? 'unset'}). Self-hosted runners are not supported`,
    )
  }

  if (uid === null || uid === 0) {
    return fail('root-user', 'the Action must run as an unprivileged user, not root')
  }

  for (const marker of CONTAINER_MARKERS) {
    if (await deps.pathExists(marker)) {
      return fail('container-job', 'container jobs are not supported')
    }
  }

  const location = await checkActionLocation(deps)
  if (location !== null) return location

  const tools = await resolveTools(deps)
  if (!tools.ok) return tools.result

  const sudoWorks = await deps.exec
    .getExecOutput(tools.paths.sudo, ['-n', 'true'], {silent: true, ignoreReturnCode: true})
    .then(output => output.exitCode === 0)
    .catch(() => false)
  if (!sudoWorks) {
    return fail('sudo', 'passwordless sudo (`sudo -n true`) is required')
  }

  for (const sysctl of ['protected_hardlinks', 'protected_symlinks']) {
    const value = (await deps.readText(`/proc/sys/fs/${sysctl}`))?.trim()
    if (value !== '1') {
      return fail('protected-links', `fs.${sysctl} must be 1 (found ${value ?? 'unreadable'})`)
    }
  }

  deps.logger.debug('Sandbox preflight passed', {tools: tools.paths})
  return {ok: true, tools: tools.paths}
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * The directories the sandbox user can write once handoff has run: the checkout, the four OpenCode XDG dirs, and the
 * runner temp tree (response, credential, gh-config and attachment dirs all live under it). A superset is fine: this only
 * decides whether the Action's own files are exposed.
 */
export function sandboxWritableRoots(env: NodeJS.ProcessEnv, cwd: string): readonly string[] {
  const home = env.HOME ?? ''
  const xdg = (name: string, fallback: string): string => {
    const value = env[name]
    return value !== undefined && value.length > 0 && path.isAbsolute(value) ? value : path.join(home, fallback)
  }
  const roots = [
    env.GITHUB_WORKSPACE !== undefined && env.GITHUB_WORKSPACE.length > 0 ? env.GITHUB_WORKSPACE : cwd,
    path.join(xdg('XDG_DATA_HOME', '.local/share'), 'opencode'),
    path.join(xdg('XDG_CONFIG_HOME', '.config'), 'opencode'),
    path.join(xdg('XDG_CACHE_HOME', '.cache'), 'opencode'),
    path.join(xdg('XDG_STATE_HOME', '.local/state'), 'opencode'),
  ]
  if (env.RUNNER_TEMP !== undefined && env.RUNNER_TEMP.length > 0) roots.push(env.RUNNER_TEMP)
  return roots.map(root => path.resolve(root))
}

/**
 * The Action's own files (`dist/post.js`, `action.yaml`) run later as the runner. If the sandbox can write the place they
 * live, it can plant code that runs with the runner's privileges. `uses: ./` installs the Action inside the checkout, so
 * it is refused; a published `fro-bot/agent@<ref>` lives under `_actions`, outside every writable root.
 */
async function checkActionLocation(deps: SandboxPreflightDeps): Promise<SandboxPreflightResult | null> {
  const advice =
    'use a published `fro-bot/agent@<ref>` instead of a local `uses: ./` install, so the Action is not stored where the agent user can write'
  const candidates = [...deps.actionPaths]
  const reported = deps.env.GITHUB_ACTION_PATH
  if (reported !== undefined && reported.length > 0) candidates.push(reported)
  if (candidates.length === 0) {
    return fail('action-location', `the Action's install location could not be determined; ${advice}`)
  }
  const roots = sandboxWritableRoots(deps.env, deps.cwd)
  for (const candidate of candidates) {
    let resolved: string
    try {
      resolved = await deps.realpath(path.resolve(candidate))
    } catch {
      resolved = path.resolve(candidate)
    }
    for (const root of roots) {
      if (isInsideOrEqual(root, resolved) || isInsideOrEqual(resolved, root)) {
        return fail(
          'action-location',
          `the Action is installed at ${resolved}, which overlaps the writable path ${root}; ${advice}`,
        )
      }
    }
  }
  return null
}

async function resolveTools(
  deps: SandboxPreflightDeps,
): Promise<
  {readonly ok: true; readonly paths: SandboxToolPaths} | {readonly ok: false; readonly result: SandboxPreflightResult}
> {
  const resolved: Partial<Record<SandboxToolName, string>> = {}
  for (const name of SANDBOX_TOOL_NAMES) {
    let found: string | null = null
    for (const dir of TRUSTED_TOOL_DIRS) {
      const candidate = `${dir}/${name}`
      if (await deps.isExecutable(candidate)) {
        found = candidate
        break
      }
    }
    if (found === null) {
      return {ok: false, result: fail('tool', `\`${name}\` was not found in ${TRUSTED_TOOL_DIRS.join(', ')}`)}
    }
    resolved[name] = found
  }
  return {ok: true, paths: resolved as SandboxToolPaths}
}

export function createSandboxPreflightDeps(
  exec: ExecAdapter,
  logger: Logger,
): Pick<
  SandboxPreflightDeps,
  | 'exec'
  | 'env'
  | 'platform'
  | 'uid'
  | 'isExecutable'
  | 'pathExists'
  | 'readText'
  | 'actionPaths'
  | 'realpath'
  | 'cwd'
  | 'logger'
> {
  return {
    exec,
    env: process.env,
    platform: process.platform,
    uid: typeof process.geteuid === 'function' ? process.geteuid() : null,
    isExecutable: async absolutePath => {
      try {
        const stats = await fs.stat(absolutePath)
        if (!stats.isFile()) return false
        await fs.access(absolutePath, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    pathExists: async absolutePath => {
      try {
        await fs.lstat(absolutePath)
        return true
      } catch {
        return false
      }
    },
    readText: async absolutePath => {
      try {
        return await fs.readFile(absolutePath, 'utf8')
      } catch {
        return null
      }
    },
    actionPaths: bundleInstallPaths(),
    realpath: async absolutePath => fs.realpath(absolutePath),
    cwd: process.cwd(),
    logger,
  }
}

/** The running bundle's directory and its parent (`dist/` and the Action root). Empty if the location is not a file URL. */
function bundleInstallPaths(): readonly string[] {
  try {
    const bundleDir = path.dirname(fileURLToPath(import.meta.url))
    return [bundleDir, path.dirname(bundleDir)]
  } catch {
    return []
  }
}
