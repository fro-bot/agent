import type {ExecAdapter, ExecOptions} from '../../services/setup/types.js'

import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  COMMIT_MESSAGE_LOOKUP_TIMEOUT_MS,
  MAX_COMMIT_BODY_BYTES,
  MAX_COMMIT_SUBJECT_LENGTH,
  resolveBrokeredPushCommitMessage,
  sanitizeCommitMessage,
} from './commit-message.js'

const FALLBACK = 'chore: apply brokered changes'
const TRUSTED_HEAD_SHA = 'a'.repeat(40)
const TIP_SHA = 'b'.repeat(40)

describe('sanitizeCommitMessage', () => {
  it('keeps a plain subject and body', () => {
    // #given / #when
    const result = sanitizeCommitMessage('fix: handle empty input\n\nThe parser crashed on an empty string.\n')

    // #then
    expect(result).toBe('fix: handle empty input\n\nThe parser crashed on an empty string.')
  })

  it.each(['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]', '[SKIP CI]', '[Skip Actions]'])(
    'strips the %s workflow-skip token from the subject',
    token => {
      // #given
      const raw = `fix: ship it ${token}`

      // #when / #then
      expect(sanitizeCommitMessage(raw)).toBe('fix: ship it')
    },
  )

  it('strips workflow-skip tokens from the body', () => {
    // #given
    const raw = 'fix: ship it\n\nThis is safe [skip ci] to merge.\n[no ci]'

    // #when
    const result = sanitizeCommitMessage(raw)

    // #then
    expect(result).not.toMatch(/skip ci|no ci/i)
    expect(result?.startsWith('fix: ship it')).toBe(true)
  })

  it('strips a workflow-skip token that is reassembled by removing a nested one', () => {
    // #given
    const raw = 'fix: x [ski[skip ci]p ci]'

    // #when / #then
    expect(sanitizeCommitMessage(raw)).toBe('fix: x')
  })

  it('strips the GitHub ***NO_CI*** marker', () => {
    expect(sanitizeCommitMessage('fix: x ***NO_CI***')).toBe('fix: x')
  })

  it('strips a trailing trailer block', () => {
    // #given
    const raw =
      'feat: add thing\n\nBody text.\n\nCo-authored-by: Mallory <mallory@example.com>\nSigned-off-by: Eve <eve@example.com>'

    // #when / #then
    expect(sanitizeCommitMessage(raw)).toBe('feat: add thing\n\nBody text.')
  })

  it('strips a body that contains only trailers', () => {
    // #given
    const raw = 'feat: add thing\n\nCo-authored-by: Mallory <mallory@example.com>\nReviewed-by: Eve <eve@example.com>\n'

    // #when / #then
    expect(sanitizeCommitMessage(raw)).toBe('feat: add thing')
  })

  it('strips stacked trailer blocks and trailer continuation lines', () => {
    // #given
    const raw = 'feat: add thing\n\nBody.\n\nChange-Id: I123\n  continued\n\nBug: 42'

    // #when / #then
    expect(sanitizeCommitMessage(raw)).toBe('feat: add thing\n\nBody.')
  })

  it('strips attribution trailers that are not in a separate trailing paragraph', () => {
    // #given a spoofed co-author line glued to prose
    const raw = 'feat: add thing\n\nSome prose.\nCo-authored-by: Mallory <mallory@example.com>'

    // #when
    const result = sanitizeCommitMessage(raw)

    // #then
    expect(result).toBe('feat: add thing\n\nSome prose.')
  })

  it('strips trailer keys case-insensitively', () => {
    expect(sanitizeCommitMessage('feat: x\n\nbody\n\nCO-AUTHORED-BY: A <a@b.c>')).toBe('feat: x\n\nbody')
  })

  it('keeps ordinary Key: value prose in a non-trailing paragraph', () => {
    // #given
    const raw = 'fix: x\n\nNote: this stays.\n\nMore prose without a trailer.'

    // #when / #then
    expect(sanitizeCommitMessage(raw)).toBe(raw)
  })

  it('does not treat a conventional-commit subject as a trailer', () => {
    expect(sanitizeCommitMessage('fix: the subject looks like Key: value')).toBe(
      'fix: the subject looks like Key: value',
    )
  })

  it('returns null when the subject is itself an attribution trailer', () => {
    expect(sanitizeCommitMessage('Co-authored-by: Mallory <mallory@example.com>\n\nbody')).toBeNull()
  })

  it('strips control characters except newlines', () => {
    // #given NUL, ESC, DEL, a C1 control, and a tab around real newlines
    const raw = 'fix:\u0000 a\u001B[31mb\u007Fc\u0085d\te\n\nline one\u0007\nline two'

    // #when
    const result = sanitizeCommitMessage(raw)

    // #then
    expect(result).toBe('fix: a[31mbcde\n\nline one\nline two')
  })

  it('normalizes CRLF line endings', () => {
    expect(sanitizeCommitMessage('fix: x\r\n\r\nbody\r\nmore')).toBe('fix: x\n\nbody\nmore')
    expect(sanitizeCommitMessage('fix: x\r\rbody')).toBe('fix: x\n\nbody')
  })

  it('trims surrounding whitespace and collapses runs of blank lines', () => {
    expect(sanitizeCommitMessage('\n\n  fix: x  \n\n\n\n\nbody   \n\n')).toBe('fix: x\n\nbody')
  })

  it('caps the subject at 72 characters', () => {
    // #given
    const raw = `feat: ${'x'.repeat(200)}\n\nbody`

    // #when
    const result = sanitizeCommitMessage(raw)
    const subject = result?.split('\n')[0] ?? ''

    // #then
    expect(subject).toHaveLength(MAX_COMMIT_SUBJECT_LENGTH)
    expect(result?.endsWith('\n\nbody')).toBe(true)
  })

  it('does not split a surrogate pair when capping the subject', () => {
    // #given a subject whose 72nd code point is an astral character
    const raw = `${'a'.repeat(71)}😀😀`

    // #when
    const subject = sanitizeCommitMessage(raw) ?? ''

    // #then
    expect([...subject]).toHaveLength(MAX_COMMIT_SUBJECT_LENGTH)
    expect(subject.endsWith('😀')).toBe(true)
    expect(subject).not.toContain('\uFFFD')
  })

  it('caps the body at 4 KB', () => {
    // #given
    const raw = `fix: x\n\n${'y'.repeat(10_000)}`

    // #when
    const result = sanitizeCommitMessage(raw) ?? ''
    const body = result.slice('fix: x\n\n'.length)

    // #then
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(MAX_COMMIT_BODY_BYTES)
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(MAX_COMMIT_BODY_BYTES - 4)
  })

  it('does not leave a broken multi-byte character at the body cap', () => {
    // #given a body of 3-byte characters whose boundary falls mid-character
    const raw = `fix: x\n\n${'€'.repeat(2000)}`

    // #when
    const result = sanitizeCommitMessage(raw) ?? ''
    const body = result.slice('fix: x\n\n'.length)

    // #then
    expect(body).not.toContain('\uFFFD')
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(MAX_COMMIT_BODY_BYTES)
  })

  it.each(['', '   \n\n  ', '[skip ci]', '\u0000\u0001', '[skip ci]\n\nbody that must not become the subject'])(
    'returns null when the subject is empty after sanitizing (%j)',
    raw => {
      expect(sanitizeCommitMessage(raw)).toBeNull()
    },
  )
})

interface FakeGitOptions {
  readonly revList?: {readonly stdout: string; readonly exitCode?: number}
  readonly log?: {readonly stdout: string; readonly exitCode?: number}
}

function createFakeExecAdapter(options: FakeGitOptions = {}): {
  adapter: ExecAdapter
  execWithTimeout: ReturnType<typeof vi.fn>
} {
  const execWithTimeout = vi.fn(
    async (_command: string, args: string[] | undefined, _timeoutMs: number, execOptions?: ExecOptions) => {
      const subcommand = (args ?? []).find(arg => arg === 'rev-list' || arg === 'log')
      const source = subcommand === 'rev-list' ? options.revList : options.log
      execOptions?.listeners?.stdout?.(Buffer.from(source?.stdout ?? ''))
      return source?.exitCode ?? 0
    },
  )
  return {
    adapter: {exec: vi.fn().mockResolvedValue(0), execWithTimeout, getExecOutput: vi.fn()},
    execWithTimeout,
  }
}

describe('resolveBrokeredPushCommitMessage', () => {
  it('uses the sanitized tip commit message when the agent made commits', async () => {
    // #given
    const {adapter, execWithTimeout} = createFakeExecAdapter({
      revList: {stdout: `${TIP_SHA}\n`},
      log: {stdout: 'fix: repair the parser [skip ci]\n\nDetails.\n\nCo-authored-by: X <x@y.z>\n'},
    })

    // #when
    const message = await resolveBrokeredPushCommitMessage(
      adapter,
      TRUSTED_HEAD_SHA,
      '/workspace',
      createMockLogger(),
      FALLBACK,
    )

    // #then the message comes from the tip commit via argv-form git, with no shell string
    expect(message).toBe('fix: repair the parser\n\nDetails.')
    const calls = execWithTimeout.mock.calls as unknown as [string, string[]][]
    expect(calls.every(([command]) => command === 'git')).toBe(true)
    expect(calls[0]?.[1]).toContain(`${TRUSTED_HEAD_SHA}..HEAD`)
    expect(calls[1]?.[1]).toEqual(expect.arrayContaining(['log', '-1', '--format=%B', TIP_SHA]))
  })

  it('uses the fallback when the agent made no local commits', async () => {
    // #given an empty trustedHeadSha..HEAD range
    const {adapter, execWithTimeout} = createFakeExecAdapter({revList: {stdout: ''}})

    // #when
    const message = await resolveBrokeredPushCommitMessage(
      adapter,
      TRUSTED_HEAD_SHA,
      '/workspace',
      createMockLogger(),
      FALLBACK,
    )

    // #then
    expect(message).toBe(FALLBACK)
    expect(execWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('uses the fallback when the tip commit subject is empty after sanitizing', async () => {
    // #given
    const {adapter} = createFakeExecAdapter({revList: {stdout: TIP_SHA}, log: {stdout: '[skip ci]\n\nbody\n'}})

    // #when / #then
    await expect(
      resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', createMockLogger(), FALLBACK),
    ).resolves.toBe(FALLBACK)
  })

  it('uses the fallback when git fails', async () => {
    // #given
    const {adapter} = createFakeExecAdapter({
      revList: {stdout: TIP_SHA, exitCode: 128},
      log: {stdout: 'fix: must not be used'},
    })

    // #when / #then
    await expect(
      resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', createMockLogger(), FALLBACK),
    ).resolves.toBe(FALLBACK)
  })

  it('uses the fallback when git log fails', async () => {
    // #given
    const {adapter} = createFakeExecAdapter({revList: {stdout: TIP_SHA}, log: {stdout: 'fix: x', exitCode: 1}})

    // #when / #then
    await expect(
      resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', createMockLogger(), FALLBACK),
    ).resolves.toBe(FALLBACK)
  })

  it('uses the fallback and never shells out when the trusted SHA is malformed', async () => {
    // #given an attacker-shaped anchor
    const {adapter, execWithTimeout} = createFakeExecAdapter({revList: {stdout: TIP_SHA}})

    // #when
    const message = await resolveBrokeredPushCommitMessage(
      adapter,
      '--output=/tmp/x',
      '/workspace',
      createMockLogger(),
      FALLBACK,
    )

    // #then
    expect(message).toBe(FALLBACK)
    expect(execWithTimeout).not.toHaveBeenCalled()
  })

  it('uses the fallback when rev-list returns something that is not a commit id', async () => {
    // #given
    const {adapter, execWithTimeout} = createFakeExecAdapter({revList: {stdout: '--exec=evil\n'}})

    // #when
    const message = await resolveBrokeredPushCommitMessage(
      adapter,
      TRUSTED_HEAD_SHA,
      '/workspace',
      createMockLogger(),
      FALLBACK,
    )

    // #then
    expect(message).toBe(FALLBACK)
    expect(execWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('uses the fallback when the adapter throws', async () => {
    // #given
    const adapter: ExecAdapter = {
      exec: vi.fn().mockResolvedValue(0),
      execWithTimeout: vi.fn().mockRejectedValue(new Error('spawn failed')),
      getExecOutput: vi.fn(),
    }

    // #when / #then
    await expect(
      resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', createMockLogger(), FALLBACK),
    ).resolves.toBe(FALLBACK)
  })
})

const HIDDEN_PREFIXES = [
  ['NBSP', '\u00A0'],
  ['EM SPACE', '\u2003'],
  ['IDEOGRAPHIC SPACE', '\u3000'],
  ['BOM / ZWNBSP', '\uFEFF'],
  ['ZERO WIDTH SPACE', '\u200B'],
  ['THIN SPACE', '\u2009'],
  ['WORD JOINER', '\u2060'],
] as const
const FORBIDDEN_TRAILERS = ['Co-authored-by: Mallory <mallory@example.com>', 'skip-checks: true'] as const

function parseTrailers(message: string): string {
  return execFileSync('git', ['interpret-trailers', '--parse'], {input: message, encoding: 'utf-8'})
}

describe('sanitizeCommitMessage Unicode whitespace bypass', () => {
  describe.each(FORBIDDEN_TRAILERS)('%s', trailer => {
    it.each(HIDDEN_PREFIXES)('removes it when prefixed with %s (own paragraph)', (_name, hidden) => {
      // #given a trailer hidden behind a character ASCII-only matchers treat as text
      const raw = `fix: x\n\n${hidden}${trailer}`

      // #when
      const result = sanitizeCommitMessage(raw) ?? ''

      // #then it is gone, and git agrees there is no trailer left
      expect(result).toBe('fix: x')
      expect(result).not.toMatch(/co-authored-by|skip-checks/i)
      expect(parseTrailers(result)).toBe('')
    })

    it.each(HIDDEN_PREFIXES)('removes it when prefixed with %s (glued to prose)', (_name, hidden) => {
      // #given
      const raw = `fix: x\n\nSome prose.\n${hidden}${trailer}\n`

      // #when
      const result = sanitizeCommitMessage(raw) ?? ''

      // #then
      expect(result).toBe('fix: x\n\nSome prose.')
      expect(parseTrailers(result)).toBe('')
    })

    it.each(HIDDEN_PREFIXES)('removes it when %s splits the key', (_name, hidden) => {
      // #given
      const [key = '', ...rest] = trailer.split(':')
      const raw = `fix: x\n\nBody.\n\n${key.slice(0, 3)}${hidden}${key.slice(3)}:${rest.join(':')}`

      // #when
      const result = sanitizeCommitMessage(raw) ?? ''

      // #then
      expect(result).not.toMatch(/co-?authored|skip-?checks/i)
      expect(parseTrailers(result)).toBe('')
    })
  })

  it('removes a hidden-prefix skip token', () => {
    expect(sanitizeCommitMessage('fix: x\n\n\u200B[skip ci]\u00A0')).toBe('fix: x')
    expect(sanitizeCommitMessage('fix: x [ski\u200Bp ci]')).toBe('fix: x')
  })

  it('rejects a subject that is a trailer behind hidden whitespace', () => {
    expect(sanitizeCommitMessage('\u00A0Co-authored-by: Mallory <m@example.com>')).toBeNull()
  })

  it('revalidates after truncation: a body cut that leaves a trailing trailer-shaped paragraph is stripped', () => {
    // #given the final paragraph is not a trailer until the 4 KB cap cuts it down to `Bug:`
    const raw = `fix: x\n\n${'x'.repeat(MAX_COMMIT_BODY_BYTES - 6)}\n\nBug:1 more words`

    // #when
    const result = sanitizeCommitMessage(raw) ?? ''

    // #then
    expect(result.endsWith('Bug:')).toBe(false)
    expect(parseTrailers(result)).toBe('')
  })

  it.each([
    'fix: x\n\n\u00A0Co-authored-by: Mallory <m@example.com>',
    'fix: x\n\n\u3000skip-checks: true',
    `fix: x\n\n${'x'.repeat(MAX_COMMIT_BODY_BYTES - 6)}\n\nBug:1 more words`,
    '  fix:\u00A0\u00A0x [skip\u2003ci]\n\n\n\n  body \u200B \n\nChange-Id: I1\n  more',
    'fix: x\n\nSigned-off-by: A <a@b.c>\n\u00A0\n\nCc: z',
    `${'a'.repeat(100)}\n\n${'€'.repeat(3000)}`,
  ])('is a fixed point (%#)', raw => {
    // #given / #when
    const once = sanitizeCommitMessage(raw)

    // #then sanitizing the output again returns it unchanged
    expect(once).not.toBeNull()
    expect(sanitizeCommitMessage(once ?? '')).toBe(once)
  })
})

describe('resolveBrokeredPushCommitMessage lookup bounds', () => {
  it('suppresses signature display and the pager, and bounds both git calls', async () => {
    // #given
    const {adapter, execWithTimeout} = createFakeExecAdapter({
      revList: {stdout: TIP_SHA},
      log: {stdout: 'fix: signed\n'},
    })

    // #when
    await resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', createMockLogger(), FALLBACK)

    // #then
    const calls = execWithTimeout.mock.calls as unknown as [string, string[], number][]
    expect(calls).toHaveLength(2)
    for (const [command, args, timeoutMs] of calls) {
      expect(command).toBe('git')
      expect(args.slice(0, 3)).toEqual(['--no-pager', '-c', 'log.showSignature=false'])
      expect(timeoutMs).toBeLessThanOrEqual(5_000)
    }
    expect(calls[1]?.[1]).toContain('--no-show-signature')
  })

  it.each(['rev-list', 'log'])('falls back to the constant and warns when %s times out', async stalled => {
    // #given
    const logger = createMockLogger()
    const execWithTimeout = vi.fn(
      async (_command: string, args?: string[], _timeoutMs?: number, options?: ExecOptions) => {
        if ((args ?? []).includes(stalled)) {
          return 'timed-out' as const
        }
        options?.listeners?.stdout?.(Buffer.from((args ?? []).includes('rev-list') ? TIP_SHA : 'fix: x'))
        return 0
      },
    )
    const adapter: ExecAdapter = {exec: vi.fn().mockResolvedValue(0), execWithTimeout, getExecOutput: vi.fn()}

    // #when
    const message = await resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', logger, FALLBACK)

    // #then
    expect(message).toBe(FALLBACK)
    expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('timed out'), expect.any(Object))
  })

  it('uses the fallback and warns when the adapter has no timeout support (never an unbounded call)', async () => {
    // #given
    const getExecOutput = vi.fn()
    const adapter: ExecAdapter = {exec: vi.fn().mockResolvedValue(0), getExecOutput}
    const logger = createMockLogger()

    // #when
    const message = await resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', logger, FALLBACK)

    // #then
    expect(message).toBe(FALLBACK)
    expect(getExecOutput).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalled()
  })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf-8',
    env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'},
  }).trim()
}

describe('resolveBrokeredPushCommitMessage against real git', () => {
  it('selects the tip of two local commits and sanitizes it, even with signature display configured on', async () => {
    // #given a trusted base plus two agent commits, with a repo-local verifier that would hang if invoked
    const dir = mkdtempSync(path.join(tmpdir(), 'commit-message-'))
    try {
      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'base')
      const base = git(dir, 'rev-parse', 'HEAD')
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: first')
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'fix: the tip [skip ci]\n\nWhy.\n\nCo-authored-by: X <x@y.z>')
      git(dir, 'config', 'log.showSignature', 'true')
      git(dir, 'config', 'gpg.program', 'sleep')

      // #when
      const message = await resolveBrokeredPushCommitMessage(
        createExecAdapter(),
        base,
        dir,
        createMockLogger(),
        FALLBACK,
      )

      // #then
      expect(message).toBe('fix: the tip\n\nWhy.')
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('uses the fallback when the agent made no commits past the trusted head', async () => {
    // #given
    const dir = mkdtempSync(path.join(tmpdir(), 'commit-message-'))
    try {
      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'base')
      const base = git(dir, 'rev-parse', 'HEAD')

      // #when / #then
      await expect(
        resolveBrokeredPushCommitMessage(createExecAdapter(), base, dir, createMockLogger(), FALLBACK),
      ).resolves.toBe(FALLBACK)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('keeps the timeout constant within the 5 s bound', () => {
    expect(COMMIT_MESSAGE_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})
