import {describe, expect, it, vi} from 'vitest'

import {createRemoteOpenCodeV2Client, V2_HEARTBEAT_FRAME} from './remote-client-v2.js'

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

/** A fetch double that records every request and answers from `respond`. */
function makeFetch(respond: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly fetch: typeof fetch
  readonly requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: raw === undefined ? undefined : JSON.parse(raw),
    }
    requests.push(request)
    return respond(request)
  }
  return {fetch: impl, requests}
}

function sseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {status, headers: {'content-type': 'text/event-stream'}})
}

const AUTH = {authorization: 'Bearer secret-token'}

describe('createRemoteOpenCodeV2Client', () => {
  it('creates a session at the given location and returns its id', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => json(200, {data: {id: 'ses_1'}}))
    const client = createRemoteOpenCodeV2Client({baseUrl: 'http://workspace:9200/', headers: AUTH, fetch})

    // #when
    const result = await client.createSession({directory: '/workspace/repo'})

    // #then
    expect(result).toEqual({success: true, data: {id: 'ses_1'}})
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'http://workspace:9200/api/session',
      method: 'POST',
      body: {location: {directory: '/workspace/repo'}},
    })
    expect(requests[0]?.headers.authorization).toBe('Bearer secret-token')
  })

  it('reports a 401 as an auth failure and never carries the body', async () => {
    // #given — the 401 body is always the same shape and says nothing about why
    const {fetch} = makeFetch(() => json(401, {_tag: 'UnauthorizedError', message: 'Authentication required'}))
    const client = createRemoteOpenCodeV2Client({baseUrl: 'http://workspace:9200', headers: AUTH, fetch})

    // #when
    const result = await client.createSession({directory: '/workspace/repo'})

    // #then
    expect(result).toEqual({success: false, error: {kind: 'auth', status: 401}})
  })

  it('reports other statuses, transport failures and aborts as distinct kinds', async () => {
    // #given
    const controller = new AbortController()
    const statusClient = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(503, {})).fetch,
    })
    const networkClient = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const abortedClient = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    })

    // #when / #then
    expect(await statusClient.interrupt({sessionId: 's'})).toEqual({success: false, error: {kind: 'http', status: 503}})
    expect(await networkClient.interrupt({sessionId: 's'})).toEqual({
      success: false,
      error: {kind: 'network', message: 'fetch failed'},
    })
    expect(await abortedClient.interrupt({sessionId: 's', signal: controller.signal})).toEqual({
      success: false,
      error: {kind: 'aborted'},
    })
  })

  it('reports a success body it cannot read as a parse failure', async () => {
    // #given
    const client = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(200, {unexpected: true})).fetch,
    })

    // #when / #then
    expect(await client.createSession({directory: '/d'})).toEqual({success: false, error: {kind: 'parse'}})
    expect(await client.interrupt({sessionId: 's'})).toEqual({success: false, error: {kind: 'parse'}})
  })

  it('sends the prompt as top-level text with the directory header', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => json(200, {data: {}}))
    const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    const result = await client.prompt({sessionId: 'ses/1', text: 'fix it', directory: '/workspace/repo'})

    // #then
    expect(result.success).toBe(true)
    expect(requests[0]).toMatchObject({
      url: 'http://w/api/session/ses%2F1/prompt',
      method: 'POST',
      body: {text: 'fix it'},
    })
    expect(requests[0]?.headers['x-opencode-directory']).toBe('/workspace/repo')
  })

  it('reads the interrupt reply and never treats a missing flag as a stop', async () => {
    // #given
    const stopped = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(200, {interrupted: true})).fetch,
    })
    const idle = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(200, {interrupted: false})).fetch,
    })

    // #when / #then
    expect(await stopped.interrupt({sessionId: 's'})).toEqual({success: true, data: {interrupted: true}})
    expect(await idle.interrupt({sessionId: 's'})).toEqual({success: true, data: {interrupted: false}})
  })

  it('reads the persisted outcome of a session', async () => {
    // #given
    const info = {id: 'ses_1', parentID: 'ses_0', location: {directory: '/d'}, outcome: 'interrupted'}
    const client = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(200, {data: info})).fetch,
    })

    // #when
    const result = await client.getSession({sessionId: 'ses_1'})

    // #then
    expect(result).toEqual({
      success: true,
      data: {id: 'ses_1', parentId: 'ses_0', directory: '/d', outcome: 'interrupted'},
    })
  })

  it('reads a session with no outcome as null', async () => {
    // #given
    const client = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(200, {data: {id: 'ses_1', location: {directory: '/d'}}})).fetch,
    })

    // #when
    const result = await client.getSession({sessionId: 'ses_1'})

    // #then
    expect(result).toEqual({success: true, data: {id: 'ses_1', parentId: null, directory: '/d', outcome: null}})
  })

  it('sends permission replies keyed by request id with the decision', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => new Response(null, {status: 204}))
    const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    const once = await client.replyPermission({sessionId: 'ses_1', requestId: 'per_a', decision: 'once'})
    const reject = await client.replyPermission({sessionId: 'ses_1', requestId: 'per_b', decision: 'reject'})

    // #then — two nested asks inside one execute stay two requests
    expect(once.success).toBe(true)
    expect(reject.success).toBe(true)
    expect(requests.map(request => [request.url, request.body])).toEqual([
      ['http://w/api/session/ses_1/permission/per_a/reply', {decision: 'once'}],
      ['http://w/api/session/ses_1/permission/per_b/reply', {decision: 'reject'}],
    ])
  })

  it('answers and cancels forms on the session-scoped routes', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => new Response(null, {status: 204}))
    const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    await client.replyForm({sessionId: 'ses_1', formId: 'frm_1', answer: {q0: 'A', q1: ['x', 'y']}})
    await client.cancelForm({sessionId: 'ses_1', formId: 'frm_2', message: 'not supported here'})
    await client.cancelForm({sessionId: 'ses_1', formId: 'frm_3'})

    // #then
    expect(requests.map(request => [request.method, request.url, request.body])).toEqual([
      ['POST', 'http://w/api/session/ses_1/form/frm_1/reply', {answer: {q0: 'A', q1: ['x', 'y']}}],
      ['DELETE', 'http://w/api/session/ses_1/form/frm_2?message=not+supported+here', undefined],
      ['DELETE', 'http://w/api/session/ses_1/form/frm_3', undefined],
    ])
  })

  it('exposes the active list unwrapped and throws when it cannot read it', async () => {
    // #given
    const ok = createRemoteOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(200, {data: {ses_child: {type: 'running'}}})).fetch,
    })
    const failing = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch: makeFetch(() => json(500, {})).fetch})

    // #when / #then
    expect(await ok.session.active()).toEqual({ses_child: {type: 'running'}})
    await expect(failing.session.active()).rejects.toThrow('session.active failed: http 500')
  })

  it('lists sessions with the filter and cursor as query parameters', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => json(200, {data: [{id: 'a'}], cursor: {next: 'c2'}}))
    const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    const page = await client.session.list({parentID: 'ses_root', directory: '/d', cursor: 'c1', limit: 100})

    // #then
    expect(page).toEqual({data: [{id: 'a'}], cursor: {next: 'c2'}})
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/api/session')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      parentID: 'ses_root',
      directory: '/d',
      cursor: 'c1',
      limit: '100',
    })
  })

  describe('subscribeEvents', () => {
    it('yields parsed data frames and a heartbeat marker for comment frames', async () => {
      // #given
      const {fetch, requests} = makeFetch(() =>
        sseResponse([
          'data: {"type":"server.connected","data":{}}\n\n',
          ': heartbeat\n\n',
          'data: {"type":"session.text.delta",',
          '"data":{"delta":"hi"}}\n\n',
        ]),
      )
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', headers: AUTH, fetch})

      // #when
      const result = await client.subscribeEvents({directory: '/workspace/repo'})

      // #then
      if (!result.success) throw new Error('expected a stream')
      const frames: unknown[] = []
      for await (const frame of result.data) frames.push(frame)
      expect(frames).toEqual([
        {type: 'server.connected', data: {}},
        V2_HEARTBEAT_FRAME,
        {type: 'session.text.delta', data: {delta: 'hi'}},
      ])
      expect(requests[0]?.url).toBe('http://w/api/event')
      expect(requests[0]?.headers['x-opencode-directory']).toBe('/workspace/repo')
      expect(requests[0]?.headers.accept).toBe('text/event-stream')
    })

    it('keeps reading after a frame it cannot parse', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => sseResponse(['data: {not json\n\n', 'data: {"type":"x"}\n\n'])).fetch,
      })

      // #when
      const result = await client.subscribeEvents({directory: '/d'})
      if (!result.success) throw new Error('expected a stream')
      const frames: unknown[] = []
      for await (const frame of result.data) frames.push(frame)

      // #then — the unreadable frame is still a sign of life, and carries no payload
      expect(frames).toEqual([{type: 'server.unreadable'}, {type: 'x'}])
    })

    it('fails a subscription the proxy rejects, as auth', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch: makeFetch(() => json(401, {})).fetch})

      // #when / #then
      expect(await client.subscribeEvents({directory: '/d'})).toEqual({
        success: false,
        error: {kind: 'auth', status: 401},
      })
    })

    it('fails a response that is not an event stream', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch: makeFetch(() => json(200, {})).fetch})

      // #when / #then
      expect(await client.subscribeEvents({directory: '/d'})).toEqual({success: false, error: {kind: 'parse'}})
    })

    it('ends the iteration when the signal aborts', async () => {
      // #given — a stream that never produces a frame
      const controller = new AbortController()
      const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            init?.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')))
          },
        })
        return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}})
      })
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch: fetchSpy})
      const result = await client.subscribeEvents({directory: '/d', signal: controller.signal})
      if (!result.success) throw new Error('expected a stream')

      // #when
      const reading = (async () => {
        const frames: unknown[] = []
        for await (const frame of result.data) frames.push(frame)
        return frames
      })()
      controller.abort()

      // #then
      await expect(reading).resolves.toEqual([])
    })
  })
})
