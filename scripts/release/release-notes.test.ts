import {describe, expect, it} from 'vitest'
import {
  AMBIGUOUS_RUN_SENTINEL,
  buildNarrationPrompt,
  classifyOutcome,
  escapeAnnotation,
  parseDispatchedRuns,
  selectDispatchedRun,
  validateTag,
} from './release-notes.js'

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

  // CHANGE 5 ADD: injection-shaped rejection
  it('rejects a tag with a semicolon (injection attempt)', () => {
    // #given
    const tag = 'v1.2.3; rm -rf /'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a tag with a space (injection attempt)', () => {
    // #given
    const tag = 'v1.2.3 extra'

    // #when
    const result = validateTag(tag)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a tag with a newline (injection attempt)', () => {
    // #given
    const tag = 'v1.2.3\nmalicious'

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

  // CHANGE 5 FLIP: non-zero non-124 watchExit is now warn/exit 0 (not error/exit 1)
  it('returns warn exit 0 for unexpected watchExit (non-zero, non-124)', () => {
    // #given
    const input = {watchExit: 137, conclusion: '', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then — gh run watch --exit-status returns non-zero when the run fails; that's narrative, not release
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('WATCH_EXIT=137')
  })

  // CHANGE 5 FLIP: off-target is now warn/exit 0 (not error/exit 1)
  it('returns warn exit 0 for off-target release edit (ANSI-colored log)', () => {
    // #given — log contains ANSI escape codes around a different tag
    const log = '\u001B[31mgh release edit v9.9.9\u001B[0m\nsome other output'
    const input = {watchExit: 0, conclusion: 'success', log, bodyLen: 800, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then — demoted to best-effort warn; log-forensics is not a sound security boundary
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
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

  // CHANGE 5 ADD: auth failure takes precedence over timeout
  it('auth failure takes precedence over watchExit 124 (timeout)', () => {
    // #given — log has auth keywords AND watchExit is 124 (timeout)
    const log = 'HTTP 401: Bad credentials'
    const input = {watchExit: 124, conclusion: '', log, bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then — auth check fires FIRST (rule 1), not timeout (rule 2)
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('auth failure')
  })

  // CHANGE 5 ADD: auth failure takes precedence over non-zero watchExit
  it('auth failure takes precedence over non-zero non-124 watchExit', () => {
    // #given — log has auth keywords AND watchExit is 137
    const log = 'HTTP 401: Bad credentials'
    const input = {watchExit: 137, conclusion: 'failure', log, bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then — auth check fires FIRST (rule 1), not watchExit (rule 3)
    expect(result.level).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('auth failure')
  })

  // CHANGE 5 FLIP: action_required is now warn/exit 0 (not error/exit 1)
  it('returns warn exit 0 for action_required conclusion', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'action_required', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('action_required')
  })

  // CHANGE 5 FLIP: skipped is now warn/exit 0 (not error/exit 1)
  it('returns warn exit 0 for skipped conclusion', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'skipped', log: '', bodyLen: 0, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('skipped')
  })

  // CHANGE 5 FLIP: below-floor body is now warn/exit 0 (not error/exit 1)
  it('returns warn exit 0 for success with body length below MIN_RELEASE_BODY_LENGTH', () => {
    // #given
    const input = {watchExit: 0, conclusion: 'success', log: '', bodyLen: 50, targetTag: 'v2.23.0'}

    // #when
    const result = classifyOutcome(input)

    // #then — short body is quality signal, not security signal
    expect(result.level).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('body shorter than expected')
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
})

describe('selectDispatchedRun', () => {
  // Epoch for 2023-11-14T22:13:20Z = 1700000000
  const BASE_EPOCH = 1_700_000_000
  const CORR_ID = 'release-notes-abc123'

  it('returns null for an empty list', () => {
    // #given
    const runs: readonly {databaseId: number; createdAt: string; displayTitle: string}[] = []

    // #when
    const result = selectDispatchedRun(runs, BASE_EPOCH, CORR_ID)

    // #then
    expect(result).toBeNull()
  })

  it('returns null when all runs predate the dispatch epoch', () => {
    // #given
    const runs = [
      {databaseId: 1, createdAt: '2023-11-14T22:13:00Z', displayTitle: `Fro Bot · release-notes · ${CORR_ID}`},
      {databaseId: 2, createdAt: '2023-11-14T22:12:00Z', displayTitle: `Fro Bot · release-notes · ${CORR_ID}`},
    ]
    const dispatchEpochSeconds = BASE_EPOCH + 20 // after both

    // #when
    const result = selectDispatchedRun(runs, dispatchEpochSeconds, CORR_ID)

    // #then
    expect(result).toBeNull()
  })

  // CHANGE 5: same-second (createdAt epoch == dispatchEpoch) with matching correlation → selected (>= not >)
  it('returns the databaseId when createdAt epoch equals dispatchEpoch (same-second, >= semantics)', () => {
    // #given — createdAt exactly equals dispatchEpochSeconds
    // 2023-11-14T22:13:20Z = 1700000000
    const runs = [
      {databaseId: 42, createdAt: '2023-11-14T22:13:20Z', displayTitle: `Fro Bot · release-notes · ${CORR_ID}`},
    ]

    // #when
    const result = selectDispatchedRun(runs, BASE_EPOCH, CORR_ID)

    // #then — same-second is now included (>= not >)
    expect(result).toBe(42)
  })

  it('returns null when run is at epoch but correlationId does not match', () => {
    // #given
    const runs = [
      {databaseId: 42, createdAt: '2023-11-14T22:13:20Z', displayTitle: 'Fro Bot · release-notes · other-id'},
    ]

    // #when
    const result = selectDispatchedRun(runs, BASE_EPOCH, CORR_ID)

    // #then — no correlation match
    expect(result).toBeNull()
  })

  it('returns the single matching databaseId when exactly one run matches correlation and epoch', () => {
    // #given
    const runs = [
      {databaseId: 10, createdAt: '2023-11-14T22:13:00Z', displayTitle: `Fro Bot · release-notes · ${CORR_ID}`}, // before epoch
      {databaseId: 20, createdAt: '2023-11-14T22:13:25Z', displayTitle: `Fro Bot · release-notes · ${CORR_ID}`}, // after epoch
    ]

    // #when
    const result = selectDispatchedRun(runs, BASE_EPOCH, CORR_ID)

    // #then
    expect(result).toBe(20)
  })

  // CHANGE 5 ADD: >1 matches → AMBIGUOUS_RUN_SENTINEL
  it('returns AMBIGUOUS_RUN_SENTINEL when multiple runs match correlation and epoch', () => {
    // #given — two runs after epoch, both with matching correlationId
    const runs = [
      {databaseId: 100, createdAt: '2023-11-14T22:13:25Z', displayTitle: `Fro Bot · release-notes · ${CORR_ID}`},
      {databaseId: 200, createdAt: '2023-11-14T22:13:30Z', displayTitle: `Fro Bot · release-notes · ${CORR_ID}`},
    ]

    // #when
    const result = selectDispatchedRun(runs, BASE_EPOCH, CORR_ID)

    // #then — ambiguous, not a specific run
    expect(result).toBe(AMBIGUOUS_RUN_SENTINEL)
  })

  it('returns null when post-epoch runs exist but none match the correlationId', () => {
    // #given — runs are after epoch but have a different correlationId
    const runs = [
      {databaseId: 100, createdAt: '2023-11-14T22:13:25Z', displayTitle: 'Fro Bot · release-notes · different-id'},
      {databaseId: 200, createdAt: '2023-11-14T22:13:30Z', displayTitle: 'Fro Bot'},
    ]

    // #when
    const result = selectDispatchedRun(runs, BASE_EPOCH, CORR_ID)

    // #then — no correlation match → null (not ambiguous, not a run id)
    expect(result).toBeNull()
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

describe('parseDispatchedRuns', () => {
  it('returns a valid array from well-formed JSON', () => {
    // #given
    const raw = JSON.stringify([
      {databaseId: 1, createdAt: '2024-01-01T00:00:00Z', displayTitle: 'Fro Bot · release-notes · abc'},
      {databaseId: 2, createdAt: '2024-01-02T00:00:00Z', displayTitle: 'Fro Bot · release-notes · def'},
    ])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      databaseId: 1,
      createdAt: '2024-01-01T00:00:00Z',
      displayTitle: 'Fro Bot · release-notes · abc',
    })
    expect(result[1]).toEqual({
      databaseId: 2,
      createdAt: '2024-01-02T00:00:00Z',
      displayTitle: 'Fro Bot · release-notes · def',
    })
  })

  it('returns empty array for an empty string', () => {
    // #given
    const raw = ''

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('returns empty array for non-JSON garbage', () => {
    // #given
    const raw = 'error: could not connect to github.com'

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('returns empty array when JSON is a non-array value (object)', () => {
    // #given
    const raw = JSON.stringify({databaseId: 1, createdAt: '2024-01-01T00:00:00Z', displayTitle: 'title'})

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('returns empty array when JSON is a non-array value (null)', () => {
    // #given
    const raw = 'null'

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('filters out rows with missing databaseId', () => {
    // #given
    const raw = JSON.stringify([{createdAt: '2024-01-01T00:00:00Z', displayTitle: 'title'}])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('filters out rows with wrong-typed databaseId (string instead of number)', () => {
    // #given
    const raw = JSON.stringify([{databaseId: '123', createdAt: '2024-01-01T00:00:00Z', displayTitle: 'title'}])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('filters out rows with missing createdAt', () => {
    // #given
    const raw = JSON.stringify([{databaseId: 1, displayTitle: 'title'}])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('filters out rows with empty createdAt string', () => {
    // #given
    const raw = JSON.stringify([{databaseId: 1, createdAt: '', displayTitle: 'title'}])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('filters out rows with missing displayTitle', () => {
    // #given
    const raw = JSON.stringify([{databaseId: 1, createdAt: '2024-01-01T00:00:00Z'}])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })

  it('filters out null entries in the array', () => {
    // #given
    const raw = JSON.stringify([null, {databaseId: 1, createdAt: '2024-01-01T00:00:00Z', displayTitle: 'title'}])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toHaveLength(1)
    expect(result[0]?.databaseId).toBe(1)
  })

  it('keeps valid rows and drops invalid rows in a mixed array', () => {
    // #given
    const raw = JSON.stringify([
      {databaseId: 10, createdAt: '2024-01-01T00:00:00Z', displayTitle: 'good'},
      {databaseId: 'bad', createdAt: '2024-01-01T00:00:00Z', displayTitle: 'bad-type'},
      null,
      {databaseId: 20, createdAt: '2024-01-02T00:00:00Z', displayTitle: 'also-good'},
      {createdAt: '2024-01-03T00:00:00Z', displayTitle: 'missing-id'},
    ])

    // #when
    const result = parseDispatchedRuns(raw)

    // #then — only the two fully-valid rows survive
    expect(result).toHaveLength(2)
    expect(result[0]?.databaseId).toBe(10)
    expect(result[1]?.databaseId).toBe(20)
  })

  it('filters out rows with non-finite databaseId (null, as JSON cannot represent Infinity)', () => {
    // #given — JSON cannot represent Infinity/NaN; they serialize as null.
    // Test the isFinite guard via a raw string with null databaseId.
    const raw = '[{"databaseId":null,"createdAt":"2024-01-01T00:00:00Z","displayTitle":"title"}]'

    // #when
    const result = parseDispatchedRuns(raw)

    // #then
    expect(result).toEqual([])
  })
})

describe('escapeAnnotation', () => {
  it('leaves normal text unchanged', () => {
    // #given
    const message = 'narrative applied successfully'

    // #when
    const result = escapeAnnotation(message)

    // #then
    expect(result).toBe('narrative applied successfully')
  })

  it('escapes % as %25', () => {
    // #given
    const message = '50% complete'

    // #when
    const result = escapeAnnotation(message)

    // #then
    expect(result).toBe('50%25 complete')
  })

  it(String.raw`escapes CR (\r) as %0D`, () => {
    // #given
    const message = 'line one\rline two'

    // #when
    const result = escapeAnnotation(message)

    // #then
    expect(result).toBe('line one%0Dline two')
  })

  it(String.raw`escapes LF (\n) as %0A`, () => {
    // #given
    const message = 'line one\nline two'

    // #when
    const result = escapeAnnotation(message)

    // #then
    expect(result).toBe('line one%0Aline two')
  })

  it('escapes % before CR/LF to avoid double-encoding', () => {
    // #given — if % were encoded after \n, the %0A would become %250A
    const message = '%\n'

    // #when
    const result = escapeAnnotation(message)

    // #then — % → %25 first, then \n → %0A; result is %25%0A not %250A
    expect(result).toBe('%25%0A')
  })

  it('escapes all three special characters in a single string', () => {
    // #given
    const message = 'err: 100% failed\r\ncheck logs'

    // #when
    const result = escapeAnnotation(message)

    // #then
    expect(result).toBe('err: 100%25 failed%0D%0Acheck logs')
  })

  it('handles an empty string', () => {
    // #given
    const message = ''

    // #when
    const result = escapeAnnotation(message)

    // #then
    expect(result).toBe('')
  })

  it('handles multiple consecutive special characters', () => {
    // #given
    const message = '%%\n\n\r\r'

    // #when
    const result = escapeAnnotation(message)

    // #then
    expect(result).toBe('%25%25%0A%0A%0D%0D')
  })
})
