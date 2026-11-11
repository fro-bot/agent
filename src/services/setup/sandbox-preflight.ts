import type {Logger} from '../../shared/logger.js'
import type {ExecAdapter} from './types.js'
import * as fs from 'node:fs/promises'
import process from 'node:process'

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
  'runner-environment' | 'platform' | 'root-user' | 'container-job' | 'sudo' | 'tool' | 'protected-links'

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
  'exec' | 'env' | 'platform' | 'uid' | 'isExecutable' | 'pathExists' | 'readText' | 'logger'
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
    logger,
  }
}
