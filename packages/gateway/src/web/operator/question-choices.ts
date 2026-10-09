/**
 * Parsing and mapping for the operator question-decision body.
 *
 * The body names options by index into the question's `options` (see
 * `QuestionAnswerChoice` in the operator contract), because the labels an
 * operator sees are bounded and control-stripped and can differ from the raw
 * labels the agent sent. `resolveQuestionAnswers` maps each index back to the
 * raw label, so the reply to OpenCode carries exactly the labels it asked for.
 *
 * Both functions are pure. Neither logs or returns question or answer text in an
 * error: failures are a reason code and a question index.
 */

import type {QuestionAnswers, QuestionInfo} from '../../approvals/question-registry.js'
import type {
  QuestionAnswerChoice,
  QuestionDecisionInvalidReason,
  QuestionDecisionRequest,
} from '../../operator-contract/question-frame.js'

/** Cap on questions and on indices per question. Far above anything real; the 64 KiB body limit is the byte bound. */
const MAX_ENTRIES = 256

export type ParsedDecisionBody =
  {readonly kind: 'ok'; readonly value: QuestionDecisionRequest} | {readonly kind: 'malformed'}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseChoice(raw: unknown): QuestionAnswerChoice | null {
  if (!isPlainObject(raw)) return null
  const {options, text} = raw
  if (text !== undefined && typeof text !== 'string') return null
  if (options === undefined) return text === undefined ? {} : {text}
  if (!Array.isArray(options) || options.length > MAX_ENTRIES) return null
  for (const index of options as unknown[]) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  }
  return {options: options as number[], ...(text === undefined ? {} : {text})}
}

/** Shape-check a decision body. Anything that is not exactly an answer or a skip is `malformed`. */
export function parseQuestionDecisionBody(body: unknown): ParsedDecisionBody {
  if (!isPlainObject(body)) return {kind: 'malformed'}
  if (body.decision === 'skip') return {kind: 'ok', value: {decision: 'skip'}}
  if (body.decision !== 'answer') return {kind: 'malformed'}
  const {answers} = body
  if (!Array.isArray(answers) || answers.length > MAX_ENTRIES) return {kind: 'malformed'}
  const choices: QuestionAnswerChoice[] = []
  for (const raw of answers as unknown[]) {
    const choice = parseChoice(raw)
    if (choice === null) return {kind: 'malformed'}
    choices.push(choice)
  }
  return {kind: 'ok', value: {decision: 'answer', answers: choices}}
}

export type ResolvedAnswers =
  | {readonly kind: 'ok'; readonly answers: QuestionAnswers}
  | {
      readonly kind: 'invalid'
      readonly reason: QuestionDecisionInvalidReason
      readonly questionIndex: number | null
    }

/**
 * Map per-question choices to the answer arrays the gate validates and OpenCode
 * receives: the raw label for each chosen index, then the free text if any.
 * Structural problems are reported here; whether free text is allowed, how many
 * values a question accepts, and the text length cap are left to the gate, so
 * the gate stays the single owner of those rules.
 */
export function resolveQuestionAnswers(
  questions: readonly QuestionInfo[],
  choices: readonly QuestionAnswerChoice[],
): ResolvedAnswers {
  if (choices.length !== questions.length) {
    return {kind: 'invalid', reason: 'arity-mismatch', questionIndex: null}
  }
  const answers: string[][] = []
  for (const [questionIndex, question] of questions.entries()) {
    const choice = choices[questionIndex] ?? {}
    const values: string[] = []
    const seen = new Set<number>()
    for (const optionIndex of choice.options ?? []) {
      const option = question.options[optionIndex]
      if (option === undefined) return {kind: 'invalid', reason: 'unknown-option', questionIndex}
      if (seen.has(optionIndex)) return {kind: 'invalid', reason: 'malformed', questionIndex}
      seen.add(optionIndex)
      values.push(option.label)
    }
    if (choice.text !== undefined && choice.text.length > 0) values.push(choice.text)
    answers.push(values)
  }
  return {kind: 'ok', answers}
}
