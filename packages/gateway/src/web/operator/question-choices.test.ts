import type {QuestionInfo} from '../../approvals/question-registry.js'
import {describe, expect, it} from 'vitest'
import {parseQuestionDecisionBody, resolveQuestionAnswers} from './question-choices.js'

const questions: readonly QuestionInfo[] = [
  {
    question: 'Env?',
    header: 'Env',
    options: [
      {label: 'staging', description: ''},
      {label: 'prod', description: ''},
    ],
    multiple: true,
    custom: true,
  },
  {question: 'Why?', header: 'Why', options: [], multiple: false, custom: true},
]

describe('parseQuestionDecisionBody', () => {
  it('accepts skip and ignores extra fields', () => {
    expect(parseQuestionDecisionBody({decision: 'skip', extra: 1})).toEqual({kind: 'ok', value: {decision: 'skip'}})
  })

  it('accepts an answer with indices and text', () => {
    expect(parseQuestionDecisionBody({decision: 'answer', answers: [{options: [0, 1], text: 'x'}, {}]})).toEqual({
      kind: 'ok',
      value: {decision: 'answer', answers: [{options: [0, 1], text: 'x'}, {}]},
    })
  })

  it.each([null, 5, 'x', [], {}, {decision: 'answer'}, {decision: 'answer', answers: [null]}])(
    'rejects %j as malformed',
    body => {
      expect(parseQuestionDecisionBody(body)).toEqual({kind: 'malformed'})
    },
  )

  it('rejects an oversized answers array', () => {
    expect(parseQuestionDecisionBody({decision: 'answer', answers: Array.from({length: 257}, () => ({}))})).toEqual({
      kind: 'malformed',
    })
  })
})

describe('resolveQuestionAnswers', () => {
  it('maps indices to raw labels and appends free text last', () => {
    expect(resolveQuestionAnswers(questions, [{options: [1, 0], text: 'extra'}, {text: 'because'}])).toEqual({
      kind: 'ok',
      answers: [['prod', 'staging', 'extra'], ['because']],
    })
  })

  it('treats empty text and no options as an unanswered question', () => {
    expect(resolveQuestionAnswers(questions, [{text: ''}, {}])).toEqual({kind: 'ok', answers: [[], []]})
  })

  it('reports an out-of-range index with its question index', () => {
    expect(resolveQuestionAnswers(questions, [{}, {options: [0]}])).toEqual({
      kind: 'invalid',
      reason: 'unknown-option',
      questionIndex: 1,
    })
  })

  it('reports a repeated index as malformed', () => {
    expect(resolveQuestionAnswers(questions, [{options: [1, 1]}, {}])).toEqual({
      kind: 'invalid',
      reason: 'malformed',
      questionIndex: 0,
    })
  })

  it('reports an arity mismatch for the whole request', () => {
    expect(resolveQuestionAnswers(questions, [{}])).toEqual({
      kind: 'invalid',
      reason: 'arity-mismatch',
      questionIndex: null,
    })
  })
})
