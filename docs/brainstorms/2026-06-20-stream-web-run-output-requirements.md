---
title: Stream web-launched run output to the operator
date: 2026-06-20
status: ready-for-planning
issue: 965
surface: gateway operator SSE
---

# Stream web-launched run output to the operator

## Problem

A web operator can launch a run (`POST /operator/runs`) and watch it reach `succeeded`/`failed` over the SSE run-stream (`GET /operator/runs/:runId/stream`), but **cannot read what the agent actually said**. The agent's output text flows into the web `ReplySink` during execution, but `createWebReplySink()` (`packages/gateway/src/web/operator/web-sinks.ts:69-123`) buffers it in memory and its `flush`/`send` are no-ops — the text is dropped. The operator SSE projection (`packages/gateway/src/web/sse/projection.ts:57-90`) carries only run status, never message content.

The Discord transport already delivers the same text (its `flush()` posts the buffered output to the thread — `packages/gateway/src/discord/streaming.ts:163-210`). This issue brings parity to the web surface.

## Goal

Deliver a web-launched run's agent output to the operator over the **existing** SSE run-stream — live as it's produced, with a guaranteed complete answer at the end — reusing the run-observation manager and the single run-stream connection. Closes #965 (advances #907).

Live streaming (vs the simpler final-answer-only the issue triage suggested) is a deliberate bet: an operator watching a long run benefits from reading along in real time — to intervene, debug, or just perceive progress — rather than waiting for a terminal dump. The cost is the streaming machinery below; the final-answer frame keeps the guarantee simple regardless. (Acknowledged tradeoff: for short runs the live value over final-only is marginal; the design keeps final-answer delivery authoritative so the streaming layer can degrade to "deltas are best-effort, the final frame is the contract.")

Two output frame shapes carry the contract:
- **`output` (delta)** — incremental agent text as it's produced. The client **appends** these.
- **`output` (final)** — a single authoritative snapshot of the complete answer, marked `final: true`. The client **replaces** its accumulated live text with this. This is the completeness guarantee.

1. **Live delta-streaming + authoritative final frame.** Output flows as the agent produces it (the operator reads along, like the Discord thread filling in). On terminal status, a single `final: true` `output` frame carries the complete answer, which **replaces** the accumulated deltas — so the operator always ends with the full, correct text even if mid-stream deltas were coalesced. Clients render deltas optimistically (append) and replace with the final frame on completion.

2. **Hard ordering: final answer before terminal status.** The final `output` frame for a run MUST be enqueued before the terminal status frame (`succeeded`/`failed`) is published to a subscriber. A subscriber can never observe terminal status without the final answer already in its queue — closing the race where the operator sees "succeeded" with no answer. (Requires per-run serialization between the output and status entry points; the planning doc owns the mechanism.)

3. **Terminal-output snapshot cached for late subscribers.** The manager caches the final answer alongside the latest status (it already caches latest status). A subscriber connecting **after** the run reached a terminal phase receives both the terminal status and the cached final `output` frame — so reconnect-after-completion still delivers the answer. This is a single bounded snapshot per run, not a delta history.

4. **Overflow: silent coalesce, keep the connection.** Output frames flow through the manager's per-subscriber queue cap (`DEFAULT_SUBSCRIBER_QUEUE_CAP_BYTES = 64 KB`, `packages/gateway/src/web/sse/manager.ts:37`). Under queue pressure, pending output deltas are coalesced/dropped **silently** — no elision marker — and the connection is **not** dropped. The authoritative final frame restores completeness, so a coalesced live stream is always corrected at the end. (Status-frame overflow keeps its existing drop-on-overflow behavior; only output frames coalesce. Per-subscriber queues are independent — a slow subscriber's coalescing never affects a fast one.)

5. **Output delivered as-is; the repo-authz gate is the trust boundary.** The operator passed the same denylist + repo-authz gate that protects the status stream and could see this output in the Discord thread. Stream the agent's visible output text as-is, reusing run-core's existing visible-output discipline (reasoning suppressed, tools summarized — `packages/gateway/src/execute/run-core.ts:373-400`). Do **not** add a per-message scrub. The trust boundary is the connection's authz, not per-frame redaction.

6. **Output rides the same continuous-authz lease.** Output frames flow on the same authenticated connection as status frames, gated by the existing ~30s lease. If access is revoked mid-run, the whole connection closes — status and output stop together. No separate authz path for output (it can't leak to a de-authorized operator because the connection itself is torn down).

## Security posture

The web SSE stream is **not a new authorization boundary** — output reaches only operators who passed the same denylist + repo-authz gate that already protects the status stream, exactly as they would see it in the Discord thread. It **is** a new *exposure surface*: browser-readable, copy-pasteable, screenshot-able, potentially client-cached. This is parity with Discord for already-authorized operators, **not** a broadening of access to new principals. Two consciously-accepted properties:

- **Bounded revocation window.** Output rides the same ~30s continuous-authz lease as status. If access is revoked mid-run, up to ~30s of output can still flow before the lease tears down the connection — identical to the status-stream behavior, accepted as the same bounded lag.
- **Secret-scanning deferred by policy, not omission.** Output may contain repo contents, paths, tool output, or inadvertent secrets. v1 relies on run-core's existing visible-output discipline only, with no active secret-detection pass — matching the Discord transport (which doesn't scrub either). Revisiting a minimal high-risk-token filter for the browser surface is a possible follow-up, not a v1 gap.

## Scope

### In scope
- An additive `output` frame on the closed `ObservationFrame` union (`status | reset | heartbeat` → `+ output`), carrying operator-safe agent text, with a `final: boolean` flag distinguishing delta (append) from final-snapshot (replace).
- A content entry point on the run-observation manager (e.g. `observeOutput(runId, text)`) alongside the existing observer-only `observe(runState)`, keeping `RunObservationManagerDeps` content-pushed rather than run-state-pulled.
- Per-run serialization so the final `output` frame is enqueued before the terminal status frame (the ordering guarantee), and a per-run terminal-output snapshot cache so late subscribers receive the final answer.
- Wire the web `ReplySink` (`web-sinks.ts`) to push deltas through that entry point on `append`, and the final answer on terminal-status/`flush`. This requires the web sink to reach the manager + runId at construction (see Open questions / construction-order).
- Silent coalescing in the per-subscriber queue path for output frames (status frames keep their existing drop-on-overflow path; per-subscriber queues stay independent).
- `writeFrame` event mapping for the new `output` frame (`packages/gateway/src/web/sse/run-stream-route.ts:174-191`).
- A terminal `output` frame on **every** terminal run, including empty/early-failure runs — with empty content (or an explicit empty marker) so the operator can distinguish "no output" from "missing output".
- MINOR operator-contract bump → **1.3.0** (`packages/gateway/src/operator-contract/version.ts`, currently `1.2.0`). The `ready` frame already advertises `contractVersion`; 1.2.x clients keep working via feature detection — 1.3.0 only adds the `output` frame type, no breaking change.

### Non-goals (v1)
- No mid-stream elision marker. Overflow coalesces output silently; the authoritative final frame is the completeness mechanism. (Re-add an elision signal later only if operators report needing real-time awareness of skipped detail.)
- No secret-scanning / active redaction pass on output text (deferred by policy — see Security posture).
- No second SSE channel — reuse the run-observation manager + run-stream route.
- **No mid-stream delta replay/scrollback.** A reconnecting subscriber resumes live; it does **not** replay the individual deltas produced while it was disconnected. The terminal-output snapshot (in scope above) IS cached and re-delivered — that is the bounded exception that makes the completeness guarantee hold on reconnect-after-completion, not a full delta history.
- No tighter-than-Discord projection (e.g. excluding the tool summaries run-core already shows) — parity with the existing visible-output discipline, not a new one.

## Success criteria

- A web operator subscribed to a run's stream sees the agent's output arrive live as the run executes.
- The operator **always** ends with the complete answer: the `final: true` `output` frame is enqueued before terminal status and replaces any coalesced live text — whether the operator was connected throughout, was slow (coalesced), or connected after the run completed (cached snapshot).
- A run with no output (empty or early failure) still produces a terminal `output` frame, so the operator can tell "no output" apart from "missing output".
- Under a slow/overflowing subscriber, the connection stays alive; output coalesces silently and the final frame restores completeness. A slow subscriber never affects a fast one.
- Output is never delivered to an operator who has lost repo access mid-run (the lease tears down the connection, within the accepted ~30s window).
- The Discord transport's behavior is unchanged (the `ReplySink` change is additive to the web sink only).
- No raw tool args / secrets beyond what run-core's existing visible-output discipline already emits.

## Open questions for planning

- **Construction-order (load-bearing):** the web `ReplySink` is built in `launch-route.ts` with no manager/runId today. Planning must specify how the sink reaches the observation manager + runId — thread `{runId, manager}` into the sink factory, or wrap the sink with a run-scoped adapter at the launch site.
- The per-run serialization mechanism for the ordering guarantee (e.g. accept output until terminal status is observed, then flush/coalesce output before emitting terminal status).
- Coalescing strategy in the queue (merge adjacent output deltas vs newest-wins) and the byte-accounting interaction with the existing status-frame queue path.
- Final-frame payload: send the complete buffered answer (client replaces) vs tail-only — confirm the complete-answer approach against the 64 KB cap (a very large answer may itself need chunking).

## Grounding (verified against `main` @ d0b34ce5)

- `ReplySink` interface (`append`/`flush`/`buffered`/`send` + visible-output tracking): `packages/gateway/src/execute/launch-types.ts:189-299`; doc anticipates "a web transport may implement `append`/`flush` as SSE pushes" (`:216-220`).
- Web sink no-op gap: `packages/gateway/src/web/operator/web-sinks.ts:69-123` (`append` buffers, `flush`/`send` no-op).
- Manager observer-only + closed frame union + 64 KB cap: `packages/gateway/src/web/sse/manager.ts:37,53-78,106-135`.
- SSE frame writing + `ready`/`contractVersion`: `packages/gateway/src/web/sse/run-stream-route.ts:174-191,442-448`.
- Output text already flows into `replySink.append`: `packages/gateway/src/execute/run-core.ts:373-400`; final answer via `replySink.buffered()` → `statusSink.resolveToAnswer(...)`: `packages/gateway/src/execute/run.ts:635-645`.
- Contract version `1.2.0`: `packages/gateway/src/operator-contract/version.ts:15`.
