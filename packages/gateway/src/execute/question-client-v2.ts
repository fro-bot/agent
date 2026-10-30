/**
 * Question reply/reject effects for a run on OpenCode V2: the sibling of `question-client.ts`.
 *
 * V2 has no question route. The model's `question` tool asks a form, so a reply is a form reply and a reject is a form
 * cancel, both addressed by session id AND form id. The question registry hands the effects only a request id, which on
 * V2 is the form id. The run loop records each question form it forwards in a `FormDirectoryV2`; the effects read the
 * session and the field layout back from it. A form the directory does not hold is refused, never guessed at.
 *
 * Contract, as in V1: the effects never throw and never return response text. Every failure collapses to a short reason
 * code, because an error body can echo the question or answer text and must not reach logs.
 */

import type {RemoteOpenCodeV2Client, RemoteQuestionClientV2, V2FormField} from '@fro-bot/runtime'
import type {QuestionAnswers, QuestionEffectResult, QuestionSideEffects} from '../approvals/question-registry.js'

import {createRemoteQuestionClientV2} from '@fro-bot/runtime'

/** Per-call bound; a hung workspace must not pin a settlement. */
const QUESTION_CALL_TIMEOUT_MS = 10_000

export interface FormRecordV2 {
  readonly sessionId: string
  /** The form's fields in question order. */
  readonly fields: readonly V2FormField[]
}

/** The open question forms of one run, by form id. */
export interface FormDirectoryV2 {
  readonly remember: (formId: string, record: FormRecordV2) => void
  readonly lookup: (formId: string) => FormRecordV2 | undefined
  readonly forget: (formId: string) => void
}

export function createFormDirectoryV2(): FormDirectoryV2 {
  const forms = new Map<string, FormRecordV2>()
  return {
    remember: (formId, record) => {
      forms.set(formId, record)
    },
    lookup: formId => forms.get(formId),
    forget: formId => {
      forms.delete(formId)
    },
  }
}

export interface QuestionEffectsV2Options {
  readonly client: RemoteOpenCodeV2Client
  readonly forms: FormDirectoryV2
  /** Override for tests; defaults to a question client over `client`. */
  readonly questionClient?: RemoteQuestionClientV2
}

export function createQuestionEffectsV2(options: QuestionEffectsV2Options): QuestionSideEffects {
  const {forms} = options
  const questionClient = options.questionClient ?? createRemoteQuestionClientV2(options.client)

  async function settle(
    formId: string,
    call: (record: ReturnType<FormDirectoryV2['lookup']> & object) => Promise<{readonly error?: unknown}>,
  ): Promise<QuestionEffectResult> {
    const record = forms.lookup(formId)
    if (record === undefined) return {ok: false, error: 'unknown-form'}
    try {
      const response = await call(record)
      return response.error == null ? {ok: true} : {ok: false, error: 'sdk-error'}
    } catch {
      return {ok: false, error: 'sdk-threw'}
    }
  }

  return {
    replyQuestion: async (requestID: string, answers: QuestionAnswers) =>
      settle(requestID, async record =>
        questionClient.answer({
          sessionId: record.sessionId,
          formId: requestID,
          fields: record.fields,
          answers,
          signal: AbortSignal.timeout(QUESTION_CALL_TIMEOUT_MS),
        }),
      ),
    rejectQuestion: async (requestID: string) =>
      settle(requestID, async record =>
        questionClient.reject({
          sessionId: record.sessionId,
          formId: requestID,
          signal: AbortSignal.timeout(QUESTION_CALL_TIMEOUT_MS),
        }),
      ),
  }
}
