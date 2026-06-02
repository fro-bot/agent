import type {ExecFileFn} from './clone.js'

import {mkdir, mkdtemp, open, realpath, rename, rm} from 'node:fs/promises'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {executeClone, resetCloneSemaphoreForTesting, scrubCredentials} from './clone.js'

// #given mocked fs operations
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn(),
    open: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    realpath: vi.fn(),
  }
})

const mockMkdir = vi.mocked(mkdir)
const mockMkdtemp = vi.mocked(mkdtemp)
const mockOpen = vi.mocked(open)
const mockRename = vi.mocked(rename)
const mockRm = vi.mocked(rm)
const mockRealpath = vi.mocked(realpath)

const TEST_REPOS_ROOT = '/workspace/repos'
const FAKE_ASKPASS_DIR = '/tmp/workspace-agent-askpass-abc123'
const FAKE_ASKPASS_PATH = `${FAKE_ASKPASS_DIR}/askpass.sh`

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

const VALID_REQUEST = {
  owner: 'fro-bot',
  repo: 'agent',
  token: `ghs_${'a'.repeat(36)}`,
}

/** Shared mkdtempFn that returns the fake dir (bypasses real fs). */
const fakeMkdtempFn = vi.fn().mockResolvedValue(FAKE_ASKPASS_DIR)

beforeEach(() => {
  vi.resetAllMocks()
  resetCloneSemaphoreForTesting()
  // Re-setup default implementations after reset.
  mockMkdir.mockResolvedValue(undefined)
  mockMkdtemp.mockResolvedValue(FAKE_ASKPASS_DIR)
  mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
  mockRename.mockResolvedValue(undefined)
  mockRm.mockResolvedValue(undefined)
  fakeMkdtempFn.mockResolvedValue(FAKE_ASKPASS_DIR)
  // Default: path does not exist (ENOENT on first realpath call)
  mockRealpath.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
  // Default: resolved path after clone
  mockRealpath.mockResolvedValue(`${TEST_REPOS_ROOT}/fro-bot/agent`)
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
    // tmpClonePath is in the owner dir with .tmp- prefix
    expect(cloneArgs[4]).toMatch(/\/workspace\/repos\/fro-bot\/.tmp-agent-/)

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
    })

    // #then — script content uses $GITHUB_TOKEN, not the literal token
    expect(fakeHandle.writeFile).toHaveBeenCalledOnce()
    const scriptContent = fakeHandle.writeFile.mock.calls[0]![0] as string
    expect(scriptContent).toContain('GITHUB_TOKEN')
    expect(scriptContent).toContain('printf')
    expect(scriptContent).not.toContain(VALID_REQUEST.token)
    expect(scriptContent).not.toContain('ghs_')
  })

  it('askpass script uses case/printf for username and password', async () => {
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
    })

    // #then
    const scriptContent = fakeHandle.writeFile.mock.calls[0]![0] as string
    expect(scriptContent).toContain('case "$1"')
    expect(scriptContent).toContain('Username*')
    expect(scriptContent).toContain('x-access-token')
    expect(scriptContent).toContain('Password*')
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
    })

    // #then
    expect(mockOpen).toHaveBeenCalledWith(FAKE_ASKPASS_PATH, 'wx', 0o600)
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
    })

    // #then — rename called from tmpPath to destPath
    expect(mockRename).toHaveBeenCalledOnce()
    const [from, to] = mockRename.mock.calls[0] as [string, string]
    expect(from).toMatch(/\/workspace\/repos\/fro-bot\/.tmp-agent-/)
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
    })

    // #then
    expect(result.statusCode).toBe(200)
    const success = result.response as {ok: true; commit: string}
    expect(success.commit).toBe('a'.repeat(40))
  })
})

describe('executeClone — idempotency (repo-exists)', () => {
  it('returns 409 repo-exists when destination already exists', async () => {
    // #given — realpath succeeds on first call (path exists)
    vi.resetAllMocks()
    resetCloneSemaphoreForTesting()
    mockMkdir.mockResolvedValue(undefined)
    mockOpen.mockResolvedValue(makeFakeFileHandle() as unknown as import('node:fs/promises').FileHandle)
    mockRename.mockResolvedValue(undefined)
    mockRm.mockResolvedValue(undefined)
    fakeMkdtempFn.mockResolvedValue(FAKE_ASKPASS_DIR)
    // First realpath call succeeds → path already exists (no ENOENT)
    mockRealpath.mockResolvedValueOnce(`${TEST_REPOS_ROOT}/fro-bot/agent`)
    const execFileFn = vi.fn()

    // #when
    const result = await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
    })

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'repo-exists'})
    // No git clone invoked
    expect(execFileFn).not.toHaveBeenCalled()
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
    })

    // #then — rm called for tmp clone dir (not destPath)
    const rmCalls = mockRm.mock.calls.map(c => c[0] as string)
    const tmpRm = rmCalls.find(p => p.includes('.tmp-agent-'))
    expect(tmpRm).toBeDefined()
    // destPath must NOT have been rm'd (partial clone never reached it)
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
    })

    // #then
    expect(mockRm).toHaveBeenCalledWith(FAKE_ASKPASS_DIR, {recursive: true, force: true})
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
    })

    // #then — tmp dir cleaned up
    const rmCalls = mockRm.mock.calls.map(c => c[0] as string)
    const tmpRm = rmCalls.find(p => p.includes('.tmp-agent-'))
    expect(tmpRm).toBeDefined()
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
  it('does not pass GITHUB_TOKEN to rev-parse execFile call', async () => {
    // #given
    const execFileFn = makeExecFile([
      {stdout: '', stderr: ''}, // git clone
      {stdout: 'abc123def456\n', stderr: ''}, // git rev-parse HEAD
    ])

    // #when
    await executeClone(VALID_REQUEST, {
      execFileFn,
      reposRoot: TEST_REPOS_ROOT,
      mkdtempFn: fakeMkdtempFn,
      options: {timeoutMs: 500},
    })

    // #then — second call is rev-parse; its env must NOT contain GITHUB_TOKEN
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
            // rev-parse resolves immediately
            resolve({stdout: 'sha123\n', stderr: ''})
          }
        }),
    ) as unknown as ExecFileFn

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
