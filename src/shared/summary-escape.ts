function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Escapes untrusted text for a job-summary table cell or inline run, which is emitted as raw HTML. */
export function escapeSummaryText(value: string): string {
  return escapeHtml(value)
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replaceAll(/\r\n|\r|\n/g, ' ')
}
