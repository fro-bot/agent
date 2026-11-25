/**
 * A session id that survives export. The telemetry session id (`<owner>/<repo>:<logical key>`) is a plain attribute value, so
 * the exporter scrubs it like any other text. A repository named `password-manager` reads to the scrubber as a name and a value
 * (`password…:`), and `acme/password-manager:issue-42` and `…:issue-43` would both leave as `acme/password-manager:[REDACTED]`:
 * two conversations merged into one session. A caller that computes a session id passes it through here first.
 *
 * This is the only place a session id is derived. The plugin uses the id it is handed verbatim, and falls back to OpenCode's own
 * session when the export would change it (see `toExportSpan` in the plugin).
 */

import type {Scrubber} from './scrub.js'

import {createHash} from 'node:crypto'

import {isUsableTracingField} from '../agent/tracing-launcher.js'

/** Hex characters of the SHA-256 digest the hashed id keeps: 128 bits, so two conversations do not meet by accident. */
const HASH_HEX_CHARS = 32

/** Whether the scrubber would export `text` exactly as written: no range replaced, nothing withheld, nothing it cannot read. */
function exportsUnchanged(text: string, scrubber: Scrubber): boolean {
  try {
    const result = scrubber.scrub(text)
    return result.ok && result.text === text && scrubber.survived?.(text) !== true
  } catch {
    return false
  }
}

/**
 * The id to use for `candidate`, which is always the same for the same candidate:
 * - `candidate` itself, when `scrubber` leaves it byte-identical and the launcher would accept it (non-empty, at most 200
 *   characters, no control characters);
 * - otherwise `sha256:` and the first 32 hex characters of the SHA-256 of `candidate` (UTF-8), when `scrubber` leaves that
 *   form byte-identical;
 * - otherwise `undefined`: no session id, and the turn spans keep OpenCode's own session.
 *
 * An empty candidate names no conversation and gives `undefined`. So does an ill-formed one (a lone surrogate): UTF-8 encoding
 * replaces each with U+FFFD, so `…\uD800` and `…\uD801` would hash to the same id and two conversations would share a session,
 * and the exporter would write the candidate itself lossily too.
 */
export function scrubSafeSessionId(candidate: string, scrubber: Scrubber): string | undefined {
  if (candidate.length === 0 || !candidate.isWellFormed()) return undefined
  if (isUsableTracingField(candidate) && exportsUnchanged(candidate, scrubber)) return candidate
  const hashed = `sha256:${createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, HASH_HEX_CHARS)}`
  return exportsUnchanged(hashed, scrubber) ? hashed : undefined
}
