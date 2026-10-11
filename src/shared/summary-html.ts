/**
 * HTML builders for the GitHub Actions job summary.
 *
 * `core.summary.addTable`/`addList` interpolate cell data into `<td>`/`<li>` verbatim, and GitHub does not render
 * Markdown inside an HTML block -- nor does it for Markdown lines that directly follow one (`<h3>`, `<table>`, ... with
 * no blank line between). So every dynamic piece of a job summary is built here as escaped HTML instead.
 *
 * Contract: `htmlText`, `htmlLink`, `htmlStrong`, and `htmlCode` take PLAIN text and escape it exactly once.
 * `htmlLines`, `htmlParagraph`, and `htmlCodeSpans`' result are already HTML -- never pass their output back through
 * `htmlText`. Output never contains a blank line (newlines in values collapse to a space), because a blank line would
 * end the HTML block and hand the rest of the summary to the Markdown parser.
 */

const SAFE_URL_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:'])

/** Escapes plain text for HTML text and attribute-value context (`& < > " '`); newlines collapse to a space. */
export function htmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll(/\r\n|\r|\n/g, ' ')
}

/** Returns the normalized href for an `http:`/`https:` URL, or `null` for anything else (including unparseable input). */
function toSafeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return SAFE_URL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

/** `<a href>` for an `http:`/`https:` URL; any other URL (e.g. `javascript:`) degrades to escaped plain text. */
export function htmlLink(text: string, url: string): string {
  const href = toSafeHref(url)
  return href === null ? htmlText(text) : `<a href="${htmlText(href)}">${htmlText(text)}</a>`
}

export function htmlStrong(text: string): string {
  return `<strong>${htmlText(text)}</strong>`
}

export function htmlCode(text: string): string {
  return `<code>${htmlText(text)}</code>`
}

/**
 * Escapes trusted, static text that uses Markdown-style `` `code` `` spans and renders the spans as `<code>`.
 * Only for author-written strings (remediation sentences), not for untrusted values.
 */
export function htmlCodeSpans(text: string): string {
  return htmlText(text).replaceAll(/`([^`]+)`/g, '<code>$1</code>')
}

/** Joins already-built HTML fragments with `<br>`, for a multi-line table cell. */
export function htmlLines(fragments: readonly string[]): string {
  return fragments.join('<br>')
}

/** Wraps an already-built HTML fragment in a paragraph, so consecutive paragraphs render on separate lines. */
export function htmlParagraph(html: string): string {
  return `<p>${html}</p>`
}
