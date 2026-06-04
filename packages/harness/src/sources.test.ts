import {describe, expect, it} from 'vitest'
import {parseSource, resolveSources} from './sources.js'

const SOURCE_REPO = 'https://github.com/anomalyco/opencode.git'

// ---------------------------------------------------------------------------
// parseSource — PR URL
// ---------------------------------------------------------------------------

describe('parseSource', () => {
  it('pull request URL maps to refs/pull/N/head', () => {
    // #given / #when
    const src = parseSource('https://github.com/anomalyco/opencode/pull/30182', SOURCE_REPO)

    // #then
    expect(src.fetchRef).toBe('refs/pull/30182/head')
    expect(src.repo).toBe('https://github.com/anomalyco/opencode.git')
    expect(src.label).toBe('anomalyco/opencode#30182')
    // merge ref is the remote-tracking ref
    expect(src.merge).toContain('pr-30182')
  })

  it('pull request URL with trailing slash still maps correctly', () => {
    // #given / #when
    const src = parseSource('https://github.com/anomalyco/opencode/pull/30182/', SOURCE_REPO)

    // #then
    expect(src.fetchRef).toBe('refs/pull/30182/head')
  })

  it('pull request URL with non-numeric PR number throws', () => {
    // #given / #when / #then
    expect(() => parseSource('https://github.com/anomalyco/opencode/pull/abc', SOURCE_REPO)).toThrow(
      /Unsupported GitHub pull request URL/,
    )
  })

  // ---------------------------------------------------------------------------
  // parseSource — /tree/ branch URL
  // ---------------------------------------------------------------------------

  it('/tree/ branch URL maps to refs/heads/<branch>', () => {
    // #given / #when
    const src = parseSource('https://github.com/anomalyco/opencode/tree/dev', SOURCE_REPO)

    // #then
    expect(src.fetchRef).toBe('refs/heads/dev')
    expect(src.repo).toBe('https://github.com/anomalyco/opencode.git')
    expect(src.label).toBe('anomalyco/opencode:dev')
  })

  it('/tree/ URL with nested branch name', () => {
    // #given / #when
    const src = parseSource('https://github.com/anomalyco/opencode/tree/feat/my-feature', SOURCE_REPO)

    // #then
    expect(src.fetchRef).toBe('refs/heads/feat/my-feature')
    expect(src.label).toBe('anomalyco/opencode:feat/my-feature')
  })

  // ---------------------------------------------------------------------------
  // parseSource — local branch name
  // ---------------------------------------------------------------------------

  it('local branch name maps to refs/heads/<b>', () => {
    // #given / #when
    const src = parseSource('my-local-branch', SOURCE_REPO)

    // #then
    expect(src.fetchRef).toBe('refs/heads/my-local-branch')
    expect(src.repo).toBe(SOURCE_REPO)
    expect(src.label).toBe('my-local-branch')
    expect(src.merge).toBe('refs/remotes/watch/local/my-local-branch')
  })

  it('local branch name with slash maps to refs/heads/<b>', () => {
    // #given / #when
    const src = parseSource('feat/something', SOURCE_REPO)

    // #then
    expect(src.fetchRef).toBe('refs/heads/feat/something')
    expect(src.merge).toBe('refs/remotes/watch/local/feat/something')
  })

  // ---------------------------------------------------------------------------
  // parseSource — unsupported GitHub URL forms
  // ---------------------------------------------------------------------------

  it('bare GitHub repo URL (no path segment) throws', () => {
    // #given / #when / #then
    expect(() => parseSource('https://github.com/anomalyco/opencode', SOURCE_REPO)).toThrow(
      /Unsupported GitHub integration source URL/,
    )
  })

  it('github URL with unknown path segment throws', () => {
    // #given / #when / #then
    expect(() => parseSource('https://github.com/anomalyco/opencode/issues/123', SOURCE_REPO)).toThrow(
      /Unsupported GitHub integration source URL/,
    )
  })

  it('github URL missing owner/repo throws', () => {
    // #given / #when / #then
    expect(() => parseSource('https://github.com/anomalyco', SOURCE_REPO)).toThrow(/Unsupported GitHub source URL/)
  })

  it('empty string throws', () => {
    // #given / #when / #then
    expect(() => parseSource('', SOURCE_REPO)).toThrow(/Empty integration source/)
  })

  it('whitespace-only string throws', () => {
    // #given / #when / #then
    expect(() => parseSource('   ', SOURCE_REPO)).toThrow(/Empty integration source/)
  })
})

// ---------------------------------------------------------------------------
// resolveSources
// ---------------------------------------------------------------------------

describe('resolveSources', () => {
  it('maps array of mixed inputs', () => {
    // #given / #when
    const sources = resolveSources(
      [
        'https://github.com/anomalyco/opencode/pull/30182',
        'https://github.com/anomalyco/opencode/tree/dev',
        'local-branch',
      ],
      SOURCE_REPO,
    )

    // #then
    expect(sources.length).toBe(3)
    const [first, second, third] = sources
    expect(first?.fetchRef).toBe('refs/pull/30182/head')
    expect(second?.fetchRef).toBe('refs/heads/dev')
    expect(third?.fetchRef).toBe('refs/heads/local-branch')
  })

  it('empty array returns empty array', () => {
    // #given / #when
    const sources = resolveSources([], SOURCE_REPO)

    // #then
    expect(sources.length).toBe(0)
  })
})
