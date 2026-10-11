import {describe, expect, it} from 'vitest'

import {htmlCode, htmlCodeSpans, htmlLines, htmlLink, htmlParagraph, htmlStrong, htmlText} from './summary-html.js'

describe('htmlText', () => {
  it('escapes ampersand, angle brackets, and both quote kinds', () => {
    // #given text containing every HTML-significant character
    // #when escaping it
    const result = htmlText(`<script>alert("x" & 'y')</script>`)

    // #then each is entity-encoded exactly once
    expect(result).toBe('&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;')
  })

  it('collapses newlines so a value can never contain a blank line', () => {
    // #given text with CRLF, CR and LF line breaks, including a blank line
    // #when escaping it
    const result = htmlText('a\r\nb\rc\n\nd')

    // #then no line break survives
    expect(result).toBe('a b c  d')
  })

  it('does not double-escape when applied once to plain text containing an entity-like string', () => {
    // #given plain text that merely looks like an entity
    // #when escaping it once
    // #then the ampersand is escaped exactly once
    expect(htmlText('&amp;')).toBe('&amp;amp;')
  })
})

describe('htmlLink', () => {
  it('renders an https URL as an anchor', () => {
    // #given a run URL
    // #when building the link
    const result = htmlLink('123', 'https://github.com/o/r/actions/runs/123')

    // #then the anchor is exact
    expect(result).toBe('<a href="https://github.com/o/r/actions/runs/123">123</a>')
  })

  it('accepts http URLs', () => {
    // #given an http URL
    // #then it is linked
    expect(htmlLink('x', 'http://example.com/a')).toBe('<a href="http://example.com/a">x</a>')
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'ftp://example.com/x'])(
    'renders %s as escaped plain text, never an anchor',
    url => {
      // #given a URL with a disallowed scheme
      // #when building the link
      const result = htmlLink('<click>', url)

      // #then only the escaped text remains
      expect(result).toBe('&lt;click&gt;')
      expect(result).not.toContain('<a')
    },
  )

  it('renders an unparseable or relative URL as plain text', () => {
    // #given non-absolute URLs
    // #then they are not linked
    expect(htmlLink('x', '/relative/path')).toBe('x')
    expect(htmlLink('x', '')).toBe('x')
  })

  it('attribute-escapes quotes in the URL and escapes the label', () => {
    // #given a URL whose query contains a double quote and an ampersand, and a hostile label
    // #when building the link
    const result = htmlLink('a&b', 'https://example.com/?q="x"&y=1')

    // #then the href cannot break out of its attribute
    expect(result).toBe('<a href="https://example.com/?q=%22x%22&amp;y=1">a&amp;b</a>')
  })
})

describe('htmlStrong / htmlCode', () => {
  it('wrap escaped text', () => {
    // #given text with markup
    // #then the wrapper holds the escaped text
    expect(htmlStrong('Model: <x>')).toBe('<strong>Model: &lt;x&gt;</strong>')
    expect(htmlCode('a&b')).toBe('<code>a&amp;b</code>')
  })
})

describe('htmlCodeSpans', () => {
  it('renders backtick spans as code and escapes everything else', () => {
    // #given a sentence with a code span and markup
    // #when converting it
    const result = htmlCodeSpans('enable `s3-backup` for <state> & more')

    // #then the span is code and the rest is escaped
    expect(result).toBe('enable <code>s3-backup</code> for &lt;state&gt; &amp; more')
  })
})

describe('htmlLines / htmlParagraph', () => {
  it('joins fragments with <br> and wraps paragraphs', () => {
    // #given two HTML fragments
    // #when joining and wrapping
    // #then lines are separated by <br> and the paragraph wraps the fragment
    expect(htmlLines(['<strong>a</strong>', 'b'])).toBe('<strong>a</strong><br>b')
    expect(htmlParagraph('x')).toBe('<p>x</p>')
  })
})
