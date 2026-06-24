/**
 * Cross-package type-mirror test: one-way assignability of ReadyzResponse.
 *
 * The two ReadyzResponse types are intentionally asymmetric:
 *   - Gateway (packages/gateway/src/workspace-api/types.ts): discriminated union (NARROWER)
 *     `ReadyzReady | ReadyzNotReady` — `ready: true` only pairs with `opencode: 'ready'`
 *   - Workspace-agent (apps/workspace-agent/src/types.ts): flat interface (LOOSER)
 *     `{ ready: boolean; opencode: 'ready' | 'starting' | 'down' | 'degraded' | 'unknown' }`
 *
 * Wire direction: workspace-agent PRODUCES the flat shape; gateway CONSUMES a narrowed view.
 * Therefore: every gateway-valid ReadyzResponse must be assignable to the workspace-agent shape.
 *
 * This is a ONE-WAY check (Gateway → Workspace), NOT equality.
 * Equality would fail today by design — the gateway discriminated union is strictly narrower.
 *
 * If the gateway ReadyzResponse stops being assignable to the workspace-agent shape (e.g. a
 * new field is added to the gateway type that the workspace-agent doesn't produce), `tsc` will
 * fail here, catching wire-compatibility drift at compile time.
 *
 * NOTE: The workspace-agent shape is mirrored locally (NOT imported across the package/container
 * boundary). The gateway Docker image builds in isolation without apps/workspace-agent present,
 * so cross-package imports would break `bun run --filter @fro-bot/gateway build`. This follows the
 * same convention as client.ts. Keep `WorkspaceReadyzResponse` in sync with the source of truth:
 * apps/workspace-agent/src/types.ts `ReadyzResponse`.
 */

import type {ReadyzResponse as GatewayReadyzResponse} from './types.js'

import {describe, expect, it} from 'vitest'

/**
 * Local mirror of apps/workspace-agent/src/types.ts `ReadyzResponse` (the wire producer shape).
 * NOT imported across the package/container boundary — the gateway image builds in isolation
 * without apps/workspace-agent present (see client.ts for the same mirroring convention).
 * Keep in sync with the workspace-agent source of truth.
 */
interface WorkspaceReadyzResponse {
  readonly ready: boolean
  readonly opencode: 'ready' | 'starting' | 'down' | 'degraded' | 'unknown'
}

// ---------------------------------------------------------------------------
// Compile-time type assertion helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that type A is assignable to type B at compile time.
 * If A is NOT assignable to B, this produces a `never` type, which causes a
 * type error when used as a value (the `assertAssignable` variable below).
 *
 * Usage: `type CheckName = AssertAssignable<Narrower, Wider>`
 */
type AssertAssignable<A, B> = A extends B ? true : never

// ---------------------------------------------------------------------------
// One-way assignability: GatewayReadyzResponse → WorkspaceReadyzResponse
// ---------------------------------------------------------------------------

/**
 * Every gateway-valid ReadyzResponse (the narrower discriminated union) must be
 * assignable to the workspace-agent flat ReadyzResponse (the looser producer shape).
 *
 * If this type resolves to `never`, the `assertAssignable` variable below will fail to compile,
 * surfacing the drift as a type error in `bun run check-types`.
 */
type GatewayAssignableToWorkspace = AssertAssignable<GatewayReadyzResponse, WorkspaceReadyzResponse>

/**
 * Materialise the compile-time check as a value so TypeScript eagerly evaluates it.
 * If `GatewayAssignableToWorkspace` is `never`, this assignment fails to compile.
 */
const assertAssignable: GatewayAssignableToWorkspace = true

// Suppress "declared but never read" — the value exists solely for the compile-time check.
assertAssignable satisfies true

// ---------------------------------------------------------------------------
// Runtime test (required by Vitest; the real guard is the compile-time check above)
// ---------------------------------------------------------------------------

describe('ReadyzResponse cross-package type-mirror', () => {
  it('gateway ReadyzResponse is one-way assignable to workspace-agent ReadyzResponse (compile-time guard)', () => {
    // The real assertion is the compile-time check above.
    // This runtime assertion satisfies the test runner and documents intent.
    expect(true).toBe(true)
  })

  it('readyzReady shape is structurally compatible with workspace-agent ReadyzResponse', () => {
    // #given — a value that satisfies the gateway ReadyzReady shape
    const ready: GatewayReadyzResponse = {ready: true, opencode: 'ready'}

    // #then — it is also a valid workspace-agent ReadyzResponse (structural check at runtime)
    const asWorkspace: WorkspaceReadyzResponse = ready
    expect(asWorkspace.ready).toBe(true)
    expect(asWorkspace.opencode).toBe('ready')
  })

  it('readyzNotReady shape is structurally compatible with workspace-agent ReadyzResponse', () => {
    // #given — a value that satisfies the gateway ReadyzNotReady shape
    const notReady: GatewayReadyzResponse = {ready: false, opencode: 'starting'}

    // #then — it is also a valid workspace-agent ReadyzResponse
    const asWorkspace: WorkspaceReadyzResponse = notReady
    expect(asWorkspace.ready).toBe(false)
    expect(asWorkspace.opencode).toBe('starting')
  })

  it('all gateway not-ready opencode statuses are valid workspace-agent opencode values', () => {
    // #given — all not-ready opencode values the gateway discriminated union allows
    const statuses = ['starting', 'down', 'degraded', 'unknown'] as const

    for (const status of statuses) {
      // #when
      const notReady: GatewayReadyzResponse = {ready: false, opencode: status}
      const asWorkspace: WorkspaceReadyzResponse = notReady

      // #then
      expect(asWorkspace.opencode).toBe(status)
    }
  })
})
