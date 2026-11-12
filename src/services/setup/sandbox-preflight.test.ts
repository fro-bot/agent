import type {SandboxPreflightDeps} from './sandbox-preflight.js'
import type {ExecAdapter} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  discoverActionLocation,
  runSandboxPreflight,
  SANDBOX_TOOL_NAMES,
  TRUSTED_TOOL_DIRS,
} from './sandbox-preflight.js'

interface Overrides {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly uid?: number | null
  readonly missingTools?: readonly string[]
  readonly containerMarker?: string
  readonly sudoExitCode?: number
  readonly sysctls?: Readonly<Record<string, string | null>>
  /** Where the Action is installed (bundle dir and its parent). Defaults to a published-action location. */
  readonly actionPaths?: readonly string[]
  /** Maps a path to its real path, as `fs.realpath` would. */
  readonly realpaths?: Readonly<Record<string, string>>
  /** The script path the runner started the Action with (`process.argv[1]`); defaults to `main.js` in the first install path. */
  readonly invokedAs?: string | null
}

const HOSTED_ENV: NodeJS.ProcessEnv = {
  RUNNER_OS: 'Linux',
  RUNNER_ENVIRONMENT: 'github-hosted',
  HOME: '/home/runner',
  GITHUB_WORKSPACE: '/home/runner/work/repo/repo',
  RUNNER_TEMP: '/home/runner/work/_temp',
}
const PUBLISHED_ACTION = [
  '/home/runner/work/_actions/fro-bot/agent/v1/dist',
  '/home/runner/work/_actions/fro-bot/agent/v1',
]

function createDeps(overrides: Overrides = {}) {
  const getExecOutput = vi.fn<ExecAdapter['getExecOutput']>(async () => ({
    exitCode: overrides.sudoExitCode ?? 0,
    stdout: '',
    stderr: '',
  }))
  const exec: ExecAdapter = {exec: vi.fn(async () => 0), getExecOutput}
  const sysctls: Record<string, string | null> = {
    protected_hardlinks: '1\n',
    protected_symlinks: '1\n',
    ...overrides.sysctls,
  }
  const deps: SandboxPreflightDeps = {
    exec,
    env: overrides.env ?? HOSTED_ENV,
    platform: overrides.platform ?? 'linux',
    uid: overrides.uid === undefined ? 1001 : overrides.uid,
    isExecutable: async absolutePath => {
      const name = absolutePath.slice(absolutePath.lastIndexOf('/') + 1)
      // Tools live in /usr/bin only; earlier directories in the search order are empty.
      return absolutePath === `/usr/bin/${name}` && overrides.missingTools?.includes(name) !== true
    },
    pathExists: async absolutePath => absolutePath === overrides.containerMarker,
    readText: async absolutePath => {
      const key = absolutePath.replace('/proc/sys/fs/', '')
      return sysctls[key] ?? null
    },
    actionPaths: overrides.actionPaths ?? PUBLISHED_ACTION,
    invokedAs:
      overrides.invokedAs === undefined
        ? ((overrides.actionPaths ?? PUBLISHED_ACTION)[0] ?? null) === null
          ? null
          : `${(overrides.actionPaths ?? PUBLISHED_ACTION)[0]}/main.js`
        : overrides.invokedAs,
    realpath: async absolutePath => overrides.realpaths?.[absolutePath] ?? absolutePath,
    cwd: '/home/runner/work/repo/repo',
    logger: createMockLogger(),
  }
  return {deps, getExecOutput}
}

describe('runSandboxPreflight', () => {
  it('returns absolute tool paths when every check passes', async () => {
    // #given a supported hosted Linux runner
    const {deps, getExecOutput} = createDeps()

    // #when the preflight runs
    const result = await runSandboxPreflight(deps)

    // #then it succeeds with an absolute path per tool and probed sudo by absolute path
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    for (const name of SANDBOX_TOOL_NAMES) {
      expect(result.tools[name]).toBe(`/usr/bin/${name}`)
    }
    expect(getExecOutput).toHaveBeenCalledWith('/usr/bin/sudo', ['-n', 'true'], expect.anything())
  })

  it('never resolves tools through PATH', async () => {
    // #given a hostile PATH pointing at a directory that is not in the trusted list
    const {deps} = createDeps({env: {...HOSTED_ENV, PATH: '/tmp/evil'}})

    // #when the preflight runs
    const result = await runSandboxPreflight(deps)

    // #then every resolved tool comes from a trusted directory
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    for (const resolved of Object.values(result.tools)) {
      expect(TRUSTED_TOOL_DIRS.some(dir => resolved.startsWith(`${dir}/`))).toBe(true)
    }
  })

  it.each([
    ['runner-environment', {env: {RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'self-hosted'}}],
    ['runner-environment', {env: {RUNNER_OS: 'Linux'}}],
    ['platform', {env: {RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted'}}],
    ['platform', {platform: 'darwin' as const}],
    ['root-user', {uid: 0}],
    ['root-user', {uid: null}],
    ['container-job', {containerMarker: '/.dockerenv'}],
    ['sudo', {sudoExitCode: 1}],
    ['tool', {missingTools: ['setpriv']}],
    ['tool', {missingTools: ['setfacl']}],
    ['tool', {missingTools: ['useradd']}],
    ['tool', {missingTools: ['pgrep']}],
    ['protected-links', {sysctls: {protected_hardlinks: '0\n'}}],
    ['protected-links', {sysctls: {protected_symlinks: null}}],
  ] as const)('fails the %s check', async (check, overrides: Overrides) => {
    // #given a runner that violates exactly one requirement
    const {deps} = createDeps(overrides)

    // #when the preflight runs
    const result = await runSandboxPreflight(deps)

    // #then it names the failed check in an actionable message
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.check).toBe(check)
    expect(result.message).toContain('isolate-agent')
    expect(result.message).toContain(check)
  })

  it('reports the first failing check without probing sudo', async () => {
    // #given a self-hosted runner that would also fail sudo
    const {deps, getExecOutput} = createDeps({
      env: {RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'self-hosted'},
      sudoExitCode: 1,
    })

    // #when the preflight runs
    const result = await runSandboxPreflight(deps)

    // #then only the first failure is reported and nothing privileged was attempted
    expect(!result.ok && result.check).toBe('runner-environment')
    expect(getExecOutput).not.toHaveBeenCalled()
  })

  describe('action install location', () => {
    const WORKSPACE = '/home/runner/work/repo/repo'

    it('passes for a published action outside every writable root', async () => {
      // #given the Action installed under _actions, beside the workspace
      const {deps} = createDeps()

      // #when / #then
      expect((await runSandboxPreflight(deps)).ok).toBe(true)
    })

    it.each([
      ['equal to the workspace (uses: ./)', [`${WORKSPACE}/dist`, WORKSPACE]],
      ['nested in the workspace', [`${WORKSPACE}/.github/actions/agent/dist`, `${WORKSPACE}/.github/actions/agent`]],
      ['a parent of the workspace', ['/home/runner/work/repo/dist', '/home/runner/work/repo']],
      [
        'inside a handed-over XDG data dir',
        ['/home/runner/.local/share/opencode/x/dist', '/home/runner/.local/share/opencode/x'],
      ],
      ['inside the runner temp tree', ['/home/runner/work/_temp/act/dist', '/home/runner/work/_temp/act']],
      ['a parent of the runner home XDG roots', ['/home/runner/dist', '/home/runner']],
    ])('fails closed before any tool probe when the install is %s', async (_label, actionPaths) => {
      // #given the Action installed where the sandbox user could rewrite it
      const {deps, getExecOutput} = createDeps({actionPaths})

      // #when
      const result = await runSandboxPreflight(deps)

      // #then it names the reason, points at a published ref, and probes nothing privileged
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.check).toBe('action-location')
      expect(result.message).toContain('fro-bot/agent@')
      expect(getExecOutput).not.toHaveBeenCalled()
    })

    it('resolves symlinks first, so a published-looking path that points into the workspace is refused', async () => {
      // #given a link under _actions that resolves into the checkout
      const {deps} = createDeps({
        actionPaths: ['/home/runner/work/_actions/fro-bot/agent/v1'],
        realpaths: {'/home/runner/work/_actions/fro-bot/agent/v1': `${WORKSPACE}/vendored`},
      })

      // #when / #then
      const result = await runSandboxPreflight(deps)
      expect(!result.ok && result.check).toBe('action-location')
    })

    it('honors a GITHUB_ACTION_PATH that differs from the bundle location', async () => {
      // #given the bundle looks safe, but the runner reports the action inside the workspace
      const {deps} = createDeps({env: {...HOSTED_ENV, GITHUB_ACTION_PATH: WORKSPACE}})

      // #when / #then
      const result = await runSandboxPreflight(deps)
      expect(!result.ok && result.check).toBe('action-location')
    })

    it('does not mistake a sibling with a shared name prefix for an overlap', async () => {
      // #given an install dir whose name merely starts with the workspace's
      const {deps} = createDeps({actionPaths: [`${WORKSPACE}-tools/dist`, `${WORKSPACE}-tools`]})

      // #when / #then
      expect((await runSandboxPreflight(deps)).ok).toBe(true)
    })

    describe('lexical and canonical paths', () => {
      const PUBLISHED_CANONICAL = '/home/runner/work/_actions/fro-bot/agent/v1'

      it('rejects an alias inside the checkout that points at a protected install outside it', async () => {
        // #given `uses: ./x`, where x is a symlink in the checkout to a protected install: the runner starts the Action
        // from the alias, so the sandbox could replace that symlink with a directory of its own
        const alias = `${WORKSPACE}/x/dist/main.js`
        const {deps, getExecOutput} = createDeps({
          actionPaths: [`${PUBLISHED_CANONICAL}/dist`, PUBLISHED_CANONICAL],
          invokedAs: alias,
          realpaths: {[alias]: `${PUBLISHED_CANONICAL}/dist/main.js`},
        })

        // #when
        const result = await runSandboxPreflight(deps)

        // #then it is refused on the lexical path even though the canonical one is safe, and nothing was probed
        expect(!result.ok && result.check).toBe('action-location')
        expect(!result.ok && result.message).toContain(alias)
        expect(getExecOutput).not.toHaveBeenCalled()
      })

      it('rejects a GITHUB_ACTION_PATH alias inside the checkout that resolves outside it', async () => {
        // #given the runner-reported path is the alias
        const alias = `${WORKSPACE}/x`
        const {deps} = createDeps({
          env: {...HOSTED_ENV, GITHUB_ACTION_PATH: alias},
          actionPaths: [`${PUBLISHED_CANONICAL}/dist`, PUBLISHED_CANONICAL],
          invokedAs: `${PUBLISHED_CANONICAL}/dist/main.js`,
          realpaths: {[alias]: PUBLISHED_CANONICAL},
        })

        // #when / #then
        const result = await runSandboxPreflight(deps)
        expect(!result.ok && result.check).toBe('action-location')
      })

      it('rejects when the canonical path is inside a writable root but the lexical one is not', async () => {
        // #given a path that looks safe but resolves into the checkout
        const lexical = '/home/runner/work/_actions/fro-bot/agent/v1'
        const {deps} = createDeps({
          actionPaths: [lexical],
          invokedAs: `${lexical}/main.js`,
          realpaths: {[lexical]: `${WORKSPACE}/vendored`, [`${lexical}/main.js`]: `${WORKSPACE}/vendored/main.js`},
        })

        // #when / #then
        expect((await runSandboxPreflight(deps)).ok).toBe(false)
      })

      it('compares against the canonical form of a writable root too (a workspace that is itself a link)', async () => {
        // #given a checkout path that is a link to /srv/real-ws, and an install living under the link's target
        const {deps} = createDeps({
          env: {...HOSTED_ENV, GITHUB_WORKSPACE: '/home/runner/work/link'},
          actionPaths: ['/srv/real-ws/tools/dist', '/srv/real-ws/tools'],
          invokedAs: '/srv/real-ws/tools/dist/main.js',
          realpaths: {'/home/runner/work/link': '/srv/real-ws'},
        })

        // #when / #then
        const result = await runSandboxPreflight(deps)
        expect(!result.ok && result.check).toBe('action-location')
      })

      it('accepts a published install invoked through its own path', async () => {
        // #given the runner started the Action from the _actions install
        const {deps} = createDeps({
          actionPaths: [`${PUBLISHED_CANONICAL}/dist`, PUBLISHED_CANONICAL],
          invokedAs: `${PUBLISHED_CANONICAL}/dist/main.js`,
        })

        // #when / #then
        expect((await runSandboxPreflight(deps)).ok).toBe(true)
      })

      it('fails closed when nothing says how the Action was started (no GITHUB_ACTION_PATH, no script path)', async () => {
        // #given a canonical install that looks fine, but no invocation path to compare it with
        const {deps} = createDeps({
          actionPaths: [`${PUBLISHED_CANONICAL}/dist`, PUBLISHED_CANONICAL],
          invokedAs: null,
        })

        // #when
        const result = await runSandboxPreflight(deps)

        // #then
        expect(!result.ok && result.check).toBe('action-location')
        expect(!result.ok && result.message).toContain('how the Action was started')
      })

      it('fails closed when the script path is not this install (inconclusive), without GITHUB_ACTION_PATH', async () => {
        // #given argv[1] belongs to some other program, so it says nothing about where this bundle was started from
        const {deps} = createDeps({
          actionPaths: [`${PUBLISHED_CANONICAL}/dist`, PUBLISHED_CANONICAL],
          invokedAs: '/usr/local/bin/bun-runner.js',
        })

        // #when / #then
        const result = await runSandboxPreflight(deps)
        expect(!result.ok && result.check).toBe('action-location')
      })

      it('lets a GITHUB_ACTION_PATH that names this install settle it when the script path is unavailable', async () => {
        // #given only the runner-reported path, and it is this install
        const {deps} = createDeps({
          env: {...HOSTED_ENV, GITHUB_ACTION_PATH: PUBLISHED_CANONICAL},
          actionPaths: [`${PUBLISHED_CANONICAL}/dist`, PUBLISHED_CANONICAL],
          invokedAs: null,
        })

        // #when / #then
        expect((await runSandboxPreflight(deps)).ok).toBe(true)
      })
    })

    describe('discoverActionLocation', () => {
      it('reads the script path and the bundle location, and reports the missing pieces as null/empty', () => {
        // #given the pieces Node gives a running script
        const found = discoverActionLocation({
          argv: ['/usr/bin/node', '/home/runner/work/_actions/fro-bot/agent/v1/dist/main.js'],
          moduleUrl: 'file:///home/runner/work/_actions/fro-bot/agent/v1/dist/main.js',
        })

        // #then the bundle's directory and its parent come from the module URL, and the invocation from argv[1]
        expect(found.invokedAs).toBe('/home/runner/work/_actions/fro-bot/agent/v1/dist/main.js')
        expect(found.actionPaths).toEqual([
          '/home/runner/work/_actions/fro-bot/agent/v1/dist',
          '/home/runner/work/_actions/fro-bot/agent/v1',
        ])
      })

      it('has no invocation without argv[1], and no install paths for a module URL that is not a file URL', () => {
        // #given a bare argv and a non-file URL
        const found = discoverActionLocation({argv: ['/usr/bin/node'], moduleUrl: 'data:text/javascript,x'})

        // #then
        expect(found.invokedAs).toBeNull()
        expect(found.actionPaths).toEqual([])
      })

      it('keeps an argv[1] that is a relative path as given, for the caller to resolve and reject or accept', () => {
        // #given `node ./x/dist/main.js`
        const found = discoverActionLocation({
          argv: ['/usr/bin/node', './x/dist/main.js'],
          moduleUrl: 'file:///opt/a/dist/main.js',
        })

        // #then
        expect(found.invokedAs).toBe('./x/dist/main.js')
      })
    })

    it('fails closed when the install location cannot be determined', async () => {
      // #given no location at all
      const {deps} = createDeps({actionPaths: []})

      // #when / #then
      const result = await runSandboxPreflight(deps)
      expect(!result.ok && result.check).toBe('action-location')
    })

    it('uses the working directory as the workspace when GITHUB_WORKSPACE is unset', async () => {
      // #given no GITHUB_WORKSPACE, and an install equal to the cwd
      const env = {...HOSTED_ENV, GITHUB_WORKSPACE: undefined}
      const {deps} = createDeps({env, actionPaths: [WORKSPACE]})

      // #when / #then
      const result = await runSandboxPreflight(deps)
      expect(!result.ok && result.check).toBe('action-location')
    })
  })
})
