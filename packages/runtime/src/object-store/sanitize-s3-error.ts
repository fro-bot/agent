const AMZ_PREFIX = 'X-Amz-'
const AMZ_REPLACEMENT = 'X-Amz-REDACTED=[REDACTED]'

function isParameterNameChar(char: string): boolean {
  return /[A-Z0-9-]/i.test(char)
}

function isValueChar(char: string): boolean {
  return char !== '&' && !/\s/.test(char)
}

/**
 * Redacts `X-Amz-<name>=<value>` pairs. Equivalent to `/X-Amz-[A-Za-z0-9-]+=[^&\s]+/g`, but a single forward scan: that
 * pattern re-scanned the whole name run from every `X-Amz-` start inside it, which is quadratic on a long run of repeated
 * prefixes. A name run is a maximal stretch of name characters, so if it is not followed by `=` and a value, no start inside
 * it can match either and the scan resumes after it.
 */
function redactAmzParameters(message: string): string {
  let redacted = ''
  let copiedUpTo = 0
  let searchFrom = 0
  while (true) {
    const start = message.indexOf(AMZ_PREFIX, searchFrom)
    if (start === -1) break
    const nameStart = start + AMZ_PREFIX.length
    let nameEnd = nameStart
    while (nameEnd < message.length && isParameterNameChar(message.charAt(nameEnd))) nameEnd++
    if (nameEnd === nameStart) {
      searchFrom = start + 1
      continue
    }
    let valueEnd = nameEnd + 1
    if (message.charAt(nameEnd) === '=') {
      while (valueEnd < message.length && isValueChar(message.charAt(valueEnd))) valueEnd++
    }
    if (message.charAt(nameEnd) !== '=' || valueEnd === nameEnd + 1) {
      searchFrom = nameEnd
      continue
    }
    redacted += message.slice(copiedUpTo, start) + AMZ_REPLACEMENT
    copiedUpTo = valueEnd
    searchFrom = valueEnd
  }
  return redacted + message.slice(copiedUpTo)
}

export function sanitizeS3ErrorMessage(message: string): string {
  return redactAmzParameters(message)
    .replaceAll(/Authorization([:=]\s*)(Bearer\s+)?[^,\s]+/gi, 'Authorization$1$2[REDACTED]')
    .slice(0, 500)
}
