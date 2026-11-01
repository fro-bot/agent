import {describe, expect, it} from 'vitest'

import {createActionOpenCodeV2Client} from './remote-client-action-v2.js'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

function makeFetch(respond: (request: Recorded) => Response): {fetch: typeof fetch; requests: Recorded[]} {
  const requests: Recorded[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const request: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    requests.push(request)
    return respond(request)
  }
  return {fetch: impl, requests}
}

describe('createActionOpenCodeV2Client', () => {
  it('keeps the shared client methods', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => json(200, {data: {id: 'ses_1'}}))
    const client = createActionOpenCodeV2Client({baseUrl: 'http://w/', headers: {authorization: 'x'}, fetch})

    // #when
    const result = await client.createSession({directory: '/d'})

    // #then
    expect(result).toEqual({success: true, data: {id: 'ses_1'}})
    expect(requests[0]?.url).toBe('http://w/api/session')
  })

  it('switches the agent and the model of a session', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => new Response(null, {status: 204}))
    const client = createActionOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    const agent = await client.switchAgent({sessionId: 'ses/1', agent: 'plan'})
    const model = await client.switchModel({sessionId: 'ses/1', model: {providerID: 'anthropic', modelID: 'm'}})

    // #then
    expect(agent.success && model.success).toBe(true)
    expect(requests.map(request => [request.method, request.url, request.body])).toEqual([
      ['POST', 'http://w/api/session/ses%2F1/agent', {agent: 'plan'}],
      ['POST', 'http://w/api/session/ses%2F1/model', {model: {id: 'm', providerID: 'anthropic'}}],
    ])
  })

  it('waits on the experimental wait route and reads 204 as idle', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => new Response(null, {status: 204}))
    const client = createActionOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    const result = await client.waitSession({sessionId: 'ses_1'})

    // #then
    expect(result).toEqual({success: true, data: undefined})
    expect(requests[0]).toMatchObject({method: 'POST', url: 'http://w/api/experimental/session/ses_1/wait'})
  })

  it('reports a wait that failed without a body, and an unknown session as 404', async () => {
    // #given
    const unavailable = createActionOpenCodeV2Client({
      baseUrl: 'http://w',
      fetch: makeFetch(() => json(503, {message: 'secret body'})).fetch,
    })
    const missing = createActionOpenCodeV2Client({baseUrl: 'http://w', fetch: makeFetch(() => json(404, {})).fetch})

    // #when / #then
    expect(await unavailable.waitSession({sessionId: 's'})).toEqual({
      success: false,
      error: {kind: 'http', status: 503},
    })
    expect(await missing.waitSession({sessionId: 's'})).toEqual({success: false, error: {kind: 'http', status: 404}})
  })

  it('updates the title or archives a session with a PATCH', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => new Response(null, {status: 204}))
    const client = createActionOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    await client.updateSession({sessionId: 'ses_1', title: 'T'})
    await client.updateSession({sessionId: 'ses_1', archived: true})

    // #then
    expect(requests.map(request => [request.method, request.url, request.body])).toEqual([
      ['PATCH', 'http://w/api/session/ses_1', {title: 'T'}],
      ['PATCH', 'http://w/api/session/ses_1', {archived: true}],
    ])
  })

  it('appends a synthetic message without scheduling a turn', async () => {
    // #given
    const {fetch, requests} = makeFetch(() => json(200, {data: {}}))
    const client = createActionOpenCodeV2Client({baseUrl: 'http://w', fetch})

    // #when
    const result = await client.addSyntheticMessage({sessionId: 'ses_1', text: 'summary'})

    // #then
    expect(result.success).toBe(true)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'http://w/api/session/ses_1/synthetic',
      body: {text: 'summary', resume: false},
    })
  })
})
