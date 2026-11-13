import type {SandboxPreflightDeps} from './sandbox-preflight.js'
import type {ExecAdapter} from './types.js'
import path from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  discoverActionLocation,
  runSandboxPreflight,
  SANDBOX_TOOL_NAMES,
  TRUSTED_TOOL_DIRS,
} from './sandbox-preflight.js'

type EntryKind = 'directory' | 'file' | 'symlink' | 'other'

interface Overrides {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly uid?: number | null
  readonly missingTools?: readonly string[]
  readonly containerMarker?: string
  readonly sudoExitCode?: number
  readonly sysctls?: Readonly<Record<string, string | null>>
  /** The directory of the running bundle, as Node resolved it (canonical). Defaults to `<install>/dist`. */
  readonly bundleDir?: string | null
  /** The script path the runner started the Action with (`process.argv[1]`). Defaults to `<install>/dist/main.js`. */
  readonly invokedAs?: string | null
  /** The filesystem as `lstat` sees it. Defaults to a complete published install at `PUBLISHED_ROOT`. */
  readonly entries?: ReadonlyMap<string, EntryKind>
  /** Maps a path to its real path, as `fs.realpath` would. */
  readonly realpaths?: Readonly<Record<string, string>>
}

const HOSTED_ENV: NodeJS.ProcessEnv = {
  RUNNER_OS: 'Linux',
  RUNNER_ENVIRONMENT: 'github-hosted',
  HOME: '/home/runner',
  GITHUB_WORKSPACE: '/home/runner/work/repo/repo',
  RUNNER_TEMP: '/home/runner/work/_temp',
  GITHUB_ACTION_REPOSITORY: 'fro-bot/agent',
  GITHUB_ACTION_PATH: '/home/runner/work/_actions/fro-bot/agent/v1',
}
const WORK = '/home/runner/work'
const PUBLISHED_ROOT = '/home/runner/work/_actions/fro-bot/agent/v1'

/** A complete published install: every directory from the work dir down to `dist`, plus the manifest and the entry scripts. */
function publishedEntries(root: string, work = WORK): Map<string, EntryKind> {
  const entries = new Map<string, EntryKind>()
  let current = work
  entries.set(current, 'directory')
  for (const part of root.slice(work.length + 1).split('/')) {
    current = `${current}/${part}`
    entries.set(current, 'directory')
  }
  entries.set(`${root}/dist`, 'directory')
  for (const file of ['action.yaml', 'dist/main.js', 'dist/post.js', 'dist/key-proxy.js'])
    entries.set(`${root}/${file}`, 'file')
  return entries
}

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
    bundleDir: overrides.bundleDir === undefined ? `${PUBLISHED_ROOT}/dist` : overrides.bundleDir,
    invokedAs: overrides.invokedAs === undefined ? `${PUBLISHED_ROOT}/dist/main.js` : overrides.invokedAs,
    lstat: async absolutePath => (overrides.entries ?? publishedEntries(PUBLISHED_ROOT)).get(absolutePath) ?? null,
    realpath: async absolutePath => overrides.realpaths?.[absolutePath] ?? absolutePath,
    cwd: '/home/runner/work/repo/repo',
    logger: createMockLogger(),
  }
  return {deps, getExecOutput}
}

async function expectRefused(deps: SandboxPreflightDeps, getExecOutput: {mock: unknown}, reason?: RegExp) {
  const result = await runSandboxPreflight(deps)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.check).toBe('action-location')
  expect(result.message).toContain('fro-bot/agent@')
  if (reason !== undefined) expect(result.message).toMatch(reason)
  // refused before any privileged probe
  expect((getExecOutput as {mock: {calls: unknown[]}}).mock.calls).toHaveLength(0)
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

  describe('published installs only', () => {
    const WORKSPACE = '/home/runner/work/repo/repo'
    const withInstall = (root: string, extra: Partial<Parameters<typeof createDeps>[0]> = {}) =>
      createDeps({
        env: {...HOSTED_ENV, GITHUB_ACTION_PATH: root},
        bundleDir: `${root}/dist`,
        invokedAs: `${root}/dist/main.js`,
        entries: publishedEntries(root),
        ...extra,
      })

    it('passes for a published install', async () => {
      // #given the Action installed under the runner's _actions tree, started from it
      const {deps} = createDeps()

      // #when / #then
      expect((await runSandboxPreflight(deps)).ok).toBe(true)
    })

    it('derives the work directory from RUNNER_TEMP instead of assuming /home/runner/work', async () => {
      // #given a runner whose work directory is elsewhere
      const work = '/srv/gha/work'
      const root = `${work}/_actions/fro-bot/agent/v1`
      const {deps} = withInstall(root, {
        env: {...HOSTED_ENV, RUNNER_TEMP: `${work}/_temp`, GITHUB_ACTION_PATH: root},
        entries: publishedEntries(root, work),
      })

      // #when / #then
      expect((await runSandboxPreflight(deps)).ok).toBe(true)
    })

    it.each(['v1', 'feature/x', 'release/2026/11', '..action'])(
      'passes for the ref %s (a ref may contain "/")',
      async ref => {
        // #given a published install whose ref is shown
        const root = `${WORK}/_actions/fro-bot/agent/${ref}`
        const {deps} = withInstall(root)

        // #when / #then
        expect((await runSandboxPreflight(deps)).ok).toBe(true)
      },
    )

    it('passes for a repository literally named ..action under _actions (a real directory, not a climb)', async () => {
      // #given
      const root = `${WORK}/_actions/fro-bot/..action/v1`
      const {deps} = withInstall(root)

      // #when / #then
      expect((await runSandboxPreflight(deps)).ok).toBe(true)
    })

    it('refuses a local install (uses: ./) before probing anything', async () => {
      // #given the Action started from the checkout
      const root = WORKSPACE
      const {deps, getExecOutput} = withInstall(root, {entries: publishedEntries(`${WORK}/_actions/x/y/z`)})

      // #when / #then
      await expectRefused(deps, getExecOutput)
    })

    it('refuses a checkout directory named ..action (the path that used to read as a climb out of the workspace)', async () => {
      // #given `uses: ./..action`
      const root = `${WORKSPACE}/..action`
      const {deps, getExecOutput} = withInstall(root)

      // #when / #then
      await expectRefused(deps, getExecOutput)
    })

    it.each([
      ['_actions itself', `${WORK}/_actions`],
      ['an owner directory', `${WORK}/_actions/fro-bot`],
      ['a repository directory without a ref', `${WORK}/_actions/fro-bot/agent`],
      ['a sibling of _actions', `${WORK}/_temp/fro-bot/agent/v1`],
      ['a path that climbs out of _actions', `${WORK}/_actions/fro-bot/agent/../../../repo/repo`],
    ])('refuses %s as the install root', async (_label, root) => {
      // #given an invocation path that is not <work>/_actions/<owner>/<repo>/<ref>
      const {deps, getExecOutput} = withInstall(root, {entries: publishedEntries(path.resolve(root))})

      // #when / #then
      await expectRefused(deps, getExecOutput)
    })

    it.each([
      ['the work directory', WORK],
      ['_actions', `${WORK}/_actions`],
      ['the owner directory', `${WORK}/_actions/fro-bot`],
      ['the repository directory', `${WORK}/_actions/fro-bot/agent`],
      ['the ref directory', PUBLISHED_ROOT],
      ['dist', `${PUBLISHED_ROOT}/dist`],
    ])('refuses a symlink at %s, even when it points at a protected install', async (_label, linked) => {
      // #given that component is a symlink (to somewhere protected, so the canonical path looks fine)
      const entries = publishedEntries(PUBLISHED_ROOT)
      entries.set(linked, 'symlink')
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {entries})

      // #when / #then
      await expectRefused(deps, getExecOutput, /symlink/)
    })

    it('refuses an intermediate hop: protected -> writable -> protected', async () => {
      // #given _actions/.../v1 is a link into the checkout, which links back to a protected install
      const entries = publishedEntries(PUBLISHED_ROOT)
      entries.set(PUBLISHED_ROOT, 'symlink')
      entries.set(`${WORKSPACE}/hop`, 'symlink')
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {
        entries,
        realpaths: {[PUBLISHED_ROOT]: '/opt/protected-agent', [`${WORKSPACE}/hop`]: '/opt/protected-agent'},
      })

      // #when / #then the walk stops at the first link; the endpoints being protected does not matter
      await expectRefused(deps, getExecOutput, /symlink/)
    })

    it.each([
      ['action.yaml is a symlink', `${PUBLISHED_ROOT}/action.yaml`, 'symlink'],
      ['action.yaml is a directory', `${PUBLISHED_ROOT}/action.yaml`, 'directory'],
      ['main.js is a symlink', `${PUBLISHED_ROOT}/dist/main.js`, 'symlink'],
      ['post.js is a symlink', `${PUBLISHED_ROOT}/dist/post.js`, 'symlink'],
      ['post.js is a FIFO or device', `${PUBLISHED_ROOT}/dist/post.js`, 'other'],
      ['key-proxy.js is a symlink', `${PUBLISHED_ROOT}/dist/key-proxy.js`, 'symlink'],
      ['key-proxy.js is a directory', `${PUBLISHED_ROOT}/dist/key-proxy.js`, 'directory'],
    ] as const)('refuses an install where %s', async (_label, target, kind) => {
      // #given the file the runner reloads or executes is not a regular file
      const entries = publishedEntries(PUBLISHED_ROOT)
      entries.set(target, kind)
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {entries})

      // #when / #then
      await expectRefused(deps, getExecOutput, /regular file/)
    })

    it('refuses an install that has no key-proxy.js, because the proxy child is the program that holds the keys', async () => {
      // #given an install without the proxy entry
      const entries = publishedEntries(PUBLISHED_ROOT)
      entries.delete(`${PUBLISHED_ROOT}/dist/key-proxy.js`)
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {entries})

      // #when / #then
      await expectRefused(deps, getExecOutput, /key-proxy\.js is not a regular file/)
    })

    it('accepts action.yml in place of action.yaml, and refuses neither being present', async () => {
      // #given only action.yml
      const entries = publishedEntries(PUBLISHED_ROOT)
      entries.delete(`${PUBLISHED_ROOT}/action.yaml`)
      entries.set(`${PUBLISHED_ROOT}/action.yml`, 'file')
      expect((await runSandboxPreflight(withInstall(PUBLISHED_ROOT, {entries}).deps)).ok).toBe(true)

      // #and neither
      entries.delete(`${PUBLISHED_ROOT}/action.yml`)
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {entries})
      await expectRefused(deps, getExecOutput, /action\.ya?ml/)
    })

    it('refuses an empty or missing GITHUB_ACTION_REPOSITORY (provenance only), but never accepts on it alone', async () => {
      for (const value of ['', undefined]) {
        // #given a published layout with no repository provenance
        const {deps, getExecOutput} = createDeps({env: {...HOSTED_ENV, GITHUB_ACTION_REPOSITORY: value}})

        // #when / #then
        await expectRefused(deps, getExecOutput, /GITHUB_ACTION_REPOSITORY/)
      }

      // #and a repository name with a local layout is still refused
      const {deps, getExecOutput} = withInstall(WORKSPACE)
      await expectRefused(deps, getExecOutput)
    })

    it('refuses when the bundle that is running is not the one the runner started', async () => {
      // #given the invocation path says _actions, but the running bundle lives in the checkout
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {bundleDir: `${WORKSPACE}/dist`})

      // #when / #then
      await expectRefused(deps, getExecOutput, /bundle/)
    })

    it('refuses when GITHUB_ACTION_PATH and the script path disagree', async () => {
      // #given two published installs, one reported and the other started
      const other = `${WORK}/_actions/fro-bot/agent/v2`
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {invokedAs: `${other}/dist/main.js`})

      // #when / #then
      await expectRefused(deps, getExecOutput)
    })

    it('derives the install from the script path when GITHUB_ACTION_PATH is unset', async () => {
      // #given only argv[1]
      const {deps} = withInstall(PUBLISHED_ROOT, {env: {...HOSTED_ENV, GITHUB_ACTION_PATH: undefined}})

      // #when / #then
      expect((await runSandboxPreflight(deps)).ok).toBe(true)
    })

    it('fails closed when neither GITHUB_ACTION_PATH nor a script path says how the Action was started', async () => {
      // #given a perfectly good canonical bundle, but no lexical invocation
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {
        env: {...HOSTED_ENV, GITHUB_ACTION_PATH: undefined},
        invokedAs: null,
      })

      // #when / #then
      await expectRefused(deps, getExecOutput, /how the Action was started/)
    })

    it('fails closed without RUNNER_TEMP, since the work directory cannot be derived', async () => {
      // #given
      const {deps, getExecOutput} = createDeps({env: {...HOSTED_ENV, RUNNER_TEMP: undefined}})

      // #when / #then
      await expectRefused(deps, getExecOutput, /work directory/)
    })

    it('fails closed when the running bundle location is unknown', async () => {
      // #given
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {bundleDir: null})

      // #when / #then
      await expectRefused(deps, getExecOutput, /bundle/)
    })

    it('refuses a missing component rather than assuming it exists', async () => {
      // #given dist is absent
      const entries = publishedEntries(PUBLISHED_ROOT)
      entries.delete(`${PUBLISHED_ROOT}/dist`)
      const {deps, getExecOutput} = withInstall(PUBLISHED_ROOT, {entries})

      // #when / #then
      await expectRefused(deps, getExecOutput, /dist/)
    })

    describe('discoverActionLocation', () => {
      it('reads the script path and the canonical bundle directory', () => {
        // #given the pieces Node gives a running script
        const found = discoverActionLocation({
          argv: ['/usr/bin/node', `${PUBLISHED_ROOT}/dist/main.js`],
          moduleUrl: `file://${PUBLISHED_ROOT}/dist/main.js`,
        })

        // #then
        expect(found.invokedAs).toBe(`${PUBLISHED_ROOT}/dist/main.js`)
        expect(found.bundleDir).toBe(`${PUBLISHED_ROOT}/dist`)
      })

      it('has no invocation without argv[1] and no bundle for a module URL that is not a file URL', () => {
        // #given
        const found = discoverActionLocation({argv: ['/usr/bin/node'], moduleUrl: 'data:text/javascript,x'})

        // #then
        expect(found.invokedAs).toBeNull()
        expect(found.bundleDir).toBeNull()
      })
    })
  })
})
