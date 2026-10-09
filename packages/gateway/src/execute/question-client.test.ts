import type {RemoteQuestionClient} from '@fro-bot/runtime'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createQuestionEffects} from './question-client.js'

const mockCreateV2Client = vi.hoisted(() => vi.fn())
vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: (...args: unknown[]): unknown => mockCreateV2Client(...args),
}))

const ANY_SIGNAL: unknown = expect.any(AbortSignal)

const DIRECTORY = '/workspace/repos/acme/widget'

function makeSdk() {
  const reply = vi.fn().mockResolvedValue({data: true, error: undefined})
  const reject = vi.fn().mockResolvedValue({data: true, error: undefined})
  mockCreateV2Client.mockReturnValue({question: {reply, reject}})
  return {reply, reject}
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createQuestionEffects', () => {
  it('builds the v2 client with the base URL and the same bearer header the v1 handle uses', () => {
    // #given / #when
    makeSdk()
    createQuestionEffects({baseURL: 'http://workspace:9200', token: 'tok', directory: DIRECTORY})

    // #then
    expect(mockCreateV2Client).toHaveBeenCalledExactlyOnceWith({
      baseUrl: 'http://workspace:9200',
      headers: {Authorization: 'Bearer tok'},
    })
  })

  it('replyQuestion calls question.reply with the request id, answers and canonical directory', async () => {
    // #given
    const {reply} = makeSdk()
    const effects = createQuestionEffects({baseURL: 'http://workspace:9200', token: 'tok', directory: DIRECTORY})

    // #when
    const result = await effects.replyQuestion('que_1', [['a'], []])

    // #then
    expect(result).toEqual({ok: true})
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      {requestID: 'que_1', directory: DIRECTORY, answers: [['a'], []]},
      expect.objectContaining({signal: ANY_SIGNAL}),
    )
  })

  it('rejectQuestion calls question.reject with the request id and canonical directory', async () => {
    // #given
    const {reject} = makeSdk()
    const effects = createQuestionEffects({baseURL: 'http://workspace:9200', token: 'tok', directory: DIRECTORY})

    // #when
    const result = await effects.rejectQuestion('que_1')

    // #then
    expect(result).toEqual({ok: true})
    expect(reject).toHaveBeenCalledExactlyOnceWith(
      {requestID: 'que_1', directory: DIRECTORY},
      expect.objectContaining({signal: ANY_SIGNAL}),
    )
  })

  it('response.error maps to an error result carrying a reason code, not the SDK error text', async () => {
    // #given endpoints that report errors in the response envelope, with text echoing the answer
    const {reply, reject} = makeSdk()
    reply.mockResolvedValue({data: undefined, error: {message: 'answer text SECRET'}})
    reject.mockResolvedValue({data: undefined, error: 'SECRET'})
    const effects = createQuestionEffects({baseURL: 'http://workspace:9200', token: 'tok', directory: DIRECTORY})

    // #when
    const replied = await effects.replyQuestion('que_1', [['SECRET']])
    const rejected = await effects.rejectQuestion('que_1')

    // #then
    expect(replied).toEqual({ok: false, error: 'sdk-error'})
    expect(rejected).toEqual({ok: false, error: 'sdk-error'})
  })

  it('a thrown transport error becomes a reason-coded error result and never propagates', async () => {
    // #given
    const {reply, reject} = makeSdk()
    reply.mockRejectedValue(new Error('ECONNRESET SECRET'))
    reject.mockRejectedValue(new Error('ECONNRESET SECRET'))
    const effects = createQuestionEffects({baseURL: 'http://workspace:9200', token: 'tok', directory: DIRECTORY})

    // #when / #then
    await expect(effects.replyQuestion('que_1', [])).resolves.toEqual({ok: false, error: 'sdk-threw'})
    await expect(effects.rejectQuestion('que_1')).resolves.toEqual({ok: false, error: 'sdk-threw'})
  })

  it('an injected client is used instead of constructing one', async () => {
    // #given
    const client: RemoteQuestionClient = {
      answer: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
    }

    // #when
    const effects = createQuestionEffects({baseURL: 'http://x', token: 't', directory: DIRECTORY, client})
    await effects.replyQuestion('que_1', [['a']])

    // #then
    expect(mockCreateV2Client).not.toHaveBeenCalled()
    expect(client.answer).toHaveBeenCalledOnce()
  })
})
