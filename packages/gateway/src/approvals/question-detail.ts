/**
 * Question detail bounding helpers.
 *
 * Applied at the operator frame/DTO build site, never in the registry: the
 * registry and Discord keep raw values, so only the operator-facing surfaces
 * (SSE frames and the pending-question listing) are bounded here.
 *
 * Guarantees per string:
 *  - Length-capped at the field's cap (UTF-16 code units; a cut never leaves a
 *    lone high surrogate behind).
 *  - Control characters removed so the value cannot inject ANSI escapes or
 *    hostile sequences: C0 (U+0000–U+001F), DEL, and C1 (U+0080–U+009F). Tab,
 *    CR, and LF become a single space instead of vanishing, so a multi-line
 *    question does not glue words together. Unicode bidirectional overrides and
 *    isolates (U+202A–U+202E, U+2066–U+2069) are removed so an option label
 *    cannot visually reorder itself.
 *  - Otherwise verbatim. Nothing is escaped, rendered, or interpreted as HTML
 *    or Markdown: `<img src=x onerror=alert(1)>` stays that exact string.
 *    Consumers render it inertly (see `operator-contract/question-frame.ts`).
 *
 * A bounded string can differ from the raw one. Option labels double as answer
 * values, so the caps leave generous room over what the tool asks for (labels
 * are meant to be a few words); a label that bounding altered will not match
 * the registry's raw label when submitted back.
 */

import type {QuestionPromptDetail, QuestionRequestDetail} from '../operator-contract/question-frame.js'
import type {QuestionInfo} from './question-registry.js'

// ---------------------------------------------------------------------------
// Field caps (UTF-16 code units)
// ---------------------------------------------------------------------------

/** The tool asks for a header of at most ~30 characters; 128 leaves room without letting a header act as a body. */
export const QUESTION_HEADER_MAX_LENGTH = 128

/** Same cap as approval detail (~4 KB) and Discord's embed-description limit, so one surface never shows more than another could. */
export const QUESTION_TEXT_MAX_LENGTH = 4096

/** Labels are a few words, but double as the answer value, so truncation must be a rarity: 256 is far above normal. */
export const QUESTION_OPTION_LABEL_MAX_LENGTH = 256

/** Descriptions are a sentence; 1,024 matches Discord's embed-field-value limit. */
export const QUESTION_OPTION_DESCRIPTION_MAX_LENGTH = 1024

// Characters removed outright: C0 minus tab/LF/CR, DEL, C1, bidi overrides/isolates.
// eslint-disable-next-line no-control-regex
const REMOVED_CONTROLS = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g
// Whitespace controls collapse to one space each.
const WHITESPACE_CONTROLS = /[\t\n\r]/g

/**
 * Strip control characters and cap the length. Pure; the same input always
 * yields the same output. An empty string stays empty.
 */
export function boundQuestionText(value: string, maxLength: number): string {
  const stripped = value.replaceAll(WHITESPACE_CONTROLS, ' ').replaceAll(REMOVED_CONTROLS, '')
  if (stripped.length <= maxLength) return stripped

  let end = maxLength
  // Do not cut between the halves of a surrogate pair.
  const lastKept = stripped.charCodeAt(end - 1)
  if (lastKept >= 0xd800 && lastKept <= 0xdb_ff) end -= 1
  return stripped.slice(0, end)
}

function toPromptDetail(question: QuestionInfo): QuestionPromptDetail {
  return {
    header: boundQuestionText(question.header, QUESTION_HEADER_MAX_LENGTH),
    text: boundQuestionText(question.question, QUESTION_TEXT_MAX_LENGTH),
    options: question.options.map(option => ({
      label: boundQuestionText(option.label, QUESTION_OPTION_LABEL_MAX_LENGTH),
      description: boundQuestionText(option.description, QUESTION_OPTION_DESCRIPTION_MAX_LENGTH),
    })),
    multiple: question.multiple,
    custom: question.custom,
  }
}

/**
 * Build the bounded, operator-facing form of a pending question request. Used
 * for both the SSE open frame and the pending-question listing, so the two
 * cannot drift. `multiple` and `custom` are the registry's normalized booleans.
 */
export function toQuestionRequestDetail(requestID: string, questions: readonly QuestionInfo[]): QuestionRequestDetail {
  return {requestID, questions: questions.map(toPromptDetail)}
}
