/**
 * Discord agent-question UI primitives.
 *
 * Pure builders and a custom-id codec — no Discord client, no network. The
 * question counterpart of `approvals.ts`.
 *
 * ### What fits in Discord
 *
 * One prompt message carries at most 5 action rows of 5 buttons or one select
 * menu, a select menu holds at most 25 options, and a modal holds 5 inputs.
 * `planQuestionPrompt` renders the shapes that fit natively and reports
 * everything else as a `fallback`, which the transport turns into a notice that
 * points to the operator web surface. It never renders a partial prompt.
 *
 * - **One question, not `multiple`, at most 20 options**: one button per option
 *   (5 per row, at most 4 rows) plus a control row.
 * - **One question, not `multiple`, 21–25 options; or `multiple` with at most
 *   25 options**: one string select (`maxValues` = option count when `multiple`,
 *   else 1) plus a control row.
 * - **Control row**: Skip, plus "Answer with text…" when the question allows a
 *   custom answer. That button opens a one-input modal (4,000 characters).
 * - **Fallback**: more than one question, more than 25 options, an option with
 *   no usable label, or a custom id the codec refuses.
 *
 * ### Custom ids
 *
 * `fb-q:<action>:<requestID>` or `fb-q:o:<requestID>:<optionIndex>`. Actions:
 * `o` option button, `s` select, `k` skip, `t` text button, `m` modal. Ids carry
 * a request id and an index only — never a label or any question text — and the
 * codec refuses anything over Discord's 100-character limit.
 *
 * ### Untrusted text
 *
 * Question text, option labels and descriptions, and answers are untrusted plain
 * text. They are bounded with the `question-detail` helpers and, wherever Discord
 * renders markdown (embeds), escaped with `escapeMarkdown`. Button and select
 * labels are plain text and are only bounded. Nothing here can ping anyone: every
 * send and edit goes through `discord/io.ts`, which always applies
 * `allowedMentions: {parse: []}`, and the prompt text lives in embeds, which never
 * notify.
 */

import type {APIEmbedField} from 'discord.js'
import type {QuestionAnswers, QuestionInfo, QuestionSettlement} from '../approvals/question-registry.js'

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import {boundQuestionText} from '../approvals/question-detail.js'
import {QUESTION_ANSWER_MAX_LENGTH} from '../approvals/question-registry.js'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const CUSTOM_ID_MAX = 100
/** Buttons per row and rows per message (Discord). One row is kept for the controls. */
const BUTTONS_PER_ROW = 5
const MAX_OPTION_ROWS = 4
/** Largest option count rendered as buttons (4 rows of 5). */
export const MAX_BUTTON_OPTIONS = BUTTONS_PER_ROW * MAX_OPTION_ROWS
/** Largest option count a string select holds (Discord). */
export const MAX_SELECT_OPTIONS = 25

const BUTTON_LABEL_MAX = 80
const SELECT_LABEL_MAX = 100
const SELECT_DESCRIPTION_MAX = 100

const EMBED_TITLE_HEADER_MAX = 100
/** Pre-escape cap; escaping at most doubles a string, so this stays under the 4,096 description limit. */
const EMBED_QUESTION_MAX = 1800
const EMBED_DESCRIPTION_BUDGET = 3900
const EMBED_OPTION_DESCRIPTION_MAX = 100
const SETTLED_ANSWER_ITEM_MAX = 500
const SETTLED_ANSWER_FIELD_MAX = 1000

/** Characters allowed in a request id that goes into a custom id, so parsing is unambiguous. */
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/

export const QUESTION_PREFIX = 'fb-q:'
/** Custom id of the single text input inside the answer modal. */
export const QUESTION_MODAL_INPUT_ID = 'answer'

// ---------------------------------------------------------------------------
// Custom-id codec
// ---------------------------------------------------------------------------

export type QuestionAction = 'option' | 'select' | 'skip' | 'text' | 'modal'

const ACTION_CODE: Readonly<Record<QuestionAction, string>> = {
  option: 'o',
  select: 's',
  skip: 'k',
  text: 't',
  modal: 'm',
}

const CODE_ACTION: Readonly<Record<string, QuestionAction>> = {
  o: 'option',
  s: 'select',
  k: 'skip',
  t: 'text',
  m: 'modal',
}

export interface ParsedQuestionCustomId {
  readonly action: QuestionAction
  readonly requestID: string
  /** Present only for `option`. */
  readonly optionIndex?: number
}

/**
 * Build a question custom id, or `null` when the id cannot be built safely: the
 * request id is empty, has characters outside the id alphabet, or the result
 * would pass Discord's 100-character limit. The caller takes the web fallback
 * on `null`. An `option` action requires `optionIndex`.
 */
export function buildQuestionCustomId(action: QuestionAction, requestID: string, optionIndex?: number): string | null {
  if (!REQUEST_ID_PATTERN.test(requestID)) return null
  const base = `${QUESTION_PREFIX}${ACTION_CODE[action]}:${requestID}`
  let id = base
  if (action === 'option') {
    if (optionIndex === undefined || !Number.isInteger(optionIndex) || optionIndex < 0) return null
    id = `${base}:${optionIndex}`
  }
  return id.length > CUSTOM_ID_MAX ? null : id
}

/** Parse a custom id back into its parts. `null` for any id that is not a well-formed question id. Never throws. */
export function parseQuestionCustomId(customId: string): ParsedQuestionCustomId | null {
  if (typeof customId !== 'string' || !customId.startsWith(QUESTION_PREFIX)) return null
  const rest = customId.slice(QUESTION_PREFIX.length)
  const action = CODE_ACTION[rest.slice(0, 1)]
  if (action === undefined || rest.charAt(1) !== ':') return null
  const body = rest.slice(2)
  if (action === 'option') {
    const split = body.lastIndexOf(':')
    if (split <= 0) return null
    const requestID = body.slice(0, split)
    const indexText = body.slice(split + 1)
    if (!REQUEST_ID_PATTERN.test(requestID) || !/^\d{1,3}$/.test(indexText)) return null
    return {action, requestID, optionIndex: Number(indexText)}
  }
  if (!REQUEST_ID_PATTERN.test(body)) return null
  return {action, requestID: body}
}

// ---------------------------------------------------------------------------
// Prompt planning
// ---------------------------------------------------------------------------

export type QuestionFallbackReason = 'multi-question' | 'too-many-options' | 'unusable-option' | 'custom-id'

export type QuestionPromptPlan =
  | {
      readonly kind: 'prompt'
      readonly embed: EmbedBuilder
      readonly components: readonly ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]
    }
  | {readonly kind: 'fallback'; readonly reason: QuestionFallbackReason}

/**
 * Escape untrusted text for a markdown-rendering surface. Beyond the default set this turns on
 * masked links (`[text](url)` would otherwise render as a clickable link with attacker-chosen
 * text), headings, and list markers, so the text reads as the plain text it is.
 */
function escapeText(text: string): string {
  return escapeMarkdown(text, {maskedLink: true, heading: true, bulletedList: true, numberedList: true})
}

function boundedLabel(label: string, max: number): string {
  return boundQuestionText(label, max).trim()
}

function promptEmbed(question: QuestionInfo, showOptionDescriptions: boolean): EmbedBuilder {
  const header = boundQuestionText(question.header, EMBED_TITLE_HEADER_MAX).trim()
  const text = boundQuestionText(question.question, EMBED_QUESTION_MAX).trim()
  let description = escapeText(text.length === 0 ? '(no question text)' : text)

  if (showOptionDescriptions) {
    const lines: string[] = []
    for (const [index, option] of question.options.entries()) {
      const detail = boundQuestionText(option.description, EMBED_OPTION_DESCRIPTION_MAX).trim()
      if (detail.length === 0) continue
      const label = escapeText(boundedLabel(option.label, BUTTON_LABEL_MAX))
      lines.push(`${index + 1}. **${label}** — ${escapeText(detail)}`)
    }
    let used = description.length
    const kept: string[] = []
    for (const line of lines) {
      if (used + line.length + 1 > EMBED_DESCRIPTION_BUDGET) break
      kept.push(line)
      used += line.length + 1
    }
    if (kept.length > 0) description = `${description}\n\n${kept.join('\n')}`
    if (kept.length < lines.length) description = `${description}\n…`
  }

  return new EmbedBuilder()
    .setTitle(header.length === 0 ? '❓ Agent question' : `❓ ${escapeText(header)}`)
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({text: 'If nobody answers in time, the question is skipped and the agent continues.'})
    .setTimestamp()
}

/**
 * Plan the Discord prompt for a question request: either a native prompt (embed
 * plus components) or a reason to use the web fallback notice. Pure.
 */
export function planQuestionPrompt(requestID: string, questions: readonly QuestionInfo[]): QuestionPromptPlan {
  const [question] = questions
  if (questions.length !== 1 || question === undefined) return {kind: 'fallback', reason: 'multi-question'}

  const count = question.options.length
  if (count > MAX_SELECT_OPTIONS) return {kind: 'fallback', reason: 'too-many-options'}

  const labels = question.options.map(option => boundedLabel(option.label, BUTTON_LABEL_MAX))
  if (labels.some(label => label.length === 0)) return {kind: 'fallback', reason: 'unusable-option'}

  const useSelect = count > 0 && (question.multiple || count > MAX_BUTTON_OPTIONS)
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = []

  if (useSelect) {
    const customId = buildQuestionCustomId('select', requestID)
    if (customId === null) return {kind: 'fallback', reason: 'custom-id'}
    const select = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(question.multiple ? 'Choose one or more…' : 'Choose an option…')
      .setMinValues(1)
      .setMaxValues(question.multiple ? count : 1)
      .addOptions(
        question.options.map((option, index) => {
          const description = boundedLabel(option.description, SELECT_DESCRIPTION_MAX)
          return {
            // Values are indices, never labels; the label is display-only.
            value: String(index),
            label: boundedLabel(option.label, SELECT_LABEL_MAX),
            ...(description.length === 0 ? {} : {description}),
          }
        }),
      )
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select))
  } else {
    for (let start = 0; start < count; start += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder<ButtonBuilder>()
      for (let index = start; index < Math.min(start + BUTTONS_PER_ROW, count); index++) {
        const customId = buildQuestionCustomId('option', requestID, index)
        if (customId === null) return {kind: 'fallback', reason: 'custom-id'}
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(labels[index] ?? '')
            .setStyle(ButtonStyle.Primary),
        )
      }
      rows.push(row)
    }
  }

  const skipId = buildQuestionCustomId('skip', requestID)
  const textId = buildQuestionCustomId('text', requestID)
  if (skipId === null || textId === null) return {kind: 'fallback', reason: 'custom-id'}
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(skipId).setLabel('Skip').setStyle(ButtonStyle.Secondary),
  )
  if (question.custom) {
    controls.addComponents(
      new ButtonBuilder().setCustomId(textId).setLabel('Answer with text…').setStyle(ButtonStyle.Secondary),
    )
  }
  rows.push(controls)

  return {kind: 'prompt', embed: promptEmbed(question, !useSelect), components: rows}
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/** The free-text answer modal: one required paragraph input capped at the gate's answer length. */
export function buildQuestionAnswerModal(requestID: string): ModalBuilder | null {
  const customId = buildQuestionCustomId('modal', requestID)
  if (customId === null) return null
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Answer the agent question')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUESTION_MODAL_INPUT_ID)
          .setLabel('Your answer')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(QUESTION_ANSWER_MAX_LENGTH),
      ),
    )
}

// ---------------------------------------------------------------------------
// Fallback notice
// ---------------------------------------------------------------------------

/**
 * The notice posted when a request cannot be shown natively. Fixed copy: it never
 * carries question text. `operatorOrigin` is the gateway's configured public
 * operator origin (an `https://` origin), or `undefined` when none is configured.
 */
export function buildQuestionFallbackNotice(operatorOrigin: string | undefined): string {
  const where =
    operatorOrigin === undefined ? 'the operator web surface' : `the operator web surface (<${operatorOrigin}>)`
  return `❓ An agent question is waiting for an answer. It can't be shown here — answer it on ${where}. If nobody answers in time, it is skipped and the agent continues.`
}

/** The fixed copy a fallback notice is edited to once the question is resolved. */
export const QUESTION_FALLBACK_RESOLVED_NOTICE = '✅ The agent question was resolved.'

// ---------------------------------------------------------------------------
// Settled render
// ---------------------------------------------------------------------------

type SettlementActor = QuestionSettlement['actor']

function actorLabel(actor: SettlementActor): string | null {
  if (actor === null) return null
  if (actor.kind === 'discord-user') return /^\d{1,25}$/.test(actor.userId) ? `<@${actor.userId}>` : null
  const login = boundQuestionText(actor.login, 64).trim()
  return login.length === 0 ? null : escapeText(login)
}

function answerLines(answers: QuestionAnswers): string[] {
  const lines: string[] = []
  for (const values of answers) {
    for (const value of values) {
      const text = boundQuestionText(value, SETTLED_ANSWER_ITEM_MAX).trim()
      if (text.length > 0) lines.push(`• ${escapeText(text)}`)
    }
  }
  return lines
}

function answerField(answers: QuestionAnswers): APIEmbedField | null {
  const lines = answerLines(answers)
  if (lines.length === 0) return null
  let value = ''
  let kept = 0
  for (const line of lines) {
    if (value.length + line.length + 1 > SETTLED_ANSWER_FIELD_MAX) break
    value = value.length === 0 ? line : `${value}\n${line}`
    kept++
  }
  if (kept < lines.length) value = `${value}\n…`
  return {name: 'Answer', value, inline: false}
}

/**
 * The embed an answered/skipped/expired/cancelled prompt is edited to. Shows the
 * question and the outcome; the chosen labels and free text are bounded and
 * escaped. The caller removes the components.
 */
export function buildQuestionSettledEmbed(
  question: QuestionInfo | undefined,
  settlement: QuestionSettlement,
): EmbedBuilder {
  const by = actorLabel(settlement.actor)
  const field = settlement.reason === 'replied' ? answerField(settlement.answers) : null

  let title: string
  let color: number
  if (settlement.reason === 'replied') {
    if (field === null) {
      title = by === null ? '⏭️ Skipped' : `⏭️ Skipped by ${by}`
      color = 0x99aab5
    } else {
      title = by === null ? '✅ Answered' : `✅ Answered by ${by}`
      color = 0x57f287
    }
  } else if (settlement.reason === 'deadline') {
    title = '⏱️ Timed out — skipped'
    color = 0x99aab5
  } else if (settlement.reason === 'rejected') {
    title = '⛔ Cancelled'
    color = 0xed4245
  } else {
    title = '⚠️ Cancelled (run ended)'
    color = 0x99aab5
  }

  const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp()
  if (question !== undefined) {
    const header = boundQuestionText(question.header, EMBED_TITLE_HEADER_MAX).trim()
    const text = boundQuestionText(question.question, EMBED_QUESTION_MAX).trim()
    const quoted = [header.length === 0 ? null : `**${escapeText(header)}**`, escapeText(text)]
      .filter((part): part is string => part !== null && part.length > 0)
      .join('\n')
    if (quoted.length > 0) embed.setDescription(quoted)
  }
  if (field !== null) embed.addFields(field)
  return embed
}
