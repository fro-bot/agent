/**
 * Cross-package type-mirror test: mutual (two-way) assignability of the checkout-provenance,
 * clone-error-code, update, recovery, and backups wire types duplicated between
 * `apps/workspace-agent/src/types.ts` (producer) and `packages/gateway/src/workspace-api/types.ts`
 * (consumer): `CheckoutObservation`, `CheckoutHead`, `WorktreeState`, `CheckoutOperation`,
 * `CloneErrorCode`, `UpdateRequest`/`UpdateResult` (Unit 6 slice 6a; covers the embedded
 * `UpdateRefusalReason`/`UpdateFailureReason`/`UpdateChangeKind`/`LayoutRefusalReason`/
 * `Obstruction` end-to-end), `PreviewRecoveryRequest`/`PreviewRecoveryResult`,
 * `ExecuteRecoveryRequest`/`ExecuteRecoveryResult`, `BackupEntry`, `ListBackupsResult`, and
 * `DeleteBackupResult`.
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
  BackupEntry as AgentBackupEntry,
  CheckoutHead as AgentCheckoutHead,
  CheckoutObservation as AgentCheckoutObservation,
  CheckoutOperation as AgentCheckoutOperation,
  CloneErrorCode as AgentCloneErrorCode,
  DeleteBackupResult as AgentDeleteBackupResult,
  ExecuteRecoveryRequest as AgentExecuteRecoveryRequest,
  ExecuteRecoveryResult as AgentExecuteRecoveryResult,
  ListBackupsResult as AgentListBackupsResult,
  PreviewRecoveryRequest as AgentPreviewRecoveryRequest,
  PreviewRecoveryResult as AgentPreviewRecoveryResult,
  UpdateRequest as AgentUpdateRequest,
  UpdateResult as AgentUpdateResult,
  WorktreeState as AgentWorktreeState,
} from '../apps/workspace-agent/src/types.js'
import type {
  BackupEntry as GatewayBackupEntry,
  CheckoutHead as GatewayCheckoutHead,
  CheckoutObservation as GatewayCheckoutObservation,
  CheckoutOperation as GatewayCheckoutOperation,
  CloneErrorCode as GatewayCloneErrorCode,
  DeleteBackupResult as GatewayDeleteBackupResult,
  ExecuteRecoveryRequest as GatewayExecuteRecoveryRequest,
  ExecuteRecoveryResult as GatewayExecuteRecoveryResult,
  ListBackupsResult as GatewayListBackupsResult,
  PreviewRecoveryRequest as GatewayPreviewRecoveryRequest,
  PreviewRecoveryResult as GatewayPreviewRecoveryResult,
  UpdateRequest as GatewayUpdateRequest,
  UpdateResult as GatewayUpdateResult,
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

/**
 * `CloneErrorCode` is the `/clone` wire-error union (`apps/workspace-agent/src/types.ts`,
 * mirrored in `packages/gateway/src/workspace-api/types.ts`). A code added to one side but not
 * the other silently breaks either the gateway's parser (`client.ts`'s `isCloneErrorCode`, whose
 * own `CLONE_ERROR_CODES` set has to be updated by hand and is NOT caught by this guard) or the
 * gateway's retry classification (`PERMANENT_CLONE_ERROR_CODES`, execute/run.ts) — this guard
 * catches only the type-level half of that drift, at compile time.
 */
type CloneErrorCodeMirrored = AssertMutuallyAssignable<GatewayCloneErrorCode, AgentCloneErrorCode>
const assertCloneErrorCodeMirrored: CloneErrorCodeMirrored = true
assertCloneErrorCodeMirrored satisfies true

/**
 * `/update` wire types (Unit 6, slice 6a) — `UpdateRequest` and the full `UpdateResult` union
 * (which itself embeds `UpdateRefusalReason`, `UpdateFailureReason`, `UpdateChangeKind`,
 * `LayoutRefusalReason`, and `Obstruction`; checking `UpdateResult` end-to-end covers all of them
 * without a separate assertion per embedded type).
 */
type UpdateRequestMirrored = AssertMutuallyAssignable<GatewayUpdateRequest, AgentUpdateRequest>
const assertUpdateRequestMirrored: UpdateRequestMirrored = true
assertUpdateRequestMirrored satisfies true

type UpdateResultMirrored = AssertMutuallyAssignable<GatewayUpdateResult, AgentUpdateResult>
const assertUpdateResultMirrored: UpdateResultMirrored = true
assertUpdateResultMirrored satisfies true

/** `/recover/preview` wire types (Unit 5 slice 5c, Unit 6 slice 6a). */
type PreviewRecoveryRequestMirrored = AssertMutuallyAssignable<
  GatewayPreviewRecoveryRequest,
  AgentPreviewRecoveryRequest
>
const assertPreviewRecoveryRequestMirrored: PreviewRecoveryRequestMirrored = true
assertPreviewRecoveryRequestMirrored satisfies true

type PreviewRecoveryResultMirrored = AssertMutuallyAssignable<GatewayPreviewRecoveryResult, AgentPreviewRecoveryResult>
const assertPreviewRecoveryResultMirrored: PreviewRecoveryResultMirrored = true
assertPreviewRecoveryResultMirrored satisfies true

/** `/recover` wire types. */
type ExecuteRecoveryRequestMirrored = AssertMutuallyAssignable<
  GatewayExecuteRecoveryRequest,
  AgentExecuteRecoveryRequest
>
const assertExecuteRecoveryRequestMirrored: ExecuteRecoveryRequestMirrored = true
assertExecuteRecoveryRequestMirrored satisfies true

type ExecuteRecoveryResultMirrored = AssertMutuallyAssignable<GatewayExecuteRecoveryResult, AgentExecuteRecoveryResult>
const assertExecuteRecoveryResultMirrored: ExecuteRecoveryResultMirrored = true
assertExecuteRecoveryResultMirrored satisfies true

/** `/backups` wire types — `BackupEntry` is checked both standalone and embedded in `ListBackupsResult`. */
type BackupEntryMirrored = AssertMutuallyAssignable<GatewayBackupEntry, AgentBackupEntry>
const assertBackupEntryMirrored: BackupEntryMirrored = true
assertBackupEntryMirrored satisfies true

type ListBackupsResultMirrored = AssertMutuallyAssignable<GatewayListBackupsResult, AgentListBackupsResult>
const assertListBackupsResultMirrored: ListBackupsResultMirrored = true
assertListBackupsResultMirrored satisfies true

type DeleteBackupResultMirrored = AssertMutuallyAssignable<GatewayDeleteBackupResult, AgentDeleteBackupResult>
const assertDeleteBackupResultMirrored: DeleteBackupResultMirrored = true
assertDeleteBackupResultMirrored satisfies true

// ---------------------------------------------------------------------------
// Runtime test (required by Vitest; the real guard is the compile-time check above)
// ---------------------------------------------------------------------------

describe('checkout-provenance cross-package type-mirror (CheckoutObservation, CheckoutHead, WorktreeState, CheckoutOperation, CloneErrorCode, UpdateRequest/Result, PreviewRecoveryRequest/Result, ExecuteRecoveryRequest/Result, BackupEntry, ListBackupsResult, DeleteBackupResult)', () => {
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

  it('every gateway CloneErrorCode value is also a valid workspace-agent CloneErrorCode value (compile-time guard)', () => {
    // The real assertion is the compile-time check above (CloneErrorCodeMirrored). This runtime
    // assertion documents intent and satisfies the test runner.
    const code: GatewayCloneErrorCode = 'checkout-handoff-failed'
    const asAgent: AgentCloneErrorCode = code
    expect(asAgent).toBe('checkout-handoff-failed')
  })

  it('a value satisfying the gateway UpdateResult (refused/obstructed) shape also satisfies the workspace-agent shape', () => {
    // #given
    const result: GatewayUpdateResult = {
      kind: 'refused',
      reason: 'obstructed',
      obstructions: [{path: 'a.txt', kind: 'exact-conflict'}],
    }

    // #then — structurally compatible with the workspace-agent producer shape
    const asAgent: AgentUpdateResult = result
    expect(asAgent.kind).toBe('refused')
  })

  it('a value satisfying the gateway ExecuteRecoveryResult (ok) shape also satisfies the workspace-agent shape', () => {
    // #given
    const result: GatewayExecuteRecoveryResult = {kind: 'ok', recoveryId: 'gen-1', sha: 'b'.repeat(40), branch: 'main'}

    // #then
    const asAgent: AgentExecuteRecoveryResult = result
    expect(asAgent.kind).toBe('ok')
  })

  it('a value satisfying the gateway ListBackupsResult shape also satisfies the workspace-agent shape', () => {
    // #given
    const result: GatewayListBackupsResult = {
      kind: 'ok',
      backups: [
        {
          id: 'gen-1',
          metadataOk: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          sizeBytes: 100,
          sizeComplete: true,
          originalHeadSha: 'c'.repeat(40),
          originalBranch: 'main',
        },
      ],
      totalBytes: 100,
    }

    // #then
    const asAgent: AgentListBackupsResult = result
    expect(asAgent.kind).toBe('ok')
  })
})
