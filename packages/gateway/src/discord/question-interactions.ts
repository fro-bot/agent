/**
 * Discord interaction handling for agent questions.
 *
 * Handles the buttons, select menu and modal built in `questions.ts`. Every
 * decision goes through `questionRegistry.decide`, the same fail-closed gate the
 * web route uses, with a Discord actor scoped to the interaction's thread. This
 * module owns only the Discord specifics: acknowledging within Discord's 3-second
 * window, the authorization check, mapping option indices back to the raw labels
 * the registry holds, and turning gate outcomes into ephemeral replies.
 *
 * ### Order of operations
 *
 * - **Text button**: opens the modal at once. `showModal` must be the first
 *   response to the interaction, so it cannot wait on a role lookup; the modal
 *   carries no question content, and authorization is checked when it is submitted.
 * - **Everything else**: `deferReply({ephemeral: true})` first (acks within 3 s),
 *   then the authorization check, then the decision. All later responses use
 *   `editReply`.
 *
 * ### Untrusted text
 *
 * Replies are fixed copy and never echo an answer. Option labels are never read
 * from the interaction: the interaction names an option by index and the registry
 * supplies the raw label. The decision log line carries ids and an outcome or
 * reason code only — never question or answer text.
 */

import type {Guild} from 'discord.js'
import type {QuestionRegistry} from '../approvals/question-registry.js'
import type {GatewayLogger} from './client.js'
import type {RepliableInteractionTarget} from './io.js'
import type {ParsedQuestionCustomId} from './questions.js'

import {resolveQuestionAnswers} from '../web/operator/question-choices.js'
import {editInteractionAsync, replyInteractionAsync} from './io.js'
import {buildQuestionAnswerModal, MAX_SELECT_OPTIONS, QUESTION_MODAL_INPUT_ID} from './questions.js'

type ModalPayload = NonNullable<ReturnType<typeof buildQuestionAnswerModal>>

/** The slice of a button, select, or modal-submit interaction this handler uses. */
export interface QuestionInteractionLike extends RepliableInteractionTarget {
  readonly user: {readonly id: string}
  readonly guild: Guild | null
  readonly channelId: string | null
  readonly deferReply: (options: {readonly ephemeral: true}) => Promise<unknown>
  /** Buttons only. */
  readonly showModal?: (modal: ModalPayload) => Promise<unknown>
  /** String selects only: the chosen option values (indices). */
  readonly values?: readonly string[]
  /** Modal submits only. */
  readonly fields?: {readonly getTextInputValue: (customId: string) => string}
}

export interface QuestionInteractionDeps {
  readonly questionRegistry: Pick<QuestionRegistry, 'decide' | 'describeRequest'>
  /** The same role gate the mention and approval paths use. */
  readonly isAuthorized: (guild: Guild, userId: string, logger: GatewayLogger) => Promise<boolean>
  readonly logger: GatewayLogger
}

const NOT_PENDING = 'This question is no longer pending.'

function invalidReply(reason: string): string {
  switch (reason) {
    case 'text-too-long':
      return 'That answer is too long (the limit is 4,000 characters).'
    case 'unknown-option':
      return "That answer isn't allowed for this question."
    case 'multiple-not-allowed':
      return 'This question takes a single answer.'
    case 'empty-value':
      return 'The answer was empty.'
    default:
      return "That answer doesn't fit this question."
  }
}

/** Parse select values into option indices. `null` when any value is not a plain in-range index. */
function parseSelectIndices(values: readonly string[]): number[] | null {
  const indices: number[] = []
  for (const value of values) {
    if (!/^\d{1,2}$/.test(value)) return null
    const index = Number(value)
    if (index >= MAX_SELECT_OPTIONS) return null
    indices.push(index)
  }
  return indices
}

type DecisionInput =
  | {readonly kind: 'ready'; readonly decision: Parameters<QuestionRegistry['decide']>[0]['decision']}
  | {readonly kind: 'reply'; readonly content: string}

function buildDecision(
  parsed: ParsedQuestionCustomId,
  interaction: QuestionInteractionLike,
  registry: QuestionInteractionDeps['questionRegistry'],
): DecisionInput {
  if (parsed.action === 'skip') return {kind: 'ready', decision: {kind: 'skip'}}

  const request = registry.describeRequest(parsed.requestID)
  if (request === undefined) return {kind: 'reply', content: NOT_PENDING}

  let choice: {readonly options?: readonly number[]; readonly text?: string}
  if (parsed.action === 'option') {
    choice = {options: [parsed.optionIndex ?? -1]}
  } else if (parsed.action === 'select') {
    const indices = parseSelectIndices(interaction.values ?? [])
    if (indices === null || indices.length === 0) return {kind: 'reply', content: invalidReply('unknown-option')}
    choice = {options: indices}
  } else {
    const text = interaction.fields?.getTextInputValue(QUESTION_MODAL_INPUT_ID) ?? ''
    if (text.length === 0) return {kind: 'reply', content: invalidReply('empty-value')}
    choice = {text}
  }

  const resolved = resolveQuestionAnswers(request.questions, [choice])
  if (resolved.kind === 'invalid') return {kind: 'reply', content: invalidReply(resolved.reason)}
  return {kind: 'ready', decision: {kind: 'answer', answers: resolved.answers}}
}

/**
 * Handle one question interaction. Never rejects: every failure is logged by id
 * and answered with an ephemeral message.
 */
export async function handleQuestionInteraction(
  interaction: QuestionInteractionLike,
  parsed: ParsedQuestionCustomId,
  deps: QuestionInteractionDeps,
): Promise<void> {
  const {questionRegistry, isAuthorized, logger} = deps
  const {requestID} = parsed
  const log: GatewayLogger = {
    debug: (meta, msg) => logger.debug({requestID, ...meta}, msg),
    info: (meta, msg) => logger.info({requestID, ...meta}, msg),
    warn: (meta, msg) => logger.warn({requestID, ...meta}, msg),
    error: (meta, msg) => logger.error({requestID, ...meta}, msg),
  }

  try {
    // ── Text button: open the modal immediately (see module doc) ───────────
    if (parsed.action === 'text') {
      const modal = buildQuestionAnswerModal(requestID)
      if (questionRegistry.describeRequest(requestID) === undefined || modal === null) {
        await replyInteractionAsync(interaction, {content: NOT_PENDING, ephemeral: true}, log)
        return
      }
      if (interaction.showModal === undefined) {
        log.warn({reason: 'no-showModal'}, 'question-interaction: text button without a modal capability')
        return
      }
      await interaction.showModal(modal)
      return
    }

    // Defer FIRST: acks within Discord's 3 s window before any REST call.
    await interaction.deferReply({ephemeral: true})

    const guild = interaction.guild
    if (guild === null || !(await isAuthorized(guild, interaction.user.id, log))) {
      log.warn(
        {reason: 'unauthorized', discordUserId: interaction.user.id},
        'question-interaction: refused — user not authorized',
      )
      await editInteractionAsync(interaction, {content: 'Not authorized to answer this question.'}, log)
      return
    }

    const input = buildDecision(parsed, interaction, questionRegistry)
    if (input.kind === 'reply') {
      await editInteractionAsync(interaction, {content: input.content}, log)
      return
    }

    const threadId = interaction.channelId ?? ''
    const outcome = await questionRegistry.decide({
      requestID,
      scopeId: threadId,
      decision: input.decision,
      actor: {kind: 'discord-user', userId: interaction.user.id},
    })

    // Structured decision record, mirroring the web route's question.decision / question.rejected audit
    // events. The web events require a GitHub user id, which a Discord actor does not have, so this is a
    // log line with the same ids and outcome vocabulary — never question or answer text.
    const record = {family: 'question', surface: 'discord', threadId, discordUserId: interaction.user.id}
    if (outcome.kind === 'ok') {
      log.info(
        {kind: 'question.decision', ...record, outcome: input.decision.kind === 'skip' ? 'skipped' : 'answered'},
        'audit: question.decision',
      )
    } else {
      const reason =
        outcome.kind === 'scope-mismatch'
          ? 'scope_mismatch'
          : outcome.kind === 'already-claimed'
            ? 'already_claimed'
            : outcome.kind === 'not-found'
              ? 'not_found'
              : outcome.kind === 'reply-failed'
                ? 'reply_failed'
                : 'invalid'
      const level = reason === 'invalid' || reason === 'reply_failed' || reason === 'scope_mismatch' ? 'warn' : 'info'
      log[level]({kind: 'question.rejected', ...record, reason}, 'audit: question.rejected')
    }

    let content: string
    switch (outcome.kind) {
      case 'ok':
        content =
          input.decision.kind === 'skip' ? 'Skipped — the agent will continue without an answer.' : 'Answer recorded.'
        break
      case 'not-found':
        content = NOT_PENDING
        break
      case 'scope-mismatch':
        content = 'This question belongs to another thread.'
        break
      case 'already-claimed':
        content = 'Already being answered.'
        break
      case 'reply-failed':
        content = 'Failed to record the answer, try again.'
        break
      case 'invalid':
        content = invalidReply(outcome.reason)
        break
    }
    await editInteractionAsync(interaction, {content}, log)
  } catch (error: unknown) {
    log.error(
      {errName: error instanceof Error ? error.name : 'non-error'},
      'question-interaction: unexpected error handling interaction',
    )
    // editInteraction catches internally and returns a Result — never throws.
    await editInteractionAsync(interaction, {content: 'Failed to record the answer, try again.'}, log)
  }
}
