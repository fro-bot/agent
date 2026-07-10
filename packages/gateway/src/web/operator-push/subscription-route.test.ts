/**
 * Tests for the authenticated operator push subscription routes:
 *   - POST /operator/push/subscriptions
 *   - POST /operator/push/subscriptions/unsubscribe
 *   - GET  /operator/push/subscriptions
 *
 * All tests go through the REAL HTTP route (with the operator route guard
 * installed) — not a handler-only or store-only call.
 */

import type {SubscriptionRouteDeps} from './subscription-route.js'
import type {SubscriptionMetadata} from './subscription-store.js'
import {err, ok} from '@fro-bot/runtime'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {createRateLimiter} from '../../http/rate-limit.js'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildSubscriptionRoutes} from './subscription-route.js'
import {createStoreError} from './subscription-store.js'

const VALID_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123'
const OPERATOR_A_ID = '1001'

function makeMetadata(overrides?: Partial<SubscriptionMetadata>): SubscriptionMetadata {
  return {
    endpointHash: 'hash-1',
    operatorId: OPERATOR_A_ID,
    active: true,
    keyVersion: '1',
    ownershipGeneration: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeStore(overrides?: Partial<SubscriptionRouteDeps['store']>): SubscriptionRouteDeps['store'] {
  return {
    subscribe: vi.fn(async () => ok(makeMetadata())),
    unsubscribe: vi.fn(async () => ok(undefined)),
    listMetadataForOperator: vi.fn(async () => ok([makeMetadata()])),
    ...overrides,
  }
}

function makeSessionStore(): SubscriptionRouteDeps['sessionStore'] {
  return {
    get: vi.fn((_sessionId: string, _nowMs: number) => ({githubUserId: 1001, login: 'alice'})),
  }
}

function makeDeps(overrides?: Partial<SubscriptionRouteDeps>): SubscriptionRouteDeps {
  return {
    sessionStore: makeSessionStore(),
    store: makeStore(),
    keyVersion: '1',
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    now: () => 1000,
    subscribeRateLimiter: createRateLimiter({limit: 1000, windowMs: 60_000}),
    unsubscribeRateLimiter: createRateLimiter({limit: 1000, windowMs: 60_000}),
    ...overrides,
  }
}

function buildAppWithGuard(deps: SubscriptionRouteDeps, allow = true): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () =>
    allow
      ? {ok: true, githubUserId: 1001, sessionId: 'sess-1'}
      : {ok: false, response: new Response(null, {status: 404})},
  )
  buildSubscriptionRoutes(app, deps)
  return app
}

describe('buildSubscriptionRoutes — subscribe', () => {
  // #given a valid CSRF/body subscribe request
  // #when POST /operator/push/subscriptions
  // #then creates/replaces one record; response is safe metadata only
  it('happy path: subscribes and returns safe metadata only', async () => {
    const store = makeStore()
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(200)
    expect(store.subscribe).toHaveBeenCalledWith({
      operatorId: OPERATOR_A_ID,
      endpoint: VALID_ENDPOINT,
      p256dh: 'p1',
      auth: 'a1',
      keyVersion: '1',
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(body.endpoint).toBeUndefined()
    expect(body.p256dh).toBeUndefined()
    expect(body.auth).toBeUndefined()
    expect(body.endpointHash).toBe('hash-1')
  })

  // #given no authenticated session
  // #when POST /operator/push/subscriptions
  // #then notFoundResponse, no store write
  it('error path: unauthenticated request is denied with no store write', async () => {
    const store = makeStore()
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps, false)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(404)
    expect(store.subscribe).not.toHaveBeenCalled()
  })

  // #given a malformed body (missing keys)
  // #when POST /operator/push/subscriptions
  // #then 400, no store write, endpoint never logged
  it('error path: malformed body is rejected with 400 and no store write', async () => {
    const store = makeStore()
    const warn = vi.fn()
    const deps = makeDeps({store, logger: {debug: vi.fn(), info: vi.fn(), warn, error: vi.fn()}})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT}),
    })

    expect(res.status).toBe(400)
    expect(store.subscribe).not.toHaveBeenCalled()
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(VALID_ENDPOINT)
    }
  })

  // #given an endpoint that fails SSRF validation (loopback)
  // #when POST /operator/push/subscriptions
  // #then 400, endpoint value never logged
  it('error path: loopback endpoint is rejected without logging the endpoint value', async () => {
    const store = makeStore()
    const warn = vi.fn()
    const deps = makeDeps({store, logger: {debug: vi.fn(), info: vi.fn(), warn, error: vi.fn()}})
    const app = buildAppWithGuard(deps)
    const loopbackEndpoint = 'https://127.0.0.1/secret-path'

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: loopbackEndpoint, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(400)
    expect(store.subscribe).not.toHaveBeenCalled()
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secret-path')
    }
  })

  // #given the subscribe rate limit is exhausted
  // #when POST /operator/push/subscriptions
  // #then rate-limited response, no store write
  it('rate limit: exhausted operator-keyed limit denies the request', async () => {
    const store = makeStore()
    const limiter = createRateLimiter({limit: 1, windowMs: 60_000})
    const deps = makeDeps({store, subscribeRateLimiter: limiter})
    const app = buildAppWithGuard(deps)

    const requestOptions = {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    }
    // First request consumes the single-request budget.
    await app.request('/operator/push/subscriptions', requestOptions)
    const res = await app.request('/operator/push/subscriptions', requestOptions)

    expect(res.status).toBe(429)
    expect(store.subscribe).toHaveBeenCalledTimes(1)
  })

  // #given the store rejects the write (e.g. underlying object-store error)
  // #when POST /operator/push/subscriptions
  // #then a safe denial is surfaced, no distinguishing detail
  it('error path: a store write failure surfaces a safe denial without leaking the endpoint', async () => {
    const store = makeStore({
      subscribe: vi.fn(async () => err(createStoreError('subscribe: exceeded max CAS retry attempts'))),
    })
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const deps = makeDeps({store, logger})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('not-found')
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      for (const call of logger[level].mock.calls) {
        expect(JSON.stringify(call)).not.toContain(VALID_ENDPOINT)
      }
    }
  })

  // #given the operator already has the cap's worth of active subscriptions,
  // none of which is the incoming endpoint
  // #when POST /operator/push/subscriptions
  // #then 400, store.subscribe is never called
  it('subscription cap: a new endpoint at the cap is rejected without a store write', async () => {
    const activeAtCap = Array.from({length: 20}, (_v, i) => makeMetadata({endpointHash: `hash-${i}`, active: true}))
    const store = makeStore({listMetadataForOperator: vi.fn(async () => ok(activeAtCap))})
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(400)
    expect(store.subscribe).not.toHaveBeenCalled()
  })

  // #given the operator is at the cap but the incoming endpoint is already
  // one of their active records (a replace, not a new record)
  // #when POST /operator/push/subscriptions
  // #then the cap does not block it — store.subscribe is called
  it('subscription cap: a re-subscribe of an existing endpoint at the cap is allowed', async () => {
    const {createHash} = await import('node:crypto')
    const endpointHash = createHash('sha256').update(VALID_ENDPOINT, 'utf8').digest('hex')
    const activeAtCap = [
      makeMetadata({endpointHash, active: true}),
      ...Array.from({length: 19}, (_v, i) => makeMetadata({endpointHash: `hash-${i}`, active: true})),
    ]
    const store = makeStore({listMetadataForOperator: vi.fn(async () => ok(activeAtCap))})
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(200)
    expect(store.subscribe).toHaveBeenCalledOnce()
  })

  // #given the operator is well under the cap
  // #when POST /operator/push/subscriptions
  // #then the write proceeds normally
  it('subscription cap: under the cap, subscribe proceeds normally', async () => {
    const store = makeStore({listMetadataForOperator: vi.fn(async () => ok([makeMetadata()]))})
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(200)
    expect(store.subscribe).toHaveBeenCalledOnce()
  })
})

describe('buildSubscriptionRoutes — unsubscribe', () => {
  // #given an authenticated operator's own subscription
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then marks the record inactive
  it("happy path: unsubscribes the operator's own record", async () => {
    const store = makeStore()
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT}),
    })

    expect(res.status).toBe(200)
    expect(store.unsubscribe).toHaveBeenCalledWith({operatorId: OPERATOR_A_ID, endpoint: VALID_ENDPOINT})
  })

  // #given another operator's record (store fails-closed)
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then a safe denial is surfaced, no distinguishing detail
  it("error path: cannot unsubscribe another operator's record — surfaces a safe denial", async () => {
    const store = makeStore({
      unsubscribe: vi.fn(async () => err(createStoreError('unsubscribe: endpoint is not owned by this operator'))),
    })
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT}),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('not-found')
  })

  // #given malformed body (missing endpoint)
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then 400, no store write
  it('error path: malformed body is rejected with 400', async () => {
    const store = makeStore()
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    expect(store.unsubscribe).not.toHaveBeenCalled()
  })

  // #given no authenticated session
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then notFoundResponse, no store write
  it('error path: unauthenticated request is denied with no store write', async () => {
    const store = makeStore()
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps, false)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT}),
    })

    expect(res.status).toBe(404)
    expect(store.unsubscribe).not.toHaveBeenCalled()
  })
})

describe('buildSubscriptionRoutes — list', () => {
  // #given an authenticated operator with active subscriptions
  // #when GET /operator/push/subscriptions
  // #then returns safe metadata array only
  it('happy path: returns safe metadata array', async () => {
    const store = makeStore()
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {subscriptions: Record<string, unknown>[]}
    expect(body.subscriptions).toHaveLength(1)
    expect(body.subscriptions[0]?.endpointHash).toBe('hash-1')
    expect(body.subscriptions[0]?.endpoint).toBeUndefined()
  })

  // #given no authenticated session
  // #when GET /operator/push/subscriptions
  // #then notFoundResponse
  it('error path: unauthenticated request is denied', async () => {
    const store = makeStore()
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps, false)

    const res = await app.request('/operator/push/subscriptions')

    expect(res.status).toBe(404)
    expect(store.listMetadataForOperator).not.toHaveBeenCalled()
  })
})
