/**
 * Cross-package type-mirror test: mutual (two-way) assignability of the checkout-provenance
 * types duplicated between `apps/workspace-agent/src/types.ts` (producer) and
 * `packages/gateway/src/workspace-api/types.ts` (consumer): `CheckoutObservation`,
 * `CheckoutHead`, `WorktreeState`, and `CheckoutOperation`.
 *
 * Stronger than the existing precedent, `packages/gateway/src/workspace-api/readyz-types.test.ts`:
 * that test compares the gateway `ReadyzResponse` against a HAND-MAINTAINED LOCAL COPY of the
 * workspace-agent shape, so a change on the workspace-agent side goes unnoticed until someone
 * remembers to update the copy by hand. This test imports the REAL types from both packages
 * instead, so drift on either side is caught automatically.
 *
 * Location, and why: the gateway Docker image builds `packages/gateway` in isolation, so gateway
 * SOURCE can never import from `apps/workspace-agent` (this is why `client.ts` keeps its own
 * flattened comments instead of importing, and why `readyz-types.test.ts` hand-mirrors instead of
 * importing). But this file lives in `scripts/`, outside both `apps/workspace-agent` and
 * `packages/gateway` — a location covered by BOTH gates that matter:
 *   - the root `tsconfig.json` (`include: ["**\/*.ts"]`, excludes only `dist`/`node_modules`) —
 *     type-checks this file alongside both real source trees, so `bun run check-types` catches
 *     drift at compile time;
 *   - the root `vitest.config.ts` (excludes `node_modules`, `dist`, `.slim`, `.worktrees`,
 *     `deploy`, and a handful of tool-config globs — not `scripts/`) — runs this file's test body.
 * A TEST-ONLY cross-package import is fine here: it is never bundled into the gateway image
 * (nothing in `apps/workspace-agent` or the gateway's own build graph pulls this file in), it only
 * has to survive `tsc -p tsconfig.json`, which already type-checks both trees together.
 */

import type {
  CheckoutHead as AgentCheckoutHead,
  CheckoutObservation as AgentCheckoutObservation,
  CheckoutOperation as AgentCheckoutOperation,
  WorktreeState as AgentWorktreeState,
} from '../apps/workspace-agent/src/types.js'
import type {
  CheckoutHead as GatewayCheckoutHead,
  CheckoutObservation as GatewayCheckoutObservation,
  CheckoutOperation as GatewayCheckoutOperation,
  WorktreeState as GatewayWorktreeState,
} from '../packages/gateway/src/workspace-api/types.js'

import {describe, expect, it} from 'vitest'

// ---------------------------------------------------------------------------
// Compile-time two-way assignability
// ---------------------------------------------------------------------------

/**
 * Asserts A and B are mutually assignable (structurally equal, ignoring the wrapper-tuple trick
 * that keeps a union type from distributing over the conditional). If either direction fails,
 * this resolves to `never`, which fails to compile when used as a value below — surfacing drift
 * as a type error in `bun run check-types` (and in this file's own type-check within `vitest`,
 * since vitest type-checks the files it runs).
 */
type AssertMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

type ObservationMirrored = AssertMutuallyAssignable<GatewayCheckoutObservation, AgentCheckoutObservation>
const assertObservationMirrored: ObservationMirrored = true
assertObservationMirrored satisfies true

type HeadMirrored = AssertMutuallyAssignable<GatewayCheckoutHead, AgentCheckoutHead>
const assertHeadMirrored: HeadMirrored = true
assertHeadMirrored satisfies true

type WorktreeMirrored = AssertMutuallyAssignable<GatewayWorktreeState, AgentWorktreeState>
const assertWorktreeMirrored: WorktreeMirrored = true
assertWorktreeMirrored satisfies true

type OperationMirrored = AssertMutuallyAssignable<GatewayCheckoutOperation, AgentCheckoutOperation>
const assertOperationMirrored: OperationMirrored = true
assertOperationMirrored satisfies true

// ---------------------------------------------------------------------------
// Runtime test (required by Vitest; the real guard is the compile-time check above)
// ---------------------------------------------------------------------------

describe('checkout-provenance cross-package type-mirror (CheckoutObservation, CheckoutHead, WorktreeState, CheckoutOperation)', () => {
  it('gateway and workspace-agent types are mutually assignable (compile-time guard)', () => {
    // The real assertions are the compile-time checks above — if either package's type drifts
    // from the other (a field added/removed/retyped on one side but not the other), this file
    // fails to compile under `tsc -p tsconfig.json`, well before a wire-format mismatch could
    // ship and silently drop provenance data from a run's status.
    expect(true).toBe(true)
  })

  it('a value satisfying the gateway CheckoutObservation shape also satisfies the workspace-agent shape', () => {
    // #given
    const observation: GatewayCheckoutObservation = {
      head: {kind: 'attached', branch: 'main', sha: 'a'.repeat(40)},
      worktree: {kind: 'dirty', staged: 1, unstaged: 2, untracked: 3, conflicted: 4},
      operationInProgress: 'am',
      observedAt: '2026-01-01T00:00:00.000Z',
    }

    // #then — structurally compatible with the workspace-agent producer shape
    const asAgent: AgentCheckoutObservation = observation
    expect(asAgent.operationInProgress).toBe('am')
  })
})
