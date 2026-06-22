/**
 * Gateway HTTP ingress surface pinning test.
 *
 * The gateway has two distinct HTTP surfaces with different trust boundaries:
 *
 *   1. ANNOUNCE surface (sandbox-net reachable):
 *      - Bound to the announce HTTP port, reachable from the workspace via sandbox-net.
 *      - HMAC/replay/timestamp/schema-gated POST /v1/announce webhook.
 *      - Does NOT perform caller-directed outbound requests.
 *      - Any new route here could reopen the egress trust boundary.
 *
 *   2. OPERATOR surface (gateway-net only):
 *      - Bound to the operator bind host on gateway-net, NOT reachable from sandbox-net.
 *      - TLS terminated by infra reverse proxy at GATEWAY_OPERATOR_PUBLIC_ORIGIN.
 *      - Human-authenticated browser surface (session + allowlist + CSRF guard).
 *      - No route from this surface appears in the announce surface, and vice versa.
 *
 * This test fails if either route inventory changes, forcing a deliberate security
 * review before the change ships.
 *
 * If you are adding a new HTTP route and this test fails:
 *   1. Confirm which surface the new endpoint belongs to (announce vs operator).
 *   2. Confirm the new endpoint does NOT perform caller-directed outbound
 *      requests on behalf of the workspace (for announce surface routes).
 *   3. Update the appropriate EXPECTED_* constant below after review.
 *   4. Update deploy/README.md (Egress topology → Forward constraint) to
 *      document the new endpoint and its trust properties.
 *
 * SERVER ENTRY-POINT PIN (tamper-evident):
 *   The static source-scan test below asserts there are exactly TWO serve() calls
 *   across the entire gateway source tree — one for the announce server and one for
 *   the operator server. Adding a third server entry point fails this pin, requiring
 *   a deliberate security review.
 *
 *   We use a static source scan (readFileSync + regex) rather than routing the
 *   existing pin through createAnnounceServer with serve() stubbed, because:
 *   - The stub approach only catches routes wired through the factory chain;
 *     a second server in a different file would still be invisible.
 *   - A source scan is file-system-wide and catches any new serve() call
 *     regardless of where it lives in the package.
 *   - The scan is fast, deterministic, and requires no runtime setup.
 */

import type {Client} from 'discord.js'
import type {GitHubOAuthConfig, GitHubOAuthDeps} from '../web/auth/github.js'
import type {OperatorServerConfig, OperatorServerDeps} from '../web/server.js'
import type {AnnounceLogger} from './announce-handler.js'

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {loadAllowlistFromText} from '../web/auth/allowlist.js'
import {createInMemoryStateStore} from '../web/auth/github.js'
import {createInMemorySessionStore} from '../web/auth/session.js'
import {buildOperatorApp} from '../web/server.js'
import {buildAnnounceApp} from './server.js'

// ---------------------------------------------------------------------------
// Pinned ingress surfaces — update only after deliberate security review.
// ---------------------------------------------------------------------------

/**
 * The complete set of HTTP routes the gateway exposes over sandbox-net (announce surface).
 * Each entry is { method, path } matching Hono's app.routes shape.
 *
 * Current surface: exactly one endpoint — the HMAC/replay/timestamp/schema-gated
 * announce webhook. It posts a fixed embed to a configured Discord channel and
 * does not perform caller-directed outbound requests.
 *
 * SECURITY: No operator route may appear here. The announce surface is workspace-reachable
 * by design; adding operator routes here would collapse defense in depth to app-layer auth only.
 */
const EXPECTED_ANNOUNCE_ROUTES: readonly {method: string; path: string}[] = [{method: 'POST', path: '/v1/announce'}]

/**
 * The complete set of HTTP routes the gateway exposes over gateway-net (operator surface)
 * when GitHub OAuth is NOT configured (no deps.githubOAuth / config.githubOAuth).
 * Each entry is { method, path } matching Hono's app.routes shape.
 *
 * Current surface: exactly one endpoint — the unauthenticated health check.
 * GitHub OAuth routes (/operator/auth/github/start, /operator/auth/github/callback)
 * are registered only when both deps.githubOAuth and config.githubOAuth are provided;
 * see EXPECTED_OPERATOR_ROUTES_WITH_OAUTH below.
 *
 * SECURITY: No announce route may appear here. The operator surface is gateway-net only
 * and is not reachable from sandbox-net.
 */
const EXPECTED_OPERATOR_ROUTES: readonly {method: string; path: string}[] = [{method: 'GET', path: '/operator/health'}]

/**
 * The complete set of HTTP routes the gateway exposes over gateway-net (operator surface)
 * when GitHub OAuth IS configured (both deps.githubOAuth and config.githubOAuth provided).
 *
 * SECURITY: All three routes are public (unauthenticated pre-auth surface). No announce
 * route may appear here.
 */
const EXPECTED_OPERATOR_ROUTES_WITH_OAUTH: readonly {method: string; path: string}[] = [
  {method: 'GET', path: '/operator/health'},
  {method: 'GET', path: '/operator/auth/github/start'},
  {method: 'GET', path: '/operator/auth/github/callback'},
]

/**
 * The complete set of HTTP routes the gateway exposes over gateway-net (operator surface)
 * when the full browser guard is configured (OAuth + allowlist + csrfSecret + sessionStore).
 *
 * This is the production-ready surface: OAuth routes (public), logout (privileged, CSRF-gated),
 * CSRF token endpoint (privileged, safe GET), session info endpoint (privileged, safe GET),
 * and the authenticated SSE run-stream endpoint (privileged, safe GET).
 *
 * SECURITY: All privileged routes are wrapped by the browser guard (session + allowlist +
 * origin + Fetch Metadata). Adding a route here requires a deliberate security review.
 */
const EXPECTED_OPERATOR_ROUTES_WITH_BROWSER_GUARD: readonly {method: string; path: string}[] = [
  {method: 'GET', path: '/operator/health'},
  {method: 'GET', path: '/operator/auth/github/start'},
  {method: 'GET', path: '/operator/auth/github/callback'},
  {method: 'POST', path: '/operator/auth/logout'},
  {method: 'GET', path: '/operator/session/csrf'},
  {method: 'GET', path: '/operator/session'},
  {method: 'GET', path: '/operator/runs/:runId/stream'},
  {method: 'GET', path: '/operator/repos'},
  {method: 'POST', path: '/operator/runs'},
  {method: 'POST', path: '/operator/runs/:runId/approvals/:requestId/decision'},
  {method: 'GET', path: '/operator/runs/:runId/approvals'},
]

// ---------------------------------------------------------------------------
// Minimal stubs — we only need to build the apps, not run requests.
// ---------------------------------------------------------------------------

function makeAnnounceStubDeps(): Parameters<typeof buildAnnounceApp>[0] {
  const logger: AnnounceLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  // Structural stub — only the shape matters; no real Discord calls are made.
  const client = {channels: {fetch: vi.fn()}} as unknown as Client
  return {client, logger}
}

function makeAnnounceStubConfig(): Parameters<typeof buildAnnounceApp>[1] {
  return {
    webhookSecret: 'stub-secret',
    presenceChannelId: 'stub-channel',
    httpPort: 0, // not used — we never call serve()
  }
}

function makeOperatorStubDeps(): OperatorServerDeps {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    isShuttingDown: () => false,
  }
}

function makeOperatorStubConfig(): OperatorServerConfig {
  return {
    bindHost: '10.0.0.1',
    bindPort: 0, // not used — we never call serve()
    publicOrigin: 'https://operator.example.com',
  }
}

function makeOAuthStubDeps(): GitHubOAuthDeps {
  return {
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    fetch: vi.fn(async () => new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})),
    clock: () => 0,
    generateVerifier: () => 'stub-verifier-32-bytes-long-enough-for-pkce',
    generateState: () => 'stub-state-value-32-bytes-long-ok',
    stateStore: createInMemoryStateStore(),
    getSourceKey: () => 'stub-source-key',
    // rateLimiter is overwritten by buildOperatorApp with the shared instance;
    // provide a pass-through stub so the type is satisfied.
    rateLimiter: {allow: () => true},
  }
}

function makeOAuthStubConfig(): GitHubOAuthConfig {
  return {
    clientId: 'stub-client-id',
    clientSecret: 'stub-client-secret',
    publicOrigin: 'https://operator.example.com',
    callbackPath: '/operator/auth/github/callback',
    allowedReturnPaths: ['/operator/dashboard'],
    maxOutstandingAttemptsPerKey: 5,
    stateTtlMs: 10 * 60 * 1000,
  }
}

function makeBrowserGuardStubDeps(): OperatorServerDeps {
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  return {
    ...makeOperatorStubDeps(),
    githubOAuth: makeOAuthStubDeps(),
    sessionStore: createInMemorySessionStore(),
    sessionDeps: {
      logger,
      auditLogger: {info: vi.fn(), warn: vi.fn()},
      clock: () => 0,
    },
    allowlist: loadAllowlistFromText('12345', logger),
    csrfSecret: 'stub-csrf-secret-base64url-32bytes-ok',
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    // Provide the run-stream route deps so the route is registered in the pinned inventory.
    denylistCache: {
      getDenylistState: vi.fn(async () => undefined),
      isRepoDenied: vi.fn(() => false),
    },
    bindingsLookup: {
      getBindingByRepo: vi.fn(async () => ({success: true as const, data: null})),
    },
    runObservationManager: {
      observe: vi.fn(async () => undefined),
      observeOutput: vi.fn(),
      observeApproval: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      abortSubscription: vi.fn(),
      shutdown: vi.fn(),
    },
    runIndex: {
      lookup: vi.fn(async () => undefined),
      register: vi.fn(),
    },
    // Provide listBindings so the repos route is registered in the pinned inventory.
    listBindings: vi.fn(async () => ({success: true as const, data: []})),
    // Provide approvalRegistry so the decision and pending-approvals routes are registered.
    approvalRegistry: {
      handleDecision: vi.fn(async () => 'ok' as const),
      describePendingForScope: vi.fn(() => []),
    },
    // Provide getBindingByRepo and launchWorkDeps so the launch route is registered.
    getBindingByRepo: vi.fn(async () => ({success: true as const, data: null})),
    launchWorkDeps: {
      coordinationConfig: {} as import('../execute/run.js').RunMentionDeps['coordinationConfig'],
      identity: 'stub-identity',
      concurrency: {tryAcquire: vi.fn(() => 'ok' as const), release: vi.fn(), activeCount: vi.fn(() => 0), max: 3},
      queue: {
        enqueue: vi.fn(() => 'queued' as const),
        takeNext: vi.fn(() => undefined),
        pendingCount: vi.fn(() => 0),
        clear: vi.fn(() => 0),
      },
      attachUrl: 'http://localhost:3000',
      attachToken: 'stub-token',
      runTimeoutMs: 600_000,
      botUserId: 'bot-123',
      persona: null,
      logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
      approvalRegistry: {
        register: vi.fn(),
        attachMessage: vi.fn(),
        markMessagePostFailed: vi.fn(),
        has: vi.fn(() => false),
        pending: vi.fn(() => []),
        hasPendingForScope: vi.fn(() => false),
        describePendingForScope: vi.fn(() => []),
        handleDecision: vi.fn(async () => 'ok' as const),
        confirmReply: vi.fn(),
        applySettlement: vi.fn(async () => undefined),
        disposeRun: vi.fn(async () => undefined),
        disposeAll: vi.fn(async () => undefined),
      },
      approvalMode: 'approval-required' as const,
      statusMode: 'live-status' as const,
      ensureClone: vi.fn(async () => ({success: true as const, data: '/workspace'})),
      readyz: vi.fn(async () => ({success: true as const, data: {ready: true as const, opencode: 'ready' as const}})),
    },
  }
}

// ---------------------------------------------------------------------------
// Helper: extract unique logical routes from a Hono app, excluding middleware.
// ---------------------------------------------------------------------------

function extractRoutes(app: {routes: readonly {method: string; path: string}[]}): {method: string; path: string}[] {
  const seen = new Set<string>()
  return app.routes
    .map(r => ({method: r.method, path: r.path}))
    .filter(r => {
      // Exclude global middleware catch-alls (app.use('*', ...) registers as ALL /*)
      if (r.method === 'ALL' && r.path === '/*') return false
      const key = `${r.method}:${r.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// ---------------------------------------------------------------------------
// Announce surface pin test
// ---------------------------------------------------------------------------

describe('gateway announce ingress surface (sandbox-net)', () => {
  it('is exactly {POST /v1/announce} — no undeclared routes', () => {
    // #given — build the Hono app without starting a server
    const app = buildAnnounceApp(makeAnnounceStubDeps(), makeAnnounceStubConfig())

    // #when — extract the registered user-defined routes as unique (method, path) pairs.
    const actualRoutes = extractRoutes(app)

    // #then — the inventory must match the pinned set exactly.
    // Adding a route without updating this pin fails the test, requiring a
    // security review of the new workspace-reachable endpoint.
    expect(actualRoutes).toEqual(EXPECTED_ANNOUNCE_ROUTES)
  })

  it('contains no operator routes — announce and operator surfaces are disjoint', () => {
    // #given
    const announceApp = buildAnnounceApp(makeAnnounceStubDeps(), makeAnnounceStubConfig())
    const announceRoutes = extractRoutes(announceApp)
    const operatorPaths = new Set(EXPECTED_OPERATOR_ROUTES.map(r => r.path))

    // #when — check for overlap
    const overlap = announceRoutes.filter(r => operatorPaths.has(r.path))

    // #then — no operator route appears in the announce surface
    expect(overlap).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Operator surface pin test
// ---------------------------------------------------------------------------

describe('gateway operator ingress surface (gateway-net)', () => {
  it('is exactly {GET /operator/health} — no undeclared privileged routes', () => {
    // #given — build the Hono app without starting a server
    const app = buildOperatorApp(makeOperatorStubDeps(), makeOperatorStubConfig())

    // #when — extract the registered user-defined routes as unique (method, path) pairs.
    const actualRoutes = extractRoutes(app)

    // #then — the inventory must match the pinned set exactly.
    // Adding a privileged route without updating this pin fails the test, requiring
    // a security review of the new operator endpoint.
    expect(actualRoutes).toEqual(EXPECTED_OPERATOR_ROUTES)
  })

  it('contains no announce routes — operator and announce surfaces are disjoint', () => {
    // #given
    const operatorApp = buildOperatorApp(makeOperatorStubDeps(), makeOperatorStubConfig())
    const operatorRoutes = extractRoutes(operatorApp)
    const announcePaths = new Set(EXPECTED_ANNOUNCE_ROUTES.map(r => r.path))

    // #when — check for overlap
    const overlap = operatorRoutes.filter(r => announcePaths.has(r.path))

    // #then — no announce route appears in the operator surface
    expect(overlap).toEqual([])
  })

  it('every operator route has a path prefix of /operator/ — no route appears in both inventories', () => {
    // #given
    const operatorApp = buildOperatorApp(makeOperatorStubDeps(), makeOperatorStubConfig())
    const operatorRoutes = extractRoutes(operatorApp)

    // #when — check that all operator routes are namespaced
    const nonOperatorPrefixed = operatorRoutes.filter(r => !r.path.startsWith('/operator/'))

    // #then — all operator routes must be under /operator/
    expect(nonOperatorPrefixed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Operator surface pin test — OAuth-enabled
// ---------------------------------------------------------------------------

describe('gateway operator ingress surface (gateway-net) — OAuth-enabled', () => {
  it('is exactly {GET /operator/health, GET /operator/auth/github/start, GET /operator/auth/github/callback} when OAuth deps and config are provided', () => {
    // #given — build the Hono app with OAuth deps and config
    const app = buildOperatorApp(
      {...makeOperatorStubDeps(), githubOAuth: makeOAuthStubDeps()},
      {...makeOperatorStubConfig(), githubOAuth: makeOAuthStubConfig()},
    )

    // #when — extract the registered user-defined routes as unique (method, path) pairs.
    const actualRoutes = extractRoutes(app)

    // #then — the inventory must match the pinned OAuth-enabled set exactly.
    // Adding a route without updating this pin fails the test, requiring a
    // security review of the new operator endpoint.
    expect(actualRoutes).toEqual(EXPECTED_OPERATOR_ROUTES_WITH_OAUTH)
  })

  it('contains no announce routes when OAuth is enabled — surfaces remain disjoint', () => {
    // #given
    const operatorApp = buildOperatorApp(
      {...makeOperatorStubDeps(), githubOAuth: makeOAuthStubDeps()},
      {...makeOperatorStubConfig(), githubOAuth: makeOAuthStubConfig()},
    )
    const operatorRoutes = extractRoutes(operatorApp)
    const announcePaths = new Set(EXPECTED_ANNOUNCE_ROUTES.map(r => r.path))

    // #when — check for overlap
    const overlap = operatorRoutes.filter(r => announcePaths.has(r.path))

    // #then — no announce route appears in the operator surface
    expect(overlap).toEqual([])
  })

  it('every OAuth-enabled operator route has a path prefix of /operator/', () => {
    // #given
    const operatorApp = buildOperatorApp(
      {...makeOperatorStubDeps(), githubOAuth: makeOAuthStubDeps()},
      {...makeOperatorStubConfig(), githubOAuth: makeOAuthStubConfig()},
    )
    const operatorRoutes = extractRoutes(operatorApp)

    // #when — check that all operator routes are namespaced
    const nonOperatorPrefixed = operatorRoutes.filter(r => !r.path.startsWith('/operator/'))

    // #then — all operator routes must be under /operator/
    expect(nonOperatorPrefixed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Operator surface pin test — full browser guard (OAuth + allowlist + session)
// ---------------------------------------------------------------------------

describe('gateway operator ingress surface (gateway-net) — full browser guard', () => {
  it('is exactly the expected set when OAuth, allowlist, csrfSecret, and sessionStore are all provided', () => {
    // #given — build the Hono app with full browser guard deps
    const app = buildOperatorApp(makeBrowserGuardStubDeps(), {
      ...makeOperatorStubConfig(),
      githubOAuth: makeOAuthStubConfig(),
    })

    // #when — extract the registered user-defined routes as unique (method, path) pairs.
    const actualRoutes = extractRoutes(app)

    // #then — the inventory must match the pinned full-browser-guard set exactly.
    // Adding a privileged route without updating this pin fails the test, requiring
    // a security review of the new operator endpoint.
    expect(actualRoutes).toEqual(EXPECTED_OPERATOR_ROUTES_WITH_BROWSER_GUARD)
  })

  it('contains no announce routes when full browser guard is enabled — surfaces remain disjoint', () => {
    // #given
    const operatorApp = buildOperatorApp(makeBrowserGuardStubDeps(), {
      ...makeOperatorStubConfig(),
      githubOAuth: makeOAuthStubConfig(),
    })
    const operatorRoutes = extractRoutes(operatorApp)
    const announcePaths = new Set(EXPECTED_ANNOUNCE_ROUTES.map(r => r.path))

    // #when — check for overlap
    const overlap = operatorRoutes.filter(r => announcePaths.has(r.path))

    // #then — no announce route appears in the operator surface
    expect(overlap).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Server entry-point pin — tamper-evident two-server assertion.
//
// The route-inventory tests above only inspect routes registered through
// buildAnnounceApp() and buildOperatorApp(). A third HTTP server (serve() /
// http.createServer()) added ELSEWHERE in the gateway package would be
// completely invisible to them.
//
// This test statically scans every .ts source file under packages/gateway/src/
// and asserts there are exactly TWO serve( calls:
//   1. createAnnounceServer in http/server.ts
//   2. createOperatorServer in web/server.ts
//
// Adding a third server entry point fails this pin, requiring a deliberate
// security review before the change ships.
//
// We use a static source scan rather than a runtime stub approach because:
//   - Stubs only catch routes wired through the factory chain; a third server
//     in a different file would still be invisible.
//   - A source scan is file-system-wide and catches any new serve() call
//     regardless of where it lives in the package.
//   - The scan is fast, deterministic, and requires no runtime setup.
// ---------------------------------------------------------------------------

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full))
    } else if (entry.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('gateway server entry-point pin', () => {
  it('has exactly two serve() calls across packages/gateway/src/ — announce + operator servers', () => {
    // #given — locate the gateway src directory relative to this test file.
    // __dirname is packages/gateway/src/http; go up one level to src/.
    const gatewaySrcDir = join(__dirname, '..')

    // #when — scan all .ts source files (excluding test files) for serve( calls.
    const tsFiles = collectTsFiles(gatewaySrcDir).filter(f => !f.endsWith('.test.ts'))
    const serveCallPattern = /\bserve\s*\(/g

    const serveCallSites: {file: string; line: number}[] = []
    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        // Strip single-line comments (//) and JSDoc/block-comment lines (lines
        // whose non-whitespace content starts with * or /*) before matching.
        // This avoids false positives from doc-comment references like "serve()/handle".
        const stripped = line.replace(/\/\/.*$/, '').trim()
        const isCommentLine = stripped.startsWith('*') || stripped.startsWith('/*')
        const codePart = isCommentLine ? '' : stripped
        if (serveCallPattern.test(codePart)) {
          serveCallSites.push({file, line: idx + 1})
        }
        serveCallPattern.lastIndex = 0 // reset stateful regex after each line
      })
    }

    // #then — exactly two serve() calls must exist:
    //   1. createAnnounceServer in http/server.ts
    //   2. createOperatorServer in web/server.ts
    // If this assertion fails, a new HTTP server entry point was added to the gateway.
    // Before updating this count, perform a deliberate security review:
    //   1. Confirm the new server does NOT expose workspace-reachable endpoints that
    //      perform caller-directed outbound requests (egress trust boundary).
    //   2. Update deploy/README.md (Egress topology → Forward constraint).
    expect(serveCallSites).toHaveLength(2)

    const files = serveCallSites.map(s => s.file)
    expect(files.some(f => f.match(/http\/server\.ts$/))).toBe(true)
    expect(files.some(f => f.match(/web\/server\.ts$/))).toBe(true)
  })
})
