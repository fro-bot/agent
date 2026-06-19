/**
 * Denylist reader for the gateway redaction gate.
 *
 * Reads `metadata/repos.yaml` from `fro-bot/.github@data` and returns a
 * denylist of redacted repo deny keys (`redactedNodeIds`, `redactedDatabaseIds`).
 *
 * Mirrors the dashboard's `src/github/metadata.ts` reader, adapted for the
 * gateway's narrower need: only deny keys are produced (no publicRepos set).
 *
 * Security invariants:
 * - Redacted entries (private:true / owner:'[REDACTED]') are NEVER included in
 *   any public set. Their owner/name are never stored, logged, or returned.
 * - Only the node_id and database_id of a redacted entry are retained.
 * - ALL error paths return err(...) — nothing throws out of readRepoDenylist.
 * - 404 / data-branch missing → err(MetadataUnavailableError).
 * - Malformed YAML / parse failure → err(MetadataParseError).
 * - Wrong schema version → err(MetadataSchemaError). FAIL CLOSED.
 * - Redacted entry with no usable numeric deny key → err(MetadataSchemaError). FAIL CLOSED.
 * - Transport error (reader rejects) → err(MetadataTransportError).
 *
 * Hardening (differs from dashboard): every redacted entry MUST contribute a
 * usable numeric database_id (direct field or derived via deriveDatabaseId).
 * An R_-format-only entry with no numeric database_id fails the whole load
 * closed — node_id-only matching is format-fragile and could miss a cross-format
 * skew. This is an assertion, not a new burden: repos.yaml carries database_id
 * on redacted entries.
 */

import type {Result} from '@fro-bot/runtime'

import {Buffer} from 'node:buffer'

import {err, ok} from '@fro-bot/runtime'
import {parse} from 'yaml'

import {safeErrorMessage} from '../github/errors.js'

// ---------------------------------------------------------------------------
// Reader interface (injectable — tests inject a fake, production injects real)
// ---------------------------------------------------------------------------

/**
 * Injectable content reader. Receives a file path and git ref, returns the
 * raw file contents as a string.
 *
 * Implementations MUST throw a `makeNotFoundError()`-shaped error (or any
 * error with `code === NOT_FOUND_CODE`) when the file/ref does not exist, so
 * `readRepoDenylist` can distinguish 404 from other transport failures.
 */
export type MetadataReader = (path: string, ref: string) => Promise<string>

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The denylist produced by a successful metadata read.
 *
 * Contains only deny keys for redacted entries — no public repo data.
 * The gateway uses these sets to check whether a repo is denied before
 * surfacing any data about it.
 */
export interface RepoDenylist {
  /**
   * node_id of every private:true / [REDACTED] entry.
   *
   * Cross-format note: GitHub has two node_id formats (legacy base64
   * `MDEwOlJlcG9zaXRvcnkx` and new `R_kgDO...`). The node_id is the
   * primary denylist key; the numeric database_id is the format-independent
   * secondary key that closes the cross-format gap.
   */
  readonly redactedNodeIds: ReadonlySet<string>
  /**
   * Numeric databaseId of every private:true / [REDACTED] entry.
   *
   * This is the format-independent join key: the numeric id is stable across
   * both node_id formats and across repo renames/transfers. Every redacted
   * entry MUST contribute a usable numeric database_id (direct or derived);
   * an entry that cannot is a schema error → the whole load fails closed.
   */
  readonly redactedDatabaseIds: ReadonlySet<number>
}

// ---------------------------------------------------------------------------
// Error types (discriminated by name for instanceof checks)
// ---------------------------------------------------------------------------

/**
 * The data branch or metadata file does not exist (404).
 * The gate should fail closed (deny all) on cold start.
 */
export class MetadataUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataUnavailableError'
  }
}

/**
 * The YAML content could not be parsed, or has an unexpected top-level shape.
 * The gate must fail closed.
 */
export class MetadataParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataParseError'
  }
}

/**
 * The YAML schema version is not supported (version !== 1 or missing), or a
 * redacted entry has no usable numeric deny key.
 * The gate must fail closed.
 */
export class MetadataSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataSchemaError'
  }
}

/**
 * The reader threw an unexpected transport error (network, auth, etc.).
 * The gate must fail closed.
 */
export class MetadataTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataTransportError'
  }
}

export type MetadataError = MetadataUnavailableError | MetadataParseError | MetadataSchemaError | MetadataTransportError

// ---------------------------------------------------------------------------
// Not-found sentinel (for reader implementations)
// ---------------------------------------------------------------------------

/**
 * Sentinel error code that reader implementations MUST use to signal a 404 /
 * file-not-found condition. `readRepoDenylist` checks `error.code === NOT_FOUND_CODE`
 * to distinguish unavailability from transport failures.
 */
export const NOT_FOUND_CODE = 'NOT_FOUND' as const

/**
 * Convenience factory for reader implementations to signal a 404.
 *
 * Usage in a real Octokit reader:
 *   if (response.status === 404) throw makeNotFoundError('data branch not found')
 */
export function makeNotFoundError(message: string): Error & {readonly code: typeof NOT_FOUND_CODE} {
  const error = new Error(message) as Error & {code: typeof NOT_FOUND_CODE}
  error.code = NOT_FOUND_CODE
  return error
}

// ---------------------------------------------------------------------------
// Internal schema types (raw YAML shape — not exported)
// ---------------------------------------------------------------------------

interface RawRepoEntry {
  readonly owner: unknown
  readonly name: unknown
  readonly private: unknown
  readonly node_id: unknown
  /** Optional numeric databaseId — format-independent denylist key. */
  readonly database_id: unknown
  /** Alias for database_id — accepted for convenience. */
  readonly id: unknown
}

interface RawYaml {
  readonly version: unknown
  readonly repos: unknown
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REDACTED_OWNER = '[REDACTED]'
const DATA_REF = 'data'
const METADATA_PATH = 'metadata/repos.yaml'

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Read and parse `metadata/repos.yaml` from the `data` branch, returning a
 * denylist of redacted repo deny keys.
 *
 * @param reader - Injectable content reader. Must throw with `code === NOT_FOUND_CODE`
 *   for 404 / missing file/branch conditions.
 *
 * @returns
 *   - `ok(RepoDenylist)` — parsed successfully; use redactedNodeIds + redactedDatabaseIds.
 *   - `err(MetadataUnavailableError)` — 404 / data branch missing; fail closed.
 *   - `err(MetadataParseError)` — YAML parse failure or wrong top-level shape; fail closed.
 *   - `err(MetadataSchemaError)` — unsupported schema version or redacted entry with no
 *     usable numeric deny key; fail closed.
 *   - `err(MetadataTransportError)` — unexpected transport error; fail closed.
 */
export async function readRepoDenylist(reader: MetadataReader): Promise<Result<RepoDenylist, MetadataError>> {
  // 1. Fetch the file
  let raw: string
  try {
    raw = await reader(METADATA_PATH, DATA_REF)
  } catch (fetchError) {
    // Distinguish 404 (unavailable) from other transport errors
    if (isNotFoundError(fetchError)) {
      return err(new MetadataUnavailableError(`${METADATA_PATH} not found on ref=${DATA_REF}`))
    }
    // No-oracle: sanitize the error message before including it
    const msg = safeErrorMessage(fetchError)
    return err(new MetadataTransportError(`Transport error reading ${METADATA_PATH}: ${msg}`))
  }

  // 2. Parse YAML
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (parseError) {
    const msg = safeErrorMessage(parseError)
    return err(new MetadataParseError(`Failed to parse ${METADATA_PATH}: ${msg}`))
  }

  // 3. Validate top-level shape
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(new MetadataParseError(`${METADATA_PATH}: expected top-level object, got ${typeof parsed}`))
  }

  const doc = parsed as RawYaml

  // 4. Check schema version — FAIL CLOSED on mismatch
  if (doc.version !== 1) {
    return err(new MetadataSchemaError(`${METADATA_PATH}: unsupported schema version (expected 1)`))
  }

  // 5. Validate repos array
  if (!Array.isArray(doc.repos)) {
    return err(new MetadataParseError(`${METADATA_PATH}: expected repos to be an array`))
  }

  // 6. Iterate entries — classify as redacted or skip
  const redactedNodeIds = new Set<string>()
  const redactedDatabaseIds = new Set<number>()

  for (const rawEntry of doc.repos) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      // FIX 8: Fail closed on malformed/null entries — a null or non-object entry in the
      // repos array is a corruption signal. Silently skipping it could miss a redaction
      // (e.g. a redacted entry that was corrupted to null would be silently omitted from
      // the denylist, allowing the repo to surface). Fail the whole load closed instead.
      return err(
        new MetadataSchemaError(
          `${METADATA_PATH}: repos array contains a malformed entry (null or non-object) — failing closed`,
        ),
      )
    }

    const entry = rawEntry as RawRepoEntry
    const isPrivate = entry.private === true
    const isRedactedOwner = entry.owner === REDACTED_OWNER

    if (isPrivate || isRedactedOwner) {
      // Security: only retain deny keys — never store/log owner or name.
      //
      // Hardening: every redacted entry MUST contribute a usable numeric
      // database_id (direct or derived). An R_-format-only entry with no
      // numeric database_id fails the whole load closed — node_id-only
      // matching is format-fragile and could miss a cross-format skew.
      const hasValidNodeId = typeof entry.node_id === 'string' && entry.node_id.length > 0
      const rawDbId = entry.database_id ?? entry.id
      const hasDirectDatabaseId = typeof rawDbId === 'number' && Number.isFinite(rawDbId)

      // Fail closed: no usable deny key at all.
      // No-oracle: do NOT include owner/name in the error message.
      if (hasValidNodeId === false && hasDirectDatabaseId === false) {
        return err(
          new MetadataSchemaError(
            `${METADATA_PATH}: redacted entry has no usable deny key (node_id missing or empty, database_id absent)`,
          ),
        )
      }

      // Derive database_id from node_id if possible (legacy base64 format).
      // After the hasValidNodeId check, entry.node_id is known to be a non-empty string.
      const nodeIdStr = hasValidNodeId ? String(entry.node_id) : null
      const derivedId = nodeIdStr === null ? null : deriveDatabaseId(nodeIdStr)
      const hasUsableNumericId = hasDirectDatabaseId || derivedId !== null

      // Fail closed: R_-format node_id with no direct database_id — node_id-only matching
      // is format-fragile and could miss a cross-format skew.
      // No-oracle: do NOT include owner/name in the error message.
      if (hasUsableNumericId === false) {
        return err(
          new MetadataSchemaError(
            `${METADATA_PATH}: redacted entry has no usable numeric database_id (R_-format node_id with no direct database_id field)`,
          ),
        )
      }

      if (nodeIdStr !== null) {
        redactedNodeIds.add(nodeIdStr)
      }

      if (hasDirectDatabaseId && typeof rawDbId === 'number') {
        redactedDatabaseIds.add(rawDbId)
      }

      if (derivedId !== null) {
        redactedDatabaseIds.add(derivedId)
      }

      // Do NOT add to any public set. Do NOT log owner/name.
    }
    // Non-redacted entries are intentionally ignored — the gateway only needs deny keys.
  }

  return ok({redactedNodeIds, redactedDatabaseIds})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as Record<string, unknown>).code === NOT_FOUND_CODE
}

/**
 * Derive the numeric GitHub databaseId from a repository node_id string.
 *
 * GitHub has two node_id formats:
 *
 * 1. **Legacy base64** (e.g. `MDEwOlJlcG9zaXRvcnkxODY5MTU0`):
 *    base64-decode → ASCII like `010:Repository1869154`.
 *    The trailing integer after `Repository` is the databaseId.
 *    Verified known pair: `MDEwOlJlcG9zaXRvcnkxODY5MTU0` → 1869154
 *    (marcusrbrown/.dotfiles).
 *
 * 2. **New format** (starts with `R_`, e.g. `R_kgDOJ_bMaQ`):
 *    The binary decode is not reliably hand-rollable without a known test vector.
 *    Returns `null` to fail conservatively — the node_id string primary guard
 *    still applies; only the cross-format secondary guard is absent.
 *
 * Returns `null` on any decode failure or unrecognised format.
 *
 * @param nodeId - Raw node_id string from repos.yaml or GitHub API.
 * @returns The numeric databaseId, or null if it cannot be reliably derived.
 */
export function deriveDatabaseId(nodeId: string): number | null {
  if (typeof nodeId !== 'string' || nodeId.length === 0) return null

  // New format: R_kgDO... — conservative: return null rather than guess.
  if (nodeId.startsWith('R_')) return null

  // Legacy format: base64-decode and match `...Repository<digits>` suffix.
  try {
    const decoded = Buffer.from(nodeId, 'base64').toString('ascii')
    // Match the trailing Repository<digits> pattern (e.g. "010:Repository1869154")
    const match = /Repository(\d+)$/.exec(decoded)
    if (match === null || match[1] === undefined) return null
    const id = Number.parseInt(match[1], 10)
    if (!Number.isFinite(id) || id <= 0) return null
    return id
  } catch {
    return null
  }
}
