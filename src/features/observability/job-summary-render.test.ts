import type {CacheSaveResult} from '../../shared/cache-save-result.js'
import type {CommentSummaryOptions, RunMetrics} from './types.js'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'

import {writeCacheSaveResultSummary, writeInvocationOutcomeSummary, writeJobSummary} from './job-summary.js'

// Unlike job-summary.test.ts, @actions/core is NOT mocked here: these tests drive the real summary buffer into a
// real GITHUB_STEP_SUMMARY file, so they pin the exact HTML GitHub receives. `core.summary` caches the file path on
// first write, so the path is fixed once for the whole file and the contents are reset between tests.
const summaryDir = mkdtempSync(path.join(tmpdir(), 'job-summary-render-'))
const summaryFile = path.join(summaryDir, 'step-summary.md')
const originalStepSummary = process.env.GITHUB_STEP_SUMMARY
process.env.GITHUB_STEP_SUMMARY = summaryFile

const logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}

function rendered(): string {
  return readFileSync(summaryFile, 'utf8')
}

/** Anything GitHub would show raw: Markdown emphasis/links, or a blank line that hands the rest to the Markdown parser. */
function expectNoRawMarkdown(html: string): void {
  expect(html).not.toContain('**')
  expect(html).not.toMatch(/\]\(https?:/)
  expect(html).not.toContain('\n\n')
}

function createMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    startTime: 0,
    endTime: 60000,
    duration: 60000,
    cacheStatus: 'hit',
    cacheSource: null,
    sessionsUsed: [],
    sessionsCreated: [],
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    tokenUsage: null,
    model: null,
    cost: null,
    errors: [],
    ...overrides,
  }
}

function createOptions(overrides: Partial<CommentSummaryOptions> = {}): CommentSummaryOptions {
  return {
    eventType: 'issue_comment',
    repo: 'owner/repo',
    ref: 'main',
    runId: 123,
    runUrl: 'https://github.com/owner/repo/actions/runs/123',
    metrics: createMetrics(),
    agent: 'sisyphus',
    resolvedOutputMode: null,
    deliveryKind: 'none',
    ...overrides,
  }
}

describe('job summary rendered HTML', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeFileSync(summaryFile, '')
  })

  afterAll(() => {
    rmSync(summaryDir, {recursive: true, force: true})
    if (originalStepSummary == null) {
      delete process.env.GITHUB_STEP_SUMMARY
    } else {
      process.env.GITHUB_STEP_SUMMARY = originalStepSummary
    }
  })

  it('renders the run ID as an anchor inside the metadata table cell', async () => {
    // #given a run with an id and URL
    // #when the job summary is written
    await writeJobSummary(createOptions(), logger)

    // #then the Run ID cell is an anchor, not a Markdown link
    const html = rendered()
    expect(html).toContain(
      '<tr><td>Run ID</td><td><a href="https://github.com/owner/repo/actions/runs/123">123</a></td></tr>',
    )
    expectNoRawMarkdown(html)
  })

  it('does not link a run URL that is not http(s), and escapes metadata cells', async () => {
    // #given a hostile run URL and hostile metadata values
    // #when the job summary is written
    await writeJobSummary(
      createOptions({runUrl: 'javascript:alert(1)', ref: 'refs/heads/<script>alert("x")</script>&', repo: "o'/r"}),
      logger,
    )

    // #then the id is plain text, and nothing is injected
    const html = rendered()
    expect(html).toContain('<tr><td>Run ID</td><td>123</td></tr>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<td>refs/heads/&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;</td>')
    expect(html).toContain('<td>o&#39;/r</td>')
  })

  it('renders session labels as bold on separate lines', async () => {
    // #given used and created sessions
    // #when the job summary is written
    await writeJobSummary(
      createOptions({metrics: createMetrics({sessionsUsed: ['ses_a', 'ses_b'], sessionsCreated: ['ses_c']})}),
      logger,
    )

    // #then each label is <strong> in its own paragraph directly after the heading
    const html = rendered()
    expect(html).toContain(
      '<h3>Sessions</h3>\n<p><strong>Used:</strong> ses_a, ses_b</p>\n<p><strong>Created:</strong> ses_c</p>\n',
    )
    expectNoRawMarkdown(html)
  })

  it('renders model and cost on separate lines', async () => {
    // #given token usage with a model and cost
    // #when the job summary is written
    await writeJobSummary(
      createOptions({
        metrics: createMetrics({
          tokenUsage: {input: 1, output: 2, reasoning: 0, cache: {read: 0, write: 0}},
          model: 'anthropic/claude-sonnet-4',
          cost: 0.0123,
        }),
      }),
      logger,
    )

    // #then each is its own block-level paragraph
    const html = rendered()
    expect(html).toContain(
      '</table>\n<p><strong>Model:</strong> anthropic/claude-sonnet-4</p>\n<p><strong>Cost:</strong> $0.0123</p>\n',
    )
    expectNoRawMarkdown(html)
  })

  it('renders artifacts and errors as HTML lists with escaped values', async () => {
    // #given artifacts and an error whose message contains markup
    // #when the job summary is written
    await writeJobSummary(
      createOptions({
        metrics: createMetrics({
          prsCreated: ['https://github.com/owner/repo/pull/1', 'javascript:alert(1)'],
          commitsCreated: ['abc123def456'],
          commentsPosted: 1,
          errors: [{timestamp: 't', type: 'Rate<Limit>', message: '<b>x</b> & `y`', recoverable: true}],
        }),
      }),
      logger,
    )

    // #then PRs link only when safe, commits use <code>, errors are escaped list items
    const html = rendered()
    expect(html).toContain(
      '<ul><li><a href="https://github.com/owner/repo/pull/1">https://github.com/owner/repo/pull/1</a></li><li>javascript:alert(1)</li></ul>',
    )
    expect(html).toContain('<ul><li>Commit <code>abc123d</code></li></ul>')
    expect(html).toContain('<p><strong>Comments Posted:</strong> 1</p>')
    expect(html).toContain(
      '<ul><li><strong>Rate&lt;Limit&gt;</strong> (🔄 Recovered): &lt;b&gt;x&lt;/b&gt; &amp; `y`</li></ul>',
    )
    expect(html).not.toContain('<a href="javascript')
    expectNoRawMarkdown(html)
  })

  it('renders the background-work section as HTML', async () => {
    // #given one unfinished and one unconfirmed entry
    const ledger = createOwnershipLedger()
    ledger.adopt('s1', 'reviewer <a>')
    ledger.markUnknown('s1')

    // #when the job summary is written
    await writeJobSummary(createOptions(), logger, ledger)

    // #then label, list, and degraded banner are all HTML
    const html = rendered()
    expect(html).toContain(
      '<p><strong>Did not finish:</strong></p>\n<ul><li>reviewer &lt;a&gt; (unconfirmed)</li></ul>\n',
    )
    expect(html).toContain('<p>⚠️ <strong>Degraded:</strong> 1 entry could not be confirmed')
    expectNoRawMarkdown(html)
  })

  it('renders the cache-save remediation with <code> instead of backticks', async () => {
    // #given a rejected cache write, whose remediation names `s3-backup` in code style
    const result: CacheSaveResult = {cachePersisted: false, storePersisted: false, outcome: 'cache-rejected'}

    // #when the row is written
    await writeCacheSaveResultSummary(result, 'main', logger)

    // #then the code span is HTML and no backtick survives
    const html = rendered()
    expect(html).toContain('<p>Session state did not persist this run')
    expect(html).toContain('enable <code>s3-backup</code> to persist state')
    expect(html).not.toContain('`')
    expectNoRawMarkdown(html)
  })

  it('renders the ownership decline reason as bold label plus escaped text', async () => {
    // #given an ownership decline with a hostile reason
    const result: CacheSaveResult = {cachePersisted: false, storePersisted: false, outcome: 'ownership-declined'}

    // #when the row is written
    await writeCacheSaveResultSummary(result, 'main', logger, '<script>x</script>')

    // #then
    const html = rendered()
    expect(html).toContain('<p><strong>Reason:</strong> &lt;script&gt;x&lt;/script&gt;</p>')
    expect(html).not.toContain('<script>')
    expectNoRawMarkdown(html)
  })

  it('renders the skip reason, escaped message, and review-request hint link', async () => {
    // #given an unauthorized-author skip with a hostile message
    // #when the invocation outcome is written
    await writeInvocationOutcomeSummary('skipped', [], logger, {
      reason: 'unauthorized_author',
      message: 'author <img src=x onerror=1> & co',
    })

    // #then the skip line, hint anchor, and generic sentence are HTML paragraphs
    const html = rendered()
    expect(html).toContain(
      '<p><strong>Skip reason:</strong> <code>unauthorized_author</code> — author &lt;img src=x onerror=1&gt; &amp; co</p>',
    )
    expect(html).toContain(
      '<a href="https://github.com/fro-bot/agent/blob/main/docs/wiki/Troubleshooting.md#review-access-and-the-review-request-path">Review access and the review-request path</a>.</p>',
    )
    expect(html).not.toContain('<img')
    expectNoRawMarkdown(html)
  })

  it('renders incomplete reasons as escaped list items', async () => {
    // #given an incomplete outcome with a reason containing markup
    // #when the invocation outcome is written
    await writeInvocationOutcomeSummary('incomplete', ['stream ended <early>'], logger)

    // #then
    const html = rendered()
    expect(html).toContain('<ul><li>stream ended &lt;early&gt;</li></ul>')
    expectNoRawMarkdown(html)
  })
})
