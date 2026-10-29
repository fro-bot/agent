import {describe, expect, it, vi} from 'vitest'

import {
  SHELL_DIRECTORY,
  SHELL_GET_EXITED_RESPONSE,
  SHELL_ID,
  SHELL_LIST_EMPTY_RESPONSE,
  SHELL_LIST_RUNNING_RESPONSE,
  SHELL_SESSION_ID,
} from './event-v2.fixtures.js'
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

  it('trims every trailing slash from the base URL in linear time', async () => {
    // #given — a base URL ending in a long run of slashes
    const {fetch, requests} = makeFetch(() => json(200, {data: {id: 'ses_1'}}))
    const client = createRemoteOpenCodeV2Client({
      baseUrl: `http://workspace:9200${'/'.repeat(100_000)}`,
      headers: AUTH,
      fetch,
    })

    // #when
    await client.createSession({directory: '/workspace/repo'})

    // #then
    expect(requests[0]?.url).toBe('http://workspace:9200/api/session')
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

    it('reads a CRLF delimiter split across chunks at every boundary', async () => {
      // #given — two frames with CRLF line ends, cut at every position (a CR and its LF in different chunks included)
      const wire = 'data: {"type":"a","data":{}}\r\n\r\ndata: {"type":"b","data":{}}\r\n\r\n'
      const expected = [
        {type: 'a', data: {}},
        {type: 'b', data: {}},
      ]

      for (let cut = 0; cut <= wire.length; cut++) {
        const client = createRemoteOpenCodeV2Client({
          baseUrl: 'http://w',
          fetch: makeFetch(() => sseResponse([wire.slice(0, cut), wire.slice(cut)])).fetch,
        })

        // #when
        const result = await client.subscribeEvents({directory: '/d'})

        // #then
        if (!result.success) throw new Error('expected a stream')
        const frames: unknown[] = []
        for await (const frame of result.data) frames.push(frame)
        expect(frames, `cut at ${cut}`).toEqual(expected)
      }
    })

    it('reads a CRLF delimiter split across three chunks, and one byte at a time', async () => {
      // #given
      const wire = 'data: {"type":"a","data":{}}\r\n\r\ndata: {"type":"b","data":{}}\r\n\r\n'
      const expected = [
        {type: 'a', data: {}},
        {type: 'b', data: {}},
      ]
      const splits: string[][] = [[...wire]]
      for (let first = 1; first < wire.length; first++) {
        for (let second = first + 1; second < wire.length; second++) {
          splits.push([wire.slice(0, first), wire.slice(first, second), wire.slice(second)])
        }
      }

      for (const chunks of splits) {
        const client = createRemoteOpenCodeV2Client({
          baseUrl: 'http://w',
          fetch: makeFetch(() => sseResponse(chunks)).fetch,
        })

        // #when
        const result = await client.subscribeEvents({directory: '/d'})

        // #then
        if (!result.success) throw new Error('expected a stream')
        const frames: unknown[] = []
        for await (const frame of result.data) frames.push(frame)
        expect({chunks, frames}).toEqual({chunks, frames: expected})
      }
    })

    it('reads lone CR line ends and a final frame whose delimiter ends the stream', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => sseResponse(['data: {"type":"a","data":{}}\r\r', 'data: {"type":"b","data":{}}\r']))
          .fetch,
      })

      // #when
      const result = await client.subscribeEvents({directory: '/d'})

      // #then — the trailing lone CR is a line end, but one line end is not a frame delimiter
      if (!result.success) throw new Error('expected a stream')
      const frames: unknown[] = []
      for await (const frame of result.data) frames.push(frame)
      expect(frames).toEqual([{type: 'a', data: {}}])
    })

    it('ends the stream with an error at a frame it cannot parse, after delivering the frames before it', async () => {
      // #given — a frame that is cut off, then a frame that would parse
      const client = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() =>
          sseResponse([
            'data: {"type":"x"}\n\n',
            'data: {"type":"permission.asked","data":{"id":"sec\n\n',
            'data: {"type":"y"}\n\n',
          ]),
        ).fetch,
      })
      const result = await client.subscribeEvents({directory: '/d'})
      if (!result.success) throw new Error('expected a stream')

      // #when
      const frames: unknown[] = []
      const reading = (async () => {
        for await (const frame of result.data) frames.push(frame)
      })()

      // #then — the stream fails instead of skipping a frame of unknown type, and the error carries no payload
      await expect(reading).rejects.toThrow('could not be parsed')
      await expect(reading).rejects.not.toThrow('sec')
      expect(frames).toEqual([{type: 'x'}])
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
  describe('background shells', () => {
    it('lists the running shells of a location, reading owner, status and pid from the real response (p20)', async () => {
      // #given
      const {fetch, requests} = makeFetch(() => json(200, SHELL_LIST_RUNNING_RESPONSE))
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w:9200/', headers: AUTH, fetch})

      // #when
      const result = await client.listShells({directory: SHELL_DIRECTORY})

      // #then
      expect(result).toEqual({
        success: true,
        data: [{id: SHELL_ID, status: 'running', ownerSessionId: SHELL_SESSION_ID, pid: 67593}],
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({url: 'http://w:9200/api/shell', method: 'GET'})
      expect(requests[0]?.headers).toMatchObject({...AUTH, 'x-opencode-directory': SHELL_DIRECTORY})
    })

    it('reads an empty list and an untagged shell', async () => {
      // #given
      const empty = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => json(200, SHELL_LIST_EMPTY_RESPONSE)).fetch,
      })
      const untagged = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => json(200, {data: [{id: 'sh_1', status: 'running', metadata: {}}]})).fetch,
      })

      // #when / #then
      expect(await empty.listShells({directory: '/d'})).toEqual({success: true, data: []})
      expect(await untagged.listShells({directory: '/d'})).toEqual({
        success: true,
        data: [{id: 'sh_1', status: 'running', ownerSessionId: null, pid: null}],
      })
    })

    it('fails closed on a list it cannot read: a hidden shell would read as stopped', async () => {
      // #given
      const notArray = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => json(200, {data: {}})).fetch,
      })
      const noId = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => json(200, {data: [{status: 'running'}]})).fetch,
      })

      // #when / #then
      expect(await notArray.listShells({directory: '/d'})).toEqual({success: false, error: {kind: 'parse'}})
      expect(await noId.listShells({directory: '/d'})).toEqual({success: false, error: {kind: 'parse'}})
    })

    it('reads a status it does not know as unknown rather than stopped', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => json(200, {data: [{id: 'sh_1', status: 'suspended'}]})).fetch,
      })

      // #when
      const result = await client.listShells({directory: '/d'})

      // #then
      expect(result).toEqual({
        success: true,
        data: [{id: 'sh_1', status: 'unknown', ownerSessionId: null, pid: null}],
      })
    })

    it('gets one shell by id, including an exited one', async () => {
      // #given
      const {fetch, requests} = makeFetch(() => json(200, SHELL_GET_EXITED_RESPONSE))
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch})

      // #when
      const result = await client.getShell({directory: SHELL_DIRECTORY, shellId: SHELL_ID})

      // #then
      expect(result).toEqual({
        success: true,
        data: {id: SHELL_ID, status: 'exited', ownerSessionId: SHELL_SESSION_ID, pid: 67593},
      })
      expect(requests[0]).toMatchObject({url: `http://w/api/shell/${SHELL_ID}`, method: 'GET'})
      expect(requests[0]?.headers).toMatchObject({'x-opencode-directory': SHELL_DIRECTORY})
    })

    it('reports an unknown shell as http 404', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch: makeFetch(() => json(404, {})).fetch})

      // #when / #then
      expect(await client.getShell({directory: '/d', shellId: 'sh_gone'})).toEqual({
        success: false,
        error: {kind: 'http', status: 404},
      })
    })

    it('deletes a shell with a DELETE in the shell location and reads 204 as success', async () => {
      // #given
      const {fetch, requests} = makeFetch(() => new Response(null, {status: 204}))
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', headers: AUTH, fetch})

      // #when
      const result = await client.deleteShell({directory: SHELL_DIRECTORY, shellId: SHELL_ID})

      // #then
      expect(result).toEqual({success: true, data: undefined})
      expect(requests[0]).toMatchObject({url: `http://w/api/shell/${SHELL_ID}`, method: 'DELETE'})
      expect(requests[0]?.headers).toMatchObject({...AUTH, 'x-opencode-directory': SHELL_DIRECTORY})
    })

    it('encodes the shell id in the path', async () => {
      // #given
      const {fetch, requests} = makeFetch(() => new Response(null, {status: 204}))
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch})

      // #when
      await client.deleteShell({directory: '/d', shellId: 'sh_a/b?c'})

      // #then
      expect(requests[0]?.url).toBe('http://w/api/shell/sh_a%2Fb%3Fc')
    })

    it('maps auth, transport and abort failures without leaking a body, and passes the signal through', async () => {
      // #given
      const controller = new AbortController()
      const unauthorized = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => json(401, {})).fetch,
      })
      const down = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: async () => {
          throw new Error('connect refused')
        },
      })
      const aborting = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: async (_input, init) => {
          controller.abort()
          if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
          return json(200, {data: []})
        },
      })

      // #when / #then
      expect(await unauthorized.deleteShell({directory: '/d', shellId: 'sh_1'})).toEqual({
        success: false,
        error: {kind: 'auth', status: 401},
      })
      expect(await down.listShells({directory: '/d'})).toEqual({
        success: false,
        error: {kind: 'network', message: 'connect refused'},
      })
      expect(await aborting.getShell({directory: '/d', shellId: 'sh_1', signal: controller.signal})).toEqual({
        success: false,
        error: {kind: 'aborted'},
      })
    })
  })
  describe('session inbox', () => {
    it('reads the number of queued items of a session', async () => {
      // #given — the shape of `session.inbox.list`: durable enqueued work not yet delivered
      const {fetch, requests} = makeFetch(() =>
        json(200, {
          data: [
            {id: 'msg_1', type: 'synthetic', payload: {text: 'x', metadata: {source: 'shell'}}, delivery: 'steer'},
            {id: 'msg_2', type: 'user', payload: {text: 'y'}, delivery: 'steer'},
          ],
        }),
      )
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', headers: AUTH, fetch})

      // #when
      const result = await client.listSessionInbox({sessionId: 'ses_a/b'})

      // #then
      expect(result).toEqual({success: true, data: {queued: 2}})
      expect(requests[0]).toMatchObject({url: 'http://w/api/session/ses_a%2Fb/inbox', method: 'GET'})
      expect(requests[0]?.headers).toMatchObject(AUTH)
    })

    it('reads an empty inbox', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: makeFetch(() => json(200, {data: []})).fetch,
      })

      // #when / #then
      expect(await client.listSessionInbox({sessionId: 'ses_1'})).toEqual({success: true, data: {queued: 0}})
    })

    it('fails closed on a payload without a data array, never reading it as empty', async () => {
      // #given
      const client = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch: makeFetch(() => json(200, {})).fetch})

      // #when / #then
      expect(await client.listSessionInbox({sessionId: 'ses_1'})).toEqual({success: false, error: {kind: 'parse'}})
    })

    it('reports an unknown session as http 404 and passes the signal through', async () => {
      // #given
      const controller = new AbortController()
      const notFound = createRemoteOpenCodeV2Client({baseUrl: 'http://w', fetch: makeFetch(() => json(404, {})).fetch})
      const aborting = createRemoteOpenCodeV2Client({
        baseUrl: 'http://w',
        fetch: async (_input, init) => {
          controller.abort()
          if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
          return json(200, {data: []})
        },
      })

      // #when / #then
      expect(await notFound.listSessionInbox({sessionId: 'ses_gone'})).toEqual({
        success: false,
        error: {kind: 'http', status: 404},
      })
      expect(await aborting.listSessionInbox({sessionId: 'ses_1', signal: controller.signal})).toEqual({
        success: false,
        error: {kind: 'aborted'},
      })
    })
  })
})
