/**
 * Tests for the authenticated VAPID public key route: GET /operator/push/vapid-key
 *
 * All tests go through the REAL HTTP route (with the operator route guard
 * installed) — not a handler-only call.
 */

import type {VapidPublicKeyRouteDeps} from './vapid-public-key-route.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildVapidPublicKeyRoute} from './vapid-public-key-route.js'

function makeDeps(overrides?: Partial<VapidPublicKeyRouteDeps>): VapidPublicKeyRouteDeps {
  return {
    vapidPublicKeyInfo: {
      publicKey: 'BOb1EqJOpvFSxr2XOPIr82Ktdxl6AibGOAiPmrkjbsv0mpr9In09mLbskqVAgLPIDjb0UIb7mZpU0SJKWWsVazc',
      keyVersion: '1',
    },
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    ...overrides,
  }
}

function buildAppWithGuard(deps: VapidPublicKeyRouteDeps, allow: boolean): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () =>
    allow
      ? {ok: true, githubUserId: 1001, sessionId: 'sess-1'}
      : {ok: false, response: new Response(null, {status: 404})},
  )
  buildVapidPublicKeyRoute(app, deps)
  return app
}

describe('buildVapidPublicKeyRoute', () => {
  // #given an authenticated operator session
  // #when GET /operator/push/vapid-key
  // #then returns {publicKey, keyVersion}; private key never present
  it('happy path: returns publicKey and keyVersion for an authenticated operator', async () => {
    const deps = makeDeps()
    const app = buildAppWithGuard(deps, true)

    const res = await app.request('/operator/push/vapid-key')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {publicKey: string; keyVersion: string}
    expect(body).toEqual({publicKey: deps.vapidPublicKeyInfo.publicKey, keyVersion: '1'})
    expect(JSON.stringify(body)).not.toContain('privateKey')
  })

  // #given no authenticated session (guard rejects)
  // #when GET /operator/push/vapid-key
  // #then denied with the guard's response — handler never runs
  it('error path: guard denial short-circuits before the handler', async () => {
    const deps = makeDeps()
    const app = buildAppWithGuard(deps, false)

    const res = await app.request('/operator/push/vapid-key')

    expect(res.status).toBe(404)
  })
})
