import {Buffer} from 'node:buffer'
import {MAX_LITERAL_CHARS, MIN_LITERAL_CHARS, SECRET_ENV_NAME} from '@fro-bot/runtime/tracing/scrub'

/**
 * The secrets this process knows, for the lifecycle tracer's scrubber.
 *
 * `core.setSecret` cannot be read back, and the server password and key-proxy values only exist after the server starts, so
 * the tracer cannot ask GitHub what was masked. Every mask site calls `mask` here instead: it masks through the injected
 * `masker` (`core.setSecret`) and remembers the value. The registry also takes the values nobody passes to `core.setSecret`:
 * each leaf of the JSON inputs, the secret-named environment variables, and the forms the trace credential can take.
 *
 * It fails closed. The scrubber matches a literal only when it is 8 to 65,536 characters long, so a credential outside that
 * range cannot be scrubbed. `matchable()` is false as soon as one is registered, and the tracer then exports no free text.
 * A value is never silently dropped: it is either in `literals()` or it flips `matchable()`. `unmatchable()` says where each
 * such value came from (a fixed category or an environment variable's name) and how long it was, so a run that loses its free
 * text can say why without ever naming a value.
 */

export interface SecretRegistry {
  /** The recording mask function: masks through the injected masker, and registers the value. `source` is a fixed category. */
  readonly mask: (value: string, source?: string) => void
  /** Registers a value as a secret. Empty and blank values are not secrets and are ignored. `source` is a fixed category. */
  readonly add: (value: string | undefined, source?: string) => void
  /** Every string leaf of `auth-json`. Everything but the `type` tag is a credential. */
  readonly addAuthJson: (text: string) => void
  /** Every string leaf of `opencode-config`. Only a leaf under a secret-named key is a credential. */
  readonly addOpencodeConfig: (text: string) => void
  /** The value of every secret-named variable. */
  readonly addSecretEnv: (env: Readonly<Record<string, string | undefined>>) => void
  /** Each trace header value, and the Bearer token or Basic pair a person could paste on their own. */
  readonly addTraceCredential: (headers: readonly {readonly name: string; readonly value: string}[]) => void
  /** Every value the scrubber can match. */
  readonly literals: () => readonly string[]
  /** False once any registered credential is outside the scrubber's length range. */
  readonly matchable: () => boolean
  /**
   * Where each credential outside the range came from and how long it was: at most `MAX_REPORTED_SOURCES` distinct
   * (source, length) pairs, in registration order, and the number of distinct pairs in all. Never a value.
   */
  readonly unmatchable: () => UnmatchableReport
}

export interface UnmatchableSource {
  /** A fixed category (`auth-json`) or `env:NAME`. */
  readonly source: string
  readonly length: number
}

export interface UnmatchableReport {
  readonly sources: readonly UnmatchableSource[]
  readonly total: number
}

/** The most (source, length) pairs the registry keeps to report. */
export const MAX_REPORTED_SOURCES = 20
const DEFAULT_MASK_SOURCE = 'masked-value'
const DEFAULT_ADD_SOURCE = 'registered-value'

type JsonLeafPredicate = (key: string) => boolean

/** A leaf key that names a credential. Separators are optional: `api_key`, `api-key` and `apiKey` all match. */
const CREDENTIAL_KEY =
  /secret|token|passw|credential|api[_-]?key|private[_-]?key|access|refresh|auth|bearer|cookie|session|^key$/i

const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 100_000
const BASIC_OR_BEARER = /^(basic|bearer)[ \t]+(\S+)$/i

const inRange = (value: string): boolean => value.length >= MIN_LITERAL_CHARS && value.length <= MAX_LITERAL_CHARS

function hasControlOrReplacement(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0xfffd) return true
  }
  return false
}

/** The decoded `user:password` of a Basic token, or undefined when it is not a real pair. */
function decodeBasicPair(token: string): string | undefined {
  const decoded = Buffer.from(token, 'base64').toString('utf8')
  const roundTrips = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === token.replace(/=+$/, '')
  return roundTrips && decoded.includes(':') && !hasControlOrReplacement(decoded) ? decoded : undefined
}

export function createSecretRegistry(masker: (value: string) => void): SecretRegistry {
  const known = new Set<string>()
  const outOfRange = new Set<string>()
  const reported: UnmatchableSource[] = []
  let matchable = true

  /** Records that a credential from `source` cannot be matched. Only the source and the length are kept. */
  const markUnmatchable = (source: string, length: number): void => {
    matchable = false
    const key = `${length}:${source}`
    if (outOfRange.has(key)) return
    outOfRange.add(key)
    if (reported.length < MAX_REPORTED_SOURCES) reported.push({source, length})
  }

  /** A credential: in range it is a literal, out of range it makes the registry unmatchable. */
  const addCredential = (value: string | undefined, source: string): void => {
    if (value === undefined || value.trim().length === 0) return
    if (inRange(value)) known.add(value)
    else markUnmatchable(source, value.length)
  }

  /** The token of a `Bearer`/`Basic` value, and for Basic its decoded pair and password: what a person would paste on their own. */
  const addSchemeForms = (value: string, source: string): void => {
    const match = BASIC_OR_BEARER.exec(value)
    if (match === null) return
    const token = match[2] ?? ''
    addCredential(token, source)
    if ((match[1] ?? '').toLowerCase() !== 'basic') return
    const pair = decodeBasicPair(token)
    if (pair === undefined) return
    addCredential(pair, source)
    addCredential(pair.slice(pair.indexOf(':') + 1), source)
  }

  /** A leaf that may or may not be a credential: in range it is a literal, out of range it is skipped unless `credential`. */
  const addLeaf = (value: string, credential: boolean, source: string): void => {
    if (value.trim().length === 0) return
    if (inRange(value)) known.add(value)
    else if (credential) markUnmatchable(source, value.length)
    // A credential leaf like `Authorization: Bearer <token>`: a message carries the token alone as often as the whole value.
    if (credential) addSchemeForms(value, source)
  }

  function addJsonLeaves(text: string, isCredentialKey: JsonLeafPredicate, source: string): void {
    let root: unknown
    try {
      root = JSON.parse(text)
    } catch {
      // Not JSON: the whole text is the secret.
      addCredential(text, source)
      return
    }
    let nodes = 0
    const stack: {readonly value: unknown; readonly key: string; readonly depth: number}[] = [
      {value: root, key: '', depth: 0},
    ]
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      nodes += 1
      // A document past either bound is not walked to the end: a leaf may be unseen, so the registry fails closed.
      if (nodes > MAX_JSON_NODES || item.depth > MAX_JSON_DEPTH) {
        // No leaf to measure: the document itself is the unmatchable thing.
        markUnmatchable(`${source} (too large to read)`, text.length)
        return
      }
      if (typeof item.value === 'string') addLeaf(item.value, isCredentialKey(item.key), source)
      else if (Array.isArray(item.value)) {
        for (const child of item.value) stack.push({value: child, key: item.key, depth: item.depth + 1})
      } else if (typeof item.value === 'object' && item.value !== null) {
        for (const [key, child] of Object.entries(item.value)) stack.push({value: child, key, depth: item.depth + 1})
      }
    }
  }

  return {
    mask: (value, source = DEFAULT_MASK_SOURCE) => {
      addCredential(value, source)
      // A blank value is not a secret, and `core.setSecret('')` is an error.
      if (value.trim().length > 0) masker(value)
    },
    add: (value, source = DEFAULT_ADD_SOURCE) => {
      addCredential(value, source)
    },
    addAuthJson: text => {
      addJsonLeaves(text, key => key !== 'type', 'auth-json')
    },
    addOpencodeConfig: text => {
      addJsonLeaves(text, key => CREDENTIAL_KEY.test(key), 'opencode-config')
    },
    addSecretEnv: env => {
      for (const [name, value] of Object.entries(env)) {
        if (SECRET_ENV_NAME.test(name)) addCredential(value, `env:${name}`)
      }
    },
    addTraceCredential: headers => {
      for (const {value} of headers) {
        addCredential(value, 'trace-credential')
        addSchemeForms(value, 'trace-credential')
      }
    },
    literals: () => [...known],
    matchable: () => matchable,
    unmatchable: () => ({sources: [...reported], total: outOfRange.size}),
  }
}
