import type {TracingInputs} from '../../shared/types.js'
import {Buffer} from 'node:buffer'
import {
  isValidTraceRelayHeaderName,
  isValidTraceRelayHeaderValue,
  parseTraceRelayConfig,
  validateTraceRelayUrl,
} from '@fro-bot/runtime'

/**
 * Parses the `trace-endpoint` and `trace-headers` inputs.
 *
 * Tracing is the operator's switch and carries a credential, so this module is strict about three things:
 * - What is masked. Everything the headers could be turned into by a log line, an error message or a tool echo is registered
 *   before anything is validated: the whole input, each line, each value of eight characters or more, and for `Basic` and
 *   `Bearer` values the parts a person would paste on their own. A value shorter than eight characters is skipped, because
 *   masking `4` or `pass` would hide innocent text in every later log line.
 * - What it says. A refused input resolves to tracing off with exactly one warning that names the input (and a line number
 *   for headers) in fixed text. No message holds any part of the value, so the warning itself cannot leak.
 * - What it never does. It never throws and never fails the run: tracing is the one feature a bad input must not break.
 *
 * The URL and header rules are the relay's own (`validateTraceRelayUrl`, `isValidTraceRelayHeaderName`, and the final
 * `parseTraceRelayConfig`), so the Action refuses at input time exactly what the relay would refuse at start.
 */

/** Skipped below this length when registering a derived value as a secret. */
const MIN_MASKED_VALUE_LENGTH = 8

export interface TraceInputIo {
  /** One per refused input. */
  readonly warning: (message: string) => void
  /** A configuration that is allowed but worth saying once. */
  readonly notice: (message: string) => void
  readonly info: (message: string) => void
  /** Registers a value as a secret (`core.setSecret`). */
  readonly mask: (value: string) => void
}

/** Every message the parser can print. Fixed text: nothing here is built from an input value. */
export const TRACE_INPUT_MESSAGES = {
  endpoint:
    'trace-endpoint was not accepted, so tracing is off. It must be an https URL, or an http URL to a loopback IP address (such as 127.0.0.1), with no username, password, fragment or port 0.',
  credentialOverHttp:
    'trace-headers is set but trace-endpoint is an http address. The relay sends a credential only over https, so tracing is off. Use an https endpoint, or leave trace-headers empty for a loopback collector that needs no credential.',
  headersTogether:
    'trace-headers and trace-endpoint were not accepted together, so tracing is off. Check the number and the size of the headers.',
  noCredential:
    'trace-endpoint is set and trace-headers is empty: tracing is on, and spans are sent to the endpoint with no credential.',
  headersWithoutEndpoint: 'trace-headers is ignored because trace-endpoint is empty, so tracing is off.',
  headerLine: {
    format: (line: number) => `trace-headers line ${line} is not in the form "Name: value", so tracing is off.`,
    name: (line: number) =>
      `trace-headers line ${line} has a header name that is not allowed, so tracing is off. Host, Content-Type, Content-Length and the other connection headers are set by the relay.`,
    value: (line: number) =>
      `trace-headers line ${line} has a header value that is empty or holds characters a header cannot hold, so tracing is off.`,
    repeated: (line: number) => `trace-headers line ${line} repeats a header name, so tracing is off.`,
  },
} as const

const OFF: TracingInputs = {enabled: false}

const BASIC_OR_BEARER = /^(basic|bearer)[ \t]+(\S+)$/i

function hasControlOrReplacement(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0xfffd) return true
  }
  return false
}

function mask(io: Pick<TraceInputIo, 'mask'>, value: string): void {
  if (value.length > 0) io.mask(value)
}

function maskLong(io: Pick<TraceInputIo, 'mask'>, value: string): void {
  if (value.length >= MIN_MASKED_VALUE_LENGTH) io.mask(value)
}

/**
 * The credential-shaped parts of a header value: for `Basic`, the encoded part, the decoded `user:password` and the
 * password; for `Bearer`, the token. A part is registered only when it is eight characters or more.
 */
function maskDerivedForms(io: Pick<TraceInputIo, 'mask'>, value: string): void {
  const match = BASIC_OR_BEARER.exec(value)
  if (match === null) return
  const scheme = (match[1] ?? '').toLowerCase()
  const token = match[2] ?? ''
  maskLong(io, token)
  if (scheme !== 'basic') return
  const decoded = Buffer.from(token, 'base64').toString('utf8')
  // Only a real pair: it round-trips to the same base64 and holds no replacement or control character, so a value that is
  // not base64 never registers junk.
  const strict = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === token.replace(/=+$/, '')
  if (!strict || !decoded.includes(':') || hasControlOrReplacement(decoded)) return
  maskLong(io, decoded)
  maskLong(io, decoded.slice(decoded.indexOf(':') + 1))
}

/** Registers everything the endpoint and the headers could appear as, before any of it is checked. */
function maskInputs(io: Pick<TraceInputIo, 'mask'>, endpoint: string, headers: string): void {
  mask(io, endpoint)
  mask(io, headers.trim())
  for (const line of headers.split(/\r?\n/)) {
    const trimmed = line.trim()
    mask(io, trimmed)
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const value = trimmed.slice(colon + 1).trim()
    maskLong(io, value)
    maskDerivedForms(io, value)
  }
}

type HeaderLines =
  | {readonly ok: true; readonly headers: readonly {readonly name: string; readonly value: string}[]}
  | {readonly ok: false; readonly message: string}

function parseHeaderLines(raw: string): HeaderLines {
  const headers: {name: string; value: string}[] = []
  const seen = new Set<string>()
  const lines = raw.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const lineNumber = index + 1
    const colon = trimmed.indexOf(':')
    if (colon === -1) return {ok: false, message: TRACE_INPUT_MESSAGES.headerLine.format(lineNumber)}
    const name = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    if (!isValidTraceRelayHeaderName(name)) {
      return {
        ok: false,
        message:
          name.length === 0
            ? TRACE_INPUT_MESSAGES.headerLine.format(lineNumber)
            : TRACE_INPUT_MESSAGES.headerLine.name(lineNumber),
      }
    }
    if (!isValidTraceRelayHeaderValue(value))
      return {ok: false, message: TRACE_INPUT_MESSAGES.headerLine.value(lineNumber)}
    const lower = name.toLowerCase()
    if (seen.has(lower)) return {ok: false, message: TRACE_INPUT_MESSAGES.headerLine.repeated(lineNumber)}
    seen.add(lower)
    headers.push({name, value})
  }
  return {ok: true, headers}
}

/**
 * Registers every form the two inputs could appear as, and nothing else: no validation, no message. The caller runs this first
 * of everything in input parsing, so a required input that fails afterwards cannot leave a header unmasked. It never throws.
 */
export function maskTraceInputs(
  raw: {readonly endpoint: string; readonly headers: string},
  io: Pick<TraceInputIo, 'mask'>,
): void {
  try {
    maskInputs(io, raw.endpoint.trim(), raw.headers)
  } catch {
    // Masking is best effort here; the parse masks again.
  }
}

export function parseTraceInputs(
  raw: {readonly endpoint: string; readonly headers: string},
  io: TraceInputIo,
): TracingInputs {
  try {
    const endpoint = raw.endpoint.trim()
    maskInputs(io, endpoint, raw.headers)

    if (endpoint.length === 0) {
      if (raw.headers.trim().length > 0) io.info(TRACE_INPUT_MESSAGES.headersWithoutEndpoint)
      return OFF
    }

    const url = validateTraceRelayUrl(endpoint)
    if (!url.success) {
      io.warning(TRACE_INPUT_MESSAGES.endpoint)
      return OFF
    }

    const lines = parseHeaderLines(raw.headers)
    if (!lines.ok) {
      io.warning(lines.message)
      return OFF
    }

    if (url.data.protocol === 'http:' && lines.headers.length > 0) {
      io.warning(TRACE_INPUT_MESSAGES.credentialOverHttp)
      return OFF
    }

    // The relay's own parse has the last word (header count and size, the whole frame), so nothing is accepted here that the
    // supervisor would refuse a moment later.
    const accepted = parseTraceRelayConfig({version: 1, url: endpoint, headers: lines.headers})
    if (!accepted.success) {
      io.warning(
        accepted.error === 'credential-over-http'
          ? TRACE_INPUT_MESSAGES.credentialOverHttp
          : TRACE_INPUT_MESSAGES.headersTogether,
      )
      return OFF
    }

    if (lines.headers.length === 0) io.notice(TRACE_INPUT_MESSAGES.noCredential)
    return {enabled: true, url: endpoint, headers: lines.headers}
  } catch {
    // Never fails the run. The message is fixed text: whatever threw may hold a value.
    io.warning(TRACE_INPUT_MESSAGES.headersTogether)
    return OFF
  }
}
