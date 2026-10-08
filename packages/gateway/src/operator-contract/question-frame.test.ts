/**
 * Contract tests for the question frame, pending-question DTO, and decision
 * request types (contract 1.9.0).
 */

import type {
  OperatorWebStatus,
  PendingQuestionDTO,
  QuestionDecisionRequest,
  QuestionFrameData,
  QuestionRequestDetail,
} from './index.js'

import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {OPERATOR_CONTRACT_VERSION} from './index.js'

const detail: QuestionRequestDetail = {
  requestID: 'q-1',
  questions: [
    {
      header: 'Pick',
      text: '<img src=x onerror=alert(1)>',
      options: [{label: 'A', description: '`d`'}],
      multiple: false,
      custom: true,
    },
  ],
}

describe('question contract surface (1.9.0)', () => {
  it('is published under contract version 1.9.0', () => {
    // #given the barrel version
    // #when / #then
    expect(OPERATOR_CONTRACT_VERSION).toBe('1.9.0')
  })

  it('discriminates open and settle frames on `settled`', () => {
    // #given an open and a settle frame built from the shared detail
    const open: QuestionFrameData = {...detail, runId: 'run-1', settled: false}
    const settle: QuestionFrameData = {requestID: 'q-1', runId: 'run-1', settled: true}

    // #when narrowed on the discriminant
    const openQuestions = open.settled ? undefined : open.questions
    const settleKeys = Object.keys(settle).sort()

    // #then the open frame carries questions and the settle frame only ids
    expect(openQuestions).toHaveLength(1)
    expect(settleKeys).toStrictEqual(['requestID', 'runId', 'settled'])
  })

  it('shares one detail shape between the frame and the pending DTO', () => {
    // #given a pending DTO
    const dto: PendingQuestionDTO = detail

    // #when an open frame is built by spreading the DTO (compiles only if the shapes match)
    const open: QuestionFrameData = {...dto, runId: 'run-1', settled: false}

    // #then the frame carries the DTO's fields unchanged
    expect(open).toMatchObject(dto)
  })

  it('carries injection-shaped text verbatim through JSON, as inert strings', () => {
    // #given a frame whose text is markup-shaped
    const open: QuestionFrameData = {...detail, runId: 'run-1', settled: false}

    // #when serialized and parsed as a consumer would
    const parsed = JSON.parse(JSON.stringify(open)) as typeof open

    // #then the strings are unchanged
    expect(parsed).toStrictEqual(open)
  })

  it('models answer and skip as a discriminated request', () => {
    // #given the two decision bodies
    const answer: QuestionDecisionRequest = {decision: 'answer', answers: [['A']]}
    const skip: QuestionDecisionRequest = {decision: 'skip'}

    // #when / #then they are distinguishable by `decision`
    expect([answer.decision, skip.decision]).toStrictEqual(['answer', 'skip'])
  })

  it('includes waiting_for_question in the operator web status set', () => {
    // #given the status as a typed value
    const status: OperatorWebStatus = 'waiting_for_question'

    // #when / #then it survives a JSON round trip
    expect(JSON.parse(JSON.stringify({status}))).toStrictEqual({status: 'waiting_for_question'})
  })

  it('documents that question and answer strings are untrusted plain text', () => {
    // #given the contract module source
    const here = path.dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(path.join(here, 'question-frame.ts'), 'utf8')

    // #when / #then the inert-rendering obligation is stated in the contract
    expect(source).toMatch(/untrusted/i)
    expect(source).toMatch(/inert/i)
  })
})
