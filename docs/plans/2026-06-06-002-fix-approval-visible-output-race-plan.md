---
title: "fix: Resolve gateway approval/status visible-output race in timeout classification"
type: fix
status: active
date: 2026-06-06
---

# fix: Resolve gateway approval/status visible-output race in timeout classification

## Overview

The gateway mention loop posts approval/status messages to Discord (waiting-for-approval status, the approval embed, and the deadline-settled notice) through fire-and-forget sends. Each send marks the stream sink as having produced visible output only *after* the Discord send resolves. The hard-timeout error path reads `sink.hasVisibleOutput()` synchronously to choose between two timeout messages. When the timeout fires while one of these sends is still in flight, classification sees `false` and picks the misleading "no output" timeout copy — even though Discord shows the approval marker milliseconds later.

This plan adds a pending-attempt counter to the sink so an in-flight approval/status send counts as visible context at classification time, while a *failed* send never falsely claims output.

## Problem Frame

Found by adversarial review during issue #801 and deferred as a P2 to avoid expanding that PR's scope (todo `001-pending-p2-gateway-approval-visible-output-race`).

Current behavior in `packages/gateway/src/execute/run.ts`:
- The waiting-status send (`void safeSend(...).then(() => sink?.markVisibleOutputSent())`) and the embed send (`void rawThread.send(...).then(() => sink?.markVisibleOutputSent())`) are fire-and-forget. `markVisibleOutputSent()` runs only on the `.then()`.
- The deadline-settled handler `await`s its `safeSend` before marking, so it is less racy, but shares the same "mark only on success" pattern.
- The error path computes `hasVisibleOutput = sink.hasVisibleOutput() === true` synchronously after the failure-path flush, then branches the timeout copy on it.

The race: timeout fires → classification reads `hasVisibleOutput()` → an approval/status send is mid-flight → returns `false` → user gets `The task reached the N time limit. Please try again.` instead of the visible-output variant, while the approval marker lands on Discord immediately after.

## Requirements Trace

- R1. Timeout classification must not take the no-output branch *solely* because an approval/status visible message is still pending (in flight).
- R2. A failed Discord send must never cause classification to claim visible output that was not delivered.
- R3. The fix must not meaningfully extend the hard run timeout (no awaiting Discord sends in the timeout path).
- R4. Existing text/attachment flush visibility behavior and timeout failure semantics (timeout is still a failure, not partial success) remain unchanged.

## Scope Boundaries

- Does not change the timeout duration, retry behavior, or the fact that a timeout is a failure.
- Does not change the approval coordinator lifecycle, registry settlement, or deadline computation.
- Does not alter text/attachment streaming flush behavior — only adds a parallel pending-visibility signal for the out-of-band approval/status sends.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/discord/streaming.ts` — `DiscordStreamSink` interface + `createDiscordStreamSink()`. Current visible-output state is a single `let visibleOutputSent = false`, set by `markVisibleOutputSent()` and by successful text/attachment flush; read by `hasVisibleOutput()`. This is the single seam to extend.
- `packages/gateway/src/execute/run.ts`:
  - Waiting-status send (`void safeSend(rawThread, 'Waiting for tool approval…').then(...)`).
  - Embed send (`void rawThread.send({embeds, components, ...}).then(...)`).
  - Deadline-settled handler (`onDeadlineSettled: async () => { await safeSend(...); sink?.markVisibleOutputSent() }`).
  - Error classification block: `const hasVisibleOutput = sink !== null && sink.hasVisibleOutput() === true` feeding the timeout-copy ternary.

### Institutional Learnings

- Discord requires interaction ACK within 3s; approval sends are deliberately fire-and-forget so they never block `onPending` (memory 4691/4722). The fix must preserve that — no awaiting in the send path or the timeout path.
- The `(no output)` / `skipped-visible` flush contract (issue #801) is the sibling behavior; this plan reuses the same "visible output already surfaced" intent for the out-of-band sends.

## Key Technical Decisions

- **Pending-attempt counter on the sink (chosen over awaiting settlement).** Add a pending counter that an approval/status send increments synchronously *before* its Discord send and resolves after. `hasVisibleOutput()` returns `delivered || pending > 0`. This satisfies R1 (pending counts as visible) and R3 (no awaiting in the timeout path), and by decrementing on failure satisfies R2 (a failed send retracts its pending claim and never becomes "delivered").
- **Settle handle API shape.** `markVisibleOutputPending()` returns a one-shot settle function `(delivered: boolean) => void`: call `settle(true)` on send success (promotes to permanently visible, same as today's `markVisibleOutputSent`), `settle(false)` on send failure (decrements the pending count without marking delivered). Idempotent — a second call is a no-op — to avoid double-decrement.
- **`hasVisibleOutput()` semantics.** Returns `true` when either permanent visible output exists (`visibleOutputSent`) OR `pendingVisibleOutput > 0`. A still-pending send at classification time therefore reads as visible context; if it later fails, that only matters for *future* reads, and the timeout message has already been chosen correctly (the run genuinely surfaced a blocking interaction the user will see attempted).
- **Deadline-settled handler.** Keep its `await safeSend(...)` then `markVisibleOutputSent()` as-is — it is not in the racy fire-and-forget path. Optionally route it through the same pending/settle API for consistency, but not required for correctness.

## Open Questions

### Resolved During Planning

- Should the timeout path await pending sends? No — R3 forbids meaningfully extending the timeout. The pending counter makes awaiting unnecessary.
- Does a failed send leave a permanent false-positive? No — `settle(false)` decrements; only `settle(true)` sets the permanent `visibleOutputSent` flag.

### Deferred to Implementation

- Exact field names (`pendingVisibleOutput`, `markVisibleOutputPending`) — finalize at implementation; mirror existing naming in `streaming.ts`.
- Whether to also route `onDeadlineSettled` through the new API for uniformity — implementer's call; behavior is already correct there.

## Implementation Units

- [ ] **Unit 1: Add pending-visibility counter to the sink**

**Goal:** Extend `DiscordStreamSink` so out-of-band sends can mark visibility as *pending* before delivery, and resolve it on success/failure, with `hasVisibleOutput()` treating pending as visible.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/discord/streaming.ts`
- Test: `packages/gateway/src/discord/streaming.test.ts`

**Approach:**
- Add `let pendingVisibleOutput = 0` alongside `visibleOutputSent`.
- Add `markVisibleOutputPending()` to the interface, returning a one-shot settle function: increments `pendingVisibleOutput`; the returned `settle(delivered: boolean)` decrements once (guard against double-settle), and when `delivered === true` also sets `visibleOutputSent = true`.
- Change `hasVisibleOutput()` to return `visibleOutputSent || pendingVisibleOutput > 0`.
- Leave `markVisibleOutputSent()`, `append`, `flush`, `buffered` unchanged; document the new method in the interface JSDoc consistent with existing style.

**Patterns to follow:**
- The existing `markVisibleOutputSent` / `hasVisibleOutput` closure-over-`let` pattern in `createDiscordStreamSink()`.

**Test scenarios:**
- Happy path: `markVisibleOutputPending()` makes `hasVisibleOutput()` return `true` immediately (before settle).
- Happy path: `settle(true)` keeps `hasVisibleOutput()` true and persists it after the pending count would drop.
- Error path: `settle(false)` with no other output makes `hasVisibleOutput()` return `false` again (pending retracted, not promoted to delivered).
- Edge case: two concurrent `markVisibleOutputPending()` handles; settling one `false` keeps `hasVisibleOutput()` true while the other is still pending.
- Edge case: calling a settle handle twice is a no-op (no double-decrement / no negative count).
- Integration: empty-buffer `flush()` after `settle(true)` returns `{kind:'skipped-visible'}` (existing contract still holds via `visibleOutputSent`).

**Verification:**
- The sink exposes `markVisibleOutputPending`; `hasVisibleOutput()` reflects pending-as-visible and failure-retraction; all existing streaming tests still pass.

- [ ] **Unit 2: Wire approval/status sends through the pending API in run.ts**

**Goal:** Make the waiting-status and embed sends mark visibility *pending* synchronously before their Discord send, settling true/false on resolution, so timeout classification sees in-flight sends as visible context.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/execute/run.ts`
- Test: `packages/gateway/src/execute/run.test.ts`

**Approach:**
- Waiting-status send: before `void safeSend(...)`, capture `const settle = sink?.markVisibleOutputPending()`; in `.then()` call `settle?.(true)`, in `.catch()` call `settle?.(false)` (in addition to the existing warn log).
- Embed send: same pattern — `const settle = sink?.markVisibleOutputPending()` before `void rawThread.send(...)`; `.then()` → `settle?.(true)` (plus the existing `attachMessage` wiring), `.catch()` → `settle?.(false)` (plus the existing `markMessagePostFailed` + warn).
- Keep `onDeadlineSettled` as-is (already awaits before marking) — no race there.
- Do not await anything new in the error/timeout path; classification continues to read `sink.hasVisibleOutput()` synchronously.

**Patterns to follow:**
- The existing fire-and-forget `void ... .then().catch()` structure already in `run.ts`; only add the synchronous pending-capture and the settle calls.

**Test scenarios:**
- Integration: approval send started but unresolved when timeout fires → classification chooses the visible-output timeout copy (not the no-output copy). (Drive by leaving the send promise pending until after classification.)
- Integration: approval send rejects, then timeout fires → classification chooses the no-output copy (failed send did not falsely claim output).
- Integration: approval send resolves successfully before timeout → visible-output copy (existing behavior preserved).
- Edge case: no approval ever requested + empty output + timeout → no-output copy (unchanged from #801).

**Verification:**
- A pending approval/status send at timeout yields the visible-output message; a failed send yields the no-output message; successful and no-approval paths are unchanged; failure semantics (timeout is still a failure) unchanged.

## System-Wide Impact

- **Interaction graph:** Only the approval/status send sites in `run.ts` and the sink's visibility state are touched. The coordinator, registry, deadline timer, and streaming text/attachment path are unchanged.
- **Error propagation:** A failed Discord send now decrements pending rather than silently leaving a flag unset; it must not promote to delivered. The original timeout error is still surfaced and still classified as failure.
- **State lifecycle risks:** Double-settle and negative counts are guarded by the one-shot settle handle. No persistent state beyond the run.
- **Unchanged invariants:** `markVisibleOutputSent()`, `flush()` `skipped-visible`/`no-output` behavior, and timeout-is-failure semantics are preserved. `hasVisibleOutput()` only widens to include pending.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A pending send that ultimately fails momentarily reads as visible | Acceptable per R1 framing — the run genuinely reached a blocking interaction; classification only needs to not mislead when output *will* appear. The failed send retracts via `settle(false)` for any later read. |
| Double-settle causing negative pending count | One-shot idempotent settle handle (Unit 1 test pins this). |
| Awaiting sends sneaks into the timeout path | Explicitly forbidden (R3); Unit 2 keeps classification synchronous. |

## Sources & References

- Deferred todo: `.context/systematic/todos/001-pending-p2-gateway-approval-visible-output-race.md`
- Related plan: `docs/plans/2026-06-06-001-fix-discord-timeout-partial-output-plan.md`
- Related: issue #801 / PR #803 (timeout copy after visible output)
