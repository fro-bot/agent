/**
 * Span content: extraction by named field, scrubbing, bounding, and the one function that makes a span exportable.
 *
 * `scrubSpan` is the only way to produce a `ScrubbedSpan`, and the exporter takes nothing else. It scrubs every string of
 * a finished span (attribute values, name, status message, event text) and, for content attributes, scrubs the whole
 * serialized value BEFORE bounding it, so a secret that straddles a cut is already gone. A value over the input ceiling,
 * or one the scrubber fails on, is omitted with a marker, never exported raw.
 *
 * Scrubbing is best-effort: it removes the secret shapes listed in `SCRUB_PATTERNS` and the values of the plugin's own
 * secret-named environment variables. It does not find a secret that has no recognizable shape.
 *
 * Plain functions only: no SDK, no I/O, no clock. Every pattern is linear-time (no nested quantifier, no backreference,
 * no adjacent unbounded quantifiers); `content.test.ts` times each on its own adversarial input.
 */

import type {ActionIdentity} from './settings.js'

/** What a scrubbed value is replaced with. A fixed string: it never reflects the secret. */
export const REDACTION = '[REDACTED]'

// ---------------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------------

export interface ContentLimits {
  /** A string longer than this is not scanned: it is omitted. Bounds the scrubber's worst-case cost. */
  readonly inputCeilingChars: number
  /** Total characters of content attributes on one span. */
  readonly spanContentChars: number
  /** A plain string (name, status message, event text, ordinary attribute) is cut to this after scrubbing. */
  readonly plainStringChars: number
}

export const DEFAULT_CONTENT_LIMITS: ContentLimits = {
  inputCeilingChars: 8 * 1024 * 1024,
  spanContentChars: 1024 * 1024,
  plainStringChars: 8 * 1024,
}

/** Per-attribute ceilings for content, in serialized characters. */
export const CONTENT_MAX_CHARS = {
  systemInstructions: 128 * 1024,
  toolDefinitions: 128 * 1024,
  inputMessages: 512 * 1024,
  outputMessages: 128 * 1024,
  toolArguments: 64 * 1024,
  toolResult: 64 * 1024,
  prompt: 64 * 1024,
} as const

/** Added to a cut string; counted against the bound so the result stays under it. */
const TRUNCATION_OVERHEAD = 40
const TRUNCATION_SUFFIX = (removed: number): string => `…[truncated ${removed} chars]`

// ---------------------------------------------------------------------------------------------------------------------
// Scrubber
// ---------------------------------------------------------------------------------------------------------------------

export interface PatternResult {
  readonly text: string
  readonly count: number
}

export interface ScrubPattern {
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
    String.raw`((?:${SECRET_WORDS})[\w.-]{0,20})(?:\\?["'])?[ \t]{0,4}[:=][ \t]{0,4}(\\?["'])?`,
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
        if (text.startsWith(REDACTION, valueStart)) continue
        // The identifier the name belongs to: what precedes the secret word (`max_` of `max_tokens`) counts.
        let from = match.index
        while (from > 0 && match.index - from < MAX_IDENTIFIER_CHARS && isIdentifierCode(text.charCodeAt(from - 1)))
          from -= 1
        const counter = isCounterName(text.slice(from, match.index) + name)

        let valueEnd = valueStart
        if (opener === undefined) {
          while (valueEnd < text.length && !UNQUOTED_STOP.has(text.charCodeAt(valueEnd))) valueEnd += 1
          const value = text.slice(valueStart, valueEnd)
          if (counter && isShortNumber(value)) continue
          // A counter name keeps the old floor of three characters; a credential name has none.
          if (value.length < (counter ? 3 : 1)) continue
        } else {
          valueEnd = closingQuote(text, valueStart, opener)
          if (valueEnd === valueStart) continue
        }
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
 * Where a quoted value that starts at `from` ends: the index of its closing quote, or the end of the line when none is
 * found within the bound. `opener` is the quote and any backslash before it (`"`, `'`, `\"`, `\'`).
 */
function closingQuote(text: string, from: number, opener: string): number {
  const quote = opener.endsWith('"') ? 0x22 : 0x27
  const escapedLayer = opener.length === 2
  const limit = Math.min(text.length, from + MAX_QUOTED_VALUE_CHARS)
  let index = from
  while (index < limit) {
    const code = text.charCodeAt(index)
    if (code === 0x5c) {
      let run = 1
      while (text.charCodeAt(index + run) === 0x5c) run += 1
      const next = text.charCodeAt(index + run)
      if (escapedLayer) {
        // A single backslash before the quote closes the value; a longer run escapes the quote and is skipped with it.
        if (run === 1 && next === quote) return index
        index += next === quote ? run + 1 : run
      } else {
        // An odd run escapes the character after it; an even run is escaped backslashes only.
        index += run + (run % 2 === 1 ? 1 : 0)
      }
      continue
    }
    if (!escapedLayer && code === quote) return index
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
export const SCRUB_PATTERNS: readonly ScrubPattern[] = [
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

/** Env names whose value the literal pass removes. `OPENCODE_PASSWORD` is the server's own credential. */
const SECRET_ENV_NAME =
  /SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTHORIZATION/i
const MIN_LITERAL_CHARS = 8
const MAX_LITERAL_CHARS = 4096
const MAX_LITERALS = 128

/** The literal secrets to remove: from the environment once, raw and JSON-escaped, longest first. Never returns names. */
export function collectLiterals(
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): readonly string[] {
  const found = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value === undefined || value.length < MIN_LITERAL_CHARS || value.length > MAX_LITERAL_CHARS) return
    found.add(value)
    const escaped = JSON.stringify(value).slice(1, -1)
    if (escaped !== value && escaped.length <= MAX_LITERAL_CHARS * 2) found.add(escaped)
  }
  for (const [name, value] of Object.entries(env)) {
    // `OPENCODE_PASSWORD`, the server's own credential, matches `PASSWORD`.
    if (SECRET_ENV_NAME.test(name)) add(value)
  }
  for (const value of extra) add(value)
  return [...found].toSorted((a, b) => b.length - a.length).slice(0, MAX_LITERALS)
}

export type ScrubResult =
  | {readonly ok: true; readonly text: string; readonly redactions: number}
  | {readonly ok: false; readonly reason: 'over-input-ceiling' | 'scrub-failed'}

export interface Scrubber {
  readonly scrub: (text: string) => ScrubResult
}

export interface ScrubberOptions {
  /** The plugin's own environment, read once here. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Extra literal secrets, such as the trace credential this plugin was configured with. */
  readonly extraSecrets?: readonly string[]
  readonly limits?: Partial<ContentLimits>
  /** Replaces the pattern list (tests). */
  readonly patterns?: readonly ScrubPattern[]
}

export function createScrubber(options: ScrubberOptions = {}): Scrubber {
  const ceiling = options.limits?.inputCeilingChars ?? DEFAULT_CONTENT_LIMITS.inputCeilingChars
  const literals = collectLiterals(options.env ?? {}, options.extraSecrets)
  const patterns = options.patterns ?? SCRUB_PATTERNS
  return {
    scrub: text => {
      if (text.length > ceiling) return {ok: false, reason: 'over-input-ceiling'}
      try {
        let current = text
        let redactions = 0
        for (const literal of literals) {
          if (!current.includes(literal)) continue
          const parts = current.split(literal)
          redactions += parts.length - 1
          current = parts.join(REDACTION)
        }
        const lower = current.toLowerCase()
        for (const pattern of patterns) {
          const result = pattern.apply(current, lower)
          if (result.count === 0) continue
          current = result.text
          redactions += result.count
          // The case-folded copy no longer matches the text once something was replaced; refresh it for later patterns.
          // (Replacements only remove text that matched, so a stale copy could only over-trigger, never under-trigger.)
        }
        return {ok: true, text: current, redactions}
      } catch {
        return {ok: false, reason: 'scrub-failed'}
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Bounding
// ---------------------------------------------------------------------------------------------------------------------

interface Leaf {
  readonly holder: Record<string, unknown> | unknown[]
  readonly key: string | number
  readonly length: number
}

const MAX_DEPTH = 64

function collectLeaves(root: unknown): Leaf[] {
  const leaves: Leaf[] = []
  const stack: {value: unknown; depth: number}[] = [{value: root, depth: 0}]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined || item.depth > MAX_DEPTH) continue
    const {value, depth} = item
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        if (typeof child === 'string') leaves.push({holder: value, key: index, length: child.length})
        else stack.push({value: child, depth: depth + 1})
      })
    } else if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        const child = record[key]
        if (typeof child === 'string') leaves.push({holder: record, key, length: child.length})
        else stack.push({value: child, depth: depth + 1})
      }
    }
  }
  return leaves
}

const encodedLength = (text: string): number => JSON.stringify(text).length

/** Cuts a string to `keep` characters without splitting a surrogate pair, and says how much was removed. */
function cutString(text: string, keep: number): string {
  let end = Math.max(0, Math.min(keep, text.length))
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd8_00 && last <= 0xdb_ff) end -= 1
  return `${text.slice(0, end)}${TRUNCATION_SUFFIX(text.length - end)}`
}

export interface Bounded {
  readonly json: string
  readonly truncated: boolean
  /** Items dropped from the front of an array (the oldest history), when `dropOldest` applied. */
  readonly dropped: number
}

/**
 * Bounds a parsed value to `maxChars` of JSON. Oldest array items go first when `dropOldest`; then the longest string
 * leaves are cut. Structure is never cut, so the result is always valid JSON. Undefined: the structure alone is over.
 */
export function boundJson(value: unknown, maxChars: number, dropOldest: boolean): Bounded | undefined {
  let json = JSON.stringify(value)
  if (json.length <= maxChars) return {json, truncated: false, dropped: 0}
  let current = value
  let dropped = 0
  if (dropOldest && Array.isArray(value)) {
    const sizes = value.map(item => JSON.stringify(item).length)
    let total = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, sizes.length - 1)
    let first = 0
    while (total > maxChars && sizes.length - first > 1) {
      total -= (sizes[first] ?? 0) + 1
      first += 1
    }
    dropped = first
    current = value.slice(first)
    json = JSON.stringify(current)
    if (json.length <= maxChars) return {json, truncated: dropped > 0, dropped}
  }
  const root = structuredClone(current)
  const leaves = collectLeaves(root).toSorted((a, b) => b.length - a.length)
  let excess = json.length - maxChars
  for (const leaf of leaves) {
    // Leaves are longest first: one this short cannot shrink (the suffix is about as long), and neither can the rest.
    if (excess <= 0 || leaf.length <= TRUNCATION_OVERHEAD * 2) break
    const holder = leaf.holder as Record<string | number, unknown>
    const original = holder[leaf.key]
    if (typeof original !== 'string') continue
    const before = encodedLength(original)
    const keep = Math.max(0, original.length - excess - TRUNCATION_OVERHEAD)
    const cut = cutString(original, keep)
    holder[leaf.key] = cut
    excess -= before - encodedLength(cut)
  }
  json = JSON.stringify(root)
  return json.length <= maxChars ? {json, truncated: true, dropped} : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// The span that is about to be exported
// ---------------------------------------------------------------------------------------------------------------------

/** A content attribute: structured, not yet scrubbed or bounded. `scrubSpan` serializes, scrubs, then bounds it. */
export interface ContentAttribute {
  readonly kind: 'content'
  readonly value: unknown
  readonly maxChars: number
  /** Drop the oldest array items first when over the bound, and say how many. */
  readonly dropOldest?: boolean
}

export const contentAttribute = (value: unknown, maxChars: number, dropOldest = false): ContentAttribute => ({
  kind: 'content',
  value,
  maxChars,
  ...(dropOldest ? {dropOldest} : {}),
})

const isContentAttribute = (value: unknown): value is ContentAttribute =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && (value as {kind?: unknown}).kind === 'content'

export type PlainAttributeValue = string | number | boolean | readonly string[]
export type PendingAttributeValue = PlainAttributeValue | ContentAttribute

export interface PendingSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly kind: 'client' | 'internal'
  readonly startMs: number
  readonly endMs: number
  /** Insertion order is processing order: the span's content budget goes to earlier content attributes first. */
  readonly attributes: Readonly<Record<string, PendingAttributeValue>>
  readonly status: {readonly code: 'unset' | 'error'; readonly message?: string | undefined}
  readonly events: readonly {
    readonly name: string
    readonly timeMs: number
    readonly attributes: Readonly<Record<string, string>>
  }[]
  /** Content the hook-time snapshot could not take, as `attribute:reason`. Carried into the span's omission marker. */
  readonly omitted?: readonly string[]
  /** Items already left out before this point (oldest history over the snapshot's ceiling), per attribute. */
  readonly dropped?: Readonly<Record<string, number>>
}

/** Set only by `scrubSpan`. The exporter takes `ScrubbedSpan`, so a span that skipped the scrubber does not type-check. */
export const scrubbedBrand: unique symbol = Symbol('fro-bot.scrubbed-span')

export interface ScrubbedSpan {
  readonly [scrubbedBrand]: true
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly kind: 'client' | 'internal'
  readonly startMs: number
  readonly endMs: number
  readonly attributes: Readonly<Record<string, string | number | boolean | readonly string[]>>
  readonly status: {readonly code: 'unset' | 'error'; readonly message?: string}
  readonly events: readonly {
    readonly name: string
    readonly timeMs: number
    readonly attributes: Readonly<Record<string, string>>
  }[]
}

/** Marker attribute names. Fixed vocabulary: none reflects content. */
export const MARKER = {
  redactions: 'fro_bot.content.redactions',
  truncated: 'fro_bot.content.truncated',
  omitted: 'fro_bot.content.omitted',
  dropped: (attribute: string): string => `fro_bot.content.dropped.${attribute}`,
} as const

const OMITTED_TEXT = '[omitted]'

interface Tally {
  redactions: number
  readonly truncated: string[]
  readonly omitted: string[]
  readonly dropped: [string, number][]
}

/** Scrubs and bounds a plain string. Omitted (with `[omitted]`) when the scrubber cannot handle it. */
function scrubPlain(text: string, label: string, scrubber: Scrubber, limits: ContentLimits, tally: Tally): string {
  const result = safeScrub(scrubber, text)
  if (!result.ok) {
    tally.omitted.push(`${label}:${result.reason}`)
    return OMITTED_TEXT
  }
  tally.redactions += result.redactions
  if (result.text.length <= limits.plainStringChars) return result.text
  tally.truncated.push(label)
  return cutString(result.text, limits.plainStringChars - TRUNCATION_OVERHEAD)
}

function safeScrub(scrubber: Scrubber, text: string): ScrubResult {
  try {
    return scrubber.scrub(text)
  } catch {
    return {ok: false, reason: 'scrub-failed'}
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Structured redaction
// ---------------------------------------------------------------------------------------------------------------------

/** A key whose name says it holds a credential. Same words as the text patterns. */
const SENSITIVE_KEY = new RegExp(SECRET_WORDS, 'i')
const MAX_KEY_CHARS = 200
/** Nodes visited and depth reached in one structured pass. Past either, the attribute is omitted, not exported. */
const MAX_REDACTION_NODES = 500_000
const MAX_REDACTION_DEPTH = 64
/** A string that is itself JSON is parsed (and re-serialized if anything in it was redacted) up to this length. */
const MAX_EMBEDDED_JSON_CHARS = 256 * 1024

/** Whether a key's value is removed whole. A counter or limit name keeps a number. */
function isSensitiveKey(key: string, value: unknown): boolean {
  const name = key.slice(0, MAX_KEY_CHARS)
  if (!SENSITIVE_KEY.test(name)) return false
  if (isCounterName(name) && (typeof value === 'number' || (typeof value === 'string' && isShortNumber(value))))
    return false
  return true
}

interface RedactionWalk {
  nodes: number
  redactions: number
}

class RedactionBudgetError extends Error {}

function redactValue(value: unknown, depth: number, walk: RedactionWalk): unknown {
  walk.nodes += 1
  if (walk.nodes > MAX_REDACTION_NODES || depth > MAX_REDACTION_DEPTH) throw new RedactionBudgetError()
  if (typeof value === 'string') return redactEmbeddedJson(value, depth, walk)
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1, walk))
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (key === '__proto__') continue
      const child = (value as Record<string, unknown>)[key]
      if (isSensitiveKey(key, child)) {
        walk.redactions += 1
        copy[key] = REDACTION
      } else {
        copy[key] = redactValue(child, depth + 1, walk)
      }
    }
    return copy
  }
  return value
}

/** A string that holds JSON (a tool argument carrying a JSON document): its sensitive keys are removed too, at any depth. */
function redactEmbeddedJson(text: string, depth: number, walk: RedactionWalk): string {
  if (text.length < 2 || text.length > MAX_EMBEDDED_JSON_CHARS) return text
  const first = text.trimStart()[0]
  if (first !== '{' && first !== '[') return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (typeof parsed !== 'object' || parsed === null) return text
  const before = walk.redactions
  const redacted = redactValue(parsed, depth + 1, walk)
  return walk.redactions === before ? text : JSON.stringify(redacted)
}

/**
 * Removes the entire value of every key whose name says it is a credential, at any depth, whatever its type (string,
 * number, array, object, boolean, null), including inside a string that holds JSON. Runs before the text patterns, which
 * only ever see what is left. Undefined when the structure is too large or deep to walk: the caller omits the attribute.
 */
export function redactSensitiveKeys(value: unknown): {readonly value: unknown; readonly count: number} | undefined {
  const walk: RedactionWalk = {nodes: 0, redactions: 0}
  try {
    const redacted = redactValue(value, 0, walk)
    return {value: redacted, count: walk.redactions}
  } catch {
    return undefined
  }
}

function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/**
 * The only path to export. Scrubs every string of `span`, bounds content, and returns a span the exporter accepts.
 * Never throws and never lets a raw value through: what cannot be scrubbed is replaced by `[omitted]` or dropped, and
 * the span says so in marker attributes.
 */
export function scrubSpan(
  span: PendingSpan,
  scrubber: Scrubber,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): ScrubbedSpan {
  const tally: Tally = {redactions: 0, truncated: [], omitted: [...(span.omitted ?? [])], dropped: []}
  let budget = limits.spanContentChars
  const attributes: Record<string, string | number | boolean | readonly string[]> = {}

  for (const [name, value] of Object.entries(span.attributes)) {
    if (isContentAttribute(value)) {
      const walked = redactSensitiveKeys(value.value)
      if (walked === undefined) {
        // Too large or too deep to walk, or not serializable at all (a cycle shows up as depth): say which.
        tally.omitted.push(`${name}:${serialize(value.value) === undefined ? 'unserializable' : 'scrub-failed'}`)
        continue
      }
      tally.redactions += walked.count
      const json = serialize(walked.value)
      if (json === undefined) {
        tally.omitted.push(`${name}:unserializable`)
        continue
      }
      const scrubbed = safeScrub(scrubber, json)
      if (!scrubbed.ok) {
        tally.omitted.push(`${name}:${scrubbed.reason}`)
        continue
      }
      tally.redactions += scrubbed.redactions
      let parsed: unknown
      try {
        parsed = JSON.parse(scrubbed.text)
      } catch {
        // A replacement broke the JSON: omit rather than export text that does not parse.
        tally.omitted.push(`${name}:scrub-failed`)
        continue
      }
      const bounded = boundJson(parsed, Math.min(value.maxChars, Math.max(0, budget)), value.dropOldest === true)
      if (bounded === undefined) {
        tally.omitted.push(`${name}:over-budget`)
        continue
      }
      budget -= bounded.json.length
      if (bounded.truncated) tally.truncated.push(name)
      const before = span.dropped?.[name] ?? 0
      if (bounded.dropped > 0 || before > 0) tally.dropped.push([name, bounded.dropped + before])
      attributes[name] = bounded.json
    } else if (typeof value === 'string') {
      attributes[name] = scrubPlain(value, name, scrubber, limits, tally)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      attributes[name] = value
    } else {
      attributes[name] = value.map(item => scrubPlain(item, name, scrubber, limits, tally))
    }
  }

  const name = scrubPlain(span.name, 'name', scrubber, limits, tally)
  const statusMessage =
    span.status.message === undefined ? undefined : scrubPlain(span.status.message, 'status', scrubber, limits, tally)
  const events = span.events.map(event => ({
    name: event.name,
    timeMs: event.timeMs,
    attributes: Object.fromEntries(
      Object.entries(event.attributes).map(([key, text]) => [
        key,
        scrubPlain(text, `event.${key}`, scrubber, limits, tally),
      ]),
    ),
  }))

  if (tally.redactions > 0) attributes[MARKER.redactions] = tally.redactions
  if (tally.truncated.length > 0) attributes[MARKER.truncated] = tally.truncated
  if (tally.omitted.length > 0) attributes[MARKER.omitted] = tally.omitted
  for (const [attribute, count] of tally.dropped) attributes[MARKER.dropped(attribute)] = count

  return {
    [scrubbedBrand]: true,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name,
    kind: span.kind,
    startMs: span.startMs,
    endMs: span.endMs,
    attributes,
    status: statusMessage === undefined ? {code: span.status.code} : {code: span.status.code, message: statusMessage},
    events,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Extraction by named field
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** `gen_ai.system_instructions`: `[{type: 'text', content}]`. Takes each part's `text` and nothing else (no metadata). */
export function extractSystemInstructions(system: unknown): {type: 'text'; content: string}[] | undefined {
  if (!Array.isArray(system)) return undefined
  const parts: {type: 'text'; content: string}[] = []
  for (const part of system) {
    const text = isRecord(part) ? asString(part.text) : undefined
    if (text !== undefined) parts.push({type: 'text', content: text})
  }
  return parts.length === 0 ? undefined : parts
}

export interface MessageExtraction {
  readonly messages: readonly Json[]
  /** Parts that were attachments or of a kind this plugin does not read, counted, never serialized. */
  readonly omittedParts: number
}

/** The value of a tool result part as the spec's `response`: text for `text` and `content`, the value for `json`. */
function responseOf(result: unknown): unknown {
  if (!isRecord(result)) return result
  const value = result.value
  if (result.type === 'content' && Array.isArray(value)) {
    return value
      .map(item => {
        if (!isRecord(item)) return ''
        if (item.type === 'text') return asString(item.text) ?? ''
        return `[file: ${asString(item.name) ?? asString(item.mime) ?? 'attachment'}]`
      })
      .join('\n')
  }
  return value
}

function messagePart(part: unknown): {part?: Json; omitted: boolean} {
  if (!isRecord(part)) return {omitted: true}
  switch (part.type) {
    case 'text': {
      const text = asString(part.text)
      return text === undefined ? {omitted: true} : {part: {type: 'text', content: text}, omitted: false}
    }
    case 'reasoning': {
      const text = asString(part.text)
      return text === undefined ? {omitted: true} : {part: {type: 'reasoning', content: text}, omitted: false}
    }
    case 'tool-call':
      return {
        part: {
          type: 'tool_call',
          id: asString(part.id) ?? null,
          name: asString(part.name) ?? 'unknown',
          arguments: part.input,
        },
        omitted: false,
      }
    case 'tool-result':
      return {
        part: {type: 'tool_call_response', id: asString(part.id) ?? null, response: responseOf(part.result)},
        omitted: false,
      }
    default:
      // media, files and anything unknown: not serialized.
      return {omitted: true}
  }
}

/** `gen_ai.input.messages`: role and parts of each message, by named field. */
export function extractInputMessages(messages: unknown): MessageExtraction | undefined {
  if (!Array.isArray(messages)) return undefined
  const out: Json[] = []
  let omittedParts = 0
  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = asString(message.role)
    if (role === undefined) continue
    const content = message.content
    const rawParts =
      typeof content === 'string' ? [{type: 'text', text: content}] : Array.isArray(content) ? content : []
    const parts: Json[] = []
    for (const raw of rawParts) {
      const {part, omitted} = messagePart(raw)
      if (part !== undefined) parts.push(part)
      if (omitted) omittedParts += 1
    }
    out.push({role, parts})
  }
  return {messages: out, omittedParts}
}

/** `gen_ai.tool.definitions`: `[{type: 'function', name, description, parameters}]`. */
export function extractToolDefinitions(tools: unknown): Json[] | undefined {
  if (!isRecord(tools)) return undefined
  const names = Object.keys(tools)
  if (names.length === 0) return undefined
  return names.map(name => {
    const tool = tools[name]
    const description = isRecord(tool) ? asString(tool.description) : undefined
    const parameters = isRecord(tool) && isRecord(tool.input) ? tool.input : undefined
    return {
      type: 'function',
      name,
      ...(description === undefined ? {} : {description}),
      ...(parameters === undefined ? {} : {parameters}),
    }
  })
}

/** `gen_ai.tool.call.arguments`: an object. A string is parsed; anything else is wrapped as `{value}`. */
export function extractToolArguments(input: unknown): Json | undefined {
  if (input === undefined) return undefined
  if (isRecord(input)) return input
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      if (isRecord(parsed)) return parsed
    } catch {
      // Not JSON: wrapped below.
    }
  }
  return {value: input}
}

export interface ToolResultExtraction {
  readonly value: Json
  /** The tool reported that it cut its own output. */
  readonly ownTruncation: boolean
}

/**
 * `gen_ai.tool.call.result`: the content the model saw, `{content: [...]}` (files by name and type only, never their
 * location), or `{output}` for a tool that returned only structured output. Metadata is not captured; only its
 * `truncated` flag, as a marker.
 */
export function extractToolResult(result: unknown): ToolResultExtraction | undefined {
  if (!isRecord(result)) return undefined
  const metadata = isRecord(result.metadata) ? result.metadata : undefined
  const ownTruncation = metadata?.truncated === true
  const content = result.content
  if (typeof content === 'string') return {value: {content: [{type: 'text', text: content}]}, ownTruncation}
  if (Array.isArray(content)) {
    const parts = content.flatMap((item): Json[] => {
      if (!isRecord(item)) return []
      if (item.type === 'text') return [{type: 'text', text: asString(item.text) ?? ''}]
      if (item.type === 'file') {
        const name = asString(item.name)
        return [
          {
            type: 'file',
            mime: asString(item.mime) ?? 'application/octet-stream',
            ...(name === undefined ? {} : {name}),
          },
        ]
      }
      return []
    })
    return {value: {content: parts}, ownTruncation}
  }
  if (result.output !== undefined) return {value: {output: result.output}, ownTruncation}
  return undefined
}

export interface OutputInput {
  readonly texts: readonly string[]
  readonly reasoning: readonly string[]
  readonly toolCalls: readonly {readonly callId: string; readonly tool: string; readonly input?: unknown}[]
}

/** `gen_ai.output.messages`: one assistant message with reasoning, text and the tool calls the response asked for. */
export function extractOutputMessages(output: OutputInput): Json[] | undefined {
  const parts: Json[] = [
    ...output.reasoning.map(content => ({type: 'reasoning', content})),
    ...output.texts.map(content => ({type: 'text', content})),
    ...output.toolCalls.map(call => ({
      type: 'tool_call',
      id: call.callId,
      name: call.tool,
      arguments: extractToolArguments(call.input) ?? null,
    })),
  ]
  return parts.length === 0 ? undefined : [{role: 'assistant', parts}]
}

/** A user prompt's `text`, as an input message. Attachments are not read. */
export function extractPromptMessage(prompt: unknown): Json | undefined {
  const text = isRecord(prompt) ? asString(prompt.text) : undefined
  return text === undefined ? undefined : {role: 'user', parts: [{type: 'text', content: text}]}
}

/** Identity the Action supplies, as the attributes every span of its runs carries. */
export const actionIdentityAttributes = (identity: ActionIdentity): Record<string, string> => ({
  'fro_bot.repository': identity.repository,
  'fro_bot.run.id': identity.runId,
  'fro_bot.run.attempt': identity.attempt,
  'fro_bot.job': identity.job,
  'fro_bot.trigger': identity.trigger,
})
