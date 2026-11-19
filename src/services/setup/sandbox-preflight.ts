import type {Logger} from '../../shared/logger.js'
import type {ViewProbeResult} from './sandbox-view-probe.js'
import type {ExecAdapter} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {isWithin} from '@fro-bot/runtime'
import {createViewProbe} from './sandbox-view-probe.js'

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
  // The agent's own XDG roots link their `opencode` entries to the handed-over directories.
  'ln',
  'env',
  'git',
  // The git credential helper of the provisioned `gh` token (provision mode), so the model's `git push` authenticates.
  'gh',
  // The read-only view: a private mount namespace, the bind and remount tools, the old root's removal, and the namespace
  // listing the teardown reads. The sequencing shell runs the three fixed scripts of the launch; the first of them (the
  // gate) reads its own namespace id with `readlink` and waits for the runner's go-ahead with `sleep`.
  'unshare',
  'mount',
  'umount',
  'pivot_root',
  'sh',
  'lsns',
  'readlink',
  'sleep',
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
  | 'view'

export type ActionEntryKind = 'directory' | 'file' | 'symlink' | 'other'

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
   * The directory of the running bundle, canonical (Node resolves the main module through symlinks). `null` when it
   * cannot be determined.
   */
  readonly bundleDir: string | null
  /**
   * The script path the runner started the Action with (`process.argv[1]`), exactly as given: a path through a symlink
   * stays lexical. `null` when it is not available.
   */
  readonly invokedAs: string | null
  /** `lstat` without following a final symlink: what kind of entry is at the path, or `null` when nothing is there. */
  readonly lstat: (absolutePath: string) => Promise<ActionEntryKind | null>
  readonly realpath: (absolutePath: string) => Promise<string>
  /** The working directory, the workspace when `GITHUB_WORKSPACE` is unset (the same fallback bootstrap uses). */
  readonly cwd: string
  /** Builds the real read-only view over a throwaway fixture and checks it (`sandbox-view-probe.ts`). */
  readonly probeView: (tools: SandboxToolPaths) => Promise<ViewProbeResult>
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

  await noteGitTrustSupport(deps, tools.paths.git)

  // Last: it runs the real builder as root, so every cheaper check has passed first.
  const view = await deps.probeView(tools.paths)
  if (!view.ok) return fail('view', view.message)

  deps.logger.debug('Sandbox preflight passed', {tools: tools.paths})
  return {ok: true, tools: tools.paths}
}

/**
 * The first git release with `safe.directory` prefix matching (`<dir>/*`): 2.46.0, backported to 2.45.3. The sandbox trusts
 * `<checkout>/*` for the repositories a runner step cloned under the checkout; an older git ignores that entry.
 */
const GIT_PREFIX_TRUST_MIN = [2, 45, 3] as const

/** The `major.minor.patch` of `git --version` output (`git version 2.45.2.windows.1`), or null when it cannot be read. */
function parseGitVersion(output: string): readonly [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/**
 * Says, once and at info, when the runner's git is too old to honor `safe.directory` prefix entries. Never a failure: the
 * checkout itself is still trusted, only repositories under it are not. An unreadable or unparseable version says nothing,
 * because it proves nothing either way.
 */
async function noteGitTrustSupport(deps: SandboxPreflightDeps, git: string): Promise<void> {
  const output = await deps.exec
    .getExecOutput(git, ['--version'], {silent: true, ignoreReturnCode: true})
    .catch(() => null)
  const version = output === null || output.exitCode !== 0 ? null : parseGitVersion(output.stdout)
  if (version === null) return
  const older = version.findIndex((part, index) => part !== GIT_PREFIX_TRUST_MIN[index])
  if (older === -1 || (version[older] ?? 0) > (GIT_PREFIX_TRUST_MIN[older] ?? 0)) return
  deps.logger.info(
    `git ${version.join('.')} is older than 2.45.3: repositories under the checkout won't be trusted for the agent ` +
      '(only the checkout itself is)',
    {gitVersion: version.join('.')},
  )
}

/** The sub-path of the runner's work directory that holds downloaded actions. Reserved: the sandbox may never write it. */
export const ACTIONS_DIR_NAME = '_actions'

/** The pieces Node gives a running script: the canonical bundle directory and the lexical script path. */
export function discoverActionLocation(input: {readonly argv: readonly string[]; readonly moduleUrl: string}): {
  readonly bundleDir: string | null
  readonly invokedAs: string | null
} {
  const invoked = input.argv[1]
  const invokedAs = invoked !== undefined && invoked.length > 0 ? invoked : null
  try {
    return {bundleDir: path.dirname(fileURLToPath(input.moduleUrl)), invokedAs}
  } catch {
    return {bundleDir: null, invokedAs}
  }
}

const RUNNER_ENTRY_SCRIPTS = ['dist/main.js', 'dist/post.js', 'dist/key-proxy.js', 'dist/sandbox-view.js'] as const
const MANIFEST_NAMES = ['action.yaml', 'action.yml'] as const

/**
 * `isolate-agent` supports a published install only: `fro-bot/agent@<ref>`, which the runner downloads to
 * `<work>/_actions/<owner>/<repo>/<ref...>/` (a ref may contain `/`).
 *
 * The runner reloads the action manifest and opens the post script by path at post time, as the runner user, so the whole
 * install must be immutable to the sandbox. A local `uses: ./` install sits in the checkout (writable), and an alias, a
 * `..action` directory, or any symlink on the way to a protected copy can be replaced by the sandbox. Rather than rule out
 * each of those, the invariant is: the invocation path lies under `<work>/_actions/<owner>/<repo>/<ref>`, and every
 * component from the work directory down to `dist/` is a real directory, with the manifest and the entry scripts regular
 * files. `_actions` is a reserved subtree that handoff refuses to grant (see `sandbox-handoff.ts`).
 *
 * The install root comes from the running bundle (`process.argv[1]`, which always names it), never from
 * `GITHUB_ACTION_PATH`: inside a composite action that variable is the composite's own directory (in the workspace for
 * a local wrapper, and different in the main and post stages), so a published install called through a composite would be
 * refused for the wrapper's location. A composite wrapping `fro-bot/agent@<ref>` is supported.
 *
 * `GITHUB_ACTION_REPOSITORY` and `GITHUB_ACTION_REF` are the running action's own values (the runner sets them from the
 * action's reference, and clears them for a local `uses: ./`). They are provenance only: they must match the
 * `<owner>/<repo>` (case-insensitively) and the `<ref...>` the walk found, and decide nothing without the walk. The ref
 * comparison is reliable because the runner builds the directory from the same `Name` and `Ref` strings it reports, joining
 * a ref containing `/` as nested directories.
 */
async function checkActionLocation(deps: SandboxPreflightDeps): Promise<SandboxPreflightResult | null> {
  const advice =
    'use a published `fro-bot/agent@<ref>` (GitHub-hosted Linux only) instead of a local `uses: ./` install, so the Action is not stored where the agent user can write'
  const refuse = (reason: string): SandboxPreflightResult => fail('action-location', `${reason}; ${advice}`)

  const runnerTemp = deps.env.RUNNER_TEMP
  if (runnerTemp === undefined || runnerTemp.length === 0 || !path.isAbsolute(runnerTemp)) {
    return refuse('RUNNER_TEMP is not set, so the runner work directory cannot be derived')
  }
  const work = path.resolve(path.dirname(path.resolve(runnerTemp)))
  const actionsRoot = path.join(work, ACTIONS_DIR_NAME)

  const repository = deps.env.GITHUB_ACTION_REPOSITORY
  if (repository === undefined || repository.length === 0) {
    return refuse('GITHUB_ACTION_REPOSITORY is not set, so this does not look like a downloaded action')
  }

  if (deps.invokedAs === null || deps.invokedAs.length === 0) {
    return refuse('it could not be determined how the Action was started (no script path)')
  }
  if (deps.bundleDir === null) {
    return refuse('the location of the running bundle could not be determined')
  }

  // The install root: the directory above the `dist/` the script was started from.
  const scriptPath = path.resolve(deps.cwd, deps.invokedAs)
  const installRoot = path.dirname(path.dirname(scriptPath))
  if (path.dirname(scriptPath) !== path.join(installRoot, 'dist')) {
    return refuse(`the script ${scriptPath} is not ${path.join(installRoot, 'dist')}/<file>`)
  }

  const parts = isWithin(actionsRoot, installRoot) ? path.relative(actionsRoot, installRoot).split(path.sep) : []
  if (parts.length < 3 || parts.includes('') || parts.includes('..')) {
    return refuse(`the Action is started from ${installRoot}, which is not ${actionsRoot}/<owner>/<repo>/<ref>`)
  }

  const walkedRepository = `${parts[0]}/${parts[1]}`
  if (repository.toLowerCase() !== walkedRepository.toLowerCase()) {
    return refuse(`GITHUB_ACTION_REPOSITORY is ${repository}, but the install is ${walkedRepository}`)
  }
  const walkedRef = parts.slice(2).join('/')
  const ref = deps.env.GITHUB_ACTION_REF
  if (ref !== walkedRef) {
    return refuse(`GITHUB_ACTION_REF is ${ref ?? 'unset'}, but the install is ${walkedRef}`)
  }

  // Walk every component from the work directory through dist/ with lstat: each must be a real directory.
  const walk: string[] = [work]
  let current = work
  for (const part of [ACTIONS_DIR_NAME, ...parts, 'dist']) {
    current = path.join(current, part)
    walk.push(current)
  }
  for (const component of walk) {
    const kind = await deps.lstat(component)
    if (kind === null) return refuse(`${component} does not exist`)
    if (kind === 'symlink') return refuse(`${component} is a symlink`)
    if (kind !== 'directory') return refuse(`${component} is not a directory`)
  }

  // The manifest and the scripts the runner executes must be regular files (a link or device could be re-pointed).
  const manifests: ActionEntryKind[] = []
  for (const name of MANIFEST_NAMES) {
    const kind = await deps.lstat(path.join(installRoot, name))
    if (kind !== null) manifests.push(kind)
  }
  if (manifests.length === 0) return refuse(`${installRoot} has no action.yaml or action.yml`)
  if (manifests.some(kind => kind !== 'file'))
    return refuse(`the action manifest in ${installRoot} is not a regular file`)
  for (const script of RUNNER_ENTRY_SCRIPTS) {
    const kind = await deps.lstat(path.join(installRoot, script))
    if (kind !== 'file') return refuse(`${path.join(installRoot, script)} is not a regular file`)
  }

  // What is running is what the runner started: the canonical bundle directory is the walked one.
  let canonicalBundle: string
  try {
    canonicalBundle = await deps.realpath(path.join(installRoot, 'dist'))
  } catch {
    canonicalBundle = path.join(installRoot, 'dist')
  }
  if (path.resolve(deps.bundleDir) !== path.resolve(canonicalBundle)) {
    return refuse(`the running bundle is in ${deps.bundleDir}, not in ${canonicalBundle}`)
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
  | 'bundleDir'
  | 'invokedAs'
  | 'lstat'
  | 'realpath'
  | 'cwd'
  | 'probeView'
  | 'logger'
> {
  const location = discoverActionLocation({argv: process.argv, moduleUrl: import.meta.url})
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
    ...location,
    lstat: async absolutePath => {
      try {
        const stats = await fs.lstat(absolutePath)
        if (stats.isSymbolicLink()) return 'symlink'
        if (stats.isDirectory()) return 'directory'
        return stats.isFile() ? 'file' : 'other'
      } catch {
        return null
      }
    },
    realpath: async absolutePath => fs.realpath(absolutePath),
    cwd: process.cwd(),
    probeView: createViewProbe({exec, logger, env: process.env, bundleDir: location.bundleDir}),
    logger,
  }
}
