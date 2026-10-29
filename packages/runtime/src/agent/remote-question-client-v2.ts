import type {V2FormField} from './event-v2.js'
import type {RemoteOpenCodeV2Client, V2CallError, V2FormValue} from './remote-client-v2.js'

/**
 * Answers to the model's `question` tool on OpenCode V2 (v2.2.0).
 *
 * V1 had `POST /question/{id}/reply`. V2 has no question route: the `question` tool asks a form
 * (`packages/core/src/tool/plugin/question.ts`) with `metadata.kind === 'question'` and one field per question, keyed
 * `q0`, `q1`, ... A `multiselect` field takes an array, any other field a single string. The tool reads a missing key
 * as "unanswered". A reply is `POST /api/session/:id/form/:formID/reply`; a cancel is `DELETE` on the same form. A
 * cancel without a message dismisses the question and ends the asking step, which is what a V1 reject did.
 *
 * This is the V2 sibling of `remote-question-client.ts`. The answer mapping lives here because the Action will need
 * the same one.
 */

/** The outcome of a reply or cancel. `error` is a call-error kind, never response text. */
export interface RemoteQuestionResponseV2 {
  readonly error?: V2CallError
}

export interface RemoteQuestionClientV2 {
  readonly answer: (input: {
    readonly sessionId: string
    readonly formId: string
    /** The form's fields, in question order. */
    readonly fields: readonly V2FormField[]
    readonly answers: readonly (readonly string[])[]
    readonly signal?: AbortSignal
  }) => Promise<RemoteQuestionResponseV2>
  readonly reject: (input: {
    readonly sessionId: string
    readonly formId: string
    readonly signal?: AbortSignal
  }) => Promise<RemoteQuestionResponseV2>
}

/**
 * Turn per-question answer lists into a form answer. Answers pair with fields by position. A question without an
 * answer gets no key, and answers past the last field are dropped.
 */
export function buildQuestionFormAnswer(
  fields: readonly V2FormField[],
  answers: readonly (readonly string[])[],
): Readonly<Record<string, V2FormValue>> {
  const answer: Record<string, V2FormValue> = {}
  for (const [index, field] of fields.entries()) {
    const values = answers[index] ?? []
    if (values.length === 0) continue
    if (field.type === 'multiselect') {
      answer[field.key] = [...values]
    } else {
      const first = values[0]
      if (first !== undefined) answer[field.key] = first
    }
  }
  return answer
}

export function createRemoteQuestionClientV2(client: RemoteOpenCodeV2Client): RemoteQuestionClientV2 {
  return {
    answer: async ({sessionId, formId, fields, answers, signal}) => {
      const result = await client.replyForm({
        sessionId,
        formId,
        answer: buildQuestionFormAnswer(fields, answers),
        ...(signal === undefined ? {} : {signal}),
      })
      return result.success ? {} : {error: result.error}
    },
    reject: async ({sessionId, formId, signal}) => {
      const result = await client.cancelForm({sessionId, formId, ...(signal === undefined ? {} : {signal})})
      return result.success ? {} : {error: result.error}
    },
  }
}
