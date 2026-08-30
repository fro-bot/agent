import {describe, expect, it} from 'vitest'
import {
  buildResponseFileDir,
  buildResponseFileFallbackRoots,
  buildResponseFilePath,
  buildResponseFilePathCandidates,
  MAX_BODY_BYTES,
  parseResponseFile,
} from './response-file.js'

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

describe('buildResponseFilePathCandidates', () => {
  it('derives the first fallback root from the runner temp basename', () => {
    // #given a non-hosted runner temp layout
    // #when building relative fallback roots
    const roots = buildResponseFileFallbackRoots('/var/tmp/custom-runner-temp')

    // #then the runner-specific root comes first and the workspace-relative root remains second
    expect(roots).toEqual(['custom-runner-temp', ''])
  })

  it('returns the observed _temp fallback before the workspace-relative fallback', () => {
    // #given the hosted runner layout, workspace, and stable response-file parts
    const parts = {
      runnerTemp: '/tmp/runner/_temp',
      runId: '123',
      runAttempt: '1',
      nonce: 'abc123',
      workspaceDir: '/tmp/runner/repo',
    }

    // #when building candidate paths
    const candidates = buildResponseFilePathCandidates(parts)

    // #then the observed _temp path is first and the current workspace-relative path is second
    expect(candidates).toEqual({
      expectedPath: '/tmp/runner/_temp/fro-bot-response/123-1/abc123.md',
      fallbackPaths: [
        '/tmp/runner/repo/_temp/fro-bot-response/123-1/abc123.md',
        '/tmp/runner/repo/fro-bot-response/123-1/abc123.md',
      ],
    })
  })

  it.each([{workspaceDir: undefined}, {workspaceDir: '   '}])(
    'returns no fallbacks when the workspace is unavailable or the expected path is not strictly beneath runnerTemp',
    ({workspaceDir}) => {
      // #given response-file parts and a workspace configuration
      const parts = {
        runnerTemp: '/tmp/runner',
        runId: '123',
        runAttempt: '1',
        nonce: 'abc123',
        workspaceDir,
      }

      // #when building candidate paths
      const candidates = buildResponseFilePathCandidates(parts)

      // #then no unsafe or duplicate fallback is returned
      expect(candidates).toEqual({
        expectedPath: '/tmp/runner/fro-bot-response/123-1/abc123.md',
        fallbackPaths: [],
      })
    },
  )

  it('returns no fallbacks when the expected path is not beneath runnerTemp', () => {
    // #given a runner temp path whose relative form would traverse out of the workspace
    const parts = {
      runnerTemp: '/tmp/runner',
      runId: '../../outside',
      runAttempt: '1',
      nonce: 'abc123',
      workspaceDir: '/tmp/runner/repo',
    }

    // #when building candidate paths
    const candidates = buildResponseFilePathCandidates(parts)

    // #then no fallback can be derived from an out-of-tree expected path
    expect(candidates).toEqual({expectedPath: '/tmp/outside-1/abc123.md', fallbackPaths: []})
  })

  it('returns no fallbacks when parent segments escape runnerTemp', () => {
    // #given a nonce whose parent segments move the expected path outside runnerTemp
    const parts = {
      runnerTemp: '/tmp/runner',
      runId: '123',
      runAttempt: '1',
      nonce: '../../../abc123',
      workspaceDir: '/tmp/runner/repo',
    }

    // #when building candidate paths
    const candidates = buildResponseFilePathCandidates(parts)

    // #then no fallback is derived from an escaped expected path
    expect(candidates).toEqual({expectedPath: '/tmp/abc123.md', fallbackPaths: []})
  })

  it('drops duplicate fallbacks and any fallback equal to the expected path', () => {
    // #given a root whose basename produces duplicate relative fallback roots
    const duplicateCandidates = buildResponseFilePathCandidates({
      runnerTemp: '/',
      runId: '123',
      runAttempt: '1',
      nonce: 'abc123',
      workspaceDir: '/tmp/workspace',
    })
    const equalCandidate = buildResponseFilePathCandidates({
      runnerTemp: '/tmp/runner',
      runId: '123',
      runAttempt: '1',
      nonce: 'abc123',
      workspaceDir: '/tmp/runner',
    })

    // #then duplicate and primary-equal paths are excluded
    expect(duplicateCandidates.fallbackPaths).toEqual(['/tmp/workspace/fro-bot-response/123-1/abc123.md'])
    expect(equalCandidate.fallbackPaths).toEqual(['/tmp/runner/runner/fro-bot-response/123-1/abc123.md'])
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

  it('parses a verdict with body for pr-review-optional', () => {
    // #given
    const raw = '---\nverdict: approve\n---\nLooks good to me'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review-optional'})

    // #then
    expect(result).toEqual({success: true, data: {body: 'Looks good to me', verdict: 'approve'}})
  })

  it('accepts a missing verdict for pr-review-optional', () => {
    // #given
    const raw = 'A question about this pull request'

    // #when
    const result = parseResponseFile(raw, {surface: 'pr-review-optional'})

    // #then
    expect(result).toEqual({success: true, data: {body: 'A question about this pull request'}})
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

  it.each(['issue-comment', 'pr-comment'] as const)('rejects verdict on the %s comment surface', surface => {
    // #given
    const raw = '---\nverdict: approve\n---\nBody'

    // #when
    const result = parseResponseFile(raw, {surface})

    // #then
    expect(result.success === false ? result.error : undefined).toMatchObject({
      code: 'RESPONSE_FILE_ERROR',
      reason: 'verdict-on-non-review',
      message: `"verdict" is only valid for surface "pr-review", got "${surface}"`,
    })
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
