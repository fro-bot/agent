import type {OpenCodeV2ServerHandle} from './server-v2.js'

/**
 * A reading of OpenCode V2's V1 session-history import.
 *
 * A V2 server that boots on a V1 database imports its history in the background, and `GET
 * /api/experimental/migration/v1` reports how far it got (`protocol/src/groups/migration.ts`, v2.2.0). Probe P7
 * recorded `running` within about a second of start and `completed` once the import finished; `required` was never
 * seen while polling, but is part of the union. A database with no V1 history, and a fresh one, read `completed`.
 *
 * `unreadable` is a reading that did not produce a status: the request failed, answered with an error, took too long,
 * was aborted, or returned a body this code does not recognise. It is not a status of the import. A caller must not
 * treat it as `completed`.
 *
 * This is one read. The wait loop (the bound, stall detection on `numerator`) belongs to the caller.
 */

export interface V1MigrationProgress {
  readonly label: string
  /** Sessions migrated so far. Absent until the import has counted. */
  readonly numerator?: number
  /** Sessions to migrate. */
  readonly denominator?: number
}

export type V1MigrationStatusReading =
  | {readonly status: 'required'}
  | {readonly status: 'completed'}
  | {readonly status: 'running'; readonly progress?: V1MigrationProgress}
  | {readonly status: 'error'; readonly error: string}
  | {readonly status: 'unreadable'; readonly reason: 'aborted' | 'timeout' | 'network' | 'malformed'}
  | {readonly status: 'unreadable'; readonly reason: 'http'; readonly httpStatus: number}

export interface ReadV1MigrationStatusOptions {
  /** The V2 server handle's `fetch`: it carries the credential and the location header. */
  readonly fetch: OpenCodeV2ServerHandle['fetch']
  /** Bound on the whole read, body included. Default `MIGRATION_V1_STATUS_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  /** The caller's signal. An aborted signal reads as `aborted` and sends no request. */
  readonly signal?: AbortSignal
}

export const MIGRATION_V1_STATUS_PATH = '/api/experimental/migration/v1'
/** One poll must end well inside the wait loop's own interval and bound. */
export const MIGRATION_V1_STATUS_TIMEOUT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const MALFORMED = {status: 'unreadable', reason: 'malformed'} as const

function parseProgress(value: unknown): V1MigrationProgress | undefined {
  if (!isRecord(value) || typeof value.label !== 'string') return undefined
  const {label, numerator, denominator} = value
  if (numerator !== undefined && !isCount(numerator)) return undefined
  if (denominator !== undefined && !isCount(denominator)) return undefined
  return {
    label,
    ...(numerator === undefined ? {} : {numerator}),
    ...(denominator === undefined ? {} : {denominator}),
  }
}

function parseStatus(body: unknown): V1MigrationStatusReading {
  if (!isRecord(body)) return MALFORMED
  switch (body.status) {
    case 'required':
      return {status: 'required'}
    case 'completed':
      return {status: 'completed'}
    case 'error':
      return typeof body.error === 'string' ? {status: 'error', error: body.error} : MALFORMED
    case 'running': {
      // A server that says running but sends no progress is still running; the caller just cannot see a stall.
      if (body.progress === undefined) return {status: 'running'}
      const progress = parseProgress(body.progress)
      return progress === undefined ? MALFORMED : {status: 'running', progress}
    }
    default:
      return MALFORMED
  }
}

async function readOnce(
  fetchStatus: OpenCodeV2ServerHandle['fetch'],
  signal: AbortSignal,
): Promise<V1MigrationStatusReading> {
  let response: Response
  try {
    response = await fetchStatus(MIGRATION_V1_STATUS_PATH, {method: 'GET', signal})
  } catch {
    return {status: 'unreadable', reason: 'network'}
  }
  if (!response.ok) {
    // Release the connection; the body of an error answer is of no use here.
    await response.body?.cancel().catch(() => {})
    return {status: 'unreadable', reason: 'http', httpStatus: response.status}
  }
  try {
    return parseStatus(await response.json())
  } catch {
    return MALFORMED
  }
}

/**
 * Reads the import status once through a V2 server handle's `fetch`. Never throws and never waits past `timeoutMs`:
 * the bound and the caller's abort both apply to the request and to its body, and they win even over a `fetch` that
 * ignores its signal.
 */
export async function readV1MigrationStatus(options: ReadV1MigrationStatusOptions): Promise<V1MigrationStatusReading> {
  const {fetch: fetchStatus, timeoutMs = MIGRATION_V1_STATUS_TIMEOUT_MS, signal: callerSignal} = options
  if (callerSignal?.aborted === true) return {status: 'unreadable', reason: 'aborted'}

  // A timer of our own, not `AbortSignal.timeout`: that one is unref'd, so a wedged read would not hold the process.
  const bound = new AbortController()
  const timer = setTimeout(() => bound.abort(), timeoutMs)
  const signal = callerSignal === undefined ? bound.signal : AbortSignal.any([callerSignal, bound.signal])

  let onAbort: (() => void) | undefined
  const stopped = new Promise<V1MigrationStatusReading>(resolve => {
    onAbort = () => resolve({status: 'unreadable', reason: callerSignal?.aborted === true ? 'aborted' : 'timeout'})
    signal.addEventListener('abort', onAbort, {once: true})
  })

  try {
    return await Promise.race([readOnce(fetchStatus, signal), stopped])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
