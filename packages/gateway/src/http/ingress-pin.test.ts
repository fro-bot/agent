/**
 * Gateway HTTP ingress surface pinning test.
 *
 * The gateway is reachable from the workspace over sandbox-net. Its only
 * inbound HTTP surface must be the HMAC/replay-gated POST /v1/announce
 * endpoint — a fixed-embed webhook that does not perform caller-directed
 * outbound requests. Any new route added to the gateway's HTTP ingress
 * could reopen the egress trust boundary (a workspace-reachable endpoint
 * that performs arbitrary outbound requests would let the workspace bypass
 * mitmproxy via the gateway). This test fails if the route inventory
 * changes, forcing a deliberate security review before the change ships.
 *
 * If you are adding a new HTTP route and this test fails:
 *   1. Confirm the new endpoint does NOT perform caller-directed outbound
 *      requests on behalf of the workspace.
 *   2. Update EXPECTED_ROUTES below with the new route after review.
 *   3. Update deploy/README.md (Egress topology → Forward constraint) to
 *      document the new endpoint and its trust properties.
 *
 * SERVER ENTRY-POINT PIN (tamper-evident):
 *   A second HTTP server added anywhere in packages/gateway/src/ would bypass
 *   the route-inventory check above (it only inspects buildAnnounceApp's routes).
 *   The static source-scan test below asserts there is exactly ONE serve() call
 *   across the entire gateway source tree. Adding a second server entry point
 *   fails this pin, requiring a deliberate security review.
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
import type {AnnounceLogger} from './announce-handler.js'
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {buildAnnounceApp} from './server.js'

// ---------------------------------------------------------------------------
// Pinned ingress surface — update only after deliberate security review.
// ---------------------------------------------------------------------------

/**
 * The complete set of HTTP routes the gateway exposes over sandbox-net.
 * Each entry is { method, path } matching Hono's app.routes shape.
 *
 * Current surface: exactly one endpoint — the HMAC/replay/timestamp/schema-gated
 * announce webhook. It posts a fixed embed to a configured Discord channel and
 * does not perform caller-directed outbound requests.
 */
const EXPECTED_ROUTES: readonly {method: string; path: string}[] = [{method: 'POST', path: '/v1/announce'}]

// ---------------------------------------------------------------------------
// Minimal stubs — we only need to build the app, not run requests.
// ---------------------------------------------------------------------------

function makeStubDeps(): Parameters<typeof buildAnnounceApp>[0] {
  const logger: AnnounceLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  // Structural stub — only the shape matters; no real Discord calls are made.
  const client = {channels: {fetch: vi.fn()}} as unknown as Client
  return {client, logger}
}

function makeStubConfig(): Parameters<typeof buildAnnounceApp>[1] {
  return {
    webhookSecret: 'stub-secret',
    presenceChannelId: 'stub-channel',
    httpPort: 0, // not used — we never call serve()
  }
}

// ---------------------------------------------------------------------------
// Pin test
// ---------------------------------------------------------------------------

describe('gateway HTTP ingress surface', () => {
  it('is exactly {POST /v1/announce} — no undeclared routes', () => {
    // #given — build the Hono app without starting a server
    const app = buildAnnounceApp(makeStubDeps(), makeStubConfig())

    // #when — extract the registered user-defined routes as unique (method, path) pairs.
    // Hono registers each middleware in a chain as a separate entry for the same route
    // (e.g. bodyLimit + handler both appear as POST /v1/announce). Deduplicate by
    // (method, path) so the pin reflects the logical route inventory, not the
    // middleware-chain expansion. A new logical route still produces a new unique pair.
    const seen = new Set<string>()
    const actualRoutes = app.routes
      .map(r => ({method: r.method, path: r.path}))
      .filter(r => {
        const key = `${r.method}:${r.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — the inventory must match the pinned set exactly.
    // Adding a route without updating this pin fails the test, requiring a
    // security review of the new workspace-reachable endpoint.
    expect(actualRoutes).toEqual(EXPECTED_ROUTES)
  })
})

// ---------------------------------------------------------------------------
// Server entry-point pin — tamper-evident single-server assertion.
//
// The route-inventory test above only inspects routes registered through
// buildAnnounceApp(). A second HTTP server (serve() / http.createServer())
// added ELSEWHERE in the gateway package would be completely invisible to it.
//
// This test statically scans every .ts source file under packages/gateway/src/
// and asserts there is exactly ONE serve( call. Adding a second server entry
// point fails this pin, requiring a deliberate security review before the
// change ships.
//
// We use a static source scan rather than a runtime stub approach because:
//   - Stubs only catch routes wired through the factory chain; a second server
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
  it('has exactly one serve() call across packages/gateway/src/ — adding a second server requires security review', () => {
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

    // #then — exactly one serve() call must exist (in createAnnounceServer in server.ts).
    // If this assertion fails, a new HTTP server entry point was added to the gateway.
    // Before updating this count:
    //   1. Confirm the new server does NOT expose workspace-reachable endpoints that
    //      perform caller-directed outbound requests (egress trust boundary).
    //   2. Update deploy/README.md (Egress topology → Forward constraint).
    expect(serveCallSites).toHaveLength(1)
    expect(serveCallSites[0]?.file).toMatch(/server\.ts$/)
  })
})
