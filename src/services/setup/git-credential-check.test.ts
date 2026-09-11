import type {ExecAdapter, ExecOptions, Logger} from './types.js'

import process from 'node:process'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {assertNoPersistedGitCredentials} from './git-credential-check.js'

const CONFIG_ARGS = ['config', '--includes', '--name-only', '--get-regexp', String.raw`^http\.(.*\.)?extraheader$`]
const REV_PARSE_ARGS = ['rev-parse', '--absolute-git-dir']
const REMOTE_ARGS = ['remote', 'get-url', 'origin']

interface StageResult {
  readonly exitCode: number
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * Routes by the git subcommand name (`argv[0]`) only — it does not itself verify the rest of the
 * flags. Each test additionally asserts the exact argv via `toEqual(CONFIG_ARGS)` / etc., which is
 * what actually catches a wrong flag set (e.g. reintroducing `--local`).
 */
function createRoutedExecAdapter(stages: {
  config?: StageResult | Error
  revParse?: StageResult | Error
  remote?: StageResult | Error
}): {execAdapter: ExecAdapter; calls: {args: string[]; options: ExecOptions | undefined}[]} {
  const calls: {args: string[]; options: ExecOptions | undefined}[] = []

  function resolveStage(stage: StageResult | Error | undefined, fallback: StageResult): StageResult {
    if (stage instanceof Error) throw stage
    return stage ?? fallback
  }

  const getExecOutput = vi.fn().mockImplementation(async (_cmd: string, args?: string[], options?: ExecOptions) => {
    const argv = args ?? []
    calls.push({args: argv, options})
    if (argv[0] === 'config') {
      const result = resolveStage(stages.config, {exitCode: 1, stdout: '', stderr: ''})
      return {exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
    }
    if (argv[0] === 'rev-parse') {
      const result = resolveStage(stages.revParse, {exitCode: 0, stdout: '/fake/workspace/.git', stderr: ''})
      return {exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
    }
    if (argv[0] === 'remote') {
      const result = resolveStage(stages.remote, {exitCode: 0, stdout: 'https://github.com/owner/repo\n', stderr: ''})
      return {exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
    }
    throw new Error(`unexpected git invocation: ${argv.join(' ')}`)
  })

  return {
    execAdapter: {exec: vi.fn().mockResolvedValue(0), getExecOutput},
    calls,
  }
}

/** Projects only the harmless test key + LC_ALL, never the full process.env, into assertion output. */
function selectedEnvFields(env: Record<string, string> | undefined): {MARKER?: string; LC_ALL?: string} {
  return {MARKER: env?.MARKER, LC_ALL: env?.LC_ALL}
}

describe('assertNoPersistedGitCredentials', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  it('errs naming persist-credentials when an extraheader header is effective, using the unscoped --includes query', async () => {
    // #given a checkout where an effective (not necessarily local) extraheader header exists
    const {execAdapter, calls} = createRoutedExecAdapter({
      config: {exitCode: 0, stdout: 'http.https://github.com/.extraheader\n'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then the exact argv is used — no `--local`, no old regex without the optional subsection group
    expect(calls[0]?.args).toEqual(CONFIG_ARGS)
    expect(result).toEqual({success: false, error: expect.stringContaining('persist-credentials: false') as string})
    // never name the matched key/header, never leak stdout content
    expect(result.success === false && result.error).not.toContain('extraheader')
    expect(result.success === false && result.error).not.toContain('github.com')
  })

  it('resolves ok for a clean repo with no persisted credentials across all three stages', async () => {
    // #given
    const {execAdapter, calls} = createRoutedExecAdapter({})

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then all three stages ran in order with the expected argv
    expect(result.success).toBe(true)
    expect(calls.map(c => c.args)).toEqual([CONFIG_ARGS, REV_PARSE_ARGS, REMOTE_ARGS])
  })

  it('resolves ok when git is not on PATH (plain toolkit error, no code)', async () => {
    // #given the exact error shape @actions/io throws when `which` cannot resolve the binary
    const {execAdapter} = createRoutedExecAdapter({
      config: new Error(
        'Unable to locate executable file: git. Please verify either the file path exists or the file can be ' +
          'found within a directory specified by the PATH environment variable. Also check the file mode to ' +
          'verify the file is executable.',
      ),
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
    expect(mockLogger.warning).toHaveBeenCalled()
  })

  it('resolves ok when git spawn fails with an ENOENT-coded error', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      config: Object.assign(new Error('spawn git ENOENT'), {code: 'ENOENT'}),
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
  })

  it('denies when the first config check throws an error that is not the trusted missing-git shape', async () => {
    // #given the toolkit's cwd-does-not-exist error — a real failure, not proof git is absent
    const {execAdapter} = createRoutedExecAdapter({
      config: new Error('The cwd: /workspace does not exist!'),
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then fail closed, and never coerce/log the raw error message into the returned error
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('/workspace')
    expect(result.success === false && result.error).not.toContain('does not exist')
  })

  it('denies when the first config check throws a non-Error string, without treating it as the trusted missing-git shape', async () => {
    // #given a thrown value that is not an `Error` instance at all
    const execAdapter: ExecAdapter = {
      exec: vi.fn().mockResolvedValue(0),
      getExecOutput: vi.fn().mockRejectedValue('boom'),
    }

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then non-Error throws are denied, never reflected
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('boom')
  })

  it('denies when the first config check throws a plain object mimicking a missing-git Error (message/code but not instanceof Error)', async () => {
    // #given an object shaped like the trusted missing-git error but not an actual `Error`
    const impostor = {message: 'Unable to locate executable file: git.', code: 'ENOENT'}
    const execAdapter: ExecAdapter = {
      exec: vi.fn().mockResolvedValue(0),
      getExecOutput: vi.fn().mockRejectedValue(impostor),
    }

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then only a real `Error` instance qualifies for the fail-open exemption — an impostor denies
    expect(result.success).toBe(false)
  })

  it('denies when the config check returns an unexpected exit code (verification failed, not proof of absence)', async () => {
    // #given a malformed config produces exit 128, neither the match(0) nor no-match(1) case
    const {execAdapter} = createRoutedExecAdapter({
      config: {exitCode: 128, stdout: '', stderr: 'fatal: bad config line 8 in file .git/config'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then never fail open on an unexpected result, and never misdiagnose as a found credential
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('.git/config')
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
    expect(result.success === false && result.error).not.toContain('found')
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.any(String), {exitCode: 128})
  })

  it('denies when exit code 0 unexpectedly has empty stdout', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      config: {exitCode: 0, stdout: ''},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then a numeric, non-sensitive exit code is attached; the wording never claims a credential was found
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
    expect(result.success === false && result.error).not.toContain('found')
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.any(String), {exitCode: 0})
  })

  it('allows with a warning for the canonical non-repository workspace exception', async () => {
    // #given the exact stderr `rev-parse` writes for a genuinely non-repository workspace
    const {execAdapter, calls} = createRoutedExecAdapter({
      revParse: {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      },
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
    expect(mockLogger.warning).toHaveBeenCalled()
    expect(calls.map(c => c.args)).toEqual([CONFIG_ARGS, REV_PARSE_ARGS])
  })

  it('denies for an invalid GIT_DIR failure that also exits 128 but is not the canonical non-repo message', async () => {
    // #given a real but different 128 failure — must not be conflated with "no repository"
    const {execAdapter} = createRoutedExecAdapter({
      revParse: {exitCode: 128, stdout: '', stderr: 'fatal: not a git repository: /bad/gitdir'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then fail closed — this is a real repo-context problem, not proven absence, and the
    // remediation must not claim a credential was found
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('/bad/gitdir')
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
    expect(result.success === false && result.error).not.toContain('found')
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.any(String), {exitCode: 128})
  })

  it('denies for an unknown 128 exit or dubious-ownership style failure at the repo-context stage', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      revParse: {exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository at /workspace'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.any(String), {exitCode: 128})
  })

  it('allows with a warning for the canonical non-repository fatal even when a benign warning line precedes it (LF)', async () => {
    // #given a leading advice/warning line before the real fatal — the whole blob does not start
    // with the canonical prefix, but the fatal line itself does
    const {execAdapter} = createRoutedExecAdapter({
      revParse: {
        exitCode: 128,
        stdout: '',
        stderr: 'hint: something unrelated\nfatal: not a git repository (or any of the parent directories): .git\n',
      },
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
    expect(mockLogger.warning).toHaveBeenCalled()
  })

  it('allows with a warning for the canonical non-repository fatal even when a benign warning line precedes it (CRLF)', async () => {
    // #given the same shape with CRLF line endings
    const {execAdapter} = createRoutedExecAdapter({
      revParse: {
        exitCode: 128,
        stdout: '',
        stderr: 'hint: something unrelated\r\nfatal: not a git repository (or any of the parent directories): .git\r\n',
      },
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
  })

  it('denies when an inline impostor of the canonical phrase (not at line start) precedes a genuinely different invalid-GIT_DIR fatal', async () => {
    // #given a non-fatal line that happens to contain the canonical phrase mid-line, followed by a
    // real, different fatal — must not be treated as "broad substring anywhere in stderr"
    const {execAdapter} = createRoutedExecAdapter({
      revParse: {
        exitCode: 128,
        stdout: '',
        stderr:
          'note: unrelated text mentioning fatal: not a git repository (or any of the parent directories) inline\n' +
          'fatal: not a git repository: /bad/gitdir\n',
      },
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then fail closed — the real fatal line is not the canonical message
    expect(result.success).toBe(false)
  })

  it('denies when an inline impostor of the canonical phrase precedes a dubious-ownership fatal', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      revParse: {
        exitCode: 128,
        stdout: '',
        stderr:
          'note: unrelated text mentioning fatal: not a git repository (or any of the parent directories) inline\n' +
          'fatal: detected dubious ownership in repository at /workspace\n',
      },
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(false)
  })

  it('denies when two real fatal lines are present, even though one of them is the canonical message (ambiguous, fails closed)', async () => {
    // #given a contradictory pair of genuine `fatal:`-prefixed lines
    const {execAdapter} = createRoutedExecAdapter({
      revParse: {
        exitCode: 128,
        stdout: '',
        stderr:
          'fatal: not a git repository (or any of the parent directories): .git\n' + 'fatal: something else entirely\n',
      },
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then more than one fatal line is treated as ambiguous, not as proof of absence
    expect(result.success).toBe(false)
  })

  it('denies when the repo-context check throws', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      revParse: new Error('boom'),
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('boom')
  })

  it('passes the inherited environment plus a forced LC_ALL=C to the repo-context check, not a stripped one', async () => {
    // #given a harmless marker already present in the ambient environment
    process.env.MARKER = 'harmless-value'
    try {
      const {execAdapter, calls} = createRoutedExecAdapter({})

      // #when
      await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

      // #then only project selected fields — never snapshot/dump the full env in the assertion
      const revParseCall = calls.find(c => c.args[0] === 'rev-parse')
      expect(selectedEnvFields(revParseCall?.options?.env)).toEqual({MARKER: 'harmless-value', LC_ALL: 'C'})
    } finally {
      delete process.env.MARKER
    }
  })

  it('does not pass an env override to the config or remote checks (inherited by omission)', async () => {
    // #given
    const {execAdapter, calls} = createRoutedExecAdapter({})

    // #when
    await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    const configCall = calls.find(c => c.args[0] === 'config')
    const remoteCall = calls.find(c => c.args[0] === 'remote')
    expect(configCall?.options?.env).toBeUndefined()
    expect(remoteCall?.options?.env).toBeUndefined()
  })

  it('allows for a valid repository with no origin remote (exit 2)', async () => {
    // #given the real Git exit code `remote get-url` returns for a missing remote
    const {execAdapter} = createRoutedExecAdapter({
      remote: {exitCode: 2, stdout: '', stderr: "error: No such remote 'origin'"},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(true)
  })

  it('denies for an origin check failure that is neither success nor the missing-remote exit code', async () => {
    // #given some other remote failure — never treat "any nonzero" as safe-to-allow
    const {execAdapter} = createRoutedExecAdapter({
      remote: {exitCode: 1, stdout: '', stderr: 'fatal: unable to access origin'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.any(String), {exitCode: 1})
  })

  it('denies for an unexpected empty-success result from the origin check', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      remote: {exitCode: 0, stdout: ''},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.any(String), {exitCode: 0})
  })

  it('denies when the origin check throws', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      remote: new Error('kaboom'),
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toContain('kaboom')
  })

  it('errs when the origin remote URL carries an embedded credential', async () => {
    // #given
    const {execAdapter} = createRoutedExecAdapter({
      remote: {exitCode: 0, stdout: 'https://x-access-token:ghs_secrettoken@github.com/owner/repo\n'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('persist-credentials: false') as string,
    })
    expect(result.success === false && result.error).not.toContain('ghs_secrettoken')
  })

  it('resolves ok when the origin remote URL carries a bare username with no colon', async () => {
    // #given a remote URL with userinfo but no password (no colon, no secret)
    const {execAdapter} = createRoutedExecAdapter({
      remote: {exitCode: 0, stdout: 'https://someuser@github.com/owner/repo\n'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then a bare username carries no secret, so this is allowed
    expect(result.success).toBe(true)
  })

  it('errs when the origin remote URL carries a colon with an empty password', async () => {
    // #given a remote URL with a colon but an empty password segment
    const {execAdapter} = createRoutedExecAdapter({
      remote: {exitCode: 0, stdout: 'https://user:@github.com/owner/repo\n'},
    })

    // #when
    const result = await assertNoPersistedGitCredentials(execAdapter, '/workspace', mockLogger)

    // #then the presence of a colon is treated as a credential boundary, deliberately broad
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('persist-credentials: false') as string,
    })
  })
})
