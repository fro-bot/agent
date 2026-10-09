import {createOpencodeClient} from '@opencode-ai/sdk/v2/client'

/**
 * Outcome of a question reply/reject call. `error` is the SDK's `response.error`
 * field (null/undefined on success); a transport failure is thrown instead.
 */
export interface RemoteQuestionResponse {
  readonly error?: unknown
}

/**
 * Narrow client over the OpenCode v2 `question` endpoints.
 *
 * Question reply and reject exist only on the v2 SDK (`POST /question/{id}/reply`
 * and `/reject`); the v1 client used for the run's other calls does not expose
 * them. Both calls carry the workspace `directory` — OpenCode routes the request
 * to the instance that owns the pending question by directory, so omitting it
 * can resolve against the wrong instance.
 */
export interface RemoteQuestionClient {
  readonly answer: (input: {
    readonly requestID: string
    readonly directory: string
    readonly answers: readonly (readonly string[])[]
    readonly signal?: AbortSignal
  }) => Promise<RemoteQuestionResponse>
  readonly reject: (input: {
    readonly requestID: string
    readonly directory: string
    readonly signal?: AbortSignal
  }) => Promise<RemoteQuestionResponse>
}

/**
 * Create a question client for a remote OpenCode server.
 *
 * @param baseUrl  Base URL of the remote server.
 * @param headers  HTTP headers merged onto every request (e.g. the bearer token).
 */
export function createRemoteQuestionClient(
  baseUrl: string,
  headers: Readonly<Record<string, string>> = {},
): RemoteQuestionClient {
  const client = createOpencodeClient({baseUrl, headers})
  return {
    answer: async ({requestID, directory, answers, signal}) => {
      const response = await client.question.reply(
        {requestID, directory, answers: answers.map(values => [...values])},
        signal === undefined ? undefined : {signal},
      )
      return {error: response.error}
    },
    reject: async ({requestID, directory, signal}) => {
      const response = await client.question.reject({requestID, directory}, signal === undefined ? undefined : {signal})
      return {error: response.error}
    },
  }
}
