/**
 * Offline operator-route registration diagnostic.
 *
 * Builds the operator Hono app via buildOperatorApp(deps, config) using the
 * same deps-construction path as production (buildOperatorServerInputs), then
 * asserts the expected route inventory is present in app.routes.
 *
 * This diagnostic catches the class of bug where a route is silently unmounted
 * because a required dep was not wired: a missing dep causes the route to be
 * absent from app.routes, which fails the assertion and returns a non-zero exit
 * code naming the absent route.
 *
 * No port is bound, no network is required, no real S3/Discord/GitHub credentials
 * are needed. The route mount gates only check dep presence/shape, not liveness.
 *
 * SECURITY: This module must NEVER be imported from any request handler, Discord
 * command, or HTTP route. It is an offline diagnostic only. Importing it from a
 * request path would violate the offline-only contract (it constructs stubs that
 * are not safe for production use).
 *
 * Exit codes:
 *   0 — all expected operator routes are registered
 *   1 — one or more expected routes are absent (names the missing routes)
 */

import {Buffer} from 'node:buffer'

import {buildOperatorServerInputs} from '../program.js'
import {loadAllowlistFromText} from './auth/allowlist.js'
import {buildOperatorApp} from './server.js'

// ---------------------------------------------------------------------------
// Expected route inventory
//
// These are the exact method+path strings Hono records for the full operator
// route set when all deps are present. Verified against server.ts route
// registrations and the v1.4.0 drift-guard test in server.test.ts.
// ---------------------------------------------------------------------------

const EXPECTED_OPERATOR_ROUTES: readonly {readonly method: string; readonly path: string}[] = [
  {method: 'GET', path: '/operator/health'},
  {method: 'GET', path: '/operator/auth/github/start'},
  {method: 'GET', path: '/operator/auth/github/callback'},
  {method: 'POST', path: '/operator/auth/logout'},
  {method: 'GET', path: '/operator/session/csrf'},
  {method: 'GET', path: '/operator/session'},
  {method: 'GET', path: '/operator/repos'},
  {method: 'POST', path: '/operator/runs'},
  {method: 'GET', path: '/operator/runs/:runId/stream'},
  {method: 'POST', path: '/operator/runs/:runId/approvals/:requestId/decision'},
  {method: 'GET', path: '/operator/runs/:runId/approvals'},
]

// ---------------------------------------------------------------------------
// Stub factories — realistic-but-offline instances for the diagnostic
// ---------------------------------------------------------------------------

function makeNoopLogger() {
  return {
    debug: (_ctx: Record<string, unknown>, _msg: string) => undefined,
    info: (_ctx: Record<string, unknown>, _msg: string) => undefined,
    warn: (_ctx: Record<string, unknown>, _msg: string) => undefined,
    error: (_ctx: Record<string, unknown>, _msg: string) => undefined,
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

// ---------------------------------------------------------------------------
// Options — allow test overrides for regression-guard tests
// ---------------------------------------------------------------------------

export interface OperatorRouteSmokeOptions {
  /**
   * Override the bindingsStore passed to buildOperatorServerInputs.
   * Used in regression-guard tests to simulate a store without listBindings.
   */
  readonly bindingsStoreOverride?: Parameters<typeof buildOperatorServerInputs>[0]['bindingsStore']
  /**
   * Override the runObservationManager passed to buildOperatorServerInputs.
   * Pass undefined to simulate a missing run-observation manager (run-stream absent).
   */
  readonly runObservationManagerOverride?:
    | Parameters<typeof buildOperatorServerInputs>[0]['runObservationManager']
    | undefined
  /**
   * Whether to suppress log output. Defaults to false (logs to stdout).
   */
  readonly silent?: boolean
}

// ---------------------------------------------------------------------------
// Diagnostic runner
// ---------------------------------------------------------------------------

/**
 * Run the operator-route registration diagnostic.
 *
 * Builds the operator Hono app via the production deps-construction path
 * (buildOperatorServerInputs → buildOperatorApp), reads app.routes, and
 * asserts the expected operator route set is present.
 *
 * Returns an exit code:
 *   0 — all expected routes registered
 *   1 — one or more routes absent (logs which ones)
 *
 * Never calls process.exit — the caller decides.
 */
export async function runOperatorRouteSmoke(options?: OperatorRouteSmokeOptions): Promise<number> {
  const silent = options?.silent === true
  const log = (msg: string) => {
    if (silent === false) {
      // eslint-disable-next-line no-console
      console.log(msg)
    }
  }

  // Build a stub allowlist that authorizes a single numeric user ID.
  // The allowlist is required for the browser guard (and thus all privileged routes).
  const noopLogger = makeNoopLogger()
  const allowlist = loadAllowlistFromText('42\n', noopLogger)

  // Build a stub operator web config — values only need to pass the URL/host
  // validation in buildOperatorApp (publicOrigin must be https://).
  const operatorWebConfig = {
    bindHost: '127.0.0.1',
    bindPort: 18080,
    publicOrigin: 'https://operator.smoke.test',
    oauthClientId: 'stub-client-id',
    oauthClientSecret: 'stub-client-secret',
    oauthAllowedReturnPaths: ['/operator'] as readonly string[],
    oauthStateTtlMs: 10 * 60 * 1000,
    oauthMaxOutstandingAttemptsPerKey: 5,
    csrfSecret: Buffer.from('operator-smoke-csrf-secret-32b!!', 'utf8').toString('base64url'),
    allowlist,
  }

  // Resolve the bindingsStore — use the override if provided, else the default stub.
  const bindingsStore = options?.bindingsStoreOverride ?? makeStubBindingsStore()

  // Resolve the runObservationManager — use the override if provided.
  // When the override is explicitly undefined, the run-stream route will not register.
  const hasRunObservationManagerOverride = options !== undefined && 'runObservationManagerOverride' in options
  const runObservationManager = hasRunObservationManagerOverride
    ? options.runObservationManagerOverride
    : makeStubRunObservationManager()

  // Build the operator server inputs via the shared production helper.
  // This is the seam that makes the diagnostic catch wiring gaps: if a dep is
  // dropped from buildOperatorServerInputs, both production and this diagnostic
  // lose it, so the route assertion below fails.
  const {deps: baseDeps, config} = buildOperatorServerInputs({
    logger: noopLogger,
    isShuttingDown: () => false,
    denylistCache: makeStubDenylistCache(),
    bindingsStore,
    runObservationManager: runObservationManager ?? makeStubRunObservationManager(),
    runIndex: makeStubRunIndex(),
    approvalRegistry: makeStubApprovalRegistry(),
    operatorWebConfig,
  })

  // Augment deps with the launch route deps (getBindingByRepo + launchWorkDeps)
  // so POST /operator/runs is also registered. These are not part of
  // buildOperatorServerInputs because they are not program-scoped instances
  // in the same way — they are derived from the bindings store.
  const deps = {
    ...baseDeps,
    getBindingByRepo: bindingsStore.getBindingByRepo,
    launchWorkDeps: makeStubLaunchWorkDeps(),
    // When runObservationManager is explicitly overridden to undefined, remove it
    // from deps so the run-stream route gate fails (simulating a missing dep).
    ...(hasRunObservationManagerOverride && runObservationManager === undefined
      ? {runObservationManager: undefined}
      : {}),
  }

  // Build the app without binding a port.
  const app = buildOperatorApp(deps, config)

  // Extract unique logical routes (exclude global middleware ALL /* entries).
  const seen = new Set<string>()
  const registeredRoutes = app.routes
    .map((r: {method: string; path: string}) => ({method: r.method, path: r.path}))
    .filter((r: {method: string; path: string}) => {
      if (r.method === 'ALL' && r.path === '/*') return false
      const key = `${r.method}:${r.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  const registeredSet = new Set(registeredRoutes.map((r: {method: string; path: string}) => `${r.method}:${r.path}`))

  // Assert the expected route inventory.
  const missingRoutes = EXPECTED_OPERATOR_ROUTES.filter(r => registeredSet.has(`${r.method}:${r.path}`) === false)

  if (missingRoutes.length > 0) {
    for (const r of missingRoutes) {
      log(`operator-route-smoke: MISSING route ${r.method} ${r.path}`)
    }
    log(`operator-route-smoke: FAIL — ${missingRoutes.length} route(s) absent from app.routes`)
    return 1
  }

  log(`operator-route-smoke: all ${EXPECTED_OPERATOR_ROUTES.length} operator routes registered`)
  return 0
}
