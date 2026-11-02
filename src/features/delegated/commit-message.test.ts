import type {ExecAdapter} from '../../services/setup/types.js'

import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
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
  getExecOutput: ReturnType<typeof vi.fn>
} {
  const getExecOutput = vi.fn(async (_command: string, args?: string[]) => {
    const subcommand = (args ?? []).find(arg => arg === 'rev-list' || arg === 'log')
    const source = subcommand === 'rev-list' ? options.revList : options.log
    return {stdout: source?.stdout ?? '', stderr: '', exitCode: source?.exitCode ?? 0}
  })
  return {adapter: {exec: vi.fn().mockResolvedValue(0), getExecOutput}, getExecOutput}
}

describe('resolveBrokeredPushCommitMessage', () => {
  it('uses the sanitized tip commit message when the agent made commits', async () => {
    // #given
    const {adapter, getExecOutput} = createFakeExecAdapter({
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
    const calls = getExecOutput.mock.calls as unknown as [string, string[]][]
    expect(calls.every(([command]) => command === 'git')).toBe(true)
    expect(calls[0]?.[1]).toContain(`${TRUSTED_HEAD_SHA}..HEAD`)
    expect(calls[1]?.[1]).toEqual(expect.arrayContaining(['log', '-1', '--format=%B', TIP_SHA]))
  })

  it('uses the fallback when the agent made no local commits', async () => {
    // #given an empty trustedHeadSha..HEAD range
    const {adapter, getExecOutput} = createFakeExecAdapter({revList: {stdout: ''}})

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
    expect(getExecOutput).toHaveBeenCalledTimes(1)
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
    const {adapter, getExecOutput} = createFakeExecAdapter({revList: {stdout: TIP_SHA}})

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
    expect(getExecOutput).not.toHaveBeenCalled()
  })

  it('uses the fallback when rev-list returns something that is not a commit id', async () => {
    // #given
    const {adapter, getExecOutput} = createFakeExecAdapter({revList: {stdout: '--exec=evil\n'}})

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
    expect(getExecOutput).toHaveBeenCalledTimes(1)
  })

  it('uses the fallback when the adapter throws', async () => {
    // #given
    const adapter: ExecAdapter = {
      exec: vi.fn().mockResolvedValue(0),
      getExecOutput: vi.fn().mockRejectedValue(new Error('spawn failed')),
    }

    // #when / #then
    await expect(
      resolveBrokeredPushCommitMessage(adapter, TRUSTED_HEAD_SHA, '/workspace', createMockLogger(), FALLBACK),
    ).resolves.toBe(FALLBACK)
  })
})
