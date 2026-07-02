import {describe, expect, it} from 'vitest'
import {checkMarkdownLinks, collectMarkdownLinkReport} from './md-links.js'

/** Builds injectable readFile/exists adapters backed by an in-memory file map. */
function makeAdapters(files: Record<string, string>, existingPaths: readonly string[]) {
  const existing = new Set(existingPaths)
  const readFile = async (path: string): Promise<string> => {
    const content = files[path]
    if (content === undefined) throw new Error(`unexpected read: ${path}`)
    return content
  }
  const exists = async (path: string): Promise<boolean> => existing.has(path)
  return {readFile, exists}
}

describe('checkMarkdownLinks — dangling relative link detection', () => {
  it('flags a relative link to a file that does not exist', async () => {
    // #given a doc linking to a sibling file that is missing on disk
    const {readFile, exists} = makeAdapters({'docs/a.md': '[missing](./b.md)'}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({file: 'docs/a.md', line: 1, target: './b.md', resolved: 'docs/b.md'})
  })

  it('does not flag a relative link to a file that exists', async () => {
    // #given
    const {readFile, exists} = makeAdapters({'docs/a.md': '[ok](./b.md)'}, ['docs/b.md'])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(0)
  })
})

describe('checkMarkdownLinks — fenced code block skipping', () => {
  it('does not flag a link target inside a fenced code block (backtick fence)', async () => {
    // #given — dangling-looking link syntax inside a ``` fence must be ignored
    const content = ['# doc', '```ts', '[..](../X.md)', '```', ''].join('\n')
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(0)
  })

  it('does not flag a link target inside a fenced code block (tilde fence)', async () => {
    // #given
    const content = ['# doc', '~~~', '[missing](./nope.md)', '~~~', ''].join('\n')
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(0)
  })

  it('flags a link target that reappears after a fence closes', async () => {
    // #given — the fence must not leak "always skip" state past its closing delimiter
    const content = ['```', '[inside](./ignored.md)', '```', '[outside](./missing.md)'].join('\n')
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(1)
    expect(violations[0]?.target).toBe('./missing.md')
  })

  it('does not flag a fenced block with a language info string', async () => {
    // #given
    const content = ['```typescript', '[..](../missing.md)', '```'].join('\n')
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(0)
  })
})

describe('checkMarkdownLinks — inline code span skipping', () => {
  it('does not flag link syntax inside a single-backtick inline code span', async () => {
    // #given — the corpus's illustrative `[Page Name](Page%20Name.md)` example
    const content = 'See: `[Page Name](Page%20Name.md)` for the convention.'
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(0)
  })

  it('does not flag link-shaped regex fragments inside a multi-backtick code span', async () => {
    // #given
    const content = 'Regex: ``[^"\']*`` matches quoted content.'
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(0)
  })

  it('flags a real link on the same line as an inline code span', async () => {
    // #given — code span must be masked, not the whole line dropped
    const content = 'Use `code` then [missing](./nope.md) here.'
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, [])

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(1)
    expect(violations[0]?.target).toBe('./nope.md')
  })
})

describe('checkMarkdownLinks — external/anchor/data URI skipping', () => {
  it('does not flag http(s) links', async () => {
    const {readFile, exists} = makeAdapters(
      {'docs/a.md': '[a](http://example.com/x.md) and [b](https://example.com/y.md)'},
      [],
    )
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('does not flag mailto: links', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[me](mailto:someone@example.com)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('does not flag anchor-only links', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[top](#section)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('does not flag data: URIs', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[img](data:image/png;base64,AAAA)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('does not flag targets containing :// for a non-standard protocol', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[x](ftp://example.com/file.md)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('flags a genuinely missing relative target that is not external', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[x](./missing.md)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(1)
  })
})

describe('checkMarkdownLinks — image links', () => {
  it('flags a dangling relative image link', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '![alt](./missing.png)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.target).toBe('./missing.png')
  })

  it('does not flag an image link that resolves', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '![alt](./exists.png)'}, ['docs/exists.png'])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('does not flag an external image link', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '![alt](https://example.com/x.png)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })
})

describe('checkMarkdownLinks — anchor stripping and URL-decoding', () => {
  it('strips a trailing #anchor before checking existence', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[x](./b.md#section)'}, ['docs/b.md'])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('flags when the anchor-stripped target still does not exist', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[x](./missing.md#section)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.resolved).toBe('docs/missing.md')
  })

  it('uRL-decodes %20 to a space before resolving', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[Page Name](Page%20Name.md)'}, ['docs/Page Name.md'])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('flags a %20-encoded target that does not exist after decoding', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[Page Name](Page%20Name.md)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.resolved).toBe('docs/Page Name.md')
  })
})

describe('checkMarkdownLinks — resolution: relative dir, leading slash, escapes root', () => {
  it('resolves relative to the containing file directory', async () => {
    const {readFile, exists} = makeAdapters({'docs/plans/a.md': '[x](../brainstorms/b.md)'}, ['docs/brainstorms/b.md'])
    const violations = await checkMarkdownLinks(['docs/plans/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('flags a repo-root-style path that does not resolve relative to the file dir', async () => {
    // #given — the exact bug class fixed in Part 2A: `docs/...` written inside docs/plans/
    // resolves to docs/plans/docs/... which does not exist
    const {readFile, exists} = makeAdapters({'docs/plans/a.md': '[x](docs/brainstorms/b.md)'}, [
      'docs/brainstorms/b.md',
    ])
    const violations = await checkMarkdownLinks(['docs/plans/a.md'], readFile, exists)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.resolved).toBe('docs/plans/docs/brainstorms/b.md')
  })

  it('resolves a leading-slash target from the repo root', async () => {
    const {readFile, exists} = makeAdapters({'docs/plans/a.md': '[x](/docs/brainstorms/b.md)'}, [
      'docs/brainstorms/b.md',
    ])
    const violations = await checkMarkdownLinks(['docs/plans/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('flags a target that resolves outside the repo root without an fs probe', async () => {
    // #given — exists() would throw if called; it must never be invoked for an out-of-root target
    let existsCalled = false
    const readFile = async (): Promise<string> => '[x](../../outside.md)'
    const exists = async (): Promise<boolean> => {
      existsCalled = true
      return true
    }

    // #when
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)

    // #then
    expect(violations).toHaveLength(1)
    expect(existsCalled).toBe(false)
  })
})

describe('checkMarkdownLinks — directory targets', () => {
  it('does not flag a link to a directory that exists', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[x](./solutions)'}, ['docs/solutions'])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(0)
  })

  it('flags a link to a directory that does not exist', async () => {
    const {readFile, exists} = makeAdapters({'docs/a.md': '[x](./missing-dir)'}, [])
    const violations = await checkMarkdownLinks(['docs/a.md'], readFile, exists)
    expect(violations).toHaveLength(1)
  })
})

describe('collectMarkdownLinkReport — counts', () => {
  it('reports filesScanned and linksChecked, excluding skipped external/anchor targets from the count', async () => {
    const content = ['[a](./b.md)', '[ext](https://example.com)', '[anchor](#top)', '`[fake](./ignored.md)`'].join('\n')
    const {readFile, exists} = makeAdapters({'docs/a.md': content}, ['docs/b.md'])

    const report = await collectMarkdownLinkReport(['docs/a.md'], readFile, exists)

    expect(report.filesScanned).toBe(1)
    expect(report.linksChecked).toBe(1)
    expect(report.violations).toHaveLength(0)
  })
})
