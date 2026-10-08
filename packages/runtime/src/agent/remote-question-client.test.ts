import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createRemoteQuestionClient} from './remote-question-client.js'

const mockCreateOpencodeClient = vi.fn()
const mockReply = vi.fn()
const mockReject = vi.fn()

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: (...args: unknown[]): unknown => mockCreateOpencodeClient(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateOpencodeClient.mockReturnValue({question: {reply: mockReply, reject: mockReject}})
  mockReply.mockResolvedValue({data: true, error: undefined})
  mockReject.mockResolvedValue({data: true, error: undefined})
})

describe('createRemoteQuestionClient', () => {
  it('creates the v2 client with the base URL and headers', () => {
    // #given / #when
    createRemoteQuestionClient('http://workspace:9200', {Authorization: 'Bearer t'})

    // #then
    expect(mockCreateOpencodeClient).toHaveBeenCalledExactlyOnceWith({
      baseUrl: 'http://workspace:9200',
      headers: {Authorization: 'Bearer t'},
    })
  })

  it('answer calls question.reply with the request id, directory and a copy of the answers', async () => {
    // #given
    const client = createRemoteQuestionClient('http://workspace:9200')
    const answers = [['a', 'b'], []]
    const signal = AbortSignal.timeout(1_000)

    // #when
    const result = await client.answer({requestID: 'que_1', directory: '/workspace/repos/o/r', answers, signal})

    // #then
    expect(mockReply).toHaveBeenCalledExactlyOnceWith(
      {requestID: 'que_1', directory: '/workspace/repos/o/r', answers: [['a', 'b'], []]},
      {signal},
    )
    const sent = mockReply.mock.calls[0]?.[0] as {readonly answers: unknown}
    expect(sent.answers).not.toBe(answers)
    expect(result.error).toBeUndefined()
  })

  it('reject calls question.reject with the request id and directory', async () => {
    // #given
    const client = createRemoteQuestionClient('http://workspace:9200')

    // #when
    await client.reject({requestID: 'que_1', directory: '/workspace/repos/o/r'})

    // #then
    expect(mockReject).toHaveBeenCalledExactlyOnceWith(
      {requestID: 'que_1', directory: '/workspace/repos/o/r'},
      undefined,
    )
  })

  it('surfaces the SDK response.error field instead of hiding it', async () => {
    // #given
    mockReply.mockResolvedValue({data: undefined, error: {name: 'NotFoundError'}})
    mockReject.mockResolvedValue({data: undefined, error: 'gone'})
    const client = createRemoteQuestionClient('http://workspace:9200')

    // #when
    const replied = await client.answer({requestID: 'que_1', directory: '/d', answers: []})
    const rejected = await client.reject({requestID: 'que_1', directory: '/d'})

    // #then
    expect(replied.error).toEqual({name: 'NotFoundError'})
    expect(rejected.error).toBe('gone')
  })
})
