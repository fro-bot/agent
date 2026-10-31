import type {V2GatewayRoute} from './gateway-routes-v2.js'
import type {RemoteOpenCodeV2Client} from './remote-client-v2.js'

import {describe, expect, it} from 'vitest'

import {isGatewayRouteV2, routeMatches, V2_GATEWAY_ROUTES} from './gateway-routes-v2.js'
import {createRemoteOpenCodeV2Client} from './remote-client-v2.js'

/**
 * The drift guard for the workspace bearer proxy's allowlist (fro-bot/agent#1992). The gateway reaches the V2 server
 * through `createRemoteOpenCodeV2Client` and nothing else, and the proxy forwards only `V2_GATEWAY_ROUTES`. This test
 * calls EVERY method of the real client against a recording fetch and requires each request to be allowlisted. The
 * `CALLS` record is typed by the client's method names, so adding a client method fails type-checking here until it
 * is listed, and listing it makes its route fail this test until it is allowlisted.
 */

interface Seen {
  readonly method: string
  readonly pathname: string
}

type ClientCalls = {
  readonly [K in Exclude<keyof RemoteOpenCodeV2Client, 'session'>]: (client: RemoteOpenCodeV2Client) => Promise<unknown>
}

const DIRECTORY = '/workspace/repos/acme/widget'

const CALLS: ClientCalls = {
  createSession: async client => client.createSession({directory: DIRECTORY}),
  getSession: async client => client.getSession({sessionId: 'ses_abc123'}),
  prompt: async client => client.prompt({sessionId: 'ses_abc123', text: 'hi', directory: DIRECTORY}),
  interrupt: async client => client.interrupt({sessionId: 'ses_abc123'}),
  subscribeEvents: async client => {
    const subscribed = await client.subscribeEvents({directory: DIRECTORY})
    if (subscribed.success) await subscribed.data[Symbol.asyncIterator]().return?.()
  },
  replyPermission: async client =>
    client.replyPermission({sessionId: 'ses_abc123', requestId: 'per_abc123', decision: 'once'}),
  replyForm: async client => client.replyForm({sessionId: 'ses_abc123', formId: 'frm_abc123', answer: {}}),
  cancelForm: async client => client.cancelForm({sessionId: 'ses_abc123', formId: 'frm_abc123', message: 'no'}),
  listSessionInbox: async client => client.listSessionInbox({sessionId: 'ses_abc123'}),
  listShells: async client => client.listShells({directory: DIRECTORY}),
  getShell: async client => client.getShell({directory: DIRECTORY, shellId: 'shl_abc123'}),
  deleteShell: async client => client.deleteShell({directory: DIRECTORY, shellId: 'shl_abc123'}),
}

async function recordedRequests(call: (client: RemoteOpenCodeV2Client) => Promise<unknown>): Promise<Seen[]> {
  const seen: Seen[] = []
  const client = createRemoteOpenCodeV2Client({
    baseUrl: 'http://workspace:9200',
    fetch: async (input, init) => {
      seen.push({method: init?.method ?? 'GET', pathname: new URL(String(input)).pathname})
      return new Response('{"data":{}}', {status: 200, headers: {'content-type': 'text/event-stream'}})
    },
  })
  await call(client).catch(() => undefined)
  return seen
}

/**
 * The allowlist entries no exercised request matches. Each exercised request is judged against ITS OWN entry (method plus
 * segment pattern), never against the whole list: with the whole list, an unused `GET /api/credential` would pass
 * because an exercised `GET /api/session` happens to match some other GET entry.
 */
function unexercisedRoutes(routes: readonly V2GatewayRoute[], exercised: ReadonlySet<string>): string[] {
  const requests = [...exercised].map(entry => entry.split(' ') as [string, string])
  return routes
    .filter(route => !requests.some(([method, pathname]) => routeMatches(route, method, pathname)))
    .map(route => `${route.method} ${route.path}`)
}

describe('V2_GATEWAY_ROUTES drift guard', () => {
  it.each(Object.entries(CALLS))('allowlists every route RemoteOpenCodeV2Client.%s can call', async (_name, call) => {
    // #when the real client method runs against a recording fetch
    const seen = await recordedRequests(call)

    // #then it made a request, and the proxy allowlist covers each one
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) {
      expect(isGatewayRouteV2(request.method, request.pathname), `${request.method} ${request.pathname}`).toBe(true)
    }
  })

  it('allowlists the session.active and session.list routes', async () => {
    const seen = [
      ...(await recordedRequests(async client => client.session.active())),
      ...(await recordedRequests(async client => client.session.list({parentID: 'ses_abc123', limit: 5}))),
    ]
    expect(seen.map(request => `${request.method} ${request.pathname}`)).toEqual([
      'GET /api/session/active',
      'GET /api/session',
    ])
    for (const request of seen) expect(isGatewayRouteV2(request.method, request.pathname)).toBe(true)
  })

  it('has no route the client cannot call: every allowlisted route is exercised above', async () => {
    // #given every request the client methods make
    const exercised = new Set<string>()
    for (const call of Object.values(CALLS)) {
      for (const request of await recordedRequests(call)) {
        exercised.add(`${request.method} ${request.pathname}`)
      }
    }
    exercised.add('GET /api/session/active')
    exercised.add('GET /api/session')

    // #then every allowlist entry is the one some request actually matches, so a route nobody calls cannot linger
    expect(unexercisedRoutes(V2_GATEWAY_ROUTES, exercised)).toEqual([])
  })

  it('fails on an unexercised entry that shares a method with an exercised one', () => {
    // #given the real exercised set and one extra allowlisted route that no client method calls
    const exercised = new Set(['GET /api/session', 'GET /api/session/active', 'GET /api/session/ses_abc123'])
    const withExtra: readonly V2GatewayRoute[] = [
      {method: 'GET', path: '/api/session'},
      {method: 'GET', path: '/api/session/active'},
      {method: 'GET', path: '/api/session/:sessionId'},
      {method: 'GET', path: '/api/credential'},
    ]

    // #then the guard names it, even though `GET /api/session` matches another GET entry
    expect(unexercisedRoutes(withExtra, exercised)).toEqual(['GET /api/credential'])
  })

  it('also fails on an extra entry whose method nobody uses', () => {
    const exercised = new Set(['GET /api/session/ses_abc123/inbox'])
    expect(
      unexercisedRoutes(
        [
          {method: 'GET', path: '/api/session/:sessionId/inbox'},
          {method: 'DELETE', path: '/api/session/:sessionId/inbox'},
          {method: 'GET', path: '/api/session/:sessionId/:anything'},
        ],
        exercised,
      ),
    ).toEqual(['DELETE /api/session/:sessionId/inbox'])
  })
})

describe('isGatewayRouteV2', () => {
  it.each([
    ['GET', '/api/session/active'],
    ['GET', '/api/session'],
    ['POST', '/api/session'],
    ['GET', '/api/session/ses_abc-123'],
    ['POST', '/api/session/ses_abc/prompt'],
    ['POST', '/api/session/ses_abc/interrupt'],
    ['GET', '/api/event'],
    ['POST', '/api/session/ses_abc/permission/per_1/reply'],
    ['POST', '/api/session/ses_abc/form/frm_1/reply'],
    ['DELETE', '/api/session/ses_abc/form/frm_1'],
    ['GET', '/api/session/ses_abc/inbox'],
    ['GET', '/api/shell'],
    ['GET', '/api/shell/shl_1'],
    ['DELETE', '/api/shell/shl_1'],
  ])('matches %s %s', (method, pathname) => {
    expect(isGatewayRouteV2(method, pathname)).toBe(true)
  })

  it.each([
    ['DELETE', '/api/session/ses_abc'],
    ['PUT', '/api/session'],
    ['PATCH', '/api/session/ses_abc'],
    ['POST', '/api/session/active'],
    ['GET', '/api/info'],
    ['GET', '/api/credential'],
    ['POST', '/api/credential'],
    ['GET', '/api/integration/anthropic'],
    ['DELETE', '/api/debug/location'],
    ['POST', '/api/location/reload'],
    ['GET', '/api/session/ses_abc/prompt'],
    ['POST', '/api/session/ses_abc/shell'],
    ['GET', '/api/session/ses_abc/extra/segments/here'],
    ['GET', '/api/session/ses%5Fabc'],
    ['GET', '/api/session/ses abc'],
    ['GET', '/api/session/ses;abc'],
    ['GET', '/api/session/..'],
    ['GET', '/API/session'],
    ['GET', '/api/Session'],
    ['GET', '/api/session/'],
    ['GET', 'api/session'],
    ['GET', `/api/session/${'a'.repeat(129)}`],
    ['get', '/api/session'],
  ])('refuses %s %s', (method, pathname) => {
    expect(isGatewayRouteV2(method, pathname)).toBe(false)
  })
})
