/**
 * The shared scrubber: scrubbing, bounding, and the one function that makes a span exportable.
 *
 * The OpenCode plugin and the Action both use this module (the plugin bundles it inline; see the plugin's `tsdown.config.ts`).
 * Extracting content from OpenCode data is not here: it stays in the plugin, which hands this module spans to scrub.
 *
 * `scrubSpan` is the only way to produce a `ScrubbedSpan`, and the exporter takes nothing else. It scrubs every string of
 * a finished span (attribute values, name, status message, event text) and, for content attributes, scrubs the whole
 * serialized value BEFORE bounding it, so a secret that straddles a cut is already gone. A value over the input ceiling,
 * or one the scrubber fails on, is omitted with a marker, never exported raw.
 *
 * Scrubbing is best-effort: it removes the secret shapes listed in `SCRUB_PATTERNS` and the values of the caller's own
 * secret-named environment variables. It does not find a secret that has no recognizable shape.
 *
 * The design that makes it safe to extend: every text rule is a pure matcher over the ORIGINAL string that only reports
 * ranges (`ScrubMatcher`); `scrubWithMatchers` unites all ranges and builds the output once. No rule ever reads text another
 * rule rewrote, so rule order cannot matter (`scrub.order.test.ts` proves it). Structured content is walked once
 * (`scrubStructured`): sensitive-named keys go whole, every other string is scrubbed from its original text, and the result is
 * serialized, never scanned again.
 *
 * Plain functions only: no SDK, no I/O, no clock. Every matcher is linear-time (no nested quantifier, no backreference,
 * no adjacent unbounded quantifiers) and the union is a sort bounded by `MAX_RANGES`; `scrub.test.ts` times each on its own
 * adversarial input.
 */

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

/**
 * The attributes that carry captured content (the model's input, output, instructions and tool definitions, and a call's
 * arguments and result), as `genai-attributes.ts` sets them. The exporter may omit one of these, and only these, to bring an
 * oversized span under the collector's body limit; identity, outcome, marker and every other attribute is never a candidate.
 */
export const CONTENT_ATTRIBUTE_NAMES = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
] as const

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
  /**
   * `lower` is `text` case-folded once, for cheap needle checks. Ranges may arrive in any order and may overlap. `withhold` is the
   * one fail-closed signal: a matcher that has recognised a secret but cannot establish where it ends calls it, and the whole
   * string is withheld (`sensitive-value-unbounded`), never redacted "up to" a guess.
   */
  readonly find: (text: string, lower: string, emit: Emit, withhold: Withhold) => void
}

export type Emit = (start: number, end: number) => void
export type Withhold = () => void

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
  matcher.find(
    text,
    text.toLowerCase(),
    (start, end) => {
      found.push({start, end})
    },
    () => {},
  )
  return found
}

/** Whether `matcher` withholds `text` (it recognised a secret and could not establish where its value ends). */
export function matchWithholds(matcher: ScrubMatcher, text: string): boolean {
  let withheld = false
  matcher.find(
    text,
    text.toLowerCase(),
    () => {},
    () => {
      withheld = true
    },
  )
  return withheld
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
/** A key whose name says it holds a credential. Same words as the text rules. */
const SENSITIVE_KEY = new RegExp(SECRET_WORDS, 'i')
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

/** The number of JSON-string encodings a document is under, from the backslash run before its first quote: `2^d - 1`; -1 if it is not of that form. */
function layersOfRun(run: number): number {
  for (let candidate = 0; candidate <= 4; candidate += 1) if (run === 2 ** candidate - 1) return candidate
  return -1
}

/** The most whitespace (real or escaped, newlines included) allowed between a QUOTED key's colon and its value. */
const MAX_GAP_CHARS = 256

/**
 * The whitespace between a quoted key's `:` and its value, from `from`: spaces, tabs, line feeds and carriage returns, and, for a
 * document under `layers` JSON encodings, the escaped forms a serializer writes for them there (`\n`, `\r`, `\t` after
 * `2^(layers-1)` backslashes: one at depth 1, two at depth 2, four at depth 3). Returns where the value starts and whether the
 * whitespace was longer than `MAX_GAP_CHARS` (the caller then fails closed: it cannot tell where the value is, so the rest of the
 * line goes). One forward scan; the caller continues after it.
 */
function skipGap(text: string, from: number, layers: number): {readonly end: number; readonly over: boolean} {
  const escapedRun = layers >= 1 ? 2 ** (layers - 1) : 0
  let index = from
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      index += 1
    } else if (code === 0x5c && escapedRun > 0) {
      let run = 1
      while (run <= escapedRun && text.charCodeAt(index + run) === 0x5c) run += 1
      const next = text.charCodeAt(index + run)
      if (run === escapedRun && (next === 0x6e || next === 0x72 || next === 0x74)) index += run + 1
      else break
    } else {
      break
    }
  }
  return {end: index, over: index - from > MAX_GAP_CHARS}
}

/** The most a bracketed value (`{...}` or `[...]`) is scanned for its balanced close. Past it the end is not established and the string is withheld. */
const MAX_STRUCTURE_VALUE_CHARS = 256 * 1024

/** The deepest bracket nesting the scan follows. Deeper, the end of the value is not established and the string is withheld. */
const MAX_BRACKET_DEPTH = 64

/**
 * A value that begins with `{` or `[`, read by one forward scan to its balanced close: brackets count outside strings only, each
 * closer must be the one the innermost open bracket expects (`}` for `{`, `]` for `[`), a string ends at its own closing quote,
 * and quotes are read at the escape depth the document is written in. Returns the index after the close, or -1 when there is
 * none within `MAX_STRUCTURE_VALUE_CHARS` or the shared `budget`, a closer does not match, or the nesting is deeper than
 * `MAX_BRACKET_DEPTH` (then the caller withholds the string). `budget.left` is the work all such scans of one text may do together, so a text of many
 * unterminated openers costs a constant multiple of its length, not a scan each.
 *
 * Escape depth: the first quote inside the value is preceded by `r` backslashes, and `r = 2^d - 1` for a document encoded `d`
 * times as a JSON string (0, 1, 3, 7, ...). A quote after a run `n` is a delimiter when peeling `d` layers off `n`
 * (`n = 2m + 1` each time) leaves an even run, and an escaped quote when it leaves an odd one. A first run that is not of that
 * form is not a document the scan can read: -1.
 */
function structureEnd(text: string, from: number, budget: {left: number}): number {
  const limit = Math.min(text.length, from + MAX_STRUCTURE_VALUE_CHARS)
  let layers = -1
  // The closer each open bracket expects, innermost last: `}` (0x7d) for `{`, `]` (0x5d) for `[`.
  const expected = new Uint8Array(MAX_BRACKET_DEPTH)
  let depth = 0
  /** Whether a quote after `run` backslashes delimits a string (true) or is escaped inside one (false); undefined: not at this depth. */
  const delimits = (run: number): boolean | undefined => {
    let remaining = run
    for (let layer = 0; layer < layers; layer += 1) {
      if (remaining % 2 === 0) return undefined
      remaining = (remaining - 1) / 2
    }
    return remaining % 2 === 0
  }
  let index = from
  let inString = false
  while (index < limit) {
    budget.left -= 1
    if (budget.left < 0) return -1
    const code = text.charCodeAt(index)
    if (code === 0x5c) {
      let run = 1
      while (text.charCodeAt(index + run) === 0x5c) run += 1
      if (text.charCodeAt(index + run) === 0x22) {
        if (layers === -1) {
          layers = layersOfRun(run)
          if (layers === -1) return -1
        }
        const delimiter = delimits(run)
        if (delimiter === true) inString = !inString
        index += run + 1
        budget.left -= run
        continue
      }
      index += run
      budget.left -= run
      continue
    }
    if (code === 0x22) {
      if (layers === -1) layers = 0
      if (layers === 0 && delimits(0) === true) inString = !inString
    } else if (!inString) {
      if (code === 0x7b || code === 0x5b) {
        if (depth === MAX_BRACKET_DEPTH) return -1
        expected[depth] = code === 0x7b ? 0x7d : 0x5d
        depth += 1
      } else if (code === 0x7d || code === 0x5d) {
        // A closer that is not the innermost open bracket's: the value is malformed and its end cannot be established.
        depth -= 1
        if (expected[depth] !== code) return -1
        if (depth === 0) return index + 1
      }
    }
    index += 1
  }
  return -1
}

/** The most a quoted value is searched for its closing quote. Past it the end is not established and the string is withheld. */
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

/** Characters that are invisible inside a key and never part of a real name: zero-width space, joiners, word joiner, BOM. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/
const ZERO_WIDTH_ALL = /[\u200B-\u200D\u2060\uFEFF]/g

/** The longest raw key (between its quotes) the quoted-key pass inspects. A longer one is not a name. */
const MAX_KEY_RAW_CHARS = 1024

/** The most backslashes counted before a quote. A longer run is not a delimiter at a supported depth. */
const MAX_QUOTE_RUN = 64

/**
 * The escape depth a quote delimits at, from the backslash run before it. A quote of a document under `d` JSON encodings is
 * preceded by `2^d - 1` backslashes, plus any number of escaped backslashes that end the string before it (`2^(d+1)` each):
 * the run plus one has exactly `d` trailing zero bits. Depth 0 to 4; -1 for anything deeper or a run too long to be one.
 */
function depthOfDelimiterRun(run: number): number {
  if (run >= MAX_QUOTE_RUN) return -1
  const depth = Math.clz32((run + 1) & -(run + 1)) ^ 31
  return depth <= 4 ? depth : -1
}

const SIMPLE_ESCAPES: Readonly<Record<number, string>> = {
  0x22: '"',
  0x5c: '\\',
  0x2f: '/',
  0x62: '\b',
  0x66: '\f',
  0x6e: '\n',
  0x72: '\r',
  0x74: '\t',
}

/**
 * One layer of JSON string-body decoding: `\"` `\\` `\/` `\b` `\f` `\n` `\r` `\t` and `\uXXXX` (upper- or lower-case hex; a
 * surrogate pair is two escapes that join). Undefined for anything that is not a valid body: an unescaped quote, a lone
 * backslash at the end, an escape this does not know, a `\u` without four hex digits. One forward pass, no exceptions.
 */
function decodeLayer(body: string): string | undefined {
  let out = ''
  let index = 0
  while (index < body.length) {
    const code = body.charCodeAt(index)
    if (code === 0x22) return undefined
    if (code !== 0x5c) {
      out += body.charAt(index)
      index += 1
      continue
    }
    const next = body.charCodeAt(index + 1)
    const simple = SIMPLE_ESCAPES[next]
    if (simple !== undefined) {
      out += simple
      index += 2
    } else if (next === 0x75) {
      const hex = body.slice(index + 2, index + 6)
      if (!/^[\da-f]{4}$/i.test(hex)) return undefined
      out += String.fromCharCode(Number.parseInt(hex, 16))
      index += 6
    } else {
      return undefined
    }
  }
  return out
}

/**
 * A quoted key's text, as the document means it: its escapes decoded at the depth the document is written in (a document
 * under `d` encodings has `d + 1` layers of escaping to remove). Undefined when it cannot be decoded.
 */
function decodeKey(raw: string, layers: number): string | undefined {
  if (!raw.includes('\\')) return raw
  let current = raw
  for (let pass = 0; pass <= layers; pass += 1) {
    const next = decodeLayer(current)
    if (next === undefined) return undefined
    current = next
  }
  return current
}

/**
 * `name=value` and `name: value`, in plain text and in JSON text (`\"name\": \"value\"`): the range is the value.
 *
 * Two ways in, both reading the ORIGINAL text:
 * 1. A secret word, then (for an unquoted name) up to four blanks and `:` or `=`; or (for a name in quotes) the key's closing
 *    quote, then any JSON whitespace up to `MAX_GAP_CHARS` and `:`.
 * 2. Every double-quoted JSON key at the supported escape depths, found by pairing consecutive delimiting quotes of one depth
 *    (so it does not depend on how the key is spelled): its text is DECODED (`\u0061`, `\n`, `\/`, surrogate pairs, at the
 *    depth it is written in), zero-width characters are dropped, and if the result holds a secret word the value after the
 *    colon is read exactly as in 1. This is what finds `"p\u0061ssword"` and a key whose word has a long suffix.
 *
 * A key that cannot be decoded (a malformed escape, longer than `MAX_KEY_RAW_CHARS`, an escape depth beyond four) is not
 * inspected and does not withhold: it is not valid JSON, or not a name, and withholding on it would withhold most text with
 * a backslash in it. The value is read by hand, once, forward:
 * - a quoted value runs to its closing quote, honouring escapes (in an escaped layer, `\"` closes and `\\\"` does not); if
 *   no closing quote is found within `MAX_QUOTED_VALUE_CHARS` the end is not established and the string is withheld;
 * - an unquoted value is a run of non-delimiter characters (the first token only), plus the credential after a scheme word;
 * - a `{` or `[` value runs to its balanced close, or the string is withheld;
 * - a number of up to eight digits survives only after a counter or limit name (`max_tokens: 8000`), never after a name that
 *   says password, secret, credential or authorization.
 * Scanning resumes after the value, so no character is scanned more than a bounded number of times.
 */
function nameValueMatcher(): ScrubMatcher {
  const prefix = new RegExp(
    // A word and its suffix, then EITHER the closing quote of a quoted name (a run of backslashes before it is an escaped layer;
    // what follows is read by hand, since a quoted key allows wide whitespace before its colon) OR, for an unquoted name, up to
    // four blanks and the separator.
    String.raw`((?:${SECRET_WORDS})[\w.-]{0,20})(?:(\\{0,64}["'])|[ \t]{0,4}([:=]))`,
    'gi',
  )
  const SKIP = -1
  const WITHHELD = -2
  return {
    id: 'name-value-pair',
    find: (text, lower, emit, withhold) => {
      const named = SECRET_NEEDLES.some(needle => lower.includes(needle))
      // A key whose word is spelled with escapes or zero-width characters has no needle in its raw text.
      const keyed = named || text.includes(String.raw`\u`) || ZERO_WIDTH.test(text)
      if (!keyed) return
      // The work every value of this text may spend scanning for its close, all together: a text of many unterminated openers
      // costs a constant multiple of its length, not a scan each. When it is spent the value's end cannot be established, and
      // the string is withheld. (A value can be read by both ways in, so it is twice what one way needs.)
      const budget = {left: 8 * text.length + 65_536}

      /** Reads the value that starts after a separator ending at `sepEnd`. Returns where scanning resumes, SKIP or WITHHELD. */
      const readValue = (sepEnd: number, jsonForm: boolean, layers: number, counter: boolean): number => {
        // The gap between the separator and the value. For a QUOTED key and a colon (the JSON form) it may hold newlines, real or
        // escaped at the document's depth, up to `MAX_GAP_CHARS`; for every other form it is up to four spaces or tabs, so prose
        // like `password:` at the end of a line does not reach the next one.
        let at = sepEnd
        if (jsonForm) {
          const gap = skipGap(text, at, layers)
          // More whitespace than the bound: where the value starts cannot be told.
          if (gap.over) return WITHHELD
          at = gap.end
        } else {
          for (
            let blanks = 0;
            blanks < 4 && (text.charCodeAt(at) === 0x20 || text.charCodeAt(at) === 0x09);
            blanks += 1
          )
            at += 1
        }
        // The value's opening quote, in an escaped layer: up to 15 backslashes before it.
        let runEnd = at
        while (runEnd - at <= 15 && text.charCodeAt(runEnd) === 0x5c) runEnd += 1
        const quoteCode = text.charCodeAt(runEnd)
        const opened = runEnd - at <= 15 && (quoteCode === 0x22 || quoteCode === 0x27)
        const opener = opened ? text.slice(at, runEnd + 1) : undefined
        const valueStart = opened ? runEnd + 1 : at
        // After a quoted key, a backslash that is not an opening quote is an escape this matcher did not recognise (a run too long,
        // a whitespace escape of another depth): the value's start is unknown, so its end is.
        if (jsonForm && !opened && text.charCodeAt(at) === 0x5c) return WITHHELD

        // Every branch below either establishes the value's end (a balanced close, a closing quote, a delimiter) or withholds the
        // string. There is no "to the end of the line".
        let valueEnd: number
        const first = text.charCodeAt(valueStart)
        if (opener === undefined && (first === 0x7b || first === 0x5b)) {
          // A whole object or array after a sensitive name: consumed to its balanced close. No close within the size bound, or
          // within the shared work budget, or an unreadable escape depth inside: the end is not established.
          const close = structureEnd(text, valueStart, budget)
          if (close === -1) return WITHHELD
          valueEnd = close
        } else if (opener === undefined) {
          // Unquoted: the value ends at the first delimiter (whitespace, a quote, a bracket, a comma...). That is the rule for this
          // form, not a guess: a delimiter or the end of the text always ends it.
          valueEnd = unquotedEnd(text, valueStart)
          if (SCHEME_WORD.test(text.slice(valueStart, valueEnd))) valueEnd = schemeCredentialEnd(text, valueEnd)
          const value = text.slice(valueStart, valueEnd)
          if (counter && isShortNumber(value)) return SKIP
          // A counter name keeps the old floor of three characters; a credential name has none.
          if (value.length < (counter ? 3 : 1)) return SKIP
        } else {
          // Quoted: ends at its closing quote. None within the scan bound, or the shared work budget is spent: not established.
          const close = budget.left > MAX_QUOTED_VALUE_CHARS ? closingQuote(text, valueStart, opener) : -1
          if (close === -1) return WITHHELD
          valueEnd = close
          budget.left -= valueEnd - valueStart
          if (valueEnd === valueStart) return SKIP
        }
        emit(valueStart, valueEnd)
        return valueEnd
      }

      /** Way in 2: every double-quoted key at a supported depth, by its DECODED text. */
      const quotedKeys = (): void => {
        // The most recent delimiting quote at each depth: the opening quote of whatever string the next one closes.
        const lastQuote = [-1, -1, -1, -1, -1]
        for (let quote = text.indexOf('"'); quote !== -1; quote = text.indexOf('"', quote + 1)) {
          let run = 0
          while (run < MAX_QUOTE_RUN && text.charCodeAt(quote - 1 - run) === 0x5c) run += 1
          const depth = depthOfDelimiterRun(run)
          if (depth === -1) continue
          // The `2^d - 1` backslashes right before the quote belong to it; any before those are the key's own escaped backslashes.
          const delimiterRun = 2 ** depth - 1
          const open = lastQuote[depth] ?? -1
          lastQuote[depth] = quote
          if (open === -1 || quote - open > MAX_KEY_RAW_CHARS) continue
          // Is it a key at all? A closing quote, then JSON whitespace, then a colon. Cheap, and it comes first.
          const gap = skipGap(text, quote + 1, depth)
          if (text.charCodeAt(gap.end) !== 0x3a) continue
          const key = decodeKey(text.slice(open + 1, quote - delimiterRun), depth)
          // A key that cannot be decoded is not inspected (see above).
          if (key === undefined) continue
          const name = ZERO_WIDTH.test(key) ? key.replaceAll(ZERO_WIDTH_ALL, '') : key
          if (!SENSITIVE_KEY.test(name)) continue
          // The sensitive name is recognised: from here the outcome is the same as for a key found by its spelling.
          if (gap.over) return withhold()
          const result = readValue(gap.end + 1, true, depth, isCounterName(name))
          if (result === WITHHELD) return withhold()
        }
      }

      if (named) {
        prefix.lastIndex = 0
        for (;;) {
          const match = prefix.exec(text)
          if (match === null) break
          const name = match[1] ?? ''
          const nameQuote = match[2]
          const afterName = match.index + match[0].length
          // The identifier the name belongs to: what precedes the secret word (`max_` of `max_tokens`) counts.
          let from = match.index
          while (from > 0 && match.index - from < MAX_IDENTIFIER_CHARS && isIdentifierCode(text.charCodeAt(from - 1)))
            from -= 1
          const counter = isCounterName(text.slice(from, match.index) + name)

          let result: number
          if (nameQuote === undefined) {
            result = readValue(afterName, false, 0, counter)
          } else {
            const layers = depthOfDelimiterRun(nameQuote.length - 1)
            // Up to four blanks and a separator, the form a name in quotes had before the JSON whitespace rule.
            let blanksEnd = afterName
            while (
              blanksEnd - afterName < 4 &&
              (text.charCodeAt(blanksEnd) === 0x20 || text.charCodeAt(blanksEnd) === 0x09)
            )
              blanksEnd += 1
            if (layers === -1) {
              // An escape depth this matcher cannot read (deeper than it supports, or a backslash run that is not `2^d - 1`): a
              // key followed by a colon cannot be read, so it cannot tell where the value ends.
              if (text.charCodeAt(blanksEnd) === 0x3a) return withhold()
              if (text.charCodeAt(blanksEnd) !== 0x3d) continue
              result = readValue(blanksEnd + 1, false, 0, counter)
            } else {
              // The JSON form: any JSON whitespace, real or escaped at this depth, up to the bound, then a colon.
              const gap = skipGap(text, afterName, layers)
              if (text.charCodeAt(gap.end) === 0x3a) {
                // More whitespace than the bound before the colon: the key is recognised but where its value starts cannot be told.
                if (gap.over) return withhold()
                result = readValue(gap.end + 1, true, layers, counter)
              } else if (text.charCodeAt(blanksEnd) === 0x3d) {
                result = readValue(blanksEnd + 1, false, 0, counter)
              } else {
                continue
              }
            }
          }
          if (result === WITHHELD) return withhold()
          if (result !== SKIP) prefix.lastIndex = Math.max(prefix.lastIndex, result)
        }
      }
      if (keyed) quotedKeys()
    },
  }
}

/**
 * Where a quoted value that starts at `from` ends: the index of its closing delimiter, or -1 when none is found within the
 * bound (the caller then withholds the string). `opener` is the quote and any backslashes before it (`"`, `'`, `\"`, `\\\"`): the run of backslashes
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
  return -1
}

/**
 * URL userinfo: everything between `scheme://` and the `@`, whatever its length. Userinfo can only be in the authority, so the
 * run stops at the first raw `/`, `?` or `#` (and at whitespace, quotes and a backslash): an `@` in a query, a fragment or a
 * path is not userinfo, and treating it as one would erase the real hostname. Percent-encoded characters are allowed. The run
 * cannot cross a delimiter, so a scan never reaches into another candidate and the rule stays linear.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/?#@"'\\]+@/gi

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
 * takes the union of every range), and `scrub.test.ts` runs it in other orders to show that.
 */
export const SCRUB_PATTERNS: readonly ScrubMatcher[] = [
  pemMatcher(),
  regexMatcher('github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})\b/g, wholeMatch, [
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

/**
 * The forms of one secret to remove: the value, and its JSON-escaped text when that differs. None for a value outside the
 * length bounds: one shorter than `MIN_LITERAL_CHARS` would redact ordinary text, one longer than `MAX_LITERAL_CHARS` is not a
 * secret anyone typed.
 */
function literalForms(value: string | undefined): readonly string[] {
  if (value === undefined || value.length < MIN_LITERAL_CHARS || value.length > MAX_LITERAL_CHARS) return []
  const escaped = JSON.stringify(value).slice(1, -1)
  return escaped !== value && escaped.length <= MAX_LITERAL_CHARS * 2 ? [value, escaped] : [value]
}

/**
 * The literal secrets to remove: from the environment once, raw and JSON-escaped, longest first and at most `MAX_LITERALS`.
 * Never returns names. The cap bounds the cost of scanning every string for every literal; secrets added after the scrubber
 * exists go through `Scrubber.addLiterals`, which does not apply it.
 */
export function collectLiterals(
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): readonly string[] {
  const found = new Set<string>()
  const add = (value: string | undefined): void => {
    for (const form of literalForms(value)) found.add(form)
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
  | {
      readonly ok: false
      readonly reason: 'over-input-ceiling' | 'scrub-failed' | 'too-many-ranges' | 'sensitive-value-unbounded'
    }

export interface Scrubber {
  /** Scrubs one string: the ORIGINAL text in, text with each united range replaced by one marker out. */
  readonly scrub: (text: string) => ScrubResult
  /** The longest string `scrub` accepts; a content attribute whose serialization is longer is omitted unscanned. */
  readonly inputCeilingChars?: number
  /**
   * The safety net, run on every string about to be exported: whether `text` still holds one of the environment's literal
   * secrets (raw or JSON-escaped, the set the literal matcher uses). When it does the caller withholds the whole value. A
   * pure search of the final text: nothing it finds is fed back into the matchers. Each `true` is counted.
   */
  readonly survived?: (text: string) => boolean
  /** How many values `survived` has reported so far. Normally 0: a non-zero count means a matcher missed a known literal. */
  readonly survivalCount?: () => number
  /**
   * Adds literal secrets that became known after the scrubber was created (a credential minted mid-run). Every later `scrub`
   * and `survived` treats them like the construction-time literals: raw and JSON-escaped, with the same length bounds (a value
   * under eight characters is not matched, so it cannot redact ordinary text). Unlike the construction-time set, which keeps
   * only the longest `MAX_LITERALS`, none of these is dropped for want of room: dropping one would export a secret the caller
   * said it knew. A value already known is ignored. The cost of a scrub grows with the number of literals, so a caller adds
   * secrets, not arbitrary text.
   */
  readonly addLiterals?: (values: readonly string[]) => void
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
): {readonly text: string; readonly redactions: number; readonly withheld: boolean} {
  const lower = text.toLowerCase()
  const starts: number[] = []
  const ends: number[] = []
  let withheld = false
  let overCap = false
  const emit: Emit = (start, end) => {
    if (end <= start || overCap) return
    if (starts.length >= MAX_RANGES) {
      overCap = true
      return
    }
    starts.push(Math.max(0, start))
    ends.push(Math.min(text.length, end))
  }
  const withhold: Withhold = () => {
    withheld = true
  }
  for (const matcher of matchers) matcher.find(text, lower, emit, withhold)
  // Withholding outranks the range cap, so the outcome does not depend on the order the matchers ran in.
  if (withheld) return {text: '', redactions: 0, withheld: true}
  if (overCap) throw new TooManyRangesError()
  if (starts.length === 0) return {text, redactions: 0, withheld: false}

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
  return {text: out + text.slice(cursor), redactions, withheld: false}
}

export function createScrubber(options: ScrubberOptions = {}): Scrubber {
  const ceiling = options.limits?.inputCeilingChars ?? DEFAULT_CONTENT_LIMITS.inputCeilingChars
  // Mutable: `addLiterals` appends, and the literal matcher reads this same array on every scrub.
  const literals = [...collectLiterals(options.env ?? {}, options.extraSecrets)]
  const known = new Set(literals)
  const matchers = [...(options.patterns ?? SCRUB_PATTERNS), literalMatcher(literals)]
  let survivals = 0
  return {
    addLiterals: values => {
      for (const value of values) {
        for (const form of literalForms(value)) {
          if (known.has(form)) continue
          known.add(form)
          literals.push(form)
        }
      }
    },
    inputCeilingChars: ceiling,
    survived: text => {
      for (const literal of literals) {
        if (text.includes(literal)) {
          survivals += 1
          return true
        }
      }
      return false
    },
    survivalCount: () => survivals,
    scrub: text => {
      if (text.length > ceiling) return {ok: false, reason: 'over-input-ceiling'}
      try {
        const result = scrubWithMatchers(text, matchers)
        return result.withheld
          ? {ok: false, reason: 'sensitive-value-unbounded'}
          : {ok: true, text: result.text, redactions: result.redactions}
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

/** A link from a span to another span, in this trace or another. The ids are hex, as the producer chose them. */
export interface SpanLink {
  readonly traceId: string
  readonly spanId: string
  /** Text attributes of the link. Scrubbed like an event's. */
  readonly attributes: Readonly<Record<string, string>>
}

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
  /** Links to other spans. Absent for a span with none. */
  readonly links?: readonly SpanLink[]
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
  /** Present only when the span had links. */
  readonly links?: readonly SpanLink[]
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
  // The safety net: a known literal that is still here is withheld whole, never rewritten (see `Scrubber.survived`).
  if (scrubber.survived?.(result.text) === true) {
    tally.omitted.push(`${label}:literal-survived`)
    return OMITTED_TEXT
  }
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

const MAX_KEY_CHARS = 200
/** Nodes visited and depth reached in one structured pass. Past either, the attribute is omitted, not exported. */
const MAX_REDACTION_NODES = 500_000
const MAX_REDACTION_DEPTH = 64

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
  /** String leaves withheld because a sensitive value's end could not be established. */
  withheld: number
  /** Entries dropped because every key they could take was occupied (see `freeKey`). */
  droppedKeys: number
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
  if (!result.ok) {
    // A sensitive value whose end cannot be established withholds THIS leaf; every other failure fails the whole attribute.
    if (result.reason === 'sensitive-value-unbounded') {
      walk.withheld += 1
      return OMITTED_TEXT
    }
    throw new TreeFailure(result.reason)
  }
  walk.redactions += result.redactions
  return result.text
}

/** The most entries that may share one scrubbed key name (the plain name and the suffixes ` (2)` to ` (64)`). */
const MAX_KEY_COLLISIONS = 64

/**
 * The key to write a scrubbed entry under, or undefined when there is none. Two distinct keys that differ only inside text the
 * scrubber redacts become the same text, and the later entry would overwrite the earlier. THE RULE: this only ever returns an
 * unoccupied key, so an entry is never overwritten, whether the occupant is a scrubbed key or a genuine input key that happens to
 * look like a suffixed name (`name (2)`, before or after the colliding keys: a later genuine key is itself a collision with an
 * occupied key and probes from its own name). A colliding key takes ` (2)`, ` (3)`... in order, skipping any that are taken. With
 * every one up to ` (64)` taken, there is no free key: the caller drops the entry and counts it (`key-collision-overflow`). No
 * original text is kept, and the probe is bounded.
 */
function freeKey(target: Record<string, unknown>, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(target, name)) return name
  for (let n = 2; n <= MAX_KEY_COLLISIONS; n += 1) {
    const candidate = `${name} (${String(n)})`
    if (!Object.prototype.hasOwnProperty.call(target, candidate)) return candidate
  }
  return undefined
}

function scrubNode(value: unknown, depth: number, scrubber: Scrubber, walk: TreeWalk): unknown {
  walk.nodes += 1
  if (walk.nodes > MAX_REDACTION_NODES || depth > MAX_REDACTION_DEPTH) throw new TreeFailure('scrub-failed')
  // THE INVARIANT: every string, key or value, is scrubbed from its ORIGINAL text, in full, before anything is decided about it,
  // and what is returned is that scrubbed text (or the fixed marker): never the source, never a parse of it. A string that
  // happens to look like JSON is just a string; whole-value redaction inside it is the name/value matcher's job.
  if (typeof value === 'string') return scrubLeaf(value, scrubber, walk)
  if (Array.isArray(value)) return value.map(item => scrubNode(item, depth + 1, scrubber, walk))
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (key === '__proto__') continue
      const child = (value as Record<string, unknown>)[key]
      if (isSensitiveKey(key, child)) {
        // The whole value goes, whatever its type; nothing inside it is read, and the marker is never scanned.
        walk.redactions += 1
        const slot = freeKey(copy, scrubLeaf(key, scrubber, walk))
        if (slot === undefined) walk.droppedKeys += 1
        else copy[slot] = REDACTION
      } else {
        const slot = freeKey(copy, scrubLeaf(key, scrubber, walk))
        if (slot === undefined) walk.droppedKeys += 1
        else copy[slot] = scrubNode(child, depth + 1, scrubber, walk)
      }
    }
    return copy
  }
  return value
}

/**
 * Scrubs a structured value (the objects and arrays the plugin itself builds) in ONE walk. A sensitive-named key has its
 * entire value replaced, whatever its type, without reading it; every other string and every key goes through the text
 * matchers once, from its original text. A string that holds JSON is not parsed: it is a string. The two never feed each other:
 * a marker the walk inserts is a node of the output tree, and no matcher ever reads it. The caller serializes the result and
 * does not scan that text again.
 */
export function scrubStructured(
  value: unknown,
  scrubber: Scrubber,
):
  | {
      readonly ok: true
      readonly value: unknown
      readonly redactions: number
      readonly withheld: number
      readonly droppedKeys: number
    }
  | {readonly ok: false; readonly reason: TreeFailureReason} {
  const walk: TreeWalk = {nodes: 0, redactions: 0, withheld: 0, droppedKeys: 0}
  try {
    return {
      ok: true,
      value: scrubNode(value, 0, scrubber, walk),
      redactions: walk.redactions,
      withheld: walk.withheld,
      droppedKeys: walk.droppedKeys,
    }
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
      // Leaves withheld for an unbounded sensitive value are the marker in the output; the span says so once per attribute.
      if (walked.withheld > 0) tally.omitted.push(`${name}:sensitive-value-unbounded`)
      // Entries dropped for want of a free key: counted once per attribute, with a fixed reason.
      if (walked.droppedKeys > 0) tally.omitted.push(`${name}:key-collision-overflow`)
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
      // The safety net, on the exact text that would be exported.
      if (scrubber.survived?.(bounded.json) === true) {
        tally.omitted.push(`${name}:literal-survived`)
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

  const links = span.links?.map(link => ({
    traceId: link.traceId,
    spanId: link.spanId,
    attributes: Object.fromEntries(
      Object.entries(link.attributes).map(([key, text]) => [
        key,
        scrubPlain(text, `link.${key}`, scrubber, limits, tally),
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
    ...(links === undefined ? {} : {links}),
  }
}
