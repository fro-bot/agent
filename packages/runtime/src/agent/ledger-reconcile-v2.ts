import type {Result} from '@bfra.me/es/result'
import type {LedgerReconcileAdapter, LedgerReconcileChild} from './ledger-reconcile.js'

import {err, ok} from '@bfra.me/es/result'
import {toError} from '../shared/errors.js'
import {getObjectProperty, getStringProperty, ownValue} from './payload-accessors.js'

/**
 * OpenCode V2 (v2.2.0) ledger reconcile adapter, and the directory-quiescence join that the gateway builds on.
 *
 * Both sit on a deliberately small local view of the V2 client's session API, derived from
 * `packages/client/src/promise/generated/client.ts` (`session.active`, `session.list`) and `types.ts`
 * (`SessionActive`, `SessionInfo`, `SessionsResponse`) at `anomalyco/opencode@v2.2.0`. The real client satisfies
 * `V2SessionApi` structurally; this module imports no SDK.
 *
 * Evidence (probes P2, P9):
 * - `GET /api/session/active` is GLOBAL, not per directory, and lists a running background child even after its
 *   parent finished. The parent is not listed once its own turn ends.
 * - `GET /api/session?parentID=…` returns the children. Children inherit the parent's location.
 * - The `directory` filter is an EXACT string match against the directory the session was created with. A symlinked
 *   path (`/tmp/x`) misses sessions stored under the canonical one (`/private/tmp/x`), so this side canonicalises.
 *
 * The reconcile semantics are unchanged from `ledger-reconcile.ts`: the adapter only answers "who are the children" and
 * "who is live". `reconcileLedgerOnce` decides what to settle, and marks entries unknown when either call fails.
 */

export interface V2RequestOptions {
  readonly signal?: AbortSignal
}

export interface V2SessionInfoLike {
  readonly id: string
  readonly parentID?: string | null
  readonly location?: {readonly directory?: string}
}

export interface V2SessionListInput {
  readonly parentID?: string
  readonly directory?: string
  readonly cursor?: string
  readonly limit?: number
}

export interface V2SessionListPage {
  readonly data: readonly V2SessionInfoLike[]
  readonly cursor?: {readonly next?: string | null}
}

export interface V2SessionApi {
  /** `GET /api/session/active`: every running session on the server, keyed by id. */
  readonly active: (requestOptions?: V2RequestOptions) => Promise<Readonly<Record<string, {readonly type: string}>>>
  /** `GET /api/session`. */
  readonly list: (input: V2SessionListInput, requestOptions?: V2RequestOptions) => Promise<V2SessionListPage>
}

/** Sessions requested per page. */
export const DEFAULT_V2_LIST_PAGE_SIZE = 100
/** Pages followed before the list is reported incomplete. Bounds a pass against a server that never stops paging. */
export const DEFAULT_V2_LIST_MAX_PAGES = 20

export interface V2ListOptions {
  readonly pageSize?: number
  readonly maxPages?: number
}

/**
 * Race `work` against `signal`. The V2 client honours `signal`, but a pass bound must not depend on every client
 * doing so: the abort rejects here even when the request itself ignores it.
 */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(toError(signal.reason ?? new Error('aborted')))

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toError(signal.reason ?? new Error('aborted')))
    }
    signal.addEventListener('abort', onAbort, {once: true})
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(toError(error))
      },
    )
  })
}

function requestOptions(signal: AbortSignal | undefined): V2RequestOptions | undefined {
  return signal === undefined ? undefined : {signal}
}

async function fetchActive(api: V2SessionApi, signal: AbortSignal | undefined): Promise<ReadonlySet<string>> {
  if (signal?.aborted === true) throw toError(signal.reason ?? new Error('aborted'))
  const active: unknown = await raceAbort(api.active(requestOptions(signal)), signal)
  if (active === null || typeof active !== 'object' || Array.isArray(active)) {
    throw new Error('session.active returned a payload that is not an object keyed by session id')
  }
  return new Set(Object.keys(active))
}

/** Every session matching `input`, across pages. Throws when the page bound is hit, never returns a partial list. */
async function listAll(
  api: V2SessionApi,
  input: Omit<V2SessionListInput, 'cursor' | 'limit'>,
  signal: AbortSignal | undefined,
  options: V2ListOptions,
): Promise<readonly V2SessionInfoLike[]> {
  const pageSize = options.pageSize ?? DEFAULT_V2_LIST_PAGE_SIZE
  const maxPages = options.maxPages ?? DEFAULT_V2_LIST_MAX_PAGES

  const sessions: V2SessionInfoLike[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted === true) throw toError(signal.reason ?? new Error('aborted'))
    const response: unknown = await raceAbort(
      api.list({...input, limit: pageSize, ...(cursor === undefined ? {} : {cursor})}, requestOptions(signal)),
      signal,
    )
    const data = ownValue(response, 'data')
    if (!Array.isArray(data)) throw new Error('session.list returned a payload with no data array')

    for (const entry of data) {
      const id = getStringProperty(entry, 'id')
      if (id === null) continue
      sessions.push({
        id,
        parentID: getStringProperty(entry, 'parentID'),
        location: {directory: getStringProperty(getObjectProperty(entry, 'location'), 'directory') ?? undefined},
      })
    }

    const next = getStringProperty(getObjectProperty(response, 'cursor'), 'next')
    if (next === null) return sessions
    cursor = next
  }
  throw new Error(`session.list was still paging after ${maxPages} pages; refusing to act on a partial list`)
}

/**
 * Reconcile adapter over the V2 session API.
 *
 * - `liveSessionIds` is the global active list. A child absent from it has finished, or never started; the reconcile
 *   pass only acts on that after confirming the child through `children`.
 * - `children` is `session.list({parentID})`, followed across pages. A returned session whose `parentID` is not the
 *   asked-for parent is dropped, so a server-side filter slip cannot make a foreign session look like this tree's.
 *
 * Both return `Result` and never throw. An aborted `signal` fails the call even if the request ignores it.
 */
export function createV2LedgerReconcileAdapter(api: V2SessionApi, options: V2ListOptions = {}): LedgerReconcileAdapter {
  return {
    children: async (
      parentSessionId: string,
      signal?: AbortSignal,
    ): Promise<Result<readonly LedgerReconcileChild[], Error>> => {
      try {
        const sessions = await listAll(api, {parentID: parentSessionId}, signal, options)
        return ok(sessions.filter(session => session.parentID === parentSessionId).map(session => ({id: session.id})))
      } catch (error) {
        return err(toError(error))
      }
    },

    liveSessionIds: async (signal?: AbortSignal): Promise<Result<ReadonlySet<string>, Error>> => {
      try {
        return ok(await fetchActive(api, signal))
      } catch (error) {
        return err(toError(error))
      }
    },
  }
}

export interface DirectoryQuiescenceDeps {
  /** Canonicalises a path (`fs.realpath`). Injected so the join stays testable and I/O-free. */
  readonly realpath: (path: string) => Promise<string>
}

/**
 * Session ids that are running in `directory`: the global active list joined with `session.list({directory})`.
 *
 * `directory` is canonicalised first because the server compares it as an exact string (probe P9). That only works if
 * the sessions were created with the canonical path too; the caller must create them that way. A failed `realpath`
 * fails the call: falling back to the raw path would silently miss sessions and read as "quiet".
 *
 * Known limit (probe P12): a session that moved is listed under its destination, so it drops out of a join keyed on the
 * directory it started in. A run treats a move of an owned session as fatal (`mapV2EventStream`), it does not rely on
 * this join to notice.
 *
 * Nothing is listed when nothing is active, so an idle server costs one request.
 */
export async function listBusyV2SessionIdsInDirectory(
  api: V2SessionApi,
  directory: string,
  deps: DirectoryQuiescenceDeps,
  options: V2ListOptions & {readonly signal?: AbortSignal} = {},
): Promise<Result<ReadonlySet<string>, Error>> {
  const {signal, ...listOptions} = options
  try {
    const canonical = await deps.realpath(directory)
    const active = await fetchActive(api, signal)
    if (active.size === 0) return ok(new Set<string>())

    const inDirectory = await listAll(api, {directory: canonical}, signal, listOptions)
    return ok(new Set(inDirectory.map(session => session.id).filter(id => active.has(id))))
  } catch (error) {
    return err(toError(error))
  }
}
