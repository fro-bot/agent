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
 * It fails closed. The scrubber matches a literal only when it is 8 to 4,096 characters long, so a credential outside that
 * range cannot be scrubbed. `matchable()` is false as soon as one is registered, and the tracer then exports no free text.
 * A value is never silently dropped: it is either in `literals()` or it flips `matchable()`.
 */

export interface SecretRegistry {
  /** The recording mask function: masks through the injected masker, and registers the value. */
  readonly mask: (value: string) => void
  /** Registers a value as a secret. Empty and blank values are not secrets and are ignored. */
  readonly add: (value: string | undefined) => void
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
}

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
  let matchable = true

  /** A credential: in range it is a literal, out of range it makes the registry unmatchable. */
  const addCredential = (value: string | undefined): void => {
    if (value === undefined || value.trim().length === 0) return
    if (inRange(value)) known.add(value)
    else matchable = false
  }

  /** The token of a `Bearer`/`Basic` value, and for Basic its decoded pair and password: what a person would paste on their own. */
  const addSchemeForms = (value: string): void => {
    const match = BASIC_OR_BEARER.exec(value)
    if (match === null) return
    const token = match[2] ?? ''
    addCredential(token)
    if ((match[1] ?? '').toLowerCase() !== 'basic') return
    const pair = decodeBasicPair(token)
    if (pair === undefined) return
    addCredential(pair)
    addCredential(pair.slice(pair.indexOf(':') + 1))
  }

  /** A leaf that may or may not be a credential: in range it is a literal, out of range it is skipped unless `credential`. */
  const addLeaf = (value: string, credential: boolean): void => {
    if (value.trim().length === 0) return
    if (inRange(value)) known.add(value)
    else if (credential) matchable = false
    // A credential leaf like `Authorization: Bearer <token>`: a message carries the token alone as often as the whole value.
    if (credential) addSchemeForms(value)
  }

  function addJsonLeaves(text: string, isCredentialKey: JsonLeafPredicate): void {
    let root: unknown
    try {
      root = JSON.parse(text)
    } catch {
      // Not JSON: the whole text is the secret.
      addCredential(text)
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
        matchable = false
        return
      }
      if (typeof item.value === 'string') addLeaf(item.value, isCredentialKey(item.key))
      else if (Array.isArray(item.value)) {
        for (const child of item.value) stack.push({value: child, key: item.key, depth: item.depth + 1})
      } else if (typeof item.value === 'object' && item.value !== null) {
        for (const [key, child] of Object.entries(item.value)) stack.push({value: child, key, depth: item.depth + 1})
      }
    }
  }

  return {
    mask: value => {
      addCredential(value)
      // A blank value is not a secret, and `core.setSecret('')` is an error.
      if (value.trim().length > 0) masker(value)
    },
    add: addCredential,
    addAuthJson: text => {
      addJsonLeaves(text, key => key !== 'type')
    },
    addOpencodeConfig: text => {
      addJsonLeaves(text, key => CREDENTIAL_KEY.test(key))
    },
    addSecretEnv: env => {
      for (const [name, value] of Object.entries(env)) if (SECRET_ENV_NAME.test(name)) addCredential(value)
    },
    addTraceCredential: headers => {
      for (const {value} of headers) {
        addCredential(value)
        addSchemeForms(value)
      }
    },
    literals: () => [...known],
    matchable: () => matchable,
  }
}
