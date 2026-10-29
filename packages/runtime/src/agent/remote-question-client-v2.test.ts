import type {V2FormField} from './event-v2.js'
import type {RemoteOpenCodeV2Client} from './remote-client-v2.js'

import {describe, expect, it, vi} from 'vitest'

import {buildQuestionFormAnswer, createRemoteQuestionClientV2} from './remote-question-client-v2.js'

function field(key: string, type: string): V2FormField {
  return {key, type, title: null, description: null, options: []}
}

describe('buildQuestionFormAnswer', () => {
  it('keys a single-choice answer by field key as a plain string', () => {
    // #given
    const fields = [field('q0', 'string'), field('q1', 'string')]

    // #when
    const answer = buildQuestionFormAnswer(fields, [['A'], ['B']])

    // #then
    expect(answer).toEqual({q0: 'A', q1: 'B'})
  })

  it('keeps every selection of a multiselect field as an array', () => {
    // #given
    const fields = [field('q0', 'multiselect')]

    // #when
    const answer = buildQuestionFormAnswer(fields, [['x', 'y']])

    // #then
    expect(answer).toEqual({q0: ['x', 'y']})
  })

  it('omits a question that has no answer, so the tool reads it as unanswered', () => {
    // #given
    const fields = [field('q0', 'string'), field('q1', 'multiselect'), field('q2', 'string')]

    // #when
    const answer = buildQuestionFormAnswer(fields, [[], [], ['C']])

    // #then
    expect(answer).toEqual({q2: 'C'})
  })

  it('ignores answers beyond the form fields', () => {
    // #when
    const answer = buildQuestionFormAnswer([field('q0', 'string')], [['A'], ['stray']])

    // #then
    expect(answer).toEqual({q0: 'A'})
  })
})

function makeClient(overrides: Partial<RemoteOpenCodeV2Client> = {}): RemoteOpenCodeV2Client {
  return {
    replyForm: vi.fn().mockResolvedValue({success: true, data: undefined}),
    cancelForm: vi.fn().mockResolvedValue({success: true, data: undefined}),
    ...overrides,
  } as unknown as RemoteOpenCodeV2Client
}

describe('createRemoteQuestionClientV2', () => {
  it('answers a form with the built answer and returns no error', async () => {
    // #given
    const client = makeClient()
    const questions = createRemoteQuestionClientV2(client)

    // #when
    const response = await questions.answer({
      sessionId: 'ses_1',
      formId: 'frm_1',
      fields: [field('q0', 'string')],
      answers: [['A']],
    })

    // #then
    expect(response).toEqual({})
    expect(client.replyForm).toHaveBeenCalledWith({sessionId: 'ses_1', formId: 'frm_1', answer: {q0: 'A'}})
  })

  it('cancels a form without a message, which ends the asking turn', async () => {
    // #given
    const client = makeClient()
    const questions = createRemoteQuestionClientV2(client)

    // #when
    const response = await questions.reject({sessionId: 'ses_1', formId: 'frm_1'})

    // #then
    expect(response).toEqual({})
    expect(client.cancelForm).toHaveBeenCalledWith({sessionId: 'ses_1', formId: 'frm_1'})
  })

  it('reports a failed call as an error kind, never as text', async () => {
    // #given
    const client = makeClient({
      replyForm: vi.fn().mockResolvedValue({success: false, error: {kind: 'http', status: 409}}),
    })
    const questions = createRemoteQuestionClientV2(client)

    // #when
    const response = await questions.answer({sessionId: 's', formId: 'f', fields: [], answers: []})

    // #then
    expect(response).toEqual({error: {kind: 'http', status: 409}})
  })

  it('forwards the abort signal', async () => {
    // #given
    const client = makeClient()
    const signal = new AbortController().signal

    // #when
    await createRemoteQuestionClientV2(client).reject({sessionId: 's', formId: 'f', signal})

    // #then
    expect(client.cancelForm).toHaveBeenCalledWith({sessionId: 's', formId: 'f', signal})
  })
})
