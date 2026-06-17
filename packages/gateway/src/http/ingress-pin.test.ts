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
 *      - Human-authenticated browser surface (auth added in Unit 3+).
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
import type {OperatorServerConfig, OperatorServerDeps} from '../web/server.js'
import type {AnnounceLogger} from './announce-handler.js'
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
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
 * The complete set of HTTP routes the gateway exposes over gateway-net (operator surface).
 * Each entry is { method, path } matching Hono's app.routes shape.
 *
 * Current surface: exactly one endpoint — the unauthenticated health check.
 * Privileged routes (auth, launch, approvals, SSE) are added only after the auth boundary is in place
 * after the auth boundary is in place.
 *
 * SECURITY: No announce route may appear here. The operator surface is gateway-net only
 * and is not reachable from sandbox-net.
 */
const EXPECTED_OPERATOR_ROUTES: readonly {method: string; path: string}[] = [{method: 'GET', path: '/operator/health'}]

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
