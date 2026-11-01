import type {Result} from '@bfra.me/es/result'
import type {
  RemoteOpenCodeV2Client,
  RemoteOpenCodeV2ClientOptions,
  V2CallError,
  V2ModelRef,
} from './remote-client-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {createRemoteOpenCodeV2Client} from './remote-client-v2.js'

/**
 * The routes only the Action's V2 loop calls, on top of the shared client.
 *
 * They are a separate factory on purpose: the gateway's workspace proxy allowlists exactly what
 * `createRemoteOpenCodeV2Client` sends (`gateway-routes-v2.ts`, with a drift guard), so a route added to that client
 * widens the privileged bearer proxy. These five routes are the Action's own, against a server it owns, and are never
 * allowlisted for the gateway.
 *
 * - `POST /api/session/:id/agent` and `/model` set the agent and model of a continued session. A new session takes
 *   them at creation (`createSession`).
 * - `POST /api/experimental/session/:id/wait` answers 204 once no execution of the session is active. It also answers
 *   at once for a prompt that is not admitted yet (probe P1) and says nothing about how an execution ended, so it is a
 *   hint and never a completion by itself.
 * - `PATCH /api/session/:id` re-asserts the title (V2 may regenerate it after the first prompt) and archives a session.
 * - `POST /api/session/:id/synthetic` with `resume: false` records a message in the transcript and starts no turn.
 *
 * Failures are a `V2CallError` that never carries a body, a header or the URL.
 */

export interface ActionOpenCodeV2Client extends RemoteOpenCodeV2Client {
  readonly switchAgent: (input: {
    readonly sessionId: string
    readonly agent: string
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  readonly switchModel: (input: {
    readonly sessionId: string
    readonly model: V2ModelRef
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  readonly waitSession: (input: {
    readonly sessionId: string
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  readonly updateSession: (input: {
    readonly sessionId: string
    readonly title?: string
    readonly archived?: boolean
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  readonly addSyntheticMessage: (input: {
    readonly sessionId: string
    readonly text: string
    readonly signal?: AbortSignal
  }) => Promise<Result<undefined, V2CallError>>
  /**
   * `GET /api/session/:id/message`: the newest page of the session's messages, user messages only, newest first. It is how
   * a caller learns whether a prompt whose acknowledgment was lost was admitted: admission is durable and synchronous, so
   * an admitted prompt is already a user message when the server answers (probed on the pinned binary).
   */
  readonly listRecentUserMessages: (input: {
    readonly sessionId: string
    readonly signal?: AbortSignal
  }) => Promise<Result<readonly V2UserMessage[], V2CallError>>
}

export interface V2UserMessage {
  readonly id: string
  readonly text: string
  /** Epoch milliseconds, the server's clock. */
  readonly createdAt: number
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--
  return value.slice(0, end)
}

export function createActionOpenCodeV2Client(options: RemoteOpenCodeV2ClientOptions): ActionOpenCodeV2Client {
  const base = createRemoteOpenCodeV2Client(options)
  const baseUrl = trimTrailingSlashes(options.baseUrl)
  const doFetch = options.fetch ?? fetch

  async function sendNoContent(input: {
    readonly method: 'PATCH' | 'POST'
    readonly path: string
    readonly body?: unknown
    readonly signal?: AbortSignal
  }): Promise<Result<undefined, V2CallError>> {
    const headers = new Headers(options.headers ?? {})
    if (input.body !== undefined) headers.set('content-type', 'application/json')
    try {
      const response = await doFetch(`${baseUrl}${input.path}`, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : {body: JSON.stringify(input.body)}),
        ...(input.signal === undefined ? {} : {signal: input.signal}),
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) return err({kind: 'auth', status: response.status})
      if (!response.ok) return err({kind: 'http', status: response.status})
      return ok(undefined)
    } catch (error) {
      if (input.signal?.aborted === true) return err({kind: 'aborted'})
      return err({kind: 'network', message: error instanceof Error ? error.message : 'request failed'})
    }
  }

  const toWireModel = (model: V2ModelRef): {readonly id: string; readonly providerID: string} => ({
    id: model.modelID,
    providerID: model.providerID,
  })
  const sessionPath = (sessionId: string): string => `/api/session/${encodeURIComponent(sessionId)}`

  return {
    ...base,

    switchAgent: async ({sessionId, agent, signal}) =>
      sendNoContent({
        method: 'POST',
        path: `${sessionPath(sessionId)}/agent`,
        body: {agent},
        ...(signal === undefined ? {} : {signal}),
      }),

    switchModel: async ({sessionId, model, signal}) =>
      sendNoContent({
        method: 'POST',
        path: `${sessionPath(sessionId)}/model`,
        body: {model: toWireModel(model)},
        ...(signal === undefined ? {} : {signal}),
      }),

    waitSession: async ({sessionId, signal}) =>
      sendNoContent({
        method: 'POST',
        path: `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`,
        ...(signal === undefined ? {} : {signal}),
      }),

    updateSession: async ({sessionId, title, archived, signal}) =>
      sendNoContent({
        method: 'PATCH',
        path: sessionPath(sessionId),
        body: {...(title === undefined ? {} : {title}), ...(archived === undefined ? {} : {archived})},
        ...(signal === undefined ? {} : {signal}),
      }),

    listRecentUserMessages: async ({sessionId, signal}) => {
      const headers = new Headers(options.headers ?? {})
      headers.set('accept', 'application/json')
      try {
        const response = await doFetch(`${baseUrl}${sessionPath(sessionId)}/message`, {
          method: 'GET',
          headers,
          ...(signal === undefined ? {} : {signal}),
        })
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined)
          return err({kind: 'auth', status: response.status})
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          return err({kind: 'http', status: response.status})
        }
        const body: unknown = await response.json()
        const data = typeof body === 'object' && body !== null ? (body as {data?: unknown}).data : undefined
        if (!Array.isArray(data)) return err({kind: 'parse'})
        const messages: V2UserMessage[] = []
        for (const item of data as unknown[]) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as {id?: unknown; type?: unknown; text?: unknown; time?: {created?: unknown}}
          if (record.type !== 'user' || typeof record.id !== 'string' || typeof record.text !== 'string') continue
          const created = record.time?.created
          if (typeof created !== 'number') continue
          messages.push({id: record.id, text: record.text, createdAt: created})
        }
        return ok(messages)
      } catch (error) {
        if (signal?.aborted === true) return err({kind: 'aborted'})
        return err({kind: 'network', message: error instanceof Error ? error.message : 'request failed'})
      }
    },

    addSyntheticMessage: async ({sessionId, text, signal}) =>
      sendNoContent({
        method: 'POST',
        path: `${sessionPath(sessionId)}/synthetic`,
        body: {text, resume: false},
        ...(signal === undefined ? {} : {signal}),
      }),
  }
}
