import {describe, expect, it} from 'vitest'
import {isValidGitHubOwner, isValidGitHubRepoName, parseRepoSlug, type RepoSlugError} from './slug.js'

function failure(input: string): RepoSlugError {
  const result = parseRepoSlug(input)
  if (result.success === true) throw new Error(`expected ${JSON.stringify(input)} to be rejected`)
  return result.error
}

describe('parseRepoSlug: accepted shapes', () => {
  it.each([
    ['acme/widget', {owner: 'acme', repo: 'widget'}],
    ['  acme/widget  ', {owner: 'acme', repo: 'widget'}],
    ['\tacme/widget\n', {owner: 'acme', repo: 'widget'}],
    ['acme/widget.git', {owner: 'acme', repo: 'widget.git'}],
    ['acme/.github', {owner: 'acme', repo: '.github'}],
    ['acme/my.repo.name', {owner: 'acme', repo: 'my.repo.name'}],
    ['acme/my_repo', {owner: 'acme', repo: 'my_repo'}],
    ['acme/my-repo', {owner: 'acme', repo: 'my-repo'}],
    ['my-org/widget', {owner: 'my-org', repo: 'widget'}],
    ['a/b', {owner: 'a', repo: 'b'}],
    ['1/2', {owner: '1', repo: '2'}],
  ])('accepts %j', (input, expected) => {
    // #when
    const result = parseRepoSlug(input)

    // #then
    expect(result).toEqual({success: true, data: expected})
  })

  it('does NOT change case: the slug is returned exactly as written', () => {
    expect(parseRepoSlug('Acme/Widget')).toEqual({success: true, data: {owner: 'Acme', repo: 'Widget'}})
  })

  it('checks the shape only: names the GitHub rules would reject still parse', () => {
    // #given a trailing-hyphen owner and a consecutive-dot repo: shape is fine, the name rules are separate
    expect(parseRepoSlug('bad-/a..b')).toEqual({success: true, data: {owner: 'bad-', repo: 'a..b'}})
  })

  it.each([
    ['U+200B zero-width space', '\u200B'],
    ['U+200D zero-width joiner', '\u200D'],
    ['U+FEFF byte-order mark', '\uFEFF'],
    ['U+202E right-to-left override', '\u202E'],
    ['U+00AD soft hyphen', '\u00AD'],
  ])('rejects the invisible format character %s anywhere in the value', (_label, char) => {
    // #given a slug that LOOKS valid but carries a character no reader can see
    // #then each position is rejected, including both ends where trim() would not remove it
    expect(failure(`acme${char}/widget`)).toBe('forbidden-character')
    expect(failure(`acme/wid${char}get`)).toBe('forbidden-character')
    expect(failure(`${char}acme/widget`)).toBe('forbidden-character')
    expect(failure(`acme/widget${char}`)).toBe('forbidden-character')
  })
})

describe('parseRepoSlug: rejections', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['\n\t', 'empty'],
  ] as const)('rejects empty input %j as %s', (input, reason) => {
    expect(failure(input)).toBe(reason)
  })

  it.each([
    ['acme', 'missing-separator'],
    ['acme-widget', 'missing-separator'],
  ] as const)('rejects %j (no slash) as %s', (input, reason) => {
    expect(failure(input)).toBe(reason)
  })

  it.each([
    ['acme/widget/extra', 'extra-separator'],
    ['acme/widget/', 'extra-separator'],
    ['acme//widget', 'extra-separator'],
    ['a/b/c/d', 'extra-separator'],
    ['//', 'extra-separator'],
  ] as const)('rejects %j (more than one slash) as %s', (input, reason) => {
    expect(failure(input)).toBe(reason)
  })

  it.each([
    ['/widget', 'empty-owner'],
    ['acme/', 'empty-repo'],
    ['/', 'empty-owner'],
  ] as const)('rejects %j (an empty side) as %s', (input, reason) => {
    expect(failure(input)).toBe(reason)
  })

  it.each([
    ['acme/wid get', 'whitespace inside the repo'],
    ['ac me/widget', 'whitespace inside the owner'],
    ['acme /widget', 'whitespace before the slash'],
    ['acme/ widget', 'whitespace after the slash'],
    ['acme/wid\u00A0get', 'a non-breaking space'],
    ['acme/wid\u2003get', 'an em space'],
    ['acme/widget#1', 'a # suffix'],
    ['acme/wid#get', 'a # inside'],
    ['acme/widget?x=1', 'a query string'],
    [String.raw`acme\widget`, 'a backslash separator'],
    [String.raw`acme/wid\get`, 'a backslash inside'],
    ['acme/widget\u0000', 'a NUL'],
    ['acme/wid\u0007get', 'a control character'],
    ['acme/wid\u007Fget', 'DEL'],
    ['acme/wid\u0085get', 'a C1 control character'],
  ])('rejects %j as a forbidden character (%s)', input => {
    expect(failure(input)).toBe('forbidden-character')
  })

  it('reports a forbidden character before the separator count, so a#1 never reads as a missing slash', () => {
    expect(failure('acme#1')).toBe('forbidden-character')
  })

  it('never throws and never returns data on a rejection', () => {
    expect(parseRepoSlug('x')).toMatchObject({success: false})
  })
})

describe('GitHub name rules', () => {
  it.each(['a', 'acme', 'my-org', 'A1', 'a'.repeat(39), 'a-b-c', 'a--b'])('accepts the owner %j', owner => {
    expect(isValidGitHubOwner(owner)).toBe(true)
  })

  it.each(['', '-a', 'a-', '-', 'a'.repeat(40), 'a_b', 'a.b', 'a b', 'a/b', 'é', 'a\u0000'])(
    'rejects the owner %j',
    owner => {
      expect(isValidGitHubOwner(owner)).toBe(false)
    },
  )

  it.each(['a', 'widget', 'my.repo', 'my_repo', 'my-repo', 'widget.git', '.github', 'a'.repeat(100), 'Widget'])(
    'accepts the repo %j',
    repo => {
      expect(isValidGitHubRepoName(repo)).toBe(true)
    },
  )

  it.each([
    '',
    '.',
    '..',
    'a..b',
    '...',
    'a...',
    '..a',
    'a'.repeat(101),
    'a/b',
    'a b',
    'a#b',
    'a?b',
    'é',
    'a\u0000',
    String.raw`a\b`,
  ])('rejects the repo %j', repo => {
    expect(isValidGitHubRepoName(repo)).toBe(false)
  })
})
