/**
 * Question reply/reject effects for a run, backed by the OpenCode v2 SDK.
 *
 * The run's OpenCode handle is the v1 client, and question reply/reject exist
 * only on the v2 SDK. This module builds the two effects the question registry
 * injects, from a v2 client that shares the v1 handle's base URL and bearer
 * header (both through `workspaceAuthHeaders`) and the run's canonical
 * workspace directory.
 *
 * Contract: the effects never throw and never return the SDK's error text.
 * They check `response.error` explicitly (the SDK reports HTTP failures in that
 * field) and collapse every failure to a short reason code, because an error
 * body can echo the question or answer text and must not reach logs.
 */

import type {RemoteQuestionClient} from '@fro-bot/runtime'
import type {QuestionAnswers, QuestionEffectResult, QuestionSideEffects} from '../approvals/question-registry.js'

import {createRemoteQuestionClient} from '@fro-bot/runtime'
import {workspaceAuthHeaders} from './workspace-auth.js'

/** Per-call bound; a hung workspace must not pin a settlement. */
const QUESTION_CALL_TIMEOUT_MS = 10_000

export interface QuestionEffectsOptions {
  readonly baseURL: string
  /** Bearer secret for the workspace proxy. Never logged. */
  readonly token: string
  /** Canonical workspace directory the run's session lives in. */
  readonly directory: string
  /** Override for tests; defaults to a v2 client built from `baseURL` and `token`. */
  readonly client?: RemoteQuestionClient
}

async function settle(call: () => Promise<{readonly error?: unknown}>): Promise<QuestionEffectResult> {
  try {
    const response = await call()
    return response.error == null ? {ok: true} : {ok: false, error: 'sdk-error'}
  } catch {
    return {ok: false, error: 'sdk-threw'}
  }
}

export function createQuestionEffects(options: QuestionEffectsOptions): QuestionSideEffects {
  const {baseURL, token, directory} = options
  const client = options.client ?? createRemoteQuestionClient(baseURL, workspaceAuthHeaders(token))

  return {
    replyQuestion: async (requestID: string, answers: QuestionAnswers) =>
      settle(async () =>
        client.answer({requestID, directory, answers, signal: AbortSignal.timeout(QUESTION_CALL_TIMEOUT_MS)}),
      ),
    rejectQuestion: async (requestID: string) =>
      settle(async () => client.reject({requestID, directory, signal: AbortSignal.timeout(QUESTION_CALL_TIMEOUT_MS)})),
  }
}
