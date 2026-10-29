import type {Result} from '@bfra.me/es/result'
import type {V2RequestOptions, V2SessionApi, V2SessionListInput, V2SessionListPage} from './ledger-reconcile-v2.js'
import type {V2ShellStatus} from './shell-notice.js'

import {err, ok} from '@bfra.me/es/result'
import {getNumberProperty, getObjectProperty, getStringProperty} from './payload-accessors.js'
import {isShellStatus} from './shell-notice.js'

/**
 * Client for an OpenCode V2 (v2.2.0) server reached through a proxy that injects the server's own credentials.
 *
 * This is the V2 sibling of `remote-client.ts`. The gateway does not spawn the server: it holds a bearer token for the
 * workspace proxy and sends it on every request. There is no SDK here. The V2 server speaks `/api/*` over plain HTTP,
 * so each call is one `fetch` against a route in `packages/protocol/src/groups/{session,permission,event}.ts` at
 * `anomalyco/opencode@v2.2.0`:
 *
 * - `POST /api/session` creates a session (`location` in the body).
 * - `POST /api/session/:id/prompt` admits a prompt (`text` at the top level of the body).
 * - `POST /api/session/:id/interrupt` interrupts an active execution. `{interrupted: false}` means "nothing active was
 *   interrupted", which is also what a prompt that is not admitted yet looks like (probe P1), so callers never read
 *   it as a stop.
 * - `GET /api/session/:id` carries `outcome`, the persisted result of the last execution that ended. A `shutdown`
 *   interrupt does not write it (`packages/core/src/session/projector.ts`, `projectIdle`).
 * - `GET /api/session/active` and `GET /api/session` back the ledger adapter (`ledger-reconcile-v2.ts`).
 * - `POST /api/session/:id/permission/:requestID/reply` takes `{decision: 'once' | 'always' | 'reject'}`.
 * - `POST /api/session/:id/form/:formID/reply` takes `{answer}`; `DELETE /api/session/:id/form/:formID?message=` cancels.
 * - `GET /api/shell`, `GET /api/shell/:id` and `DELETE /api/shell/:id` (`groups/shell.ts`) read and stop background shells.
 *   They are location-scoped: the location rides in `x-opencode-directory`, and a DELETE in another location is a
 *   silent 204 that kills nothing.
 * - `GET /api/event` is the SSE stream for every location on the server; it starts with `server.connected`.
 *
 * Failures come back as a `V2CallError`. The error never carries a response body, a header or the request URL: a body
 * can echo model or user text, and the URL can carry ids that do not belong in a log.
 */

export type V2CallError =
  | {readonly kind: 'auth'; readonly status: number}
  | {readonly kind: 'http'; readonly status: number}
  | {readonly kind: 'network'; readonly message: string}
  | {readonly kind: 'parse'}
  | {readonly kind: 'aborted'}

export type V2PermissionDecision = 'always' | 'once' | 'reject'

export type V2FormValue = boolean | number | string | readonly string[]

export type V2SessionOutcome = 'failed' | 'interrupted' | 'succeeded'

export interface V2SessionSummary {
  readonly id: string
  readonly parentId: string | null
  readonly directory: string | null
  /** The persisted outcome of the last execution that ended, or `null` when none has. */
  readonly outcome: V2SessionOutcome | null
}

export interface V2ShellSummary {
  readonly id: string
  /** `unknown` for a status this client does not know: never read as stopped. */
  readonly status: V2ShellStatus | 'unknown'
  /** `info.metadata.sessionID`: the session that started the shell. `null` when nobody tagged it. */
  readonly ownerSessionId: string | null
  /** Present on `GET /api/shell` and `GET /api/shell/:id`; absent on the `shell.created` frame. */
  readonly pid: number | null
}

/**
 * Stand-in frame for an SSE comment line (the server sends `: heartbeat` every 15 s, probe P14). A comment carries no
 * event but proves the stream is alive, so the transport surfaces it. The event mapper ignores it.
 */
export const V2_HEARTBEAT_FRAME = {type: 'server.heartbeat'} as const

/**
 * What the event stream throws for a data frame whose JSON cannot be parsed. A frame that cannot be read has no type, so
 * nothing can say whether it was a request somebody has to answer: the stream ends, and the consumer treats that as a
 * lost connection. The message carries nothing from the payload.
 */
const V2_UNREADABLE_FRAME_MESSAGE = 'OpenCode V2 event stream carried a data frame that could not be parsed'

export interface RemoteOpenCodeV2ClientOptions {
  /** Base URL of the proxy (no trailing path). */
  readonly baseUrl: string
  /** Headers merged onto every request, including the bearer token. Never logged. */
  readonly headers?: Readonly<Record<string, string>>
  /** Test seam. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
}

export interface RemoteOpenCodeV2Client {
  /** The ledger adapter's view of the session API. `active` and `list` throw when the request fails. */
  readonly session: V2SessionApi
  readonly createSession: (input: {
    readonly directory: string
    readonly signal?: AbortSignal
  }) => Promise<Result<{readonly id: string}, V2CallError>>
  readonly getSession: (input: {
    readonly sessionId: string
    readonly signal?: AbortSignal
  }) => Promise<Result<V2SessionSummary, V2CallError>>
  readonly prompt: (input: {
    readonly sessionId: string
    readonly text: string
    readonly directory: string
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  readonly interrupt: (input: {
    readonly sessionId: string
    readonly signal?: AbortSignal
  }) => Promise<Result<{readonly interrupted: boolean}, V2CallError>>
  /** Resolves once the response headers arrive. The first frame the stream yields is `server.connected`. */
  readonly subscribeEvents: (input: {
    readonly directory: string
    readonly signal?: AbortSignal
  }) => Promise<Result<AsyncIterable<unknown>, V2CallError>>
  readonly replyPermission: (input: {
    readonly sessionId: string
    readonly requestId: string
    readonly decision: V2PermissionDecision
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  readonly replyForm: (input: {
    readonly sessionId: string
    readonly formId: string
    readonly answer: Readonly<Record<string, V2FormValue>>
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  readonly cancelForm: (input: {
    readonly sessionId: string
    readonly formId: string
    readonly message?: string
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  /**
   * The RUNNING shells of a location (exited ones are not listed). A list that cannot be read in full is a `parse`
   * failure, never a shorter list: a shell that did not make it into the answer would read as stopped.
   */
  readonly listShells: (input: {
    readonly directory: string
    readonly signal?: AbortSignal
  }) => Promise<Result<readonly V2ShellSummary[], V2CallError>>
  /** One shell, running or exited (the server retains the last 25 exited per location). Unknown or evicted: `http 404`. */
  readonly getShell: (input: {
    readonly directory: string
    readonly shellId: string
    readonly signal?: AbortSignal
  }) => Promise<Result<V2ShellSummary, V2CallError>>
  /**
   * Kill and remove a shell. Answers 204 for an unknown id too, so success means "the request was accepted", never
   * "the process is gone": confirm with `listShells`. The job ends as `error` and its notice WAKES the owning session.
   */
  readonly deleteShell: (input: {
    readonly directory: string
    readonly shellId: string
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
}

interface RequestInput {
  readonly method: 'DELETE' | 'GET' | 'POST'
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly directory?: string
  readonly signal?: AbortSignal
  readonly accept?: string
}

function describeCallError(error: V2CallError): string {
  switch (error.kind) {
    case 'auth':
    case 'http':
      return `${error.kind} ${error.status}`
    case 'network':
      return `network ${error.message}`
    case 'parse':
    case 'aborted':
      return error.kind
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readShell(value: unknown): V2ShellSummary | null {
  const id = getStringProperty(value, 'id')
  if (id === null || id.length === 0) return null
  const status = getStringProperty(value, 'status')
  return {
    id,
    status: isShellStatus(status) ? status : 'unknown',
    ownerSessionId: getStringProperty(getObjectProperty(value, 'metadata'), 'sessionID'),
    pid: getNumberProperty(value, 'pid'),
  }
}

function readOutcome(value: unknown): V2SessionOutcome | null {
  const outcome = getStringProperty(value, 'outcome')
  return outcome === 'succeeded' || outcome === 'failed' || outcome === 'interrupted' ? outcome : null
}

/**
 * SSE blocks are separated by a blank line; a block of comment lines only is a heartbeat. Throws on a data block that is
 * not JSON.
 */
function readBlock(block: string): unknown {
  const lines = block.split('\n')
  const dataLines = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''))
  if (dataLines.length === 0) return lines.every(line => line.startsWith(':')) ? V2_HEARTBEAT_FRAME : null
  try {
    return JSON.parse(dataLines.join('\n'))
  } catch {
    throw new Error(V2_UNREADABLE_FRAME_MESSAGE)
  }
}

async function* readFrames(response: Response, signal: AbortSignal | undefined): AsyncGenerator<unknown> {
  const body = response.body
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      // The runtime's lib set has no DOM stream types, so the read result is typed here.
      const chunk = (await reader.read()) as {readonly done: boolean; readonly value?: Uint8Array}
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, {stream: true}).replaceAll('\r\n', '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = readBlock(block)
        if (frame !== null) yield frame
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    // An abort the caller asked for ends the stream; any other failure is a lost connection and propagates.
    if (signal?.aborted === true) return
    throw error
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

export function createRemoteOpenCodeV2Client(options: RemoteOpenCodeV2ClientOptions): RemoteOpenCodeV2Client {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const baseHeaders = options.headers ?? {}
  const doFetch = options.fetch ?? fetch

  async function send(input: RequestInput): Promise<Result<Response, V2CallError>> {
    const headers = new Headers(baseHeaders)
    if (input.body !== undefined) headers.set('content-type', 'application/json')
    if (input.accept !== undefined) headers.set('accept', input.accept)
    if (input.directory !== undefined) headers.set('x-opencode-directory', input.directory)
    const query = input.query === undefined ? '' : `?${new URLSearchParams(input.query).toString()}`
    try {
      const response = await doFetch(`${baseUrl}${input.path}${query}`, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : {body: JSON.stringify(input.body)}),
        ...(input.signal === undefined ? {} : {signal: input.signal}),
      })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined)
        return err({kind: 'auth', status: response.status})
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return err({kind: 'http', status: response.status})
      }
      return ok(response)
    } catch (error) {
      if (input.signal?.aborted === true) return err({kind: 'aborted'})
      return err({kind: 'network', message: error instanceof Error ? error.message : 'request failed'})
    }
  }

  async function sendJson(input: RequestInput): Promise<Result<unknown, V2CallError>> {
    const sent = await send({...input, accept: 'application/json'})
    if (!sent.success) return sent
    if (sent.data.status === 204) return ok(null)
    try {
      return ok(await sent.data.json())
    } catch {
      if (input.signal?.aborted === true) return err({kind: 'aborted'})
      return err({kind: 'parse'})
    }
  }

  async function sendNoContent(input: RequestInput): Promise<Result<undefined, V2CallError>> {
    const sent = await send(input)
    if (!sent.success) return sent
    await sent.data.body?.cancel().catch(() => undefined)
    return ok(undefined)
  }

  async function active(requestOptions?: V2RequestOptions): Promise<Readonly<Record<string, {readonly type: string}>>> {
    const result = await sendJson({
      method: 'GET',
      path: '/api/session/active',
      ...(requestOptions?.signal === undefined ? {} : {signal: requestOptions.signal}),
    })
    if (!result.success) throw new Error(`session.active failed: ${describeCallError(result.error)}`)
    const data = getObjectProperty(result.data, 'data')
    if (!isRecord(data)) throw new Error('session.active failed: parse')
    return data as Readonly<Record<string, {readonly type: string}>>
  }

  async function list(input: V2SessionListInput, requestOptions?: V2RequestOptions): Promise<V2SessionListPage> {
    const query: Record<string, string> = {}
    if (input.parentID !== undefined) query.parentID = input.parentID
    if (input.directory !== undefined) query.directory = input.directory
    if (input.cursor !== undefined) query.cursor = input.cursor
    if (input.limit !== undefined) query.limit = String(input.limit)
    const result = await sendJson({
      method: 'GET',
      path: '/api/session',
      query,
      ...(requestOptions?.signal === undefined ? {} : {signal: requestOptions.signal}),
    })
    if (!result.success) throw new Error(`session.list failed: ${describeCallError(result.error)}`)
    if (!isRecord(result.data) || !Array.isArray(result.data.data)) throw new Error('session.list failed: parse')
    return result.data as unknown as V2SessionListPage
  }

  return {
    session: {active, list},

    createSession: async ({directory, signal}) => {
      const result = await sendJson({
        method: 'POST',
        path: '/api/session',
        body: {location: {directory}},
        directory,
        ...(signal === undefined ? {} : {signal}),
      })
      if (!result.success) return result
      const id = getStringProperty(getObjectProperty(result.data, 'data'), 'id')
      return id === null ? err({kind: 'parse'}) : ok({id})
    },

    getSession: async ({sessionId, signal}) => {
      const result = await sendJson({
        method: 'GET',
        path: `/api/session/${encodeURIComponent(sessionId)}`,
        ...(signal === undefined ? {} : {signal}),
      })
      if (!result.success) return result
      const info = getObjectProperty(result.data, 'data')
      const id = getStringProperty(info, 'id')
      if (id === null) return err({kind: 'parse'})
      return ok({
        id,
        parentId: getStringProperty(info, 'parentID'),
        directory: getStringProperty(getObjectProperty(info, 'location'), 'directory'),
        outcome: readOutcome(info),
      })
    },

    prompt: async ({sessionId, text, directory, signal}) =>
      sendNoContent({
        method: 'POST',
        path: `/api/session/${encodeURIComponent(sessionId)}/prompt`,
        body: {text},
        directory,
        ...(signal === undefined ? {} : {signal}),
      }),

    interrupt: async ({sessionId, signal}) => {
      const result = await sendJson({
        method: 'POST',
        path: `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
        ...(signal === undefined ? {} : {signal}),
      })
      if (!result.success) return result
      const interrupted = isRecord(result.data) ? result.data.interrupted : undefined
      return typeof interrupted === 'boolean' ? ok({interrupted}) : err({kind: 'parse'})
    },

    subscribeEvents: async ({directory, signal}) => {
      const sent = await send({
        method: 'GET',
        path: '/api/event',
        accept: 'text/event-stream',
        directory,
        ...(signal === undefined ? {} : {signal}),
      })
      if (!sent.success) return sent
      if (sent.data.headers.get('content-type')?.toLowerCase().includes('text/event-stream') !== true) {
        await sent.data.body?.cancel().catch(() => undefined)
        return err({kind: 'parse'})
      }
      return ok(readFrames(sent.data, signal))
    },

    replyPermission: async ({sessionId, requestId, decision, signal}) =>
      sendNoContent({
        method: 'POST',
        path: `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        body: {decision},
        ...(signal === undefined ? {} : {signal}),
      }),

    replyForm: async ({sessionId, formId, answer, signal}) =>
      sendNoContent({
        method: 'POST',
        path: `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
        body: {answer},
        ...(signal === undefined ? {} : {signal}),
      }),

    cancelForm: async ({sessionId, formId, message, signal}) =>
      sendNoContent({
        method: 'DELETE',
        path: `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`,
        ...(message === undefined ? {} : {query: {message}}),
        ...(signal === undefined ? {} : {signal}),
      }),

    listShells: async ({directory, signal}) => {
      const result = await sendJson({
        method: 'GET',
        path: '/api/shell',
        directory,
        ...(signal === undefined ? {} : {signal}),
      })
      if (!result.success) return result
      const data = getObjectProperty(result.data, 'data')
      if (!Array.isArray(data)) return err({kind: 'parse'})
      const shells: V2ShellSummary[] = []
      for (const entry of data) {
        const shell = readShell(entry)
        if (shell === null) return err({kind: 'parse'})
        shells.push(shell)
      }
      return ok(shells)
    },

    getShell: async ({directory, shellId, signal}) => {
      const result = await sendJson({
        method: 'GET',
        path: `/api/shell/${encodeURIComponent(shellId)}`,
        directory,
        ...(signal === undefined ? {} : {signal}),
      })
      if (!result.success) return result
      const shell = readShell(getObjectProperty(result.data, 'data'))
      return shell === null ? err({kind: 'parse'}) : ok(shell)
    },

    deleteShell: async ({directory, shellId, signal}) =>
      sendNoContent({
        method: 'DELETE',
        path: `/api/shell/${encodeURIComponent(shellId)}`,
        directory,
        ...(signal === undefined ? {} : {signal}),
      }),
  }
}
