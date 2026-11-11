import type {SandboxPreflightDeps} from './sandbox-preflight.js'
import type {ExecAdapter} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {runSandboxPreflight, SANDBOX_TOOL_NAMES, TRUSTED_TOOL_DIRS} from './sandbox-preflight.js'

interface Overrides {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly uid?: number | null
  readonly missingTools?: readonly string[]
  readonly containerMarker?: string
  readonly sudoExitCode?: number
  readonly sysctls?: Readonly<Record<string, string | null>>
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
    env: overrides.env ?? {RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted'},
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
    const {deps} = createDeps({env: {RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted', PATH: '/tmp/evil'}})

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
})
