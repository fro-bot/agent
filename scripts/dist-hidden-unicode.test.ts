import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  BINARY_EXTENSIONS,
  checkDistHiddenUnicode,
  escapeDistHiddenUnicode,
  HIDDEN_UNICODE_TEST_RE,
} from './dist-hidden-unicode.js'

// Renovate's exact codepoints (from renovatebot/renovate lib/util/unicode.ts)
const RENOVATE_CODEPOINTS = [
  0x00a0, // NO-BREAK SPACE
  0x00ad, // SOFT HYPHEN
  0x1680, // OGHAM SPACE MARK
  // \u2000-\u200A range
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x2028, // LINE SEPARATOR
  0x2029, // PARAGRAPH SEPARATOR
  // \u202A-\u202E range
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x202f, // NARROW NO-BREAK SPACE
  0x205f, // MEDIUM MATHEMATICAL SPACE
  0x3000, // IDEOGRAPHIC SPACE
  0xfeff, // ZERO WIDTH NO-BREAK SPACE (BOM)
]

describe('HIDDEN_UNICODE_TEST_RE superset coverage', () => {
  it('matches every codepoint in Renovate hidden-Unicode set', () => {
    // #given — every codepoint Renovate flags
    // #when / #then — our regex must match each one
    for (const cp of RENOVATE_CODEPOINTS) {
      const char = String.fromCodePoint(cp)
      expect(HIDDEN_UNICODE_TEST_RE.test(char), `U+${cp.toString(16).toUpperCase().padStart(4, '0')} not matched`).toBe(
        true,
      )
    }
  })

  it('does not match normal ASCII characters', () => {
    // #given
    const normal = 'Hello, world! 123 \t\n'

    // #when / #then
    expect(HIDDEN_UNICODE_TEST_RE.test(normal)).toBe(false)
  })

  it('does not match regular Unicode letters and symbols', () => {
    // #given — emoji, CJK, accented letters are NOT hidden unicode
    const normal = '日本語 café résumé 🎉'

    // #when / #then
    expect(HIDDEN_UNICODE_TEST_RE.test(normal)).toBe(false)
  })

  it('does not match U+200D (ZWJ) — key design exclusion, used in emoji sequences', () => {
    // #given — ZWJ is intentionally excluded from the regex; it is NOT in Renovate's set
    // and appears legitimately in multi-codepoint emoji (e.g. 👨‍👩‍👧)
    const zwj = '\u200D'

    // #when / #then — must NOT be matched
    expect(HIDDEN_UNICODE_TEST_RE.test(zwj)).toBe(false)
  })
})

describe('BINARY_EXTENSIONS', () => {
  it('includes expected binary extensions', () => {
    expect(BINARY_EXTENSIONS.has('png')).toBe(true)
    expect(BINARY_EXTENSIONS.has('jpg')).toBe(true)
    expect(BINARY_EXTENSIONS.has('woff2')).toBe(true)
  })

  it('does not include .map (source maps are text/JSON, not binary)', () => {
    // Source maps are JSON — they must be scanned for hidden unicode, not skipped.
    expect(BINARY_EXTENSIONS.has('map')).toBe(false)
  })

  it('does not include text extensions', () => {
    expect(BINARY_EXTENSIONS.has('js')).toBe(false)
    expect(BINARY_EXTENSIONS.has('ts')).toBe(false)
    expect(BINARY_EXTENSIONS.has('txt')).toBe(false)
  })
})

describe('escapeDistHiddenUnicode', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dist-unicode-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true, force: true})
  })

  it('escapes a raw U+200C (zero-width non-joiner) in a JS file', async () => {
    // #given — file with a raw hidden unicode char
    const filePath = join(tmpDir, 'main.js')
    await writeFile(filePath, 'const x = "\u200C"', 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.file).toBe(filePath)
    expect(results[0]?.replacements).toBe(1)

    // File content must now have the escaped form, not the raw char
    const {readFile} = await import('node:fs/promises')
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe(String.raw`const x = "\u200C"`)
    expect(content).not.toContain('\u200C')
  })

  it('escapes all Renovate-flaggable codepoints', async () => {
    // #given — one file with every Renovate codepoint
    const raw = RENOVATE_CODEPOINTS.map(cp => String.fromCodePoint(cp)).join('')
    const filePath = join(tmpDir, 'bundle.js')
    await writeFile(filePath, `var s = "${raw}"`, 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then — all chars replaced
    expect(results).toHaveLength(1)
    expect(results[0]?.replacements).toBe(RENOVATE_CODEPOINTS.length)

    const {readFile} = await import('node:fs/promises')
    const content = await readFile(filePath, 'utf8')
    for (const cp of RENOVATE_CODEPOINTS) {
      expect(content).not.toContain(String.fromCodePoint(cp))
    }
  })

  it('returns empty array when no hidden unicode is present', async () => {
    // #given
    const filePath = join(tmpDir, 'clean.js')
    await writeFile(filePath, 'const x = "hello world"', 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then
    expect(results).toHaveLength(0)
  })

  it('skips binary extensions', async () => {
    // #given — a .png file with hidden unicode bytes (should be skipped)
    const filePath = join(tmpDir, 'image.png')
    await writeFile(filePath, `\u200C\uFEFF`, 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then — binary file not touched
    expect(results).toHaveLength(0)
  })

  it('recurses into subdirectories', async () => {
    // #given — file in a nested subdir
    const subDir = join(tmpDir, 'chunks')
    await mkdir(subDir, {recursive: true})
    const filePath = join(subDir, 'vendor.js')
    await writeFile(filePath, 'var x = "\uFEFF"', 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0]?.file).toBe(filePath)
  })

  it('does not modify files that already contain escaped unicode sequences', async () => {
    // #given — content with the literal backslash-u escape (already safe, 6 ASCII chars)
    const filePath = join(tmpDir, 'escaped.js')
    const alreadyEscaped = String.raw`var x = "\u200C"`
    await writeFile(filePath, alreadyEscaped, 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then — no changes needed
    expect(results).toHaveLength(0)
  })
})

describe('escapeDistHiddenUnicode — ZWJ exclusion', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dist-unicode-zwj-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true, force: true})
  })

  it('leaves U+200D (ZWJ) unchanged — not a hidden unicode violation', async () => {
    // #given — file containing only a ZWJ (should be untouched)
    const filePath = join(tmpDir, 'emoji.js')
    await writeFile(filePath, 'var e = "\u200D"', 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then — no modifications
    expect(results).toHaveLength(0)

    const {readFile} = await import('node:fs/promises')
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain('\u200D')
  })
})

describe('checkDistHiddenUnicode — ZWJ exclusion', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dist-unicode-zwj-check-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true, force: true})
  })

  it('reports NO violation for U+200D (ZWJ)', async () => {
    // #given — file with only a ZWJ
    const filePath = join(tmpDir, 'emoji.js')
    await writeFile(filePath, 'var e = "\u200D"', 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then — ZWJ is not a violation
    expect(violations).toHaveLength(0)
  })
})

describe('checkDistHiddenUnicode — multi-violation', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dist-unicode-multi-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true, force: true})
  })

  it('reports all violations in a single file with multiple hidden chars on same and different lines', async () => {
    // #given — file with 2 chars on line 1 and 1 char on line 2
    const filePath = join(tmpDir, 'multi.js')
    await writeFile(filePath, '\u200Bfoo\u200C\nbar\u200E', 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then — all 3 violations reported
    expect(violations).toHaveLength(3)
    const codepoints = violations.map(v => v.codepoint).sort()
    expect(codepoints).toEqual(['U+200B', 'U+200C', 'U+200E'])
    // line numbers: line 1 has U+200B and U+200C, line 2 has U+200E
    const line1Violations = violations.filter(v => v.line === 1)
    const line2Violations = violations.filter(v => v.line === 2)
    expect(line1Violations).toHaveLength(2)
    expect(line2Violations).toHaveLength(1)
  })

  it('scrubber escapes all violations in a multi-violation file', async () => {
    // #given — file with 3 hidden chars across 2 lines
    const filePath = join(tmpDir, 'multi.js')
    await writeFile(filePath, '\u200Bfoo\u200C\nbar\u200E', 'utf8')

    // #when
    const results = await escapeDistHiddenUnicode(tmpDir)

    // #then — all 3 replaced
    expect(results).toHaveLength(1)
    expect(results[0]?.replacements).toBe(3)

    const {readFile} = await import('node:fs/promises')
    const content = await readFile(filePath, 'utf8')
    expect(content).not.toContain('\u200B')
    expect(content).not.toContain('\u200C')
    expect(content).not.toContain('\u200E')
    expect(content).toContain(String.raw`\u200B`)
    expect(content).toContain(String.raw`\u200C`)
    expect(content).toContain(String.raw`\u200E`)
  })
})

describe('checkDistHiddenUnicode', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dist-unicode-check-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true, force: true})
  })

  it('returns violations for a file with raw hidden unicode', async () => {
    // #given
    const filePath = join(tmpDir, 'main.js')
    await writeFile(filePath, 'line1\nline with \u200C here\nline3', 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(filePath)
    expect(violations[0]?.line).toBe(2)
    expect(violations[0]?.codepoint).toBe('U+200C')
  })

  it('returns empty array for clean content', async () => {
    // #given
    const filePath = join(tmpDir, 'clean.js')
    await writeFile(filePath, 'const x = "hello"', 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then
    expect(violations).toHaveLength(0)
  })

  it('returns empty array for already-escaped content', async () => {
    // #given — the literal \u200C escape sequence (6 ASCII chars, not the raw char)
    const filePath = join(tmpDir, 'escaped.js')
    await writeFile(filePath, String.raw`var x = "\u200C"`, 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then — escaped form is clean
    expect(violations).toHaveLength(0)
  })

  it('skips binary extensions', async () => {
    // #given
    const filePath = join(tmpDir, 'font.woff2')
    await writeFile(filePath, '\u200C\uFEFF', 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then
    expect(violations).toHaveLength(0)
  })

  it('recurses into subdirectories', async () => {
    // #given
    const subDir = join(tmpDir, 'assets')
    await mkdir(subDir, {recursive: true})
    const filePath = join(subDir, 'chunk.js')
    await writeFile(filePath, '\uFEFF', 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(filePath)
    expect(violations[0]?.codepoint).toBe('U+FEFF')
  })

  it('reports multiple violations across multiple files', async () => {
    // #given
    await writeFile(join(tmpDir, 'a.js'), '\u200B', 'utf8')
    await writeFile(join(tmpDir, 'b.js'), '\u00AD', 'utf8')

    // #when
    const violations = await checkDistHiddenUnicode(tmpDir)

    // #then
    expect(violations).toHaveLength(2)
    const codepoints = violations.map(v => v.codepoint).sort()
    expect(codepoints).toEqual(['U+00AD', 'U+200B'])
  })

  it('scrubber → checker round-trip: inject raw char, scrub, check passes', async () => {
    // #given — inject a raw U+200C
    const filePath = join(tmpDir, 'bundle.js')
    await writeFile(filePath, 'var x = "\u200C"', 'utf8')

    // #when — checker must fail first
    const before = await checkDistHiddenUnicode(tmpDir)
    expect(before).toHaveLength(1)

    // #when — scrub
    await escapeDistHiddenUnicode(tmpDir)

    // #then — checker must pass after scrub
    const after = await checkDistHiddenUnicode(tmpDir)
    expect(after).toHaveLength(0)
  })
})
