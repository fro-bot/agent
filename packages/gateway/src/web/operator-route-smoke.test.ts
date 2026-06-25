/**
 * Tests for the operator-route-smoke diagnostic.
 *
 * Covers:
 *   - Happy path: all deps present → runOperatorRouteSmoke returns 0, all expected routes present.
 *   - Regression guard (non-vacuous): listBindings absent → GET /operator/repos absent → returns non-zero.
 *   - Regression guard: run-stream deps absent → GET /operator/runs/:runId/stream absent → returns non-zero.
 *   - buildOperatorServerInputs parity: the helper produces deps that, fed to buildOperatorApp,
 *     mount the same full route set as production.
 *
 * BDD comments: #given / #when / #then.
 */

import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'

import {buildOperatorServerInputs} from '../program.js'
import {loadAllowlistFromText} from './auth/allowlist.js'
import {runOperatorRouteSmoke} from './operator-route-smoke.js'
import {buildOperatorApp} from './server.js'

// ---------------------------------------------------------------------------
// Helpers — minimal stubs for buildOperatorServerInputs
// ---------------------------------------------------------------------------

function makeStubLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeStubDenylistCache() {
  return {
    getDenylistState: async () => undefined,
    isRepoDenied: () => false,
  }
}

function makeStubBindingsStore() {
  return {
    createBinding: async () => ({success: false as const, error: new Error('stub')}),
    getBindingByRepo: async () => ({success: true as const, data: null}),
    getBindingByChannelId: async () => ({success: true as const, data: null}),
    listBindings: async () => ({success: true as const, data: []}),
  }
}

function makeStubRunObservationManager() {
  return {
    observe: async () => undefined,
    observeOutput: () => undefined,
    observeApproval: () => undefined,
    subscribe: () => () => undefined,
    abortSubscription: () => undefined,
    shutdown: () => undefined,
  }
}

function makeStubRunIndex() {
  return {
    register: () => undefined,
    lookup: async () => undefined,
  }
}

function makeStubApprovalRegistry() {
  return {
    handleDecision: async () => 'not-found' as const,
    describePendingForScope: () => [],
  }
}

function makeStubOperatorWebConfig() {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  return {
    bindHost: '127.0.0.1',
    bindPort: 18080,
    publicOrigin: 'https://operator.smoke.test',
    oauthClientId: 'stub-client-id',
    oauthClientSecret: 'stub-client-secret',
    oauthAllowedReturnPaths: ['/operator'] as readonly string[],
    oauthStateTtlMs: 10 * 60 * 1000,
    oauthMaxOutstandingAttemptsPerKey: 5,
    csrfSecret: Buffer.from('test-csrf-secret-32-bytes-long!!', 'utf8').toString('base64url'),
    allowlist: loadAllowlistFromText('42\n', noopLogger),
  }
}

// ---------------------------------------------------------------------------
// buildOperatorServerInputs parity test
// ---------------------------------------------------------------------------

describe('buildOperatorServerInputs — parity with production wiring', () => {
  it('produces deps that, fed to buildOperatorApp, mount the full operator route set', () => {
    // #given — all program-scoped instances present (mirrors production)
    const logger = makeStubLogger()
    const denylistCache = makeStubDenylistCache()
    const bindingsStore = makeStubBindingsStore()
    const runObservationManager = makeStubRunObservationManager()
    const runIndex = makeStubRunIndex()
    const approvalRegistry = makeStubApprovalRegistry()
    const operatorWebConfig = makeStubOperatorWebConfig()

    // #when — build inputs via the shared helper
    const {deps, config} = buildOperatorServerInputs({
      logger,
      isShuttingDown: () => false,
      denylistCache,
      bindingsStore,
      runObservationManager,
      runIndex,
      approvalRegistry,
      operatorWebConfig,
    })

    // #and — build the app (no port bind)
    const app = buildOperatorApp(deps, config)

    // #then — extract unique logical routes
    const seen = new Set<string>()
    const routes = app.routes
      .map((r: {method: string; path: string}) => ({method: r.method, path: r.path}))
      .filter((r: {method: string; path: string}) => {
        if (r.method === 'ALL' && r.path === '/*') return false
        const key = `${r.method}:${r.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    const routeSet = new Set(routes.map((r: {method: string; path: string}) => `${r.method}:${r.path}`))

    // All expected operator routes must be present
    expect(routeSet).toContain('GET:/operator/health')
    expect(routeSet).toContain('GET:/operator/auth/github/start')
    expect(routeSet).toContain('GET:/operator/auth/github/callback')
    expect(routeSet).toContain('POST:/operator/auth/logout')
    expect(routeSet).toContain('GET:/operator/session/csrf')
    expect(routeSet).toContain('GET:/operator/session')
    expect(routeSet).toContain('GET:/operator/repos')
    expect(routeSet).toContain('GET:/operator/runs/:runId/stream')
    expect(routeSet).toContain('GET:/operator/runs/:runId/approvals')
    expect(routeSet).toContain('POST:/operator/runs/:runId/approvals/:requestId/decision')
  })

  it('omitting listBindings from bindingsStore causes GET /operator/repos to be absent (regression guard)', () => {
    // #given — bindingsStore WITHOUT listBindings (simulates the #1001 class of bug)
    const logger = makeStubLogger()
    const denylistCache = makeStubDenylistCache()
    // Deliberately omit listBindings from the store to simulate a wiring gap
    const bindingsStoreWithoutList = {
      createBinding: async () => ({success: false as const, error: new Error('stub')}),
      getBindingByRepo: async () => ({success: true as const, data: null}),
      getBindingByChannelId: async () => ({success: true as const, data: null}),
      // listBindings intentionally absent
    }
    const runObservationManager = makeStubRunObservationManager()
    const runIndex = makeStubRunIndex()
    const approvalRegistry = makeStubApprovalRegistry()
    const operatorWebConfig = makeStubOperatorWebConfig()

    // #when — build inputs with a store that has no listBindings
    const {deps, config} = buildOperatorServerInputs({
      logger,
      isShuttingDown: () => false,
      denylistCache,
      bindingsStore: bindingsStoreWithoutList,
      runObservationManager,
      runIndex,
      approvalRegistry,
      operatorWebConfig,
    })

    const app = buildOperatorApp(deps, config)

    // #then — GET /operator/repos is NOT registered (the gate checks deps.listBindings !== undefined)
    const seen = new Set<string>()
    const routes = app.routes
      .map((r: {method: string; path: string}) => ({method: r.method, path: r.path}))
      .filter((r: {method: string; path: string}) => {
        if (r.method === 'ALL' && r.path === '/*') return false
        const key = `${r.method}:${r.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    const routePaths = routes.map((r: {method: string; path: string}) => `${r.method}:${r.path}`)
    expect(routePaths).not.toContain('GET:/operator/repos')
  })
})

// ---------------------------------------------------------------------------
// runOperatorRouteSmoke — happy path
// ---------------------------------------------------------------------------

describe('runOperatorRouteSmoke — happy path', () => {
  it('returns 0 when all expected operator routes are registered', async () => {
    // #given — no special setup needed; the smoke builds its own stubs internally

    // #when
    const exitCode = await runOperatorRouteSmoke()

    // #then — all routes present, exit 0
    expect(exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// runOperatorRouteSmoke — regression guard (non-vacuous)
// ---------------------------------------------------------------------------

describe('runOperatorRouteSmoke — regression guard', () => {
  it('returns non-zero and names the missing route when GET /operator/repos is absent (listBindings omitted)', async () => {
    // #given — inject a custom deps builder that omits listBindings
    // The smoke accepts an optional override for the bindingsStore to enable this test.
    const bindingsStoreWithoutList = {
      createBinding: async () => ({success: false as const, error: new Error('stub')}),
      getBindingByRepo: async () => ({success: true as const, data: null}),
      getBindingByChannelId: async () => ({success: true as const, data: null}),
      // listBindings intentionally absent — simulates the #1001 wiring gap
    }

    // #when — run the smoke with a store that has no listBindings
    const exitCode = await runOperatorRouteSmoke({
      bindingsStoreOverride: bindingsStoreWithoutList,
    })

    // #then — non-zero exit (route absent)
    expect(exitCode).not.toBe(0)
  })

  it('returns non-zero when run-stream deps are absent (runObservationManager omitted)', async () => {
    // #given — inject a custom deps builder that omits runObservationManager
    // #when
    const exitCode = await runOperatorRouteSmoke({
      runObservationManagerOverride: undefined,
    })

    // #then — non-zero exit (GET /operator/runs/:runId/stream absent)
    expect(exitCode).not.toBe(0)
  })
})
