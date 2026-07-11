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
    auditLogger: {info: vi.fn(), warn: vi.fn()},
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
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, auditLogger})
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

    // #then a push.subscribed audit event fires with no endpoint/key material
    expect(auditLogger.info).toHaveBeenCalledOnce()
    const [ctx] = auditLogger.info.mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx).toMatchObject({kind: 'push.subscribed', githubUserId: 1001})
    expect(JSON.stringify(ctx)).not.toContain(VALID_ENDPOINT)
  })

  // #given no authenticated session
  // #when POST /operator/push/subscriptions
  // #then notFoundResponse, no store write
  it('error path: unauthenticated request is denied with no store write', async () => {
    const store = makeStore()
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, auditLogger})
    const app = buildAppWithGuard(deps, false)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(404)
    expect(store.subscribe).not.toHaveBeenCalled()
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.subscribed'}),
      expect.anything(),
    )
  })

  // #given a malformed body (missing keys)
  // #when POST /operator/push/subscriptions
  // #then 400, no store write, endpoint never logged
  it('error path: malformed body is rejected with 400 and no store write', async () => {
    const store = makeStore()
    const warn = vi.fn()
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, logger: {debug: vi.fn(), info: vi.fn(), warn, error: vi.fn()}, auditLogger})
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
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.subscribed'}),
      expect.anything(),
    )
  })

  // #given an endpoint that fails SSRF validation (loopback)
  // #when POST /operator/push/subscriptions
  // #then 400, endpoint value never logged
  it('error path: loopback endpoint is rejected without logging the endpoint value', async () => {
    const store = makeStore()
    const warn = vi.fn()
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, logger: {debug: vi.fn(), info: vi.fn(), warn, error: vi.fn()}, auditLogger})
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
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.subscribed'}),
      expect.anything(),
    )
  })

  // #given the subscribe rate limit is exhausted
  // #when POST /operator/push/subscriptions
  // #then rate-limited response, no store write
  it('rate limit: exhausted operator-keyed limit denies the request', async () => {
    const store = makeStore()
    const limiter = createRateLimiter({limit: 1, windowMs: 60_000})
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, subscribeRateLimiter: limiter, auditLogger})
    const app = buildAppWithGuard(deps)

    const requestOptions = {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    }
    // First request consumes the single-request budget.
    await app.request('/operator/push/subscriptions', requestOptions)
    auditLogger.info.mockClear()
    const res = await app.request('/operator/push/subscriptions', requestOptions)

    expect(res.status).toBe(429)
    expect(store.subscribe).toHaveBeenCalledTimes(1)
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.subscribed'}),
      expect.anything(),
    )
  })

  // #given the store rejects the write (e.g. underlying object-store error)
  // #when POST /operator/push/subscriptions
  // #then a safe denial is surfaced, no distinguishing detail
  it('error path: a store write failure surfaces a safe denial without leaking the endpoint', async () => {
    const store = makeStore({
      subscribe: vi.fn(async () => err(createStoreError('subscribe: exceeded max CAS retry attempts'))),
    })
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, logger, auditLogger})
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
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.subscribed'}),
      expect.anything(),
    )
  })

  // #given the operator already has the cap's worth of active subscriptions,
  // none of which is the incoming endpoint
  // #when POST /operator/push/subscriptions
  // #then 400, store.subscribe is never called
  it('subscription cap: a new endpoint at the cap is rejected without a store write', async () => {
    const activeAtCap = Array.from({length: 20}, (_v, i) => makeMetadata({endpointHash: `hash-${i}`, active: true}))
    const store = makeStore({listMetadataForOperator: vi.fn(async () => ok(activeAtCap))})
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, auditLogger})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT, keys: {p256dh: 'p1', auth: 'a1'}}),
    })

    expect(res.status).toBe(400)
    expect(store.subscribe).not.toHaveBeenCalled()
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.subscribed'}),
      expect.anything(),
    )
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

  // #given the operator is one below the cap, and two concurrent requests
  // subscribe two DISTINCT new endpoints at the same time
  // #when both POST /operator/push/subscriptions fire concurrently
  // #then both succeed — this is the expected, documented soft-bound
  // behavior (the cap read is not atomic with the write), not a bug; the
  // per-operator rate limit is what actually bounds the overrun
  it('subscription cap is soft: two concurrent subscribes for distinct new endpoints at cap-1 can both succeed', async () => {
    const activeJustUnderCap = Array.from({length: 19}, (_v, i) =>
      makeMetadata({endpointHash: `hash-${i}`, active: true}),
    )
    const store = makeStore({listMetadataForOperator: vi.fn(async () => ok(activeJustUnderCap))})
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const [resA, resB] = await Promise.all([
      app.request('/operator/push/subscriptions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/concurrent-a',
          keys: {p256dh: 'p1', auth: 'a1'},
        }),
      }),
      app.request('/operator/push/subscriptions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/concurrent-b',
          keys: {p256dh: 'p2', auth: 'a2'},
        }),
      }),
    ])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(store.subscribe).toHaveBeenCalledTimes(2)
  })
})

describe('buildSubscriptionRoutes — unsubscribe', () => {
  // #given an authenticated operator's own subscription
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then marks the record inactive
  it("happy path: unsubscribes the operator's own record", async () => {
    const store = makeStore()
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, auditLogger})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT}),
    })

    expect(res.status).toBe(200)
    expect(store.unsubscribe).toHaveBeenCalledWith({operatorId: OPERATOR_A_ID, endpoint: VALID_ENDPOINT})

    // #then a push.unsubscribed audit event fires with no endpoint material
    expect(auditLogger.info).toHaveBeenCalledOnce()
    const [ctx] = auditLogger.info.mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx).toMatchObject({kind: 'push.unsubscribed', githubUserId: 1001})
    expect(JSON.stringify(ctx)).not.toContain(VALID_ENDPOINT)
  })

  // #given another operator's record (store fails-closed)
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then a safe denial is surfaced, no distinguishing detail
  it("error path: cannot unsubscribe another operator's record — surfaces a safe denial", async () => {
    const store = makeStore({
      unsubscribe: vi.fn(async () => err(createStoreError('unsubscribe: endpoint is not owned by this operator'))),
    })
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, auditLogger})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT}),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('not-found')
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.unsubscribed'}),
      expect.anything(),
    )
  })

  // #given malformed body (missing endpoint)
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then 400, no store write
  it('error path: malformed body is rejected with 400', async () => {
    const store = makeStore()
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, auditLogger})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    expect(store.unsubscribe).not.toHaveBeenCalled()
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.unsubscribed'}),
      expect.anything(),
    )
  })

  // #given no authenticated session
  // #when POST /operator/push/subscriptions/unsubscribe
  // #then notFoundResponse, no store write
  it('error path: unauthenticated request is denied with no store write', async () => {
    const store = makeStore()
    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = makeDeps({store, auditLogger})
    const app = buildAppWithGuard(deps, false)

    const res = await app.request('/operator/push/subscriptions/unsubscribe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: VALID_ENDPOINT}),
    })

    expect(res.status).toBe(404)
    expect(store.unsubscribe).not.toHaveBeenCalled()
    expect(auditLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({kind: 'push.unsubscribed'}),
      expect.anything(),
    )
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

  // #given a record the store marked inactive with the internal-only
  // 'transferred' reason (ownership moved to a different operator)
  // #when GET /operator/push/subscriptions
  // #then the response carries the coarse public 'revoked' reason — never
  // omitted, and never the literal 'transferred' string
  it('maps a transferred record to the coarse public "revoked" reason, not an omitted reason', async () => {
    const store = makeStore({
      listMetadataForOperator: vi.fn(async () => ok([makeMetadata({active: false, inactiveReason: 'transferred'})])),
    })
    const deps = makeDeps({store})
    const app = buildAppWithGuard(deps)

    const res = await app.request('/operator/push/subscriptions')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {subscriptions: Record<string, unknown>[]}
    expect(body.subscriptions[0]?.active).toBe(false)
    expect(body.subscriptions[0]?.inactiveReason).toBe('revoked')
    expect(JSON.stringify(body)).not.toContain('transferred')
  })
})
