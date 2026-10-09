/**
 * Tests for the Discord question UI primitives: custom-id codec, prompt planning,
 * answer modal, fallback notice, and the settled embed.
 */

import type {ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder} from 'discord.js'
import type {QuestionInfo, QuestionSettlement} from '../approvals/question-registry.js'
import type {QuestionPromptPlan} from './questions.js'
import {describe, expect, it} from 'vitest'
import {QUESTION_TEXT_MAX_LENGTH} from '../approvals/question-detail.js'
import {
  buildQuestionAnswerModal,
  buildQuestionCustomId,
  buildQuestionFallbackNotice,
  buildQuestionSettledEmbed,
  MAX_BUTTON_OPTIONS,
  parseQuestionCustomId,
  planQuestionPrompt,
  QUESTION_MODAL_INPUT_ID,
} from './questions.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function question(overrides: Partial<QuestionInfo> = {}): QuestionInfo {
  return {
    question: 'Which environment?',
    header: 'Env',
    options: [
      {label: 'staging', description: 'safe'},
      {label: 'prod', description: ''},
    ],
    multiple: false,
    custom: true,
    ...overrides,
  }
}

function options(count: number): QuestionInfo['options'] {
  return Array.from({length: count}, (_, index) => ({label: `opt-${index}`, description: `d${index}`}))
}

interface RowJson {
  readonly components: readonly {
    readonly type: number
    readonly custom_id: string
    readonly label?: string
    readonly max_values?: number
    readonly min_values?: number
    readonly options?: readonly {readonly value: string; readonly label: string; readonly description?: string}[]
  }[]
}

function rows(plan: QuestionPromptPlan): RowJson[] {
  if (plan.kind !== 'prompt') throw new Error('expected a native prompt')
  return plan.components.map(
    (row: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>) => row.toJSON() as unknown as RowJson,
  )
}

function labels(row: RowJson | undefined): (string | undefined)[] {
  return (row?.components ?? []).map(component => component.label)
}

// ---------------------------------------------------------------------------
// Custom-id codec
// ---------------------------------------------------------------------------

describe('question custom-id codec', () => {
  it.each(['skip', 'text', 'modal', 'select'] as const)('round-trips the %s action', action => {
    // #given / #when
    const id = buildQuestionCustomId(action, 'que_abc123')

    // #then
    expect(id).not.toBeNull()
    expect(parseQuestionCustomId(id ?? '')).toEqual({action, requestID: 'que_abc123'})
  })

  it('round-trips an option button with its index', () => {
    // #given / #when
    const id = buildQuestionCustomId('option', 'que_abc123', 17)

    // #then
    expect(id).toBe('fb-q:o:que_abc123:17')
    expect(parseQuestionCustomId(id ?? '')).toEqual({action: 'option', requestID: 'que_abc123', optionIndex: 17})
  })

  it('round-trips a request id that itself contains colons', () => {
    // #given
    const id = buildQuestionCustomId('option', 'a:b:c', 3)

    // #then the index is the last segment
    expect(parseQuestionCustomId(id ?? '')).toEqual({action: 'option', requestID: 'a:b:c', optionIndex: 3})
  })

  it('accepts an id of exactly 100 characters and refuses 101', () => {
    // #given 'fb-q:k:' is 7 characters
    const atLimit = 'x'.repeat(93)
    const overLimit = 'x'.repeat(94)

    // #then
    const id = buildQuestionCustomId('skip', atLimit)
    expect(id).toHaveLength(100)
    expect(parseQuestionCustomId(id ?? '')).toEqual({action: 'skip', requestID: atLimit})
    expect(buildQuestionCustomId('skip', overLimit)).toBeNull()
  })

  it('refuses an option id that would pass 100 characters because of the index', () => {
    // #given 'fb-q:o:' (7) + id + ':' + index (2) = 100 at id length 90
    expect(buildQuestionCustomId('option', 'x'.repeat(90), 12)).toHaveLength(100)
    expect(buildQuestionCustomId('option', 'x'.repeat(91), 12)).toBeNull()
  })

  it.each(['', 'has space', 'semi;colon', 'new\nline', 'emoji🙂'])('refuses the request id %j', requestID => {
    expect(buildQuestionCustomId('skip', requestID)).toBeNull()
  })

  it.each([
    ['an option without an index', undefined],
    ['a negative index', -1],
    ['a fractional index', 1.5],
  ])('refuses %s', (_label, index) => {
    expect(buildQuestionCustomId('option', 'que_1', index)).toBeNull()
  })

  it.each([
    '',
    'fb-approve:que_1',
    'fb-q:',
    'fb-q:x:que_1',
    'fb-q:k:',
    'fb-q:k',
    'fb-q:o:que_1',
    'fb-q:o:que_1:',
    'fb-q:o:que_1:abc',
    'fb-q:o:que_1:1234',
    'fb-q:k:has space',
  ])('parse returns null for %j', customId => {
    expect(parseQuestionCustomId(customId)).toBeNull()
  })

  it('never puts an option label in an id', () => {
    // #given an option whose label looks like an id
    const plan = planQuestionPrompt('que_1', [question({options: [{label: 'fb-q:k:que_9', description: ''}]})])

    // #then every custom id is built from the request id and an index only
    for (const row of rows(plan)) {
      for (const component of row.components) expect(component.custom_id).not.toContain('que_9')
    }
  })
})

// ---------------------------------------------------------------------------
// Prompt planning
// ---------------------------------------------------------------------------

describe('planQuestionPrompt — native shapes', () => {
  it('single-select with at most 20 options renders buttons in rows of 5, then a control row', () => {
    // #given 7 options, custom allowed
    const result = rows(planQuestionPrompt('que_1', [question({options: options(7)})]))

    // #then 5 + 2 option buttons, then Skip and the text button
    expect(result).toHaveLength(3)
    expect(result[0]?.components).toHaveLength(5)
    expect(result[1]?.components).toHaveLength(2)
    expect(result[0]?.components.every(c => c.type === 2)).toBe(true)
    expect(result[0]?.components[0]?.custom_id).toBe('fb-q:o:que_1:0')
    expect(result[1]?.components[1]?.custom_id).toBe('fb-q:o:que_1:6')
    expect(labels(result[2])).toEqual(['Skip', 'Answer with text…'])
  })

  it('20 options fill four rows; the control row is the fifth', () => {
    const result = rows(planQuestionPrompt('que_1', [question({options: options(MAX_BUTTON_OPTIONS)})]))

    expect(result).toHaveLength(5)
    expect(result.slice(0, 4).every(row => row.components.length === 5)).toBe(true)
    expect(labels(result[4])).toEqual(['Skip', 'Answer with text…'])
  })

  it('custom:false hides the text button', () => {
    const result = rows(planQuestionPrompt('que_1', [question({custom: false})]))

    expect(labels(result.at(-1))).toEqual(['Skip'])
  })

  it('21 options render one single-value select with index values', () => {
    // #given
    const result = rows(planQuestionPrompt('que_1', [question({options: options(21)})]))

    // #then one select row plus controls
    expect(result).toHaveLength(2)
    const select = result[0]?.components[0]
    expect(select?.type).toBe(3)
    expect(select?.custom_id).toBe('fb-q:s:que_1')
    expect(select?.max_values).toBe(1)
    expect(select?.options).toHaveLength(21)
    expect(select?.options?.map(option => option.value)).toEqual(Array.from({length: 21}, (_, i) => String(i)))
  })

  it('25 options still fit a select', () => {
    const result = rows(planQuestionPrompt('que_1', [question({options: options(25)})]))

    expect(result[0]?.components[0]?.options).toHaveLength(25)
  })

  it('multiple renders a select whose maxValues equals the option count', () => {
    const result = rows(planQuestionPrompt('que_1', [question({multiple: true, options: options(4)})]))

    const select = result[0]?.components[0]
    expect(select?.type).toBe(3)
    expect(select?.max_values).toBe(4)
    expect(select?.min_values).toBe(1)
  })

  it('multiple with 25 options has maxValues 25', () => {
    const result = rows(planQuestionPrompt('que_1', [question({multiple: true, options: options(25)})]))

    expect(result[0]?.components[0]?.max_values).toBe(25)
  })

  it('select option values are indices and labels are display-only; empty descriptions are omitted', () => {
    const result = rows(
      planQuestionPrompt('que_1', [
        question({
          multiple: true,
          options: [
            {label: 'prod', description: ''},
            {label: 'dev', description: 'safe'},
          ],
        }),
      ]),
    )

    expect(result[0]?.components[0]?.options).toEqual([
      {value: '0', label: 'prod'},
      {value: '1', label: 'dev', description: 'safe'},
    ])
  })

  it('a question with no options and a custom answer gets just the control row', () => {
    const result = rows(planQuestionPrompt('que_1', [question({options: []})]))

    expect(result).toHaveLength(1)
    expect(labels(result[0])).toEqual(['Skip', 'Answer with text…'])
  })

  it('bounds long labels to what Discord accepts', () => {
    const result = rows(planQuestionPrompt('que_1', [question({options: [{label: 'x'.repeat(500), description: ''}]})]))

    expect(result[0]?.components[0]?.label).toHaveLength(80)
  })
})

describe('planQuestionPrompt — web fallback', () => {
  it('a multi-question request falls back', () => {
    expect(planQuestionPrompt('que_1', [question(), question()])).toEqual({kind: 'fallback', reason: 'multi-question'})
  })

  it('a request with no questions falls back', () => {
    expect(planQuestionPrompt('que_1', [])).toEqual({kind: 'fallback', reason: 'multi-question'})
  })

  it('more than 25 options fall back', () => {
    expect(planQuestionPrompt('que_1', [question({options: options(30)})])).toEqual({
      kind: 'fallback',
      reason: 'too-many-options',
    })
    expect(planQuestionPrompt('que_1', [question({options: options(26), multiple: true})])).toEqual({
      kind: 'fallback',
      reason: 'too-many-options',
    })
  })

  it('an option with no usable label falls back instead of rendering a blank button', () => {
    expect(planQuestionPrompt('que_1', [question({options: [{label: '\u0000\u0007', description: ''}]})])).toEqual({
      kind: 'fallback',
      reason: 'unusable-option',
    })
  })

  it('an oversize request id falls back, with no partial prompt', () => {
    expect(planQuestionPrompt('x'.repeat(200), [question()])).toEqual({kind: 'fallback', reason: 'custom-id'})
  })

  it('an option id that would pass 100 characters falls back', () => {
    // #given a request id whose skip id fits but whose option ids (':' + index) do not
    const requestID = 'x'.repeat(91)
    expect(buildQuestionCustomId('skip', requestID)).not.toBeNull()

    expect(planQuestionPrompt(requestID, [question({options: options(12)})])).toEqual({
      kind: 'fallback',
      reason: 'custom-id',
    })
  })
})

function embedOf(plan: QuestionPromptPlan) {
  if (plan.kind !== 'prompt') throw new Error('expected a native prompt')
  return plan.embed.toJSON()
}

describe('planQuestionPrompt — embed content', () => {
  it('shows header and question escaped and bounded; markdown cannot form', () => {
    // #given markdown- and markup-shaped text
    const payload = '<img src=x onerror=alert(1)> `tick` **bold** [l](https://evil.example) @everyone <@123> <@&456>'
    const embed = embedOf(planQuestionPrompt('que_1', [question({header: payload, question: payload, options: []})]))

    // #then it is plain text: every markdown character is escaped
    expect(embed.title).toContain('\\`tick\\`')
    expect(embed.title).toContain(String.raw`\*\*bold\*\*`)
    expect(embed.description).toContain('\\`tick\\`')
    expect(embed.description).toContain(String.raw`\[l](https://evil.example)`)
  })

  it('strips control characters and caps the question text', () => {
    const embed = embedOf(
      planQuestionPrompt('que_1', [
        question({question: `\u001B${'q'.repeat(QUESTION_TEXT_MAX_LENGTH)}\u0000`, options: []}),
      ]),
    )

    expect(embed.description).not.toContain('\u001B')
    expect((embed.description ?? '').length).toBeLessThanOrEqual(4096)
  })

  it('lists option descriptions for button prompts but not for selects', () => {
    const buttons = embedOf(planQuestionPrompt('que_1', [question()]))
    const select = embedOf(planQuestionPrompt('que_1', [question({multiple: true})]))

    expect(buttons.description).toContain('safe')
    expect(select.description).not.toContain('safe')
  })

  it('stays under Discord embed limits for the largest prompt', () => {
    const big = 'w'.repeat(QUESTION_TEXT_MAX_LENGTH)
    const embed = embedOf(
      planQuestionPrompt('que_1', [
        question({
          header: big,
          question: big,
          options: Array.from({length: MAX_BUTTON_OPTIONS}, () => ({label: big, description: big})),
        }),
      ]),
    )

    const total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0)
    expect(embed.description?.length).toBeLessThanOrEqual(4096)
    expect(total).toBeLessThanOrEqual(6000)
  })

  it('uses a generic title and placeholder text when header and question are empty', () => {
    const embed = embedOf(planQuestionPrompt('que_1', [question({header: '', question: '', options: []})]))

    expect(embed.title).toBe('❓ Agent question')
    expect(embed.description).toContain('no question text')
  })
})

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

describe('buildQuestionAnswerModal', () => {
  it('has one required paragraph input capped at 4,000 characters', () => {
    // #given / #when
    const json = buildQuestionAnswerModal('que_1')?.toJSON()

    // #then
    expect(json?.custom_id).toBe('fb-q:m:que_1')
    const input = (json?.components[0] as unknown as {components: Record<string, unknown>[]}).components[0]
    expect(input).toMatchObject({
      custom_id: QUESTION_MODAL_INPUT_ID,
      style: 2,
      required: true,
      min_length: 1,
      max_length: 4000,
    })
  })

  it('returns null when the id cannot be built', () => {
    expect(buildQuestionAnswerModal('x'.repeat(200))).toBeNull()
  })

  it('carries no question content in the title', () => {
    expect(buildQuestionAnswerModal('que_1')?.toJSON().title).toBe('Answer the agent question')
  })
})

// ---------------------------------------------------------------------------
// Fallback notice
// ---------------------------------------------------------------------------

describe('buildQuestionFallbackNotice', () => {
  it('is fixed copy that mentions the web surface', () => {
    expect(buildQuestionFallbackNotice(undefined)).toContain('operator web surface')
    expect(buildQuestionFallbackNotice(undefined)).not.toContain('http')
  })

  it('links the configured operator origin without an embed', () => {
    expect(buildQuestionFallbackNotice('https://operator.example.com')).toContain('<https://operator.example.com>')
  })
})

// ---------------------------------------------------------------------------
// Settled embed
// ---------------------------------------------------------------------------

describe('buildQuestionSettledEmbed', () => {
  const asked = question({options: []})

  it('shows the chosen labels and free text, escaped and bounded, for an answer', () => {
    // #given an answer containing markdown, mention-shaped text, and an over-long item
    const settlement: QuestionSettlement = {
      reason: 'replied',
      answers: [['prod', '@everyone <@123> <@&456> **x**', 'y'.repeat(2000)]],
      actor: {kind: 'discord-user', userId: '123456789'},
    }

    // #when
    const embed = buildQuestionSettledEmbed(asked, settlement).toJSON()

    // #then
    expect(embed.title).toBe('✅ Answered by <@123456789>')
    const value = embed.fields?.[0]?.value ?? ''
    expect(value).toContain('• prod')
    expect(value).toContain(String.raw`\*\*x\*\*`)
    expect(value.length).toBeLessThanOrEqual(1024)
  })

  it('an all-empty reply is shown as skipped', () => {
    const embed = buildQuestionSettledEmbed(asked, {
      reason: 'replied',
      answers: [[]],
      actor: {kind: 'web-operator', githubUserId: 1, login: 'octo**cat', sessionCorrelationId: 's'},
    }).toJSON()

    expect(embed.title).toBe(String.raw`⏭️ Skipped by octo\*\*cat`)
    expect(embed.fields).toBeUndefined()
  })

  it.each([
    ['deadline', '⏱️ Timed out — skipped'],
    ['rejected', '⛔ Cancelled'],
    ['disposed', '⚠️ Cancelled (run ended)'],
  ] as const)('%s settles with the matching title and no answer field', (reason, title) => {
    const embed = buildQuestionSettledEmbed(asked, {reason, actor: null}).toJSON()

    expect(embed.title).toBe(title)
    expect(embed.fields).toBeUndefined()
  })

  it('does not build a mention from a non-snowflake Discord user id', () => {
    const embed = buildQuestionSettledEmbed(asked, {
      reason: 'replied',
      answers: [['a']],
      actor: {kind: 'discord-user', userId: '<@&456> @everyone'},
    }).toJSON()

    expect(embed.title).toBe('✅ Answered')
  })

  it('keeps the question text, escaped, and tolerates a missing question', () => {
    const withQuestion = buildQuestionSettledEmbed(question({question: '**Q**', header: 'H'}), {
      reason: 'deadline',
      actor: null,
    }).toJSON()
    const without = buildQuestionSettledEmbed(undefined, {reason: 'deadline', actor: null}).toJSON()

    expect(withQuestion.description).toContain(String.raw`\*\*Q\*\*`)
    expect(without.description).toBeUndefined()
  })
})
