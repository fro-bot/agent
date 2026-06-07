import {describe, expect, it} from 'vitest'
import {buildNarrationPrompt, classifyOutcome, selectDispatchedRun, validateTag} from './release-notes.js'

describe('validateTag', () => {
  it('accepts a standard semver tag', () => {
    // #given
    const tag = 'v2.23.0'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(true)
  })

  it('accepts a pre-release semver tag', () => {
    // #given
    const tag = 'v2.23.0-rc.1'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(true)
  })

  it('accepts a pre-release tag with alphanumeric identifiers', () => {
    // #given
    const tag = 'v1.0.0-alpha.1'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(true)
  })

  it('rejects a tag without v prefix', () => {
    // #given
    const tag = '1.2.3'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(false)
    // result.ok is false here — access .error via type assertion to avoid conditional expect
    expect((result as {ok: false; error: string}).error).toBeTruthy()
  })

  it('rejects a non-semver string', () => {
    // #given
    const tag = 'not-a-tag'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects an incomplete semver (missing patch)', () => {
    // #given
    const tag = 'v1.2'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects an empty string', () => {
    // #given
    const tag = ''

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(false)
  })
})

describe('classifyOutcome', () => {
  it('returns ok exit 0 for success with sufficient body length', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'success', log: '', bodyLen: 800, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('ok')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('narrative applied')
  })

  it('returns ok exit 0 for neutral conclusion (idempotent short-circuit)', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'neutral', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('ok')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('no-action-taken')
  })

  it('returns warn exit 0 for watchExit 124 (timeout)', () => {
    // #given
    const input = {watchExit: 124, conclusion: '', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('timed out')
  })

  it('returns error exit 1 for unexpected watchExit (non-zero, non-124)', () => {
    // #given
    const input = {watchExit: 137, conclusion: '', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('WATCH_EXIT=137')
  })

  it('returns error exit 1 for off-target release edit (ANSI-colored log)', () => {
    // #given — log contains ANSI escape codes around a different tag
    const log = '\u001B[31mgh release edit v9.9.9\u001B[0m\nsome other output'
    const input = {watchExit: 0, conclusion: 'success', log, bodyLen: 800, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('off-target')
  })

  it('does NOT flag off-target when the log contains the correct target tag', () => {
    // #given — log contains the same tag as targetTag
    const log = 'gh release edit v2.23.0 succeeded'
    const input = {watchExit: 0, conclusion: 'success', log, bodyLen: 800, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then — should fall through to conclusion-based branch, not off-target
    expect(result.level).toBe('ok')
    expect(result.exitCode).toBe(0)
  })

  it('returns error exit 1 for HTTP 401 auth failure', () => {
    // #given
    const log = 'HTTP 401: Bad credentials'
    const input = {watchExit: 0, conclusion: 'failure', log, bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('auth failure')
  })

  it('returns error exit 1 for HTTP 403 + permission denied auth failure', () => {
    // #given
    const log = 'HTTP 403\npermission denied'
    const input = {watchExit: 0, conclusion: 'failure', log, bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('auth failure')
  })

  it('returns error exit 1 for Resource not accessible auth failure', () => {
    // #given
    const log = 'Resource not accessible by integration'
    const input = {watchExit: 0, conclusion: 'failure', log, bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('auth failure')
  })

  it('returns error exit 1 for action_required conclusion', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'action_required', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('manual intervention')
  })

  it('returns error exit 1 for skipped conclusion', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'skipped', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('policy/branch protection')
  })

  it('returns error exit 1 for success with body length below 200', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'success', log: '', bodyLen: 50, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('body integrity check failed')
    expect(result.message).toContain('BODY_LEN=50')
  })

  it('returns warn exit 0 for cancelled conclusion', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'cancelled', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
  })

  it('returns warn exit 0 for generic failure (no auth/off-target keywords)', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'failure', log: 'some generic error', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('narrative-failure')
  })

  it('returns warn exit 0 for unknown conclusion', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'some_new_value', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('unknown conclusion')
    expect(result.message).toContain('some_new_value')
  })

  it('watchExit checks take precedence over log-based checks', () => {
    // #given — log has auth keywords but watchExit is 137 (unexpected exit wins)
    const log = 'HTTP 401: Bad credentials'
    const input = {watchExit: 137, conclusion: 'failure', log, bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then — watchExit=137 fires first (rule 2), not auth failure (rule 4)
    expect(result.message).toContain('WATCH_EXIT=137')
  })
})

describe('selectDispatchedRun', () => {
  it('returns null for an empty list', () => {
    // #given
    const runs: readonly {databaseId: number; createdAt: string}[] = []
    const dispatchEpochSeconds = 1_700_000_000

    // #when
    const result = selectDispatchedRun(runs, dispatchEpochSeconds)

    // #then
    expect(result).toBeNull()
  })

  it('returns null when all runs predate the dispatch epoch', () => {
    // #given
    const runs = [
      {databaseId: 1, createdAt: '2023-11-14T22:13:00Z'}, // epoch 1700000000 - 20s
      {databaseId: 2, createdAt: '2023-11-14T22:12:00Z'}, // even earlier
    ]
    const dispatchEpochSeconds = 1_700_000_020 // after both

    // #when
    const result = selectDispatchedRun(runs, dispatchEpochSeconds)

    // #then
    expect(result).toBeNull()
  })

  it('returns null when a run is exactly equal to the dispatch epoch (strictly greater required)', () => {
    // #given — createdAt exactly equals dispatchEpochSeconds
    // 2023-11-14T22:13:20Z = 1700000000
    const runs = [{databaseId: 42, createdAt: '2023-11-14T22:13:20Z'}]
    const dispatchEpochSeconds = 1_700_000_000

    // #when
    const result = selectDispatchedRun(runs, dispatchEpochSeconds)

    // #then
    expect(result).toBeNull()
  })

  it('returns the newest databaseId when two runs are both after the epoch', () => {
    // #given — two runs after epoch; run 2 is newer
    const runs = [
      {databaseId: 100, createdAt: '2023-11-14T22:13:25Z'}, // +5s after epoch
      {databaseId: 200, createdAt: '2023-11-14T22:13:30Z'}, // +10s after epoch (newest)
    ]
    const dispatchEpochSeconds = 1_700_000_000

    // #when
    const result = selectDispatchedRun(runs, dispatchEpochSeconds)

    // #then
    expect(result).toBe(200)
  })

  it('returns the single post-epoch run when only one qualifies', () => {
    // #given
    const runs = [
      {databaseId: 10, createdAt: '2023-11-14T22:13:00Z'}, // before epoch
      {databaseId: 20, createdAt: '2023-11-14T22:13:25Z'}, // after epoch
    ]
    const dispatchEpochSeconds = 1_700_000_000

    // #when
    const result = selectDispatchedRun(runs, dispatchEpochSeconds)

    // #then
    expect(result).toBe(20)
  })
})

describe('buildNarrationPrompt', () => {
  const opts = {tag: 'v2.23.0', repo: 'fro-bot/agent', correlationId: 'test-corr-id-123'}

  it('starts with correlation= on the first line', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    const firstLine = prompt.split('\n')[0]
    expect(firstLine).toBe('correlation=test-corr-id-123')
  })

  it('includes the target tag verbatim', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toContain('v2.23.0')
  })

  it('includes the repo verbatim', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toContain('fro-bot/agent')
  })

  it('includes the idempotency marker HTML comment', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toContain('<!-- fro-bot-narration-v1 -->')
  })

  it("includes the ## What's new heading", () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toContain("## What's new")
  })

  it('includes gh release edit command', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toContain('gh release edit')
  })

  it('uses --notes-file (never --notes)', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toContain('--notes-file')
    // Ensure bare --notes is not used (--notes-file is fine, --notes <string> is not)
    // We check that the only occurrence of --notes is as --notes-file
    const notesOccurrences = prompt.match(/--notes(?!-file)/g)
    expect(notesOccurrences).toBeNull()
  })

  it('includes forbidden-actions scope constraints (no PR/issue comments)', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then — must mention not commenting on PRs/issues (under "you must not:" list)
    expect(prompt).toMatch(/comment on any (?:pr|issue)|must not[\s\S]*comment/i)
  })

  it('includes forbidden-actions constraint against editing other releases', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toMatch(/do not.*edit.*other|not.*other.*release|only.*mutating.*operation|only.*gh release edit/i)
  })

  it('does NOT contain GitHub Actions workflow-expression syntax', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then — no ${{ ... }} expressions
    expect(prompt).not.toContain('${{')
  })

  it('includes the collapsed Full changelog details block instruction', () => {
    // #given / #when
    const prompt = buildNarrationPrompt(opts)

    // #then
    expect(prompt).toContain('<details>')
    expect(prompt).toContain('Full changelog')
  })
})
