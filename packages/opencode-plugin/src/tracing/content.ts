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
 * The design that makes it safe to extend: every text rule is a pure matcher over the ORIGINAL string that only reports
 * ranges (`ScrubMatcher`); `scrubWithMatchers` unites all ranges and builds the output once. No rule ever reads text another
 * rule rewrote, so rule order cannot matter (`content.order.test.ts` proves it). Structured content is walked once
 * (`scrubStructured`): sensitive-named keys go whole, every other string is scrubbed from its original text, and the result is
 * serialized, never scanned again.
 *
 * Plain functions only: no SDK, no I/O, no clock. Every matcher is linear-time (no nested quantifier, no backreference,
 * no adjacent unbounded quantifiers) and the union is a sort bounded by `MAX_RANGES`; `content.test.ts` times each on its own
 * adversarial input.
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

/**
 * A text rule. A pure matcher over the ORIGINAL, unmodified string: it reports each range `[start, end)` it would redact
 * through `emit`, and nothing else. It never reads another matcher's output, never rewrites text and never needs to
 * recognise the redaction marker, so the order matchers run in cannot change what is removed (`scrubWithMatchers`).
 */
export interface ScrubMatcher {
  /** The rule's name: used in tests and nowhere in output (a marker never names the rule that matched). */
  readonly id: string
  /** `lower` is `text` case-folded once, for cheap needle checks. Ranges may arrive in any order and may overlap. */
  readonly find: (text: string, lower: string, emit: Emit) => void
}

export type Emit = (start: number, end: number) => void

export interface Range {
  readonly start: number
  readonly end: number
}

/** Ranges one value may produce before it is omitted instead of scanned further. Bounds memory and the merge's sort. */
export const MAX_RANGES = 50_000

class TooManyRangesError extends Error {}

/** Calls `matcher` and returns the ranges it reports, uncapped. For tests and tools: `scrubWithMatchers` caps them. */
export function matchRanges(matcher: ScrubMatcher, text: string): Range[] {
  const found: Range[] = []
  matcher.find(text, text.toLowerCase(), (start, end) => {
    found.push({start, end})
  })
  return found
}

/**
 * Reports every match of `regex` (a global regex, reset before use) as the range `rangeOf` picks out of it. Skips the scan
 * when none of `needles` occur (case-folded). `rangeOf` returns the part to redact: a token whole, or only the value
 * after a name or a scheme word that stays visible.
 */
function regexMatcher(
  id: string,
  regex: RegExp,
  rangeOf: (match: RegExpExecArray, text: string) => Range,
  needles?: readonly string[],
): ScrubMatcher {
  return {
    id,
    find: (text, lower, emit) => {
      if (needles !== undefined && !needles.some(needle => lower.includes(needle))) return
      regex.lastIndex = 0
      for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
        const range = rangeOf(match, text)
        emit(range.start, range.end)
      }
    },
  }
}

const wholeMatch = (match: RegExpExecArray): Range => ({start: match.index, end: match.index + match[0].length})

/**
 * A private-key block: from its header to its end line, or, when the tool cut the block short, to the end of the string
 * value (the next `"`) or of the text. Found by header regex and `indexOf`, never by a lazy match across the body.
 */
function pemMatcher(): ScrubMatcher {
  const header = /-----BEGIN [A-Z0-9 ]{0,40}(?:PRIVATE KEY|KEY BLOCK)-----/g
  return {
    id: 'pem-private-key',
    find: (text, lower, emit) => {
      if (!lower.includes('-----begin ')) return
      header.lastIndex = 0
      // The next end line and the next quote are searched forward once and only moved when a header passes them, so a
      // text of many headers and no end line costs one scan, not one per header.
      let nextEnd = text.indexOf('-----END ')
      let nextQuote = text.indexOf('"')
      let covered = 0
      for (;;) {
        const match = header.exec(text)
        if (match === null) break
        const from = match.index
        // A header inside a block already reported: the block covers it.
        if (from < covered) continue
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
        emit(from, stop)
        covered = stop
        header.lastIndex = Math.max(stop, header.lastIndex)
      }
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
function jwtMatcher(): ScrubMatcher {
  return {
    id: 'jwt',
    find: (text, lower, emit) => {
      if (!lower.includes('eyj')) return
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
        emit(start, signatureEnd)
        from = signatureEnd
      }
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

/** Where an unquoted value that starts at `from` ends: at the first delimiter. */
function unquotedEnd(text: string, from: number): number {
  let end = from
  while (end < text.length && !UNQUOTED_STOP.has(text.charCodeAt(end))) end += 1
  return end
}

const SCHEME_WORD = /^(?:bearer|basic|token|digest)$/i

/**
 * `Authorization: Bearer <credential>`: when an assignment's first token is a scheme word, the value is the scheme AND the
 * credential after it (up to eight blanks, then the next token). This is the rule's own boundary, read from the original
 * text; the scheme rule (`auth-scheme-value`) finds the same credential on its own and the two ranges are united.
 */
function schemeCredentialEnd(text: string, end: number): number {
  let index = end
  while (index < text.length && index - end < 8 && (text.charCodeAt(index) === 0x20 || text.charCodeAt(index) === 0x09))
    index += 1
  if (index === end) return end
  const tokenEnd = unquotedEnd(text, index)
  return tokenEnd === index ? end : tokenEnd
}

/**
 * `name=value` and `name: value`, in plain text and in JSON text (`\"name\": \"value\"`): the range is the value. The match
 * starts at the secret word itself, every gap is a bounded class, and the value is then read by hand, once, forward:
 * - a quoted value runs to its closing quote, honouring escapes (in an escaped layer, `\"` closes and `\\\"` does not); if
 *   no closing quote is found within `MAX_QUOTED_VALUE_CHARS` it runs to the end of the line;
 * - an unquoted value is a run of non-delimiter characters (the first token only), plus the credential after a scheme word;
 * - a number of up to eight digits survives only after a counter or limit name (`max_tokens: 8000`), never after a name that
 *   says password, secret, credential or authorization.
 * Scanning resumes after the value, so no character is scanned more than a bounded number of times.
 */
function nameValueMatcher(): ScrubMatcher {
  const prefix = new RegExp(
    // The quote around a name or a value may sit in an escaped layer: any run of backslashes (JSON in JSON in JSON) before it.
    String.raw`((?:${SECRET_WORDS})[\w.-]{0,20})(?:\\{0,15}["'])?[ \t]{0,4}[:=][ \t]{0,4}(\\{0,15}["'])?`,
    'gi',
  )
  return {
    id: 'name-value-pair',
    find: (text, lower, emit) => {
      if (!SECRET_NEEDLES.some(needle => lower.includes(needle))) return
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
          if (SCHEME_WORD.test(text.slice(valueStart, valueEnd))) valueEnd = schemeCredentialEnd(text, valueEnd)
          const value = text.slice(valueStart, valueEnd)
          if (counter && isShortNumber(value)) continue
          // A counter name keeps the old floor of three characters; a credential name has none.
          if (value.length < (counter ? 3 : 1)) continue
        } else {
          valueEnd = closingQuote(text, valueStart, opener)
          if (valueEnd === valueStart) continue
        }
        emit(valueStart, valueEnd)
        prefix.lastIndex = Math.max(prefix.lastIndex, valueEnd)
      }
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

/** Where the value starts after a scheme word and its blanks: the scheme word stays visible. */
const afterScheme = (match: RegExpExecArray, text: string): Range => {
  let start = match.index + (match[1] ?? match[2] ?? '').length
  while (text.charCodeAt(start) === 0x20 || text.charCodeAt(start) === 0x09) start += 1
  return {start, end: match.index + match[0].length}
}

/**
 * The text rules. Each is a pure matcher over the original string; the list's order carries no meaning (`scrubWithMatchers`
 * takes the union of every range), and `content.test.ts` runs it in other orders to show that.
 */
export const SCRUB_PATTERNS: readonly ScrubMatcher[] = [
  pemMatcher(),
  regexMatcher('github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_\w{22,255})\b/g, wholeMatch, [
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
  ]),
  regexMatcher(
    'aws-access-key-id',
    /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    wholeMatch,
    ['akia', 'asia', 'agpa', 'aida', 'aroa', 'anpa', 'anva', 'abia', 'acca'],
  ),
  regexMatcher(
    'vendor-key-prefix',
    /\b(?:sk-[\w-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[\w-]{35}|hf_[A-Za-z0-9]{30,}|pplx-[A-Za-z0-9]{30,}|fw_[A-Za-z0-9]{20,}|nvapi-[\w-]{30,}|npm_[A-Za-z0-9]{36}|glpat-[\w-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|SG\.[\w-]{16,}\.[\w-]{16,}|ya29\.[\w-]{20,}|r8_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{40,})/g,
    wholeMatch,
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
  jwtMatcher(),
  // `Bearer` is a credential marker on its own; the other schemes are also English words, so their value must contain a
  // digit or a base64 or token punctuation character. The scheme word stays visible: the range is the credential.
  regexMatcher(
    'auth-scheme-value',
    /\b(?:(Bearer)[ \t]{1,8}[\w.~+/=-]{8,}|(Basic|Token|Digest)[ \t]{1,8}(?=[\w.~+/=-]*[\d._~+/=-])[\w.~+/=-]{8,})/gi,
    afterScheme,
    ['bearer', 'basic', 'token', 'digest'],
  ),
  regexMatcher(
    'connection-string',
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|clickhouse|cockroachdb):\/\/[^\s"'<>\\]{3,}/gi,
    wholeMatch,
    ['postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'amqp', 'mssql', 'sqlserver', 'clickhouse', 'cockroachdb'],
  ),
  // `scheme://user:password@host`: the range is the userinfo; the scheme and the `@` stay.
  regexMatcher(
    'url-userinfo',
    URL_USERINFO,
    match => ({start: match.index + (match[1] ?? '').length, end: match.index + match[0].length - 1}),
    ['://'],
  ),
  // `?name=value`: the range is the value; the name stays.
  regexMatcher(
    'url-query-secret',
    QUERY_SECRET,
    match => ({start: match.index + (match[1] ?? '').length, end: match.index + match[0].length}),
    ['pass', 'pwd', 'secret', 'token', 'key', 'credential', 'authorization', 'signature', 'bearer', 'sig='],
  ),
  nameValueMatcher(),
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

/**
 * The environment's literal secrets as a matcher: every occurrence of each, overlapping ones included (the union covers a
 * secret that overlaps itself or another). The literals were collected once at start; they are never named.
 */
export function literalMatcher(literals: readonly string[]): ScrubMatcher {
  return {
    id: 'environment-literal',
    find: (text, _lower, emit) => {
      for (const literal of literals) {
        for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + 1))
          emit(at, at + literal.length)
      }
    },
  }
}

export type ScrubResult =
  | {readonly ok: true; readonly text: string; readonly redactions: number}
  | {readonly ok: false; readonly reason: 'over-input-ceiling' | 'scrub-failed' | 'too-many-ranges'}

export interface Scrubber {
  /** Scrubs one string: the ORIGINAL text in, text with each united range replaced by one marker out. */
  readonly scrub: (text: string) => ScrubResult
  /** The longest string `scrub` accepts; a content attribute whose serialization is longer is omitted unscanned. */
  readonly inputCeilingChars?: number
}

export interface ScrubberOptions {
  /** The plugin's own environment, read once here. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Extra literal secrets, such as the trace credential this plugin was configured with. */
  readonly extraSecrets?: readonly string[]
  readonly limits?: Partial<ContentLimits>
  /** Replaces the text rules (tests). The environment's literals are always matched as well. */
  readonly patterns?: readonly ScrubMatcher[]
}

const isHighSurrogate = (code: number): boolean => code >= 0xd8_00 && code <= 0xdb_ff
const isLowSurrogate = (code: number): boolean => code >= 0xdc_00 && code <= 0xdf_ff

/**
 * The scrub, in one step. Every matcher reads the same original `text`; their ranges are collected, sorted, united (ranges
 * that overlap or touch become one) and the output is built in a single left-to-right pass with one marker per united
 * range. Nothing is ever matched against text a marker was put into, so the result is the same whatever order `matchers`
 * are in, and no rule can make another skip or split a match.
 *
 * The redaction count is the number of united ranges (markers in the output): a range several rules contributed to counts once.
 * A range edge that falls inside a surrogate pair moves outward to the pair's edge, so a lone half is never left behind.
 * Throws `TooManyRangesError` past `MAX_RANGES`: the caller omits the value rather than scan on.
 */
export function scrubWithMatchers(
  text: string,
  matchers: readonly ScrubMatcher[],
): {readonly text: string; readonly redactions: number} {
  const lower = text.toLowerCase()
  const starts: number[] = []
  const ends: number[] = []
  const emit: Emit = (start, end) => {
    if (end <= start) return
    if (starts.length >= MAX_RANGES) throw new TooManyRangesError()
    starts.push(Math.max(0, start))
    ends.push(Math.min(text.length, end))
  }
  for (const matcher of matchers) matcher.find(text, lower, emit)
  if (starts.length === 0) return {text, redactions: 0}

  const order = starts.map((_start, index) => index).toSorted((a, b) => (starts[a] ?? 0) - (starts[b] ?? 0))
  let out = ''
  let cursor = 0
  let redactions = 0
  let index = 0
  while (index < order.length) {
    const first = order[index] ?? 0
    let start = starts[first] ?? 0
    let end = ends[first] ?? 0
    index += 1
    // Unite everything that overlaps or touches.
    while (index < order.length && (starts[order[index] ?? 0] ?? 0) <= end) {
      end = Math.max(end, ends[order[index] ?? 0] ?? 0)
      index += 1
    }
    if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end += 1
    // A pair-edge move can make this range reach back into the previous one: continue from where that ended.
    if (start < cursor) start = cursor
    out += text.slice(cursor, start) + REDACTION
    cursor = end
    redactions += 1
  }
  return {text: out + text.slice(cursor), redactions}
}

export function createScrubber(options: ScrubberOptions = {}): Scrubber {
  const ceiling = options.limits?.inputCeilingChars ?? DEFAULT_CONTENT_LIMITS.inputCeilingChars
  const matchers = [
    ...(options.patterns ?? SCRUB_PATTERNS),
    literalMatcher(collectLiterals(options.env ?? {}, options.extraSecrets)),
  ]
  return {
    inputCeilingChars: ceiling,
    scrub: text => {
      if (text.length > ceiling) return {ok: false, reason: 'over-input-ceiling'}
      try {
        return {ok: true, ...scrubWithMatchers(text, matchers)}
      } catch (error) {
        return {ok: false, reason: error instanceof TooManyRangesError ? 'too-many-ranges' : 'scrub-failed'}
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

/** A key whose name says it holds a credential. Same words as the text rules. */
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

interface TreeWalk {
  nodes: number
  redactions: number
}

type TreeFailureReason = 'over-input-ceiling' | 'scrub-failed' | 'too-many-ranges'

class TreeFailure extends Error {
  readonly reason: TreeFailureReason
  constructor(reason: TreeFailureReason) {
    super(reason)
    this.reason = reason
  }
}

/** One string of the structure, scrubbed once, from its original text. A failure fails the whole attribute. */
function scrubLeaf(text: string, scrubber: Scrubber, walk: TreeWalk): string {
  const result = safeScrub(scrubber, text)
  if (!result.ok) throw new TreeFailure(result.reason)
  walk.redactions += result.redactions
  return result.text
}

function scrubNode(value: unknown, depth: number, scrubber: Scrubber, walk: TreeWalk): unknown {
  walk.nodes += 1
  if (walk.nodes > MAX_REDACTION_NODES || depth > MAX_REDACTION_DEPTH) throw new TreeFailure('scrub-failed')
  if (typeof value === 'string') return scrubString(value, depth, scrubber, walk)
  if (Array.isArray(value)) return value.map(item => scrubNode(item, depth + 1, scrubber, walk))
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (key === '__proto__') continue
      const child = (value as Record<string, unknown>)[key]
      if (isSensitiveKey(key, child)) {
        // The whole value goes, whatever its type; nothing inside it is read, and the marker is never scanned.
        walk.redactions += 1
        copy[scrubLeaf(key, scrubber, walk)] = REDACTION
      } else {
        copy[scrubLeaf(key, scrubber, walk)] = scrubNode(child, depth + 1, scrubber, walk)
      }
    }
    return copy
  }
  return value
}

/**
 * A string leaf. When it holds a JSON document (a tool argument carrying one) it is parsed and walked like any other part
 * of the structure, so its sensitive keys go whole and each of its own string leaves is scrubbed from its original text; if
 * anything in it was redacted it is written back as the compact serialization of those already-scrubbed parts, and that
 * text is NOT scanned again. Otherwise (not JSON, truncated JSON, a bare string) the text matchers read the original string.
 */
function scrubString(text: string, depth: number, scrubber: Scrubber, walk: TreeWalk): string {
  const parsed = parseEmbeddedJson(text)
  if (parsed === undefined) return scrubLeaf(text, scrubber, walk)
  const before = walk.redactions
  const inner = scrubNode(parsed, depth + 1, scrubber, walk)
  return walk.redactions === before ? text : JSON.stringify(inner)
}

function parseEmbeddedJson(text: string): object | undefined {
  if (text.length < 2 || text.length > MAX_EMBEDDED_JSON_CHARS) return undefined
  const first = text.trimStart()[0]
  if (first !== '{' && first !== '[') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Scrubs a structured value in ONE walk. Sensitive-named keys have their entire value replaced, whatever its type, at any
 * depth, including inside strings that hold JSON; every other string (and every key) goes through the text matchers once,
 * from its original text. The two never feed each other: a marker the walk inserts is a node of the output tree, built from
 * the original, and no matcher ever reads it, so a marker cannot hide a match or split one. The caller serializes the result
 * and does not scan that text again.
 */
export function scrubStructured(
  value: unknown,
  scrubber: Scrubber,
):
  | {readonly ok: true; readonly value: unknown; readonly redactions: number}
  | {readonly ok: false; readonly reason: TreeFailureReason} {
  const walk: TreeWalk = {nodes: 0, redactions: 0}
  try {
    return {ok: true, value: scrubNode(value, 0, scrubber, walk), redactions: walk.redactions}
  } catch (error) {
    return {ok: false, reason: error instanceof TreeFailure ? error.reason : 'scrub-failed'}
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
      // The serialization of the ORIGINAL value, for the ceiling and to catch what cannot be serialized at all.
      const original = serialize(value.value)
      if (original === undefined) {
        tally.omitted.push(`${name}:unserializable`)
        continue
      }
      if (original.length > (scrubber.inputCeilingChars ?? limits.inputCeilingChars)) {
        tally.omitted.push(`${name}:over-input-ceiling`)
        continue
      }
      const walked = scrubStructured(value.value, scrubber)
      if (!walked.ok) {
        tally.omitted.push(`${name}:${walked.reason}`)
        continue
      }
      tally.redactions += walked.redactions
      // Already scrubbed, leaf by leaf: only serialized here, to bound it, never scanned.
      const json = serialize(walked.value)
      if (json === undefined) {
        tally.omitted.push(`${name}:unserializable`)
        continue
      }
      const parsed: unknown = JSON.parse(json)
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
