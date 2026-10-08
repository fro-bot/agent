import type {QuestionAnswer, QuestionRejectData, QuestionReplyData} from '@opencode-ai/sdk/v2/client'

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

// ---------------------------------------------------------------------------
// Wire contract: what a *skip* puts on the wire, through the REAL generated SDK.
//
// A skipped question (deadline or operator Skip) is a reply with one empty answer
// per question — never a reject. OpenCode v1.18.34 accepts that body and resolves
// the pending ask, so the question tool reports "Unanswered" and the turn goes on;
// a reject would raise `Question.RejectedError` and end the turn. Upstream refs
// (anomalyco/opencode @ v1.18.34, packages/opencode/src):
//   - server/routes/instance/httpapi/groups/question.ts:12-16   ReplyPayload = {answers: Array<Answer>}
//   - server/routes/instance/httpapi/groups/question.ts:32-37   POST /question/:requestID/reply
//   - question/index.ts:114-132                                 reply publishes question.replied, Deferred.succeed
//   - tool/question.ts:30-36                                    empty answer => "Unanswered", ordinary tool output
//   - question/index.ts:134-148 + session/processor.ts:200      reject => RejectedError => blocked (turn ends)
//
// The expected request below is typed against the SDK's generated request types
// (`satisfies`), so a drift in the generated types breaks type-check, and the
// runtime assertions break if our client stops sending exactly that request.
// ---------------------------------------------------------------------------

describe('skip wire contract (real generated SDK, captured request)', () => {
  const DIRECTORY = '/workspace/repos/o/r'

  interface CapturedRequest {
    readonly method: string
    readonly pathname: string
    readonly search: URLSearchParams
    readonly bodyText: string
  }

  /** Route the mocked factory to the real SDK, with a `fetch` that records the outgoing request. */
  async function captureWire(): Promise<readonly CapturedRequest[]> {
    const actual = await vi.importActual<typeof import('@opencode-ai/sdk/v2/client')>('@opencode-ai/sdk/v2/client')
    const captured: CapturedRequest[] = []
    const recordingFetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const request = new Request(...args)
      const url = new URL(request.url)
      captured.push({
        method: request.method,
        pathname: url.pathname,
        search: url.searchParams,
        bodyText: await request.text(),
      })
      return new Response('true', {status: 200, headers: {'content-type': 'application/json'}})
    }
    mockCreateOpencodeClient.mockImplementation((config: object) =>
      actual.createOpencodeClient({...config, fetch: recordingFetch}),
    )
    return captured
  }

  it('a skip is POST /question/{id}/reply?directory=… with {answers:[[],…]}, one empty array per question', async () => {
    // #given the real SDK behind our client, and a 2-question skip
    const captured = await captureWire()
    const client = createRemoteQuestionClient('http://workspace:9200', {Authorization: 'Bearer t'})
    const skipAnswers = [[], []]

    // #when
    const result = await client.answer({requestID: 'que_1', directory: DIRECTORY, answers: skipAnswers})

    // #then exactly one request went out, and it is the generated reply request — not a reject
    expect(result.error).toBeUndefined()
    expect(captured).toHaveLength(1)
    const [request] = captured
    const expected = {
      url: '/question/{requestID}/reply',
      path: {requestID: 'que_1'},
      query: {directory: DIRECTORY},
      body: {answers: [[], []] satisfies QuestionAnswer[]},
    } satisfies QuestionReplyData
    expect(request?.method).toBe('POST')
    expect(request?.pathname).toBe(expected.url.replace('{requestID}', expected.path.requestID))
    expect(request?.search.get('directory')).toBe(expected.query.directory)
    expect(JSON.parse(request?.bodyText ?? 'null')).toStrictEqual(expected.body)
  })

  it('the skip body is never the drifted shapes ({answers: []} or {answers: [[""]]})', async () => {
    // #given
    const captured = await captureWire()
    const client = createRemoteQuestionClient('http://workspace:9200')

    // #when a one-question skip
    await client.answer({requestID: 'que_1', directory: DIRECTORY, answers: [[]]})

    // #then the single inner array exists (arity == question count) and is truly empty
    const body: unknown = JSON.parse(captured[0]?.bodyText ?? 'null')
    expect(body).not.toStrictEqual({answers: []})
    expect(body).not.toStrictEqual({answers: [['']]})
    expect(body).toStrictEqual({answers: [[]]})
  })

  it('a reject is a different endpoint with no body — the skip must never be routed there', async () => {
    // #given
    const captured = await captureWire()
    const client = createRemoteQuestionClient('http://workspace:9200')

    // #when
    await client.reject({requestID: 'que_1', directory: DIRECTORY})

    // #then
    const expected = {
      url: '/question/{requestID}/reject',
      path: {requestID: 'que_1'},
      query: {directory: DIRECTORY},
    } satisfies Omit<QuestionRejectData, 'body'>
    expect(captured).toHaveLength(1)
    expect(captured[0]?.method).toBe('POST')
    expect(captured[0]?.pathname).toBe(expected.url.replace('{requestID}', expected.path.requestID))
    expect(captured[0]?.bodyText).toBe('')
  })
})
