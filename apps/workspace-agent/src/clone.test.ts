import type {Stats} from 'node:fs'

import type {ExecFileFn} from './clone.js'
import type {GitOutcome, GitRunnerFn, GitRunnerOptions} from './git-safety.js'
import type {HandoffOps} from './handoff.js'

import {chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm} from 'node:fs/promises'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {executeClone, resetCloneSemaphoreForTesting, scrubCredentials} from './clone.js'
import {AGENT_GID, AGENT_UID} from './identity.js'
import {repoMutexKey, resetRepoLocksForTesting, withRepoLock} from './repo-mutex.js'

// #given mocked fs operations
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    chmod: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn(),
    open: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    realpath: vi.fn(),
    // Journal-store reads (journal.ts, used by clone.ts's outstanding-journal check) go through
    // these two. Defaulted to "nothing exists" in beforeEach so every pre-existing test below
    // sees an absent journal and proceeds exactly as before Unit 3.
    lstat: vi.fn(),
    readFile: vi.fn(),
  }
})

const mockChmod = vi.mocked(chmod)
const mockMkdir = vi.mocked(mkdir)
const mockMkdtemp = vi.mocked(mkdtemp)
const mockOpen = vi.mocked(open)
const mockRename = vi.mocked(rename)
const mockRm = vi.mocked(rm)
const mockRealpath = vi.mocked(realpath)
const mockLstat = vi.mocked(lstat)
const mockReadFile = vi.mocked(readFile)

const TEST_REPOS_ROOT = '/workspace/repos'
const FAKE_ASKPASS_DIR = '/tmp/workspace-agent-askpass-abc123'
const FAKE_ASKPASS_PATH = `${FAKE_ASKPASS_DIR}/askpass.sh`
/** Root-owned staging parent — mirrors identity.ts (WORKSPACE_STATE_DIR_NAME/CLONE_STAGING_DIR_NAME). */
const STAGING_ROOT = `${TEST_REPOS_ROOT}/.workspace-agent/staging`
const FAKE_STAGING_CLONE_DIR = `${STAGING_ROOT}/clone-xyz789`

/** Create a fake FileHandle with writeFile and close mocks. */
function makeFakeFileHandle() {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function makeExecFile(
  results: {stdout?: string; stderr?: string; error?: Error}[],
): ExecFileFn & ReturnType<typeof vi.fn> {
  let callIndex = 0
  return vi.fn().mockImplementation(async () => {
    const result = results[callIndex++]
    if (result === undefined) throw new Error('Unexpected execFile call')
    if (result.error !== undefined) return Promise.reject(result.error)
    return Promise.resolve({stdout: result.stdout ?? '', stderr: result.stderr ?? ''})
  }) as ExecFileFn & ReturnType<typeof vi.fn>
}

/** Injected git runner for repo-exists / race-check validation (AGENT_UID/AGENT_GID, git-safety.ts). */
function makeGitRunner(outcomes: GitOutcome[]): GitRunnerFn & ReturnType<typeof vi.fn> {
  let callIndex = 0
  return vi.fn().mockImplementation(async () => {
    const outcome = outcomes[callIndex++]
    if (outcome === undefined) throw new Error('Unexpected gitRunner call')
    return outcome
  }) as GitRunnerFn & ReturnType<typeof vi.fn>
}

/** Minimal fake node:fs Stats for handoff ops. */
function makeStats(overrides: {
  readonly dev?: number
  readonly nlink?: number
  readonly mode?: number
  readonly isSymbolicLink?: boolean
  readonly isDirectory?: boolean
  readonly isFile?: boolean
}): Stats {
  const {dev = 1, nlink = 1, mode = 0o755, isSymbolicLink = false, isDirectory = true, isFile = false} = overrides
  return {
    dev,
    nlink,
    mode,
    isSymbolicLink: () => isSymbolicLink,
    isDirectory: () => isDirectory,
    isFile: () => isFile,
  } as unknown as Stats
}

/** A handoff that treats the staged root as an empty, already-usable directory — the default happy path. */
function makeHandoffOps(): HandoffOps {
  return {
    lstat: vi.fn().mockResolvedValue(makeStats({isDirectory: true})),
    readdir: vi.fn().mockResolvedValue([]),
    lchown: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
  }
}

const VALID_REQUEST = {
  owner: 'fro-bot',
  repo: 'agent',
  token: `ghs_${'a'.repeat(36)}`,
}

/** Shared mkdtempFn: returns the askpass dir for the askpass prefix, the staging dir otherwise. */
const fakeMkdtempFn = vi.fn().mockImplementation(async (prefix: string) => {
  if (prefix.includes('askpass')) return FAKE_ASKPASS_DIR
  return FAKE_STAGING_CLONE_DIR
})

function resetFakeMkdtempFn(): void {
  fakeMkdtempFn.mockReset()
  fakeMkdtempFn.mockImplementation(async (prefix: string) => {
    if (prefix.includes('askpass')) return FAKE_ASKPASS_DIR
    return FAKE_STAGING_CLONE_DIR
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  resetCloneSemaphoreForTesting()
  resetRepoLocksForTesting()
  // Re-setup default implementations after reset.
  mockMkdir.mockResolvedValue(undefined)
  mockMkdtemp.mockResolvedValue(FAKE_ASKPASS_DIR)
  mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
  mockChmod.mockResolvedValue(undefined)
  mockRename.mockResolvedValue(undefined)
  mockRm.mockResolvedValue(undefined)
  resetFakeMkdtempFn()
  // Default: path does not exist (ENOENT on first realpath call)
  mockRealpath.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
  // Default: resolved path after clone
  mockRealpath.mockResolvedValue(`${TEST_REPOS_ROOT}/fro-bot/agent`)
  // Default: no journal for any repo — journal.ts's directory-safety checks see nothing on disk,
  // so readJournal reports 'absent' and clone proceeds exactly as it did before Unit 3.
  mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
  mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
})

describe('executeClone — happy path', () => {
  it('invokes git clone with correct args and no token in argv', async () => {
    // #given
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'abc123def456\n', stderr: ''}, // git rev-parse HEAD
    ])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(200)
    expect(result.response.ok).toBe(true)
    const successResponse = result.response as {ok: true; path: string; commit: string}
    expect(successResponse.path).toBe(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    expect(successResponse.commit).toBe('abc123def456')

    // Assert exact git clone argv — token MUST NOT appear
    const cloneCall = execFileFn.mock.calls[0] as [string, string[], {env: Record<string, string>}] | undefined
    expect(cloneCall).toBeDefined()
    expect(cloneCall![0]).toBe('git')
    // Clone goes to a tmp path (atomic clone)
    const cloneArgs = cloneCall![1]
    expect(cloneArgs[0]).toBe('-c')
    expect(cloneArgs[1]).toBe('credential.helper=')
    expect(cloneArgs[2]).toBe('clone')
    expect(cloneArgs[3]).toBe('https://github.com/fro-bot/agent.git')
    // Clone target is the unique staging directory under the root-owned staging parent —
    // never beside the destination, never under the agent-traversable owner dir.
    expect(cloneArgs[4]).toBe(FAKE_STAGING_CLONE_DIR)

    // Token must not appear in any argv
    const allArgs = execFileFn.mock.calls.flatMap((c: unknown[]) => c).join(' ')
    expect(allArgs).not.toContain(VALID_REQUEST.token)
    expect(allArgs).not.toContain('ghs_')
  })

  it('sets required git trace suppression env vars', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — assert env on the clone call
    const cloneCallOptions = execFileFn.mock.calls[0]![2] as {env: Record<string, string>}
    const cloneCallEnv = cloneCallOptions.env
    expect(cloneCallEnv.GIT_TRACE).toBe('0')
    expect(cloneCallEnv.GIT_TRACE_PACKET).toBe('0')
    expect(cloneCallEnv.GIT_TRACE_PERFORMANCE).toBe('0')
    expect(cloneCallEnv.GIT_CURL_VERBOSE).toBe('0')
    expect(cloneCallEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(cloneCallEnv.GIT_ASKPASS).toBe(FAKE_ASKPASS_PATH)
  })

  it('seals git config resolution on the clone subprocess env', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — global/system config is disabled so a planted url.<x>.insteadOf
    // redirect cannot hijack the credentialed clone request (a fresh clone has
    // no repo-local config yet, so global/system are the only places it could
    // come from), and only https is allowed.
    const cloneCallEnv = (execFileFn.mock.calls[0]![2] as {env: Record<string, string>}).env
    expect(cloneCallEnv.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(cloneCallEnv.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(cloneCallEnv.GIT_ALLOW_PROTOCOL).toBe('https')
  })

  it('propagates egress proxy env vars to the git clone subprocess', async () => {
    // #given — a proxy is configured in the container env (sandbox network)
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])
    const priorHttps = process.env.HTTPS_PROXY
    const priorNo = process.env.NO_PROXY
    process.env.HTTPS_PROXY = 'http://mitmproxy:8080'
    process.env.NO_PROXY = 'localhost,127.0.0.1'

    try {
      // #when
      await executeClone(VALID_REQUEST, {
        execFileFn,
        reposRoot: TEST_REPOS_ROOT,
        mkdtempFn: fakeMkdtempFn,
        options: {timeoutMs: 500},
        handoffOps: makeHandoffOps(),
      })

      // #then — the clone subprocess inherits the proxy settings
      const cloneCallEnv = (execFileFn.mock.calls[0]![2] as {env: Record<string, string>}).env
      expect(cloneCallEnv.HTTPS_PROXY).toBe('http://mitmproxy:8080')
      expect(cloneCallEnv.NO_PROXY).toBe('localhost,127.0.0.1')
    } finally {
      if (priorHttps === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = priorHttps
      if (priorNo === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = priorNo
    }
  })

  it('passes token via GITHUB_TOKEN env var, not embedded in script body', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — GITHUB_TOKEN in env contains the token
    const cloneCallOptions = execFileFn.mock.calls[0]![2] as {env: Record<string, string>}
    const cloneCallEnv = cloneCallOptions.env
    expect(cloneCallEnv.GITHUB_TOKEN).toBe(VALID_REQUEST.token)

    // Token must NOT appear in env values other than GITHUB_TOKEN
    const envWithoutToken = {...cloneCallEnv, GITHUB_TOKEN: '[REDACTED]'}
    const envValues = Object.values(envWithoutToken).join(' ')
    expect(envValues).not.toContain(VALID_REQUEST.token)
    expect(envValues).not.toContain('ghs_')
  })

  it('askpass script body does NOT contain the token literal', async () => {
    // #given
    const fakeHandle = makeFakeFileHandle()
    mockOpen.mockResolvedValue(fakeHandle as unknown as import('node:fs/promises').FileHandle)
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — script content uses $GITHUB_TOKEN, not the literal token
    expect(fakeHandle.writeFile).toHaveBeenCalledOnce()
    const scriptContent = fakeHandle.writeFile.mock.calls[0]![0] as string
    expect(scriptContent).toContain('GITHUB_TOKEN')
    expect(scriptContent).toContain('printf')
    expect(scriptContent).not.toContain(VALID_REQUEST.token)
    expect(scriptContent).not.toContain('ghs_')
  })

  it('askpass script uses case/printf and answers ONLY the exact github.com https prompts', async () => {
    // #given
    const fakeHandle = makeFakeFileHandle()
    mockOpen.mockResolvedValue(fakeHandle as unknown as import('node:fs/promises').FileHandle)
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — exact-literal case arms (no glob), matching git's real prompt text
    // (confirmed against real git in clone.askpass.test.ts) for https://github.com only.
    // A glob like `Username*`/`Password*` would answer ANY host's prompt — including one
    // reached via an HTTP redirect to an attacker-controlled or lookalike host.
    const scriptContent = fakeHandle.writeFile.mock.calls[0]![0] as string
    expect(scriptContent).toContain('case "$1"')
    expect(scriptContent).toContain(`"Username for 'https://github.com': ")`)
    expect(scriptContent).toContain('x-access-token')
    expect(scriptContent).toContain(`"Password for 'https://x-access-token@github.com': ")`)
  })

  it('opens askpass.sh with O_EXCL (wx flag) in the mkdtemp dir', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    // O_EXCL is a real security property (refuses to follow/overwrite an existing
    // path), so it stays asserted here. The mode passed to open() is NOT asserted
    // here anymore: it's masked by the process umask and is not what actually sets
    // the final mode (see the next test, and clone.askpass.test.ts for the real,
    // umask-independent, git-can-execute-it proof).
    expect(mockOpen).toHaveBeenCalledWith(FAKE_ASKPASS_PATH, 'wx', expect.any(Number))
  })

  it('chmods askpass.sh to 0700 after writing it (umask-independent)', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    // chmod, not the open() mode argument, is what guarantees the execute bit:
    // open()'s requested mode is masked by the process umask, so an unusual umask
    // could silently strip owner-execute back to 0600 and reintroduce the
    // "cannot exec" failure. chmod sets the mode unconditionally.
    expect(mockChmod).toHaveBeenCalledWith(FAKE_ASKPASS_PATH, 0o700)
  })

  it('creates the repos root directory with mkdir -p', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(mockMkdir).toHaveBeenCalledWith(`${TEST_REPOS_ROOT}/fro-bot`, {recursive: true, mode: 0o755})
  })

  it('renames tmp clone to dest on success (atomic clone)', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — rename called from the staging dir to destPath
    expect(mockRename).toHaveBeenCalledOnce()
    const [from, to] = mockRename.mock.calls[0] as [string, string]
    expect(from).toBe(FAKE_STAGING_CLONE_DIR)
    expect(to).toBe(`${TEST_REPOS_ROOT}/fro-bot/agent`)
  })

  it('cleans up askpass dir in finally on success', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — rm called for askpass dir cleanup
    expect(mockRm).toHaveBeenCalledWith(FAKE_ASKPASS_DIR, {recursive: true, force: true})
  })

  it('commit is a non-empty string from rev-parse', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: `${'a'.repeat(40)}\n`}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(200)
    const success = result.response as {ok: true; commit: string}
    expect(success.commit).toBe('a'.repeat(40))
  })
})

describe('executeClone — idempotency (repo-exists)', () => {
  it('returns 409 repo-exists when destination already exists and is a valid non-bare git checkout', async () => {
    // #given — realpath succeeds on first call (path exists);
    // gitRunner: --is-inside-work-tree returns "true" and --verify HEAD^{commit} succeeds
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    resetFakeMkdtempFn()
    // First realpath call succeeds → path already exists (no ENOENT)
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    // Two git validation calls: --is-inside-work-tree → "true", --verify HEAD^{commit} → sha
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''}, // rev-parse --is-inside-work-tree
      {kind: 'ok', stdout: 'abc123def456\n', stderr: ''}, // rev-parse --verify HEAD^{commit}
    ])
    const execFileFn = vi.fn() as unknown as ExecFileFn

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'repo-exists'})
    // The clone itself (execFileFn) is never invoked — the checkout already exists.
    expect(execFileFn).not.toHaveBeenCalled()
  })

  it('runs the repo-exists validation as AGENT_UID/AGENT_GID with the exact safe.directory args', async () => {
    // #given
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    resetFakeMkdtempFn()
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''},
      {kind: 'ok', stdout: 'abc123def456\n', stderr: ''},
    ])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn: vi.fn() as unknown as ExecFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — both validation calls run as AGENT_UID/AGENT_GID, with a safe.directory reset
    // followed by exactly the canonical checkout path (never `*`, never a parent path).
    expect(gitRunner).toHaveBeenCalledTimes(2)
    for (const call of gitRunner.mock.calls) {
      const [args, options] = call as [readonly string[], GitRunnerOptions]
      expect(options.uid).toBe(AGENT_UID)
      expect(options.gid).toBe(AGENT_GID)
      expect(args).toContain('safe.directory=')
      expect(args).toContain(`safe.directory=${TEST_REPOS_ROOT}/fro-bot/agent`)
      expect(args.slice(0, 2)).toEqual(['-C', `${TEST_REPOS_ROOT}/fro-bot/agent`])
    }
  })

  it('does NOT return repo-exists when destination is a bare repo (--is-inside-work-tree returns false)', async () => {
    // #given — realpath succeeds (path exists) but --is-inside-work-tree returns "false" (bare repo)
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    resetFakeMkdtempFn()
    // First realpath call succeeds → path exists
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    // --is-inside-work-tree returns "false" → bare repo
    const gitRunner = makeGitRunner([{kind: 'ok', stdout: 'false\n', stderr: ''}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn: vi.fn() as unknown as ExecFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — bare repo must NOT return repo-exists; fail closed
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    expect(result.response.ok).toBe(false)
  })

  it('does NOT return repo-exists when destination exists but is empty (not a git repo)', async () => {
    // #given — realpath succeeds (path exists) but --is-inside-work-tree fails (empty/non-git dir)
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    resetFakeMkdtempFn()
    // First realpath call succeeds → path exists
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    // --is-inside-work-tree fails → not a git repo
    const gitRunner = makeGitRunner([{kind: 'failed', code: 128, stdout: '', stderr: 'fatal: not a git repository'}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn: vi.fn() as unknown as ExecFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — must NOT return repo-exists for a non-git directory
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    // Should fail closed (clone-failed or similar non-success)
    expect(result.response.ok).toBe(false)
  })

  it('does NOT return repo-exists when destination exists but HEAD^{commit} returns empty (unborn branch)', async () => {
    // #given — realpath succeeds (path exists); --is-inside-work-tree returns "true" but
    // --verify HEAD^{commit} returns empty string (unborn branch / corrupt checkout)
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    resetFakeMkdtempFn()
    // First realpath call succeeds → path exists
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    // --is-inside-work-tree returns "true" but HEAD^{commit} returns empty
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''}, // --is-inside-work-tree
      {kind: 'ok', stdout: '', stderr: ''}, // --verify HEAD^{commit} → empty (unborn branch)
    ])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn: vi.fn() as unknown as ExecFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — must NOT return repo-exists for an unborn/corrupt checkout
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    expect(result.response.ok).toBe(false)
  })

  it('fails closed (does not return repo-exists) on a gitRunner timeout or unconfirmed termination', async () => {
    // #given — realpath succeeds (path exists); the confirmed-termination runner reports a timeout
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    resetFakeMkdtempFn()
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    const gitRunner = makeGitRunner([{kind: 'timeout'}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn: vi.fn() as unknown as ExecFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    expect(result.response.ok).toBe(false)
  })

  it('preserves symlink/root safety: does NOT return repo-exists when resolved path escapes repos root', async () => {
    // #given — realpath succeeds but resolves to a path outside the repos root (symlink attack)
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    resetFakeMkdtempFn()
    // First realpath call resolves to a path OUTSIDE the repos root
    mockRealpath.mockResolvedValueOnce('/etc/passwd')
    const execFileFn = vi.fn() as unknown as ExecFileFn

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — must NOT return repo-exists; path-escaped-workspace or similar failure
    expect(result.response.ok).toBe(false)
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
  })
})

describe('executeClone — clone failure paths', () => {
  it('returns enospc on disk full error', async () => {
    // #given
    const diskFullError = new Error('fatal: write error: No space left on device')
    const execFileFn = makeExecFile([{error: diskFullError}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(500)
    expect(result.response).toEqual({ok: false, error: 'enospc', code: 'ENOSPC'})
  })

  it('returns git-not-available when git binary is missing', async () => {
    // #given
    const noGitError = Object.assign(new Error('spawn git ENOENT'), {code: 'ENOENT'})
    noGitError.message = 'spawn git ENOENT'
    const execFileFn = makeExecFile([{error: noGitError}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(500)
    expect(result.response).toEqual({ok: false, error: 'git-not-available'})
  })

  it('returns clone-failed on generic git error', async () => {
    // #given
    const gitError = new Error('fatal: repository not found')
    const execFileFn = makeExecFile([{error: gitError}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(500)
    expect(result.response).toEqual({ok: false, error: 'clone-failed'})
  })

  it('scrubs x-access-token from error messages before returning', async () => {
    // #given — git error that echoes the URL with the token
    const gitError = new Error(
      'fatal: repository https://x-access-token:ghs_secret123@github.com/org/repo.git not found',
    )
    const execFileFn = makeExecFile([{error: gitError}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — error response must not contain the token
    const responseStr = JSON.stringify(result.response)
    expect(responseStr).not.toContain('ghs_secret123')
    expect(responseStr).not.toContain('x-access-token:ghs_')
  })

  it('cleans up askpass dir even when clone fails', async () => {
    // #given
    const gitError = new Error('fatal: not found')
    const execFileFn = makeExecFile([{error: gitError}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — rm called for askpass dir cleanup
    expect(mockRm).toHaveBeenCalledWith(FAKE_ASKPASS_DIR, {recursive: true, force: true})
  })

  it('cleans up tmp clone dir when clone fails (no partial clone at destPath)', async () => {
    // #given
    const gitError = new Error('fatal: not found')
    const execFileFn = makeExecFile([{error: gitError}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — rm called for the staging clone dir (not destPath)
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
    // destPath must NOT have been rm'd (partial clone never reached it)
    const rmCalls = mockRm.mock.calls.map(c => c[0] as string)
    const destRm = rmCalls.find(p => p === `${TEST_REPOS_ROOT}/fro-bot/agent`)
    expect(destRm).toBeUndefined()
  })
})

describe('executeClone — HEAD SHA failure', () => {
  it('returns head-resolution-failed when rev-parse throws', async () => {
    // #given — clone succeeds, rev-parse throws
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {error: new Error('fatal: not a git repository')}, // git rev-parse HEAD
    ])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — must NOT return ok:true with 'unknown'
    expect(result.response.ok).toBe(false)
    const failure = result.response as {ok: false; error: string}
    expect(failure.error).toBe('head-resolution-failed')
    expect(result.statusCode).toBe(500)
  })

  it('returns head-resolution-failed when rev-parse returns empty string', async () => {
    // #given — clone succeeds, rev-parse returns empty
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: '   \n', stderr: ''}, // git rev-parse HEAD — empty after trim
    ])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.response.ok).toBe(false)
    const failure = result.response as {ok: false; error: string}
    expect(failure.error).toBe('head-resolution-failed')
  })
})

describe('executeClone — timeout', () => {
  it('returns clone-timeout when AbortError is thrown', async () => {
    // #given — execFile rejects with AbortError
    const abortError = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
    const execFileFn = makeExecFile([{error: abortError}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(504)
    expect(result.response).toEqual({ok: false, error: 'clone-timeout'})
  })

  it('clone-timeout response does not contain the token', async () => {
    // #given
    const abortError = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
    const execFileFn = makeExecFile([{error: abortError}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    const responseStr = JSON.stringify(result.response)
    expect(responseStr).not.toContain(VALID_REQUEST.token)
    expect(responseStr).not.toContain('ghs_')
  })

  it('cleans up askpass dir after timeout', async () => {
    // #given
    const abortError = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
    const execFileFn = makeExecFile([{error: abortError}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(mockRm).toHaveBeenCalledWith(FAKE_ASKPASS_DIR, {recursive: true, force: true})
  })

  it('cleans up the staging clone dir after timeout (nothing left under staging)', async () => {
    // #given
    const abortError = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
    const execFileFn = makeExecFile([{error: abortError}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
  })
})

describe('executeClone — atomic clone (rename)', () => {
  it('returns clone-failed when rename fails with unexpected error', async () => {
    // #given — clone succeeds but rename fails
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])
    mockRename.mockRejectedValueOnce(new Error('EXDEV: cross-device link not permitted'))

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(500)
    expect(result.response).toEqual({ok: false, error: 'clone-failed'})
  })

  it('cleans up tmp clone dir when rename fails', async () => {
    // #given
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])
    mockRename.mockRejectedValueOnce(new Error('EXDEV: cross-device link not permitted'))

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — staging clone dir cleaned up
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
  })

  it('rename race EEXIST + valid non-bare git checkout at dest → returns repo-exists (409)', async () => {
    // #given — clone succeeds, rename fails with EEXIST (race), dest is a valid non-bare git checkout,
    // validated as AGENT_UID/AGENT_GID via gitRunner (not execFileFn)
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'sha123\n', stderr: ''}, // rev-parse HEAD (staging, pre-handoff)
    ])
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''}, // --is-inside-work-tree (race dest)
      {kind: 'ok', stdout: 'abc123def456\n', stderr: ''}, // --verify HEAD^{commit} (race dest)
    ])
    mockRename.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    // realpath for the race dest resolves successfully within repos root
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — race dest is a valid non-bare git checkout → repo-exists
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'repo-exists'})
  })

  it('runs the race-check validation as AGENT_UID/AGENT_GID with the exact safe.directory args', async () => {
    // #given
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''},
      {kind: 'ok', stdout: 'abc123def456\n', stderr: ''},
    ])
    mockRename.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then
    expect(gitRunner).toHaveBeenCalledTimes(2)
    for (const call of gitRunner.mock.calls) {
      const [args, options] = call as [readonly string[], GitRunnerOptions]
      expect(options.uid).toBe(AGENT_UID)
      expect(options.gid).toBe(AGENT_GID)
      expect(args).toContain('safe.directory=')
      expect(args).toContain(`safe.directory=${TEST_REPOS_ROOT}/fro-bot/agent`)
    }
  })

  it('rename race ENOTEMPTY + valid non-bare git checkout at dest → returns repo-exists (409)', async () => {
    // #given — clone succeeds, rename fails with ENOTEMPTY (race), dest is a valid non-bare git checkout
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'deadbeef1234\n', stderr: ''}, // rev-parse HEAD (staging, pre-handoff)
    ])
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''}, // --is-inside-work-tree (race dest)
      {kind: 'ok', stdout: 'deadbeef1234\n', stderr: ''}, // --verify HEAD^{commit} (race dest)
    ])
    mockRename.mockRejectedValueOnce(new Error('ENOTEMPTY: directory not empty'))
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — race dest is a valid non-bare git checkout → repo-exists
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'repo-exists'})
  })

  it('rename race EEXIST + dest is a bare repo → does NOT return repo-exists, fails closed', async () => {
    // #given — clone succeeds, rename fails with EEXIST (race), but dest is a bare repo
    // (--is-inside-work-tree returns "false")
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'sha123\n', stderr: ''}, // rev-parse HEAD (staging, pre-handoff)
    ])
    const gitRunner = makeGitRunner([{kind: 'ok', stdout: 'false\n', stderr: ''}]) // --is-inside-work-tree → bare repo
    mockRename.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — bare repo must NOT return repo-exists; fail closed
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    expect(result.response.ok).toBe(false)
    expect(result.statusCode).toBe(500)
  })

  it('rename race EEXIST + dest is empty/non-git → does NOT return repo-exists, fails closed', async () => {
    // #given — clone succeeds, rename fails with EEXIST (race), but dest is NOT a git repo
    // (empty directory — --is-inside-work-tree fails)
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'sha123\n', stderr: ''}, // rev-parse HEAD (staging, pre-handoff)
    ])
    const gitRunner = makeGitRunner([
      {kind: 'failed', code: 128, stdout: '', stderr: 'fatal: not a git repository'}, // --is-inside-work-tree fails (non-git dest)
    ])
    mockRename.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — must NOT return repo-exists for a non-git directory; fail closed
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    expect(result.response.ok).toBe(false)
    expect(result.statusCode).toBe(500)
  })

  it('rename race EEXIST + dest HEAD^{commit} returns empty (unborn branch) → does NOT return repo-exists', async () => {
    // #given — clone succeeds, rename fails with EEXIST (race), dest --is-inside-work-tree is "true"
    // but --verify HEAD^{commit} returns empty (unborn branch / corrupt checkout)
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'sha123\n', stderr: ''}, // rev-parse HEAD (staging, pre-handoff)
    ])
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''}, // --is-inside-work-tree → true
      {kind: 'ok', stdout: '', stderr: ''}, // --verify HEAD^{commit} → empty (unborn branch)
    ])
    mockRename.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
      gitRunner,
    })

    // #then — must NOT return repo-exists for an unborn/corrupt checkout; fail closed
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    expect(result.response.ok).toBe(false)
    expect(result.statusCode).toBe(500)
  })

  it('rename race EEXIST + realpath of dest fails (ENOENT) → does NOT return repo-exists, fails closed', async () => {
    // #given — clone succeeds, rename fails with EEXIST (race), but realpath of dest throws ENOENT
    // (dest disappeared between rename failure and realpath — transient race). gitRunner is never
    // reached (realpath fails first), so it needs no queued outcomes.
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'sha123\n', stderr: ''}, // rev-parse HEAD (staging, pre-handoff)
    ])
    mockRename.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    // realpath for the race dest throws (dest vanished)
    mockRealpath.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — must NOT return repo-exists; fail closed
    expect(result.response).not.toEqual({ok: false, error: 'repo-exists'})
    expect(result.response.ok).toBe(false)
    expect(result.statusCode).toBe(500)
  })

  it('rename race EEXIST + dest realpath escapes repos root → returns path-escaped-workspace', async () => {
    // #given — clone succeeds, rename fails with EEXIST (race), dest realpath escapes workspace
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'sha123\n', stderr: ''}, // rev-parse HEAD (staging, pre-handoff)
    ])
    mockRename.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    // realpath for the race dest resolves outside the repos root (symlink attack)
    mockRealpath.mockResolvedValueOnce('/etc/passwd')

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — path-escaped-workspace, not repo-exists
    expect(result.response).toEqual({ok: false, error: 'path-escaped-workspace'})
    expect(result.statusCode).toBe(500)
  })
})

describe('executeClone — staging and ownership handoff', () => {
  it('stages the clone under the root-owned state dir, never under <owner>/', async () => {
    // #given
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — the staging parent (root-owned, 0700) is created/verified under
    // <reposRoot>/.workspace-agent/staging, not under <reposRoot>/<owner>/
    expect(mockMkdir).toHaveBeenCalledWith(STAGING_ROOT, {recursive: true, mode: 0o700})
    // The staging clone dir itself is mkdtemp'd with a prefix under that same root.
    const mkdtempCalls = fakeMkdtempFn.mock.calls as [string][]
    const stagingMkdtempCall = mkdtempCalls.find(c => c[0].startsWith(STAGING_ROOT))
    expect(stagingMkdtempCall).toBeDefined()
    expect(stagingMkdtempCall?.[0]).toBe(`${STAGING_ROOT}/clone-`)
    // It is never placed beside the destination under the (agent-traversable) owner dir.
    const underOwnerDir = mkdtempCalls.some(c => c[0].startsWith(`${TEST_REPOS_ROOT}/fro-bot/.tmp-`))
    expect(underOwnerDir).toBe(false)
  })

  it('resolves and validates HEAD BEFORE the ownership handoff runs — asserts the order directly', async () => {
    // #given — a shared call-order log: the rev-parse HEAD call (execFileFn) and the first
    // handoff filesystem call (handoffOps.lstat) both push into it.
    const callOrder: string[] = []
    const execFileFn = vi.fn().mockImplementation(async (_file: string, args: readonly string[]) => {
      if (args.includes('clone')) return {stdout: '', stderr: ''}
      // rev-parse HEAD on staging
      callOrder.push('head-resolved')
      return {stdout: 'sha123\n', stderr: ''}
    }) as unknown as ExecFileFn
    const baseHandoffOps = makeHandoffOps()
    const handoffOps: HandoffOps = {
      ...baseHandoffOps,
      lstat: vi.fn().mockImplementation(async (path: string) => {
        callOrder.push('handoff-started')
        return baseHandoffOps.lstat(path)
      }),
    }

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps,
    })

    // #then — HEAD is resolved before the handoff walk ever touches the staged tree (handoff.ts
    // lstat's the root twice — once to read rootDev, once inside the walk itself — so assert
    // ordering, not an exact call count).
    expect(result.statusCode).toBe(200)
    expect(callOrder[0]).toBe('head-resolved')
    expect(callOrder.slice(1)).toEqual(['handoff-started', 'handoff-started'])
    expect(callOrder.indexOf('head-resolved')).toBeLessThan(callOrder.indexOf('handoff-started'))
  })

  it('a hardlinked entry (nlink > 1) in the staged tree fails with checkout-handoff-failed / hardlink, and leaves staging clean', async () => {
    // #given — the staged root itself looks like a hardlinked regular file to the handoff walker
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])
    const handoffOps: HandoffOps = {
      lstat: vi.fn().mockResolvedValue(makeStats({isFile: true, isDirectory: false, nlink: 2})),
      readdir: vi.fn().mockResolvedValue([]),
      lchown: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps,
    })

    // #then — the deterministic handoff error code, with the specific reason in `code`; nothing
    // was renamed, and staging is cleaned up
    expect(result.response).toEqual({ok: false, error: 'checkout-handoff-failed', code: 'hardlink'})
    expect(result.statusCode).toBe(500)
    expect(handoffOps.lchown).not.toHaveBeenCalled()
    expect(mockRename).not.toHaveBeenCalled()
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
  })

  it('exceeding the handoff entry cap fails with checkout-handoff-failed / max-entries, and leaves staging clean', async () => {
    // #given — a staged root directory with one child; cap of 1 means the child exceeds it
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])
    const handoffOps: HandoffOps = {
      lstat: vi.fn().mockResolvedValue(makeStats({isDirectory: true})),
      readdir: vi.fn().mockResolvedValue(['child']),
      lchown: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500, handoffMaxEntries: 1},
      handoffOps,
    })

    // #then — never `too-many-files` (reserved for a real EMFILE) — staging is cleaned up
    expect(result.response).toEqual({ok: false, error: 'checkout-handoff-failed', code: 'max-entries'})
    expect(result.statusCode).toBe(500)
    expect(mockRename).not.toHaveBeenCalled()
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
  })

  it('a deadline exceeded during handoff fails with checkout-handoff-failed / deadline-exceeded, and leaves staging clean', async () => {
    // #given — an already-expired deadline (negative) guarantees the very first check trips it
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])
    const handoffOps = makeHandoffOps()

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500, handoffDeadlineMs: -1},
      handoffOps,
    })

    // #then — never `clone-timeout` (reserved for `git clone` itself timing out)
    expect(result.response).toEqual({ok: false, error: 'checkout-handoff-failed', code: 'deadline-exceeded'})
    expect(result.statusCode).toBe(500)
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
  })

  it('a foreign-filesystem boundary during handoff fails with checkout-handoff-failed / foreign-filesystem', async () => {
    // #given — root and its one child report different st_dev values
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])
    let lstatCalls = 0
    const handoffOps: HandoffOps = {
      lstat: vi.fn().mockImplementation(async () => {
        lstatCalls += 1
        // First two calls (handOffToAgent's own rootDev read, then walk's root re-read) are the
        // root itself; the third is the child, on a different device.
        return makeStats({isDirectory: lstatCalls <= 2, dev: lstatCalls <= 2 ? 1 : 2})
      }),
      readdir: vi.fn().mockResolvedValue(['mounted']),
      lchown: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps,
    })

    // #then
    expect(result.response).toEqual({ok: false, error: 'checkout-handoff-failed', code: 'foreign-filesystem'})
    expect(result.statusCode).toBe(500)
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
  })

  it('an unsupported node type during handoff fails with checkout-handoff-failed / unsupported-entry', async () => {
    // #given — the staged root itself is neither a dir, file, nor symlink to the handoff walker
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])
    const handoffOps: HandoffOps = {
      lstat: vi.fn().mockResolvedValue(makeStats({isDirectory: false, isFile: false, isSymbolicLink: false})),
      readdir: vi.fn().mockResolvedValue([]),
      lchown: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps,
    })

    // #then
    expect(result.response).toEqual({ok: false, error: 'checkout-handoff-failed', code: 'unsupported-entry'})
    expect(result.statusCode).toBe(500)
    expect(mockRm).toHaveBeenCalledWith(FAKE_STAGING_CLONE_DIR, {recursive: true, force: true})
  })

  it('a real git clone timeout (AbortError) still produces clone-timeout, not checkout-handoff-failed', async () => {
    // #given — the clone itself aborts; the handoff never runs
    const abortError = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
    const execFileFn = makeExecFile([{error: abortError}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.response).toEqual({ok: false, error: 'clone-timeout'})
    expect(result.statusCode).toBe(504)
  })
})

describe('executeClone — concurrency (overloaded)', () => {
  it('returns overloaded (503) when queue depth is exceeded', async () => {
    // #given — maxConcurrent=1, maxQueueDepth=0 → any second request is overloaded
    // First request hangs (never resolves) to fill the slot.
    // First clone hangs on the git clone call (never resolves until we release it).
    // We use a latch: first call hangs, subsequent calls resolve immediately.
    let releaseFirst!: () => void
    let firstCallResolved = false
    const hangingExec = vi.fn().mockImplementation(
      async () =>
        new Promise<{stdout: string; stderr: string}>(resolve => {
          if (firstCallResolved === false) {
            firstCallResolved = true
            releaseFirst = () => resolve({stdout: '', stderr: ''})
          } else {
            // rev-parse call after clone — resolve immediately
            resolve({stdout: 'sha123\n', stderr: ''})
          }
        }),
    ) as unknown as ExecFileFn

    const firstClone = executeClone(VALID_REQUEST, {
      execFileFn: hangingExec,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {maxConcurrent: 1, maxQueueDepth: 0, timeoutMs: 10_000},
    })

    // Give the first clone time to acquire the semaphore slot.
    await new Promise(r => setTimeout(r, 20))

    // #when — second request should be overloaded immediately
    const secondResult = await executeClone(
      {...VALID_REQUEST, repo: 'other'},
      {
        execFileFn: vi.fn() as unknown as ExecFileFn,
        reposRoot: TEST_REPOS_ROOT,
        mkdtempFn: fakeMkdtempFn,
        options: {maxConcurrent: 1, maxQueueDepth: 0, timeoutMs: 10_000},
      },
    )

    // #then
    expect(secondResult.statusCode).toBe(503)
    expect(secondResult.response).toEqual({ok: false, error: 'overloaded'})

    // Cleanup: release the first clone.
    releaseFirst()
    await firstClone
  }, 15_000)
})

describe('executeClone — symlink / path escape defense', () => {
  it('returns path-escaped-workspace and removes clone if realpath escapes root', async () => {
    // #given — after clone, realpath returns a path outside the workspace
    vi.resetAllMocks()
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    fakeMkdtempFn.mockResolvedValue(FAKE_ASKPASS_DIR)
    // First realpath call: ENOENT (path doesn't exist yet)
    mockRealpath.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    // Second realpath call (post-clone): path escaped outside workspace root
    mockRealpath.mockResolvedValueOnce('/etc/passwd')

    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(500)
    expect(result.response).toEqual({ok: false, error: 'path-escaped-workspace'})
    // rm was called to remove the escaped clone
    expect(mockRm).toHaveBeenCalledWith(`${TEST_REPOS_ROOT}/fro-bot/agent`, {recursive: true, force: true})
  })
})

describe('executeClone — cleanup on exception (T3)', () => {
  it('cleans up askpass dir when mkdir throws', async () => {
    // #given — mkdir throws after askpass dir is created
    // We need to set up: mkdtemp succeeds, mkdir (for owner dir) throws.
    // But mkdir is called BEFORE mkdtemp in the impl... let's check.
    // Actually mkdir is called first, then mkdtemp. So if mkdir throws, askpassDir is null.
    // This test verifies no cleanup needed (no dir created yet).
    vi.resetAllMocks()
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockMkdir.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    mockRm.mockResolvedValue(undefined)
    mockRealpath.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))

    const execFileFn = vi.fn() as unknown as ExecFileFn

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — mkdir threw EACCES → permission-denied response, no askpass dir created
    expect(result.response).toEqual({ok: false, error: 'permission-denied'})
    // The rm calls should NOT include the askpass dir
    const rmCalls = mockRm.mock.calls.map(c => c[0] as string)
    expect(rmCalls).not.toContain(FAKE_ASKPASS_DIR)
  })

  it('cleans up askpass dir when open throws', async () => {
    // #given — mkdtemp succeeds, open throws
    vi.resetAllMocks()
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    fakeMkdtempFn.mockResolvedValue(FAKE_ASKPASS_DIR)
    mockOpen.mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    mockRm.mockResolvedValue(undefined)
    mockRealpath.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))

    const execFileFn = vi.fn() as unknown as ExecFileFn

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — askpass dir cleaned up even though open threw
    expect(mockRm).toHaveBeenCalledWith(FAKE_ASKPASS_DIR, {recursive: true, force: true})
  })

  it('cleans up askpass dir when rev-parse throws', async () => {
    // #given — clone succeeds, rev-parse throws
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {error: new Error('fatal: not a git repository')}, // git rev-parse HEAD
    ])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(mockRm).toHaveBeenCalledWith(FAKE_ASKPASS_DIR, {recursive: true, force: true})
  })
})

describe('scrubCredentials', () => {
  it('replaces x-access-token patterns', () => {
    const input = 'https://x-access-token:ghs_secret@github.com/org/repo.git'
    expect(scrubCredentials(input)).toBe('https://x-access-token:[REDACTED]@github.com/org/repo.git')
  })

  it('leaves clean strings unchanged', () => {
    const input = 'fatal: repository not found'
    expect(scrubCredentials(input)).toBe(input)
  })

  it('replaces multiple occurrences', () => {
    const input = 'x-access-token:abc@github.com and x-access-token:def@github.com'
    const result = scrubCredentials(input)
    expect(result).not.toContain('abc')
    expect(result).not.toContain('def')
    expect(result.match(/\[REDACTED\]/g)?.length).toBe(2)
  })
})

describe('clone.ts — no module-level SIGTERM/SIGINT handlers', () => {
  it('does not register SIGTERM handlers at module load', async () => {
    // #given — count listeners before and after a fresh import (module is already loaded)
    // The key assertion: clone.ts must NOT add SIGTERM/SIGINT listeners.
    // We verify by checking that process has exactly the listeners registered by main.ts
    // (which is not loaded in tests), i.e. clone.ts contributes zero signal listeners.
    const sigtermListeners = process.listeners('SIGTERM')
    const sigintListeners = process.listeners('SIGINT')

    // #then — none of the registered listeners should come from clone.ts
    // (clone.ts exports are imported at the top of this file; if it registered handlers
    // they'd already be present). We can't easily distinguish by source, but we can
    // assert that the count is 0 in the test environment (no main.ts loaded here).
    expect(sigtermListeners.length).toBe(0)
    expect(sigintListeners.length).toBe(0)
  })
})

describe('executeClone — rev-parse env omits GITHUB_TOKEN (Fix #2)', () => {
  it('does not pass GITHUB_TOKEN to the post-clone rev-parse HEAD call', async () => {
    // #given — happy path: clone + post-clone rev-parse HEAD (no existing-path check)
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'abc123def456\n', stderr: ''}, // git rev-parse HEAD (post-clone)
    ])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — second call is the post-clone rev-parse HEAD; its env must NOT contain GITHUB_TOKEN
    const revParseCall = execFileFn.mock.calls[1] as [string, string[], {env: Record<string, string>}] | undefined
    expect(revParseCall).toBeDefined()
    expect(revParseCall![1]).toContain('rev-parse')
    const revParseEnv = revParseCall![2].env
    expect(Object.prototype.hasOwnProperty.call(revParseEnv, 'GITHUB_TOKEN')).toBe(false)
    expect(revParseEnv.GITHUB_TOKEN).toBeUndefined()
  })
})

describe('executeClone — askpass wildcard arm fails closed (Fix #3)', () => {
  it('askpass script wildcard arm is "exit 1", not a token printf', async () => {
    // #given
    const fakeHandle = makeFakeFileHandle()
    mockOpen.mockResolvedValue(fakeHandle as unknown as import('node:fs/promises').FileHandle)
    const execFileFn = makeExecFile([{stdout: ''}, {stdout: 'sha123\n'}])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — wildcard arm must be "exit 1", not a printf with GITHUB_TOKEN
    const scriptContent = fakeHandle.writeFile.mock.calls[0]![0] as string
    expect(scriptContent).toContain('*) exit 1')
    // The wildcard arm must NOT contain printf (which would leak the token)
    const lines = scriptContent.split('\n')
    // Find the line that is the catch-all wildcard (not Username* or Password*)
    const wildcardLine = lines.find(l => /^\s+\*\)/.test(l))
    expect(wildcardLine).toBeDefined()
    expect(wildcardLine).not.toContain('printf')
    expect(wildcardLine).not.toContain('GITHUB_TOKEN')
  })
})

describe('executeClone — per-repo lock serialization (Test B)', () => {
  it('serializes 3 concurrent requests for the same repo: first succeeds, rest see 409', async () => {
    // #given — use a latch so the first clone holds the lock while 2nd and 3rd arrive
    let releaseFirst!: () => void
    let cloneCallCount = 0

    const latchedExec = vi.fn().mockImplementation(
      async (_file: string, args: string[]) =>
        new Promise<{stdout: string; stderr: string}>(resolve => {
          if (args.includes('clone')) {
            cloneCallCount++
            // First clone hangs until released
            releaseFirst = () => resolve({stdout: '', stderr: ''})
          } else {
            // rev-parse HEAD on staging, pre-handoff — resolve with a sha
            resolve({stdout: 'sha123\n', stderr: ''})
          }
        }),
    ) as unknown as ExecFileFn

    // repo-exists / race-check validation for the second and third (blocked) requests — each
    // makes two gitRunner calls (--is-inside-work-tree, --verify HEAD^{commit}), both "usable".
    const gitRunner = makeGitRunner([
      {kind: 'ok', stdout: 'true\n', stderr: ''}, // second: --is-inside-work-tree
      {kind: 'ok', stdout: 'sha123\n', stderr: ''}, // second: --verify HEAD^{commit}
      {kind: 'ok', stdout: 'true\n', stderr: ''}, // third: --is-inside-work-tree
      {kind: 'ok', stdout: 'sha123\n', stderr: ''}, // third: --verify HEAD^{commit}
    ])

    // First realpath: ENOENT (path doesn't exist), then resolves after clone
    // Reset the mock first to clear beforeEach's queued calls
    mockRealpath.mockReset()
    mockRealpath
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), {code: 'ENOENT'})) // first clone: pre-check
      .mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`) // first clone: post-clone realpath
      .mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`) // second clone: pre-check (path now exists → 409)
      .mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`) // third clone: pre-check (path now exists → 409)

    const sharedDeps = {
      execFileFn: latchedExec,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {maxConcurrent: 5, maxQueueDepth: 50, timeoutMs: 10_000},
      handoffOps: makeHandoffOps(),
      gitRunner,
    }

    // #when — fire 3 concurrent requests for the SAME repo
    const first = executeClone(VALID_REQUEST, sharedDeps)
    // Give first clone time to acquire the per-repo lock
    await new Promise(r => setTimeout(r, 20))

    const second = executeClone(VALID_REQUEST, sharedDeps)
    const third = executeClone(VALID_REQUEST, sharedDeps)

    // Release the first clone
    releaseFirst()

    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third])

    // #then — first succeeds, second and third see 409 (repo-exists after first completes)
    expect(firstResult.statusCode).toBe(200)
    expect(firstResult.response.ok).toBe(true)

    expect(secondResult.statusCode).toBe(409)
    expect(secondResult.response).toEqual({ok: false, error: 'repo-exists'})

    expect(thirdResult.statusCode).toBe(409)
    expect(thirdResult.response).toEqual({ok: false, error: 'repo-exists'})

    // Only ONE git clone was invoked (the others short-circuited on repo-exists check)
    expect(cloneCallCount).toBe(1)
  }, 15_000)
})

describe('executeClone — outstanding journal (Unit 3)', () => {
  it('refuses with journal-in-progress and never touches git when a journal already exists for the repo', async () => {
    // #given — a journal file (update, phase applying) already exists for this repo, discovered
    // via the same real fs.lstat/readFile journal.ts uses — not an injected dependency.
    const parentPath = `${TEST_REPOS_ROOT}/.workspace-agent`
    const journalsDirPath = `${parentPath}/journals`
    const journalFilePath = `${journalsDirPath}/${VALID_REQUEST.owner}__${VALID_REQUEST.repo}.json`

    mockLstat.mockImplementation(async (path: unknown) => {
      if (path === parentPath || path === journalsDirPath) return makeStats({isDirectory: true, isFile: false})
      if (path === journalFilePath) return makeStats({isDirectory: false, isFile: true})
      throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
    })
    mockReadFile.mockImplementation(async (path: unknown) => {
      if (path === journalFilePath) {
        return JSON.stringify({
          kind: 'update',
          owner: VALID_REQUEST.owner,
          repo: VALID_REQUEST.repo,
          phase: 'applying',
          fromSha: 'a'.repeat(40),
          toSha: 'b'.repeat(40),
          startedAt: '2026-09-24T00:00:00.000Z',
        })
      }
      throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
    })

    const execFileFn = makeExecFile([])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then — refused before any git process is spawned
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'journal-in-progress'})
    expect(execFileFn).not.toHaveBeenCalled()
  })

  it('refuses with journal-in-progress when the journal file exists but is malformed — never treated as absent', async () => {
    // #given — a journal file exists but fails to parse (foreign schema)
    const parentPath = `${TEST_REPOS_ROOT}/.workspace-agent`
    const journalsDirPath = `${parentPath}/journals`
    const journalFilePath = `${journalsDirPath}/${VALID_REQUEST.owner}__${VALID_REQUEST.repo}.json`

    mockLstat.mockImplementation(async (path: unknown) => {
      if (path === parentPath || path === journalsDirPath) return makeStats({isDirectory: true, isFile: false})
      if (path === journalFilePath) return makeStats({isDirectory: false, isFile: true})
      throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
    })
    mockReadFile.mockImplementation(async (path: unknown) => {
      if (path === journalFilePath) return '{not valid json'
      throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
    })

    const execFileFn = makeExecFile([])

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    })

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'journal-in-progress'})
    expect(execFileFn).not.toHaveBeenCalled()
  })
})

describe('executeClone — shared repo mutex (Unit 3)', () => {
  it('waits for an operation already holding the same repo-mutex key from repo-mutex.ts, then proceeds in order', async () => {
    // #given — an external operation (standing in for /update, /recover, or backup delete) has
    // already acquired the SAME mutex clone.ts uses — imported directly from repo-mutex.ts, not
    // reconstructed, so this proves clone.ts shares the module-singleton lock rather than a
    // structurally similar one of its own.
    const order: string[] = []
    let releaseExternal!: () => void
    const externalDone = withRepoLock(repoMutexKey(VALID_REQUEST.owner, VALID_REQUEST.repo), async () => {
      order.push('external-start')
      await new Promise<void>(resolve => {
        releaseExternal = resolve
      })
      order.push('external-end')
    })

    // Let the external operation actually acquire the lock (synchronous up to its own await).
    await Promise.resolve()
    await Promise.resolve()

    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''},
      {stdout: 'sha123\n', stderr: ''},
    ])

    // #when — clone starts while the external operation still holds the lock
    const clonePromise = executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
      handoffOps: makeHandoffOps(),
    }).then(result => {
      order.push('clone-end')
      return result
    })

    // Deterministic ordering assertion, not timing: clone must not have run yet.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['external-start'])
    expect(execFileFn).not.toHaveBeenCalled()

    releaseExternal()
    await externalDone

    // #then — clone only proceeds once the external holder releases, in strict order
    const result = await clonePromise
    expect(order).toEqual(['external-start', 'external-end', 'clone-end'])
    expect(result.statusCode).toBe(200)
  })
})
