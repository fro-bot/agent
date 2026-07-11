import {describe, expect, it} from 'vitest'
import {buildResponseFileDir, buildResponseFilePath, MAX_BODY_BYTES, parseResponseFile} from './response-file.js'

describe('buildResponseFileDir', () => {
  it('joins runnerTemp with a run+attempt scoped directory', () => {
    // #given
    const parts = {runnerTemp: '/tmp/runner', runId: '123', runAttempt: '1'}

    // #when
    const dir = buildResponseFileDir(parts)

    // #then
    expect(dir).toBe('/tmp/runner/fro-bot-response/123-1')
  })
})

describe('buildResponseFilePath', () => {
  it('joins the run-scoped directory with the nonce-named file', () => {
    // #given
    const parts = {runnerTemp: '/tmp/runner', runId: '123', runAttempt: '1', nonce: 'abc123'}

    // #when
    const filePath = buildResponseFilePath(parts)

    // #then
    expect(filePath).toBe('/tmp/runner/fro-bot-response/123-1/abc123.md')
  })
})

describe('parseResponseFile', () => {
  it('parses a bare body with no frontmatter for issue-comment', () => {
    // #given
    const raw = 'Hello from the agent'

    // #when
    const result = parseResponseFile(raw, {surface: 'issue-comment'})

    // #then
    expect(result).toEqual({success: true, data: {body: 'Hello from the agent'}})
  })

  it('parses a bare body with no frontmatter for pr-comment', () => {
    // #given
    const raw = 'Review comment body'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-comment'})

    // #then
    expect(result).toEqual({success: true, data: {body: 'Review comment body'}})
  })

  it('parses frontmatter verdict: approve with body for pr-review', () => {
    // #given
    const raw = '---\nverdict: approve\n---\nLooks good to me'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result).toEqual({success: true, data: {body: 'Looks good to me', verdict: 'approve'}})
  })

  it('parses frontmatter verdict: request-changes with body for pr-review', () => {
    // #given
    const raw = '---\nverdict: request-changes\n---\nPlease fix the tests'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result).toEqual({success: true, data: {body: 'Please fix the tests', verdict: 'request-changes'}})
  })

  it('rejects frontmatter carrying a "number" key as unknown-key', () => {
    // #given
    const raw = '---\nnumber: 999\nverdict: approve\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('unknown-key')
  })

  it('rejects frontmatter carrying a "repo" key as unknown-key', () => {
    // #given
    const raw = '---\nrepo: other/x\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('unknown-key')
  })

  it('rejects frontmatter carrying a "surface" key as unknown-key', () => {
    // #given
    const raw = '---\nsurface: pr-review\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('unknown-key')
  })

  it('rejects any other unrecognized frontmatter key', () => {
    // #given
    const raw = '---\nowner: someone\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('unknown-key')
  })

  it('never surfaces a target/number field on a successfully parsed result', () => {
    // #given
    const raw = '---\nverdict: approve\nschemaVersion: 1\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === true ? result.data : undefined).not.toHaveProperty('target')
    expect(result.success === true ? result.data : undefined).not.toHaveProperty('number')
    expect(result.success === true ? Object.keys(result.data).sort() : undefined).toEqual(['body', 'verdict'])
  })

  it('never consults the body for a verdict, even when the body contains verdict-like text', () => {
    // #given
    const raw = '---\nverdict: request-changes\n---\nPASS\napproved\n## Verdict: APPROVE'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === true ? result.data.verdict : undefined).toBe('request-changes')
  })

  it('rejects an empty file', () => {
    // #given
    const raw = ''

    // #when
    const result = parseResponseFile(raw, {surface: 'issue-comment'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('empty')
  })

  it('rejects an empty body after frontmatter', () => {
    // #given
    const raw = '---\nverdict: approve\n---\n   \n'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('empty')
  })

  it('treats an unterminated frontmatter-looking block as body-only rather than erroring', () => {
    // #given
    const raw = '---\nverdict: approve\nBody with no closing fence'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result).toEqual({success: true, data: {body: raw}})
  })

  it('rejects verdict on a non-review surface', () => {
    // #given
    const raw = '---\nverdict: approve\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'issue-comment'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('verdict-on-non-review')
  })

  it('rejects an unknown verdict value on pr-review', () => {
    // #given
    const raw = '---\nverdict: maybe\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('unknown-verdict')
  })

  it('rejects a body over the size cap', () => {
    // #given
    const oversizedBody = 'a'.repeat(MAX_BODY_BYTES + 1)
    const raw = `---\nverdict: approve\n---\n${oversizedBody}`

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === false ? result.error.reason : undefined).toBe('body-too-large')
  })

  it('treats a body-only file whose first line is "---" with no closing fence as body, not frontmatter', () => {
    // #given
    const raw = '---\nThis is prose that starts with a horizontal rule, not frontmatter.'

    // #when
    const result = parseResponseFile(raw, {surface: 'issue-comment'})

    // #then
    expect(result).toEqual({
      success: true,
      data: {body: '---\nThis is prose that starts with a horizontal rule, not frontmatter.'},
    })
  })

  it('preserves a body that legitimately starts with "---" after real frontmatter', () => {
    // #given
    const raw = '---\nverdict: approve\n---\n---\nThis body line is a markdown rule, not frontmatter.'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result).toEqual({
      success: true,
      data: {body: '---\nThis body line is a markdown rule, not frontmatter.', verdict: 'approve'},
    })
  })

  it('accepts schemaVersion alongside verdict as an allowlisted key', () => {
    // #given
    const raw = '---\nschemaVersion: 1\nverdict: approve\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review'})

    // #then
    expect(result.success === true ? result.data : undefined).toEqual({body: 'Body', verdict: 'approve'})
  })
})
