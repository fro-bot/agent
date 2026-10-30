import type {RemoteOpenCodeV2Client, V2FormField} from '@fro-bot/runtime'

import {ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {createFormDirectoryV2, createQuestionEffectsV2} from './question-client-v2.js'

const FIELDS: readonly V2FormField[] = [
  {key: 'q0', type: 'string', title: 'Pick', description: 'Pick?', options: []},
  {key: 'q1', type: 'multiselect', title: 'Many', description: 'Many?', options: []},
]

function makeEffects() {
  const forms = createFormDirectoryV2()
  forms.remember('frm_1', {sessionId: 'ses_1', fields: FIELDS})
  const client = {
    replyForm: vi.fn().mockResolvedValue(ok(undefined)),
    cancelForm: vi.fn().mockResolvedValue(ok(undefined)),
  } as unknown as RemoteOpenCodeV2Client
  return {effects: createQuestionEffectsV2({client, forms}), client, forms}
}

describe('createQuestionEffectsV2', () => {
  it('replies to the form with answers keyed by field, on the asking session', async () => {
    // #given
    const {effects, client} = makeEffects()

    // #when
    const result = await effects.replyQuestion('frm_1', [['A'], ['x', 'y']])

    // #then
    expect(result).toEqual({ok: true})
    expect(client.replyForm).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'ses_1', formId: 'frm_1', answer: {q0: 'A', q1: ['x', 'y']}}),
    )
  })

  it('rejects by cancelling the form with no message, which ends the asking step', async () => {
    // #given
    const {effects, client} = makeEffects()

    // #when
    const result = await effects.rejectQuestion('frm_1')

    // #then
    expect(result).toEqual({ok: true})
    const input = vi.mocked(client.cancelForm).mock.calls[0]?.[0]
    expect(input).toMatchObject({sessionId: 'ses_1', formId: 'frm_1'})
    expect(input?.message).toBeUndefined()
  })

  it('refuses a form the run never forwarded, rather than guessing a session', async () => {
    // #given
    const {effects, client} = makeEffects()

    // #when
    const reply = await effects.replyQuestion('frm_unknown', [['A']])
    const reject = await effects.rejectQuestion('frm_unknown')

    // #then
    expect(reply).toEqual({ok: false, error: 'unknown-form'})
    expect(reject).toEqual({ok: false, error: 'unknown-form'})
    expect(client.replyForm).not.toHaveBeenCalled()
    expect(client.cancelForm).not.toHaveBeenCalled()
  })

  it('collapses a failed call to a reason code, never response text', async () => {
    // #given
    const forms = createFormDirectoryV2()
    forms.remember('frm_1', {sessionId: 'ses_1', fields: FIELDS})
    const client = {
      replyForm: vi.fn().mockResolvedValue({success: false, error: {kind: 'http', status: 409}}),
      cancelForm: vi.fn().mockRejectedValue(new Error('secret answer text')),
    } as unknown as RemoteOpenCodeV2Client
    const effects = createQuestionEffectsV2({client, forms})

    // #when / #then
    expect(await effects.replyQuestion('frm_1', [['A']])).toEqual({ok: false, error: 'sdk-error'})
    expect(await effects.rejectQuestion('frm_1')).toEqual({ok: false, error: 'sdk-threw'})
  })

  it('bounds every call with a timeout signal', async () => {
    // #given
    const {effects, client} = makeEffects()

    // #when
    await effects.replyQuestion('frm_1', [['A']])
    await effects.rejectQuestion('frm_1')

    // #then
    expect(vi.mocked(client.replyForm).mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    expect(vi.mocked(client.cancelForm).mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('forgets a form once told to', () => {
    // #given
    const forms = createFormDirectoryV2()
    forms.remember('frm_1', {sessionId: 'ses_1', fields: FIELDS})

    // #when
    forms.forget('frm_1')

    // #then
    expect(forms.lookup('frm_1')).toBeUndefined()
  })
})
