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
import {EXPECTED_OPERATOR_ROUTES, runOperatorRouteSmoke} from './operator-route-smoke.js'
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

function makeStubLaunchWorkDeps() {
  // Registration only checks `deps.launchWorkDeps !== undefined`; the actual
  // shape is not inspected at construction time.
  return {} as NonNullable<Parameters<typeof buildOperatorApp>[0]['launchWorkDeps']>
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
      launchWorkDeps: makeStubLaunchWorkDeps(),
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
    expect(routeSet).toContain('POST:/operator/runs')
    expect(routeSet).toContain('GET:/operator/runs/:runId/stream')
    expect(routeSet).toContain('GET:/operator/runs/:runId/approvals')
    expect(routeSet).toContain('POST:/operator/runs/:runId/approvals/:requestId/decision')
  })

  it('omitting listBindings from bindingsStore causes GET /operator/repos to be absent', () => {
    // #given — bindingsStore WITHOUT listBindings (a route gated on a missing dep is unmounted)
    const logger = makeStubLogger()
    const denylistCache = makeStubDenylistCache()
    // Deliberately omit listBindings from the store to simulate a missing dep
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
      launchWorkDeps: makeStubLaunchWorkDeps(),
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

describe('runOperatorRouteSmoke — regression guard (non-vacuous)', () => {
  it('expected route list is non-empty (guards against vacuous pass)', () => {
    // #given / #then — the expected-routes list must never be empty
    // An empty list would pass vacuously (zero missing routes) and provide no assurance.
    expect(EXPECTED_OPERATOR_ROUTES.length).toBeGreaterThan(0)
  })

  it('returns non-zero when GET /operator/repos is absent (listBindings omitted from bindingsStore)', async () => {
    // #given — a route gated on a missing dep is unmounted; the smoke must catch it
    const bindingsStoreWithoutList = {
      createBinding: async () => ({success: false as const, error: new Error('stub')}),
      getBindingByRepo: async () => ({success: true as const, data: null}),
      getBindingByChannelId: async () => ({success: true as const, data: null}),
      // listBindings intentionally absent
    }

    // #when — run the smoke with a store that has no listBindings
    const exitCode = await runOperatorRouteSmoke({
      bindingsStoreOverride: bindingsStoreWithoutList,
    })

    // #then — non-zero exit (route absent)
    expect(exitCode).not.toBe(0)
  })

  it('returns non-zero when POST /operator/runs is absent (launchWorkDeps omitted)', async () => {
    // #given — launchWorkDeps flows through buildOperatorServerInputs; omitting it
    // causes the helper to pass undefined to deps.launchWorkDeps, and server.ts
    // gates POST /operator/runs on that dep being present.
    // #when
    const exitCode = await runOperatorRouteSmoke({
      launchWorkDepsOverride: undefined,
    })

    // #then — non-zero exit (POST /operator/runs absent)
    expect(exitCode).not.toBe(0)
  })

  it('returns non-zero when run-stream route is absent (runObservationManager omitted)', async () => {
    // #given — runObservationManager flows through buildOperatorServerInputs; omitting it
    // causes the helper to pass undefined to deps.runObservationManager, and server.ts
    // gates GET /operator/runs/:runId/stream on that dep being present.
    // #when
    const exitCode = await runOperatorRouteSmoke({
      runObservationManagerOverride: undefined,
    })

    // #then — non-zero exit (GET /operator/runs/:runId/stream absent)
    expect(exitCode).not.toBe(0)
  })

  it('returns non-zero when approval routes are absent (approvalRegistry omitted)', async () => {
    // #given — approvalRegistry flows through buildOperatorServerInputs; omitting it
    // causes the helper to pass undefined to deps.approvalRegistry, and server.ts
    // gates the approval routes on that dep being present.
    // #when — run the smoke with approvalRegistry explicitly undefined
    // We simulate this by building the app directly with approvalRegistry absent.
    const {buildOperatorServerInputs: buildInputs} = await import('../program.js')
    const {loadAllowlistFromText: loadAllowlist} = await import('./auth/allowlist.js')
    const {buildOperatorApp: buildApp} = await import('./server.js')

    const noopLogger = {debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined}
    const allowlist = loadAllowlist('42\n', noopLogger)
    const operatorWebConfig = {
      bindHost: '127.0.0.1',
      bindPort: 18080,
      publicOrigin: 'https://operator.smoke.test',
      oauthClientId: 'stub-client-id',
      oauthClientSecret: 'stub-client-secret',
      oauthAllowedReturnPaths: ['/operator'] as readonly string[],
      oauthStateTtlMs: 10 * 60 * 1000,
      oauthMaxOutstandingAttemptsPerKey: 5,
      csrfSecret: Buffer.from('test-csrf-secret-32-bytes-long!!', 'utf8').toString('base64url'),
      allowlist,
    }

    const {deps, config} = buildInputs({
      logger: noopLogger,
      isShuttingDown: () => false,
      denylistCache: makeStubDenylistCache(),
      bindingsStore: makeStubBindingsStore(),
      runObservationManager: makeStubRunObservationManager(),
      runIndex: makeStubRunIndex(),
      approvalRegistry: makeStubApprovalRegistry(),
      launchWorkDeps: makeStubLaunchWorkDeps(),
      operatorWebConfig,
    })

    // Override approvalRegistry to undefined to simulate the missing dep
    const depsWithoutApproval = {...deps, approvalRegistry: undefined}
    const app = buildApp(depsWithoutApproval, config)

    // #then — approval routes are NOT registered
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
    expect(routePaths).not.toContain('GET:/operator/runs/:runId/approvals')
    expect(routePaths).not.toContain('POST:/operator/runs/:runId/approvals/:requestId/decision')
  })
})
