/**
 * FROZEN REFERENCE, test support only. The scrubber as it stood before the range-collecting rewrite (sequential passes, each
 * reading the previous pass's output), kept so `scrub.test.ts` can show the rewrite changes nothing where the old design was
 * already right (inputs with no overlapping matches). Never imported by the plugin; delete it with the differential test.
 */

import {REDACTION} from './scrub.js'

interface PatternResult {
  readonly text: string
  readonly count: number
}

interface ScrubPattern {
  /** Stable name: used in tests and nowhere in output (a marker never names the pattern that matched). */
  readonly id: string
  readonly apply: (text: string, lower: string) => PatternResult
}

/** Replaces each match with `replacement(...groups)`; skips the scan when none of `needles` occur (case-folded). */
function replacing(
  id: string,
  regex: RegExp,
  replacement: (...groups: string[]) => string,
  needles?: readonly string[],
): ScrubPattern {
  return {
    id,
    apply: (text, lower) => {
      if (needles !== undefined && !needles.some(needle => lower.includes(needle))) return {text, count: 0}
      let count = 0
      const replaced = text.replace(regex, (...args: unknown[]) => {
        count += 1
        // The last arguments are offset and string (and groups when named): only the captures are passed on.
        const groups = args.slice(1, -2).filter((value): value is string => typeof value === 'string')
        return replacement(...groups)
      })
      return {text: replaced, count}
    },
  }
}

const whole = (): string => REDACTION

/**
 * A private-key block: from its header to its end line, or, when the tool cut the block short, to the end of the string
 * value (the next `"`) or of the text. Found by header regex and `indexOf`, never by a lazy match across the body.
 */
function pemPattern(): ScrubPattern {
  const header = /-----BEGIN [A-Z0-9 ]{0,40}(?:PRIVATE KEY|KEY BLOCK)-----/g
  return {
    id: 'pem-private-key',
    apply: (text, lower) => {
      if (!lower.includes('-----begin ')) return {text, count: 0}
      let count = 0
      let out = ''
      let cursor = 0
      header.lastIndex = 0
      // The next end line and the next quote are searched forward once and only moved when a header passes them, so a
      // text of many headers and no end line costs one scan, not one per header.
      let nextEnd = text.indexOf('-----END ')
      let nextQuote = text.indexOf('"')
      for (;;) {
        const match = header.exec(text)
        if (match === null) break
        const from = match.index
        if (from < cursor) continue
        const bodyStart = from + match[0].length
        if (nextEnd !== -1 && nextEnd < bodyStart) nextEnd = text.indexOf('-----END ', bodyStart)
        if (nextQuote !== -1 && nextQuote < bodyStart) nextQuote = text.indexOf('"', bodyStart)
        let stop = text.length
        if (nextEnd !== -1 && (nextQuote === -1 || nextEnd < nextQuote)) {
          const close = text.indexOf('-----', nextEnd + '-----END '.length)
          stop = close === -1 ? text.length : close + '-----'.length
        } else if (nextQuote !== -1) {
          stop = nextQuote
        }
        out += text.slice(cursor, from) + REDACTION
        cursor = stop
        header.lastIndex = Math.max(stop, header.lastIndex)
        count += 1
      }
      return count === 0 ? {text, count: 0} : {text: out + text.slice(cursor), count}
    },
  }
}

/** `[\w-]`: what a JWT segment is made of. */
const isSegmentChar = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x2d

/** `\w`, for the boundary before `eyJ`. */
const isWordChar = (code: number): boolean => code !== 0x2d && isSegmentChar(code)

/**
 * A JSON Web Token: `eyJ`, a header of at least 8 segment characters, a dot, a payload of at least 8, a dot, a signature
 * of at least 4. The same language as `\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}`, found by one forward walk.
 *
 * Why not the regex: `[\w-]` takes the dash, so in `eyJ-eyJ-eyJ-…` every `eyJ` starts inside the previous one's run, each
 * attempt walks to the end of the run and backtracks over it, and the whole is quadratic (0.18 s at 20 KB, 2.9 s at 80 KB).
 * Here a run's end is found once and remembered, and a candidate inside a run that already failed is skipped, so no
 * position is walked more than three times (once as each segment).
 */
function jwtPattern(): ScrubPattern {
  return {
    id: 'jwt',
    apply: (text, lower) => {
      if (!lower.includes('eyj')) return {text, count: 0}
      const length = text.length
      // The most recent maximal run of segment characters, so a start inside it does not walk it again.
      let runFrom = -1
      let runTo = -1
      const runEnd = (start: number): number => {
        if (start >= runFrom && start <= runTo && runFrom !== -1) return runTo
        let end = start
        while (end < length && isSegmentChar(text.charCodeAt(end))) end += 1
        runFrom = start
        runTo = end
        return end
      }
      let count = 0
      let out = ''
      let cursor = 0
      let from = 0
      for (;;) {
        const start = text.indexOf('eyJ', from)
        if (start === -1) break
        from = start + 3
        // `\b` before `e`: the character before is not a word character. A dash is not one, but is a segment character.
        if (start > 0 && isWordChar(text.charCodeAt(start - 1))) continue
        const headerEnd = runEnd(start + 3)
        // Every start inside this run has the same end and a shorter header: if this one fails on the dot, they all do.
        if (headerEnd - (start + 3) < 8 || text.charCodeAt(headerEnd) !== 0x2e) {
          from = Math.max(from, headerEnd)
          continue
        }
        const payloadEnd = runEnd(headerEnd + 1)
        if (payloadEnd - (headerEnd + 1) < 8 || text.charCodeAt(payloadEnd) !== 0x2e) {
          // Later starts inside the header run reach the same payload and fail alike; the payload itself may hold starts.
          from = Math.max(from, headerEnd + 1)
          continue
        }
        const signatureEnd = runEnd(payloadEnd + 1)
        if (signatureEnd - (payloadEnd + 1) < 4) {
          from = Math.max(from, headerEnd + 1)
          continue
        }
        out += text.slice(cursor, start) + REDACTION
        cursor = signatureEnd
        from = signatureEnd
        count += 1
      }
      return count === 0 ? {text, count: 0} : {text: out + text.slice(cursor), count}
    },
  }
}

/** Words that make a name secret-like. Matched inside a name, so `X_API_KEY` and `dbPassword` both qualify. */
const SECRET_WORDS =
  'password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|auth[_-]?key|session[_-]?key|client[_-]?secret|signature|bearer'
const SECRET_NEEDLES: readonly string[] = [
  'pass',
  'pwd',
  'secret',
  'token',
  'key',
  'credential',
  'authorization',
  'signature',
  'bearer',
]

/** Characters that end an unquoted value: whitespace, quotes, a backslash and the delimiters of a URL or a list. */
const UNQUOTED_STOP: ReadonlySet<number> = new Set(
  [' ', '\t', '\n', '\r', '\f', '\v', '"', "'", '\\', '<', '>', ',', ';', '&', ')', '}', ']'].map(char =>
    char.charCodeAt(0),
  ),
)

/**
 * Names that are a count or a limit, not a credential: `max_tokens`, `token_count`, `tokens`, `input_tokens`. Only these may
 * keep a numeric value; a password, secret, credential or authorization name never does. Tested on a bounded identifier.
 */
const COUNTER_NAME =
  /(?:^|[_.-])(?:max|min|total|num|count|limit|input|output|prompt|completion|cache|reasoning|used|remaining|budget)[_.-]?tokens$|^tokens$|tokens?[_.-]?(?:count|limit|used|budget|remaining|total|usage)$/i
const MAX_IDENTIFIER_CHARS = 64

function isCounterName(identifier: string): boolean {
  return COUNTER_NAME.test(identifier.slice(-MAX_IDENTIFIER_CHARS))
}

/** A value that is only a short number: a count, never a password. */
const isShortNumber = (text: string): boolean => /^\d{1,8}$/.test(text)

const isIdentifierCode = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x2e ||
  code === 0x2d

/** The most a quoted value is searched for its closing quote. Past it the value is redacted to the end of the line. */
const MAX_QUOTED_VALUE_CHARS = 8192

/**
 * Where an unquoted value that starts at `from` ends. A marker inside it is part of the value, not the end of it (the marker
 * holds a closing bracket, which is also a delimiter): `pre-[REDACTED]-tail` is one value.
 */
function unquotedEnd(text: string, from: number): number {
  let end = from
  while (end < text.length) {
    if (text.startsWith(REDACTION, end)) {
      end += REDACTION.length
      continue
    }
    if (UNQUOTED_STOP.has(text.charCodeAt(end))) break
    end += 1
  }
  return end
}

const SCHEME_WORD = /^(?:bearer|basic|token|digest)$/i

/** After an authorization scheme word ending at `end`: up to eight blanks and the credential token that follows it, if any. */
function schemeCredentialEnd(text: string, end: number): number {
  let index = end
  while (index < text.length && index - end < 8 && (text.charCodeAt(index) === 0x20 || text.charCodeAt(index) === 0x09))
    index += 1
  if (index === end) return end
  const tokenEnd = unquotedEnd(text, index)
  return tokenEnd === index ? end : tokenEnd
}

/**
 * `name=value` and `name: value`, in plain text and in JSON text (`\"name\": \"value\"`). The match starts at the secret word
 * itself, so nothing before it is scanned or kept; every gap is a bounded class, so adjacent optional parts cannot trade
 * characters. The value is then read by hand, once, forward:
 * - a quoted value runs to its closing quote, honouring escapes (in an escaped layer, `\"` closes and `\\\"` does not); if
 *   no closing quote is found within `MAX_QUOTED_VALUE_CHARS` it runs to the end of the line;
 * - an unquoted value is a run of non-delimiter characters (the first token only);
 * - a number of up to eight digits survives only after a counter or limit name (`max_tokens: 8000`), never after a name that
 *   says password, secret, credential or authorization.
 * The cursor moves past everything consumed, so no character is scanned more than a bounded number of times.
 */
function nameValuePattern(): ScrubPattern {
  const prefix = new RegExp(
    // The quote around a name or a value may sit in an escaped layer: any run of backslashes (JSON in JSON in JSON) before it.
    String.raw`((?:${SECRET_WORDS})[\w.-]{0,20})(?:\\{0,15}["'])?[ \t]{0,4}[:=][ \t]{0,4}(\\{0,15}["'])?`,
    'gi',
  )
  return {
    id: 'name-value-pair',
    apply: (text, lower) => {
      if (!SECRET_NEEDLES.some(needle => lower.includes(needle))) return {text, count: 0}
      let count = 0
      let out = ''
      let cursor = 0
      prefix.lastIndex = 0
      for (;;) {
        const match = prefix.exec(text)
        if (match === null) break
        const name = match[1] ?? ''
        const opener = match[2]
        const valueStart = match.index + match[0].length
        // The identifier the name belongs to: what precedes the secret word (`max_` of `max_tokens`) counts.
        let from = match.index
        while (from > 0 && match.index - from < MAX_IDENTIFIER_CHARS && isIdentifierCode(text.charCodeAt(from - 1)))
          from -= 1
        const counter = isCounterName(text.slice(from, match.index) + name)

        let valueEnd: number
        if (opener === undefined) {
          valueEnd = unquotedEnd(text, valueStart)
          // `Authorization: Bearer <credential>`: the first token is the scheme, the credential is the second.
          if (SCHEME_WORD.test(text.slice(valueStart, valueEnd))) valueEnd = schemeCredentialEnd(text, valueEnd)
          const value = text.slice(valueStart, valueEnd)
          if (counter && isShortNumber(value)) continue
          // A counter name keeps the old floor of three characters; a credential name has none.
          if (value.length < (counter ? 3 : 1)) continue
        } else {
          valueEnd = closingQuote(text, valueStart, opener)
          if (valueEnd === valueStart) continue
        }
        // Only a value that is exactly the marker counts as already redacted (an earlier pass, or the structured pass).
        if (text.slice(valueStart, valueEnd) === REDACTION) continue
        if (valueStart < cursor) continue
        out += text.slice(cursor, valueStart) + REDACTION
        cursor = valueEnd
        prefix.lastIndex = Math.max(prefix.lastIndex, valueEnd)
        count += 1
      }
      return count === 0 ? {text, count: 0} : {text: out + text.slice(cursor), count}
    },
  }
}

/**
 * Where a quoted value that starts at `from` ends: the index of its closing delimiter, or the end of the line when none is
 * found within the bound. `opener` is the quote and any backslashes before it (`"`, `'`, `\"`, `\\\"`): the run of backslashes
 * says how many layers of JSON escaping the text is in. In a layer, the delimiter is exactly that run and a quote; a quote
 * of the value itself is written with a longer run and does not close it.
 */
function closingQuote(text: string, from: number, opener: string): number {
  const quote = opener.endsWith('"') ? 0x22 : 0x27
  const delimiterRun = opener.length - 1
  const limit = Math.min(text.length, from + MAX_QUOTED_VALUE_CHARS)
  let index = from
  while (index < limit) {
    const code = text.charCodeAt(index)
    if (code === 0x5c) {
      let run = 1
      while (text.charCodeAt(index + run) === 0x5c) run += 1
      const next = text.charCodeAt(index + run)
      if (delimiterRun > 0) {
        if (next === quote) {
          if (run === delimiterRun) return index
          index += run + 1
        } else {
          index += run
        }
      } else {
        // Not in an escaped layer: an odd run escapes the character after it; an even run is escaped backslashes only.
        index += run + (run % 2 === 1 ? 1 : 0)
      }
      continue
    }
    if (delimiterRun === 0 && code === quote) return index
    index += 1
  }
  // Not closed within the bound: redact to the end of the line.
  const newline = text.indexOf('\n', from)
  return newline === -1 ? text.length : newline
}

/** URL userinfo: everything between `scheme://` and the `@`. */
const URL_USERINFO = /([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@"'\\]{1,256}@/gi

/** A secret-like query parameter's value. */
const QUERY_SECRET = new RegExp(
  String.raw`([?&;][\w.-]{0,30}(?:${SECRET_WORDS}|sig|key)[\w.-]{0,10}=)[^\s&"'#\\]{3,}`,
  'gi',
)

/**
 * The patterns, in the order they run. Specific shapes first, so a generic `name: value` match never has to guess at a
 * token that a specific pattern already recognized.
 */
const LEGACY_PATTERNS: readonly ScrubPattern[] = [
  pemPattern(),
  replacing('github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_\w{22,255})\b/g, whole, [
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
  ]),
  replacing(
    'aws-access-key-id',
    /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    whole,
    ['akia', 'asia', 'agpa', 'aida', 'aroa', 'anpa', 'anva', 'abia', 'acca'],
  ),
  replacing(
    'vendor-key-prefix',
    /\b(?:sk-[\w-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[\w-]{35}|hf_[A-Za-z0-9]{30,}|pplx-[A-Za-z0-9]{30,}|fw_[A-Za-z0-9]{20,}|nvapi-[\w-]{30,}|npm_[A-Za-z0-9]{36}|glpat-[\w-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|SG\.[\w-]{16,}\.[\w-]{16,}|ya29\.[\w-]{20,}|r8_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{40,})/g,
    whole,
    [
      'sk-',
      'sk_',
      'rk_',
      'xai-',
      'gsk_',
      'aiza',
      'hf_',
      'pplx-',
      'fw_',
      'nvapi-',
      'npm_',
      'glpat-',
      'xox',
      'sg.',
      'ya29.',
      'r8_',
      'dop_v1_',
    ],
  ),
  jwtPattern(),
  // `Bearer` is a credential marker on its own; the other schemes are also English words, so their value must contain a
  // digit or a base64 or token punctuation character.
  replacing(
    'auth-scheme-value',
    /\b(?:(Bearer)[ \t]{1,8}[\w.~+/=-]{8,}|(Basic|Token|Digest)[ \t]{1,8}(?=[\w.~+/=-]*[\d._~+/=-])[\w.~+/=-]{8,})/gi,
    scheme => `${scheme} ${REDACTION}`,
    ['bearer', 'basic', 'token', 'digest'],
  ),
  replacing(
    'connection-string',
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|clickhouse|cockroachdb):\/\/[^\s"'<>\\]{3,}/gi,
    whole,
    ['postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'amqp', 'mssql', 'sqlserver', 'clickhouse', 'cockroachdb'],
  ),
  replacing('url-userinfo', URL_USERINFO, prefix => `${prefix}${REDACTION}@`, ['://']),
  replacing('url-query-secret', QUERY_SECRET, name => `${name}${REDACTION}`, [
    'pass',
    'pwd',
    'secret',
    'token',
    'key',
    'credential',
    'authorization',
    'signature',
    'bearer',
    'sig=',
  ]),
  nameValuePattern(),
]

/** The patterns that run before the literals, in this order: they must see a value whole, over the original text. */
const LEADING_PATTERN_IDS: readonly string[] = ['pem-private-key', 'name-value-pair']

export function createLegacyScrubber(literals: readonly string[]): {
  readonly scrub: (text: string) => {readonly text: string; readonly redactions: number}
} {
  const patterns = LEGACY_PATTERNS
  const isLeading = (pattern: ScrubPattern): boolean => LEADING_PATTERN_IDS.includes(pattern.id)
  const leading = LEADING_PATTERN_IDS.flatMap(id => patterns.filter(pattern => pattern.id === id))
  const trailing = patterns.filter(pattern => !isLeading(pattern))
  return {
    scrub: text => {
      let current = text
      let redactions = 0
      // The order matters. A pass that inserts a marker can make a later pass skip or split what it would have matched, so
      // the passes that must see a value whole run first, over the original text:
      // 1. a private-key block (multi-line, consumed whole);
      // 2. a secret-named assignment, which consumes its entire value from the original text;
      // 3. the literal secrets from the environment;
      // 4. every other token shape.
      const lower0 = current.toLowerCase()
      for (const pattern of leading) {
        const result = pattern.apply(current, lower0)
        if (result.count === 0) continue
        current = result.text
        redactions += result.count
      }
      for (const literal of literals) {
        if (!current.includes(literal)) continue
        const parts = current.split(literal)
        redactions += parts.length - 1
        current = parts.join(REDACTION)
      }
      const lower = current.toLowerCase()
      for (const pattern of trailing) {
        const result = pattern.apply(current, lower)
        if (result.count === 0) continue
        current = result.text
        redactions += result.count
        // The case-folded copy no longer matches the text once something was replaced; refresh it for later patterns.
        // (Replacements only remove text that matched, so a stale copy could only over-trigger, never under-trigger.)
      }
      return {text: current, redactions}
    },
  }
}
