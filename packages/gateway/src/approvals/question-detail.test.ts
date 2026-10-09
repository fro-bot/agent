import type {QuestionInfo} from './question-registry.js'
import {describe, expect, it} from 'vitest'
import {
  boundQuestionText,
  QUESTION_HEADER_MAX_LENGTH,
  QUESTION_OPTION_DESCRIPTION_MAX_LENGTH,
  QUESTION_OPTION_LABEL_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  toQuestionRequestDetail,
} from './question-detail.js'

describe('boundQuestionText', () => {
  it('returns short clean text unchanged', () => {
    // #given text with nothing to strip
    // #when bounded
    // #then it is returned verbatim, including quotes and backslashes
    expect(boundQuestionText(String.raw`Which "one" \ do you want?`, 100)).toBe(String.raw`Which "one" \ do you want?`)
  })

  it('truncates to exactly the cap', () => {
    // #given text one over the cap
    const result = boundQuestionText('a'.repeat(101), 100)

    // #then it is cut to the cap
    expect(result).toHaveLength(100)
  })

  it('strips C0, DEL, and C1 control characters', () => {
    // #given text laced with ESC, NUL, BEL, DEL, and a C1 CSI
    const result = boundQuestionText('a\u001B[31mb\u0000c\u0007d\u007Fe\u009Bf', 100)

    // #then no control characters remain
    expect(result).toBe('a[31mbcdef')
  })

  it('turns tab, CR, and LF into single spaces so words are not glued together', () => {
    // #given a multi-line question
    const result = boundQuestionText('line one\nline two\r\nline\tthree', 100)

    // #then each whitespace control becomes one space (CRLF becomes two)
    expect(result).toBe('line one line two  line three')
  })

  it('strips bidirectional overrides and isolates', () => {
    // #given a label that tries to reorder itself
    const result = boundQuestionText('safe\u202Eevil\u2066x\u2069', 100)

    // #then the override characters are gone
    expect(result).toBe('safeevilx')
  })

  it('strips before capping, so removed characters do not count against the cap', () => {
    // #given 10 visible chars padded with 50 NULs, capped at 10
    const result = boundQuestionText(`${'\u0000'.repeat(50)}${'a'.repeat(10)}`, 10)

    // #then all visible characters survive
    expect(result).toBe('a'.repeat(10))
  })

  it('does not leave half of a surrogate pair at the cut', () => {
    // #given an emoji (surrogate pair) straddling the cap
    const result = boundQuestionText(`ab${'\u{1F600}'}cd`, 3)

    // #then the cut drops the whole pair
    expect(result).toBe('ab')
  })

  it('keeps an empty string empty', () => {
    // #given / #when / #then
    expect(boundQuestionText('', 10)).toBe('')
  })

  it('does not interpret or escape HTML and Markdown', () => {
    // #given an injection-shaped string
    const payload = '<img src=x onerror=alert(1)> `tick` [l](javascript:alert(1)) &amp; **b**'

    // #when / #then it is carried verbatim
    expect(boundQuestionText(payload, 4096)).toBe(payload)
  })
})

describe('toQuestionRequestDetail', () => {
  const question: QuestionInfo = {
    question: 'Which?',
    header: 'Pick',
    options: [{label: 'A', description: 'first'}],
    multiple: true,
    custom: false,
  }

  it('maps fields to the operator shape and keeps the normalized flags', () => {
    // #given a normalized registry question
    // #when built
    const detail = toQuestionRequestDetail('q-1', [question])

    // #then question becomes text and the booleans are preserved
    expect(detail).toStrictEqual({
      requestID: 'q-1',
      questions: [
        {
          header: 'Pick',
          text: 'Which?',
          options: [{label: 'A', description: 'first'}],
          multiple: true,
          custom: false,
        },
      ],
    })
  })

  it('applies a distinct cap to each field', () => {
    // #given over-cap strings in every field
    const big: QuestionInfo = {
      question: 'q'.repeat(QUESTION_TEXT_MAX_LENGTH + 1),
      header: 'h'.repeat(QUESTION_HEADER_MAX_LENGTH + 1),
      options: [
        {
          label: 'l'.repeat(QUESTION_OPTION_LABEL_MAX_LENGTH + 1),
          description: 'd'.repeat(QUESTION_OPTION_DESCRIPTION_MAX_LENGTH + 1),
        },
      ],
      multiple: false,
      custom: true,
    }

    // #when built
    const [prompt] = toQuestionRequestDetail('q-1', [big]).questions

    // #then each field is cut to its own cap
    expect(prompt?.text).toHaveLength(QUESTION_TEXT_MAX_LENGTH)
    expect(prompt?.header).toHaveLength(QUESTION_HEADER_MAX_LENGTH)
    expect(prompt?.options[0]?.label).toHaveLength(QUESTION_OPTION_LABEL_MAX_LENGTH)
    expect(prompt?.options[0]?.description).toHaveLength(QUESTION_OPTION_DESCRIPTION_MAX_LENGTH)
  })

  it('does not mutate the registry question', () => {
    // #given a question with a control character
    const dirty: QuestionInfo = {...question, question: 'a\u0000b'}

    // #when built
    toQuestionRequestDetail('q-1', [dirty])

    // #then the source is untouched
    expect(dirty.question).toBe('a\u0000b')
  })
})
