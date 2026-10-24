---
date: 2026-10-23
topic: post-consolidation
focus: What to build or improve now that the Action/gateway consolidation ladder is finished. Grounded in open issues, recent PRs and the consolidation requirements doc.
mode: repo-grounded
---

# Ideation: after the Action/gateway consolidation

## Codebase Context

The consolidation ladder is finished:

- lease loop (#1899, #1902)
- abort/settle bugfixes (#1906, #1907)
- event loop (#1912)
- dirty-checkout auto-recovery (#1915, #1918, #1919)
- post-hook unleased publish (#1926)
- owner/repo slug contract (#1927)
- error-message helper and SDK envelopes (#1929)
- token-mint backstop removal (#1930)

The consolidation requirements doc still has one large open row: gateway session continuity. It is blocked on safe concurrent publication (#1712), with #1778 behind it.

Open and recent issues fall into four themes:

1. **Run lifecycle and terminal-state reliability** (high severity, increasing): #1922, #1923, and the earlier #1889, #1836, #1753, #1757, #1716, #1705, #1736.
2. **Coordination and persistent-state safety** (high severity, recurring): #1712, #1890, #1835, #1655, #1580.
3. **Operator control and notification parity** (medium severity, increasing): #1916, #1917, and recent closed issues.
4. **OpenCode and provider compatibility** (medium severity, stable): #1805, #1581, #1742.

Past learnings that bear on this:

- Closing a stream does not stop a prompt.
- Every reconcile pass needs a bound and a guard.
- Quiescence is checked by snapshot, so it is corroboration, not a fence.
- The live abort probe has to be re-run by hand on every harness base bump.

## Ranked Ideas

### 1. Stuck runs end with their OpenCode process

**Description:**

- The workspace proxy propagates an upstream SSE close or error to the downstream connection.
- Each run is bound to the OpenCode process incarnation that started it. If that process disappears, the run fails, even when a replacement server is already ready.
- A bounded periodic reconcile pass finishes stranded active runs and terminal writes that failed, so recovery no longer waits for a gateway restart.
- The completion gate's existing rejection reasons are surfaced as an operator-visible wait state, so the operator can see why a run hasn't finished.

**Warrant:** `direct:`

- The #1922 and #1923 triage reproduced a dead upstream leaving the downstream SSE read pending while new requests succeeded (`apps/workspace-agent/src/opencode-proxy.ts:261-307`).
- Recovery is startup-only (`packages/gateway/src/execute/recovery.ts:1-25`).
- Terminal-write failures are logged and deferred (`packages/gateway/src/execute/run.ts:1984-2091`).

**Rationale:** Runs stuck as `running` are the most visible failure in the highest-severity theme, and it is growing. Each piece reuses machinery that already exists: the teardown barrier, recovery, and the completion gate.

**Downsides:** Binding runs to a process incarnation adds state. The SSE fix alone may cover most cases. The periodic pass has to keep the quiescence safeguards in place before it releases any reservation.

**Confidence:** 80% **Complexity:** Medium **Status:** Explored

### 2. Recycle OpenCode at verified idle boundaries

**Description:** Restart the workspace OpenCode server after an RSS, uptime or distinct-directory threshold. The restart is coordinated with admission and verified quiescence, so no run can start in the gap. A bolder variant runs one OpenCode process per run, so that process exit reclaims memory. **Warrant:** `direct:` #1923 measured hundreds of MB retained across repos, enough to exhaust a small host. Supervision after readiness only waits for the process to exit (`apps/workspace-agent/src/opencode-server.ts:666-688`). **Rationale:** It removes a slow resource leak on a small single-operator host without relying on an upstream fix. **Downsides:** A restart loses warm caches and needs an admission handshake. The per-run variant is a large architectural change. **Confidence:** 70% **Complexity:** Medium **Status:** Explored. Deferred until the growth is measured on Linux with real runs. See `docs/brainstorms/2026-10-23-opencode-process-lifecycle-requirements.md`.

### 3. Gateway conversation continuity without shared S3

**Description:** Two variants:

- **(A)** Resume a Discord thread's session on the workspace OpenCode server, scoped to repo, identity and server incarnation. If the session is missing, start a fresh one and say so.
- **(B)** Keep gateway sessions disposable and rebuild bounded thread context into the prompt, treated as untrusted evidence.

**Warrant:** `direct:` This is the largest open consolidation row. It is blocked only because it assumes shared publication (#1712, #1778). See `packages/gateway/src/execute/run-core.ts:506-531`. **Rationale:** It delivers the user-visible continuity gap without first solving concurrent S3 publication. **Downsides:** (A) does not survive a workspace restart. (B) costs prompt tokens and replays untrusted content. **Confidence:** 60% **Complexity:** Medium **Status:** Unexplored

### 4. Cancel from Discord

**Description:** `/fro-bot cancel` in the active run's thread or bound channel uses the existing cancellation engine. A separate "stop channel" action also clears the queue. **Warrant:** `direct:` #1916. See `packages/gateway/src/discord/commands/fro-bot.ts:103-180`, `packages/gateway/src/execute/cancel.ts:53-90` and `packages/gateway/src/execute/queue.ts:41-50`. **Rationale:** It stops wrong-direction work without switching to the dashboard. **Downsides:** It adds two commands with subtly different meanings. **Confidence:** 85% **Complexity:** Medium **Status:** Unexplored

### 5. Attention routing

**Description:**

- Approvals for runs started in Discord can be decided on the authenticated web run card that a push notification opens.
- Failure pushes deep-link to the failed run.
- An optional "needs me" view collects pending approvals, questions and failures.

**Warrant:** `direct:` #1917. See `packages/gateway/src/web/operator-push/payload-builder.ts:68-110` and `packages/gateway/src/approvals/registry.ts:200-212`. **Rationale:** It removes the push → dashboard → Discord detour from the daily loop. **Downsides:** Deciding approvals on the web widens what that surface can do. **Confidence:** 65% **Complexity:** Medium **Status:** Unexplored

### 6. Harness upgrade qualification suite

**Description:** Automate the live abort probe (abort at 0 and 500 ms after `promptAsync`, then watch for 40 s) along with process-failure scenarios: child SIGKILL, workspace restart, a dropped notice, and terminal-store failure. Run it against a candidate harness on every base-version bump. It also becomes the foundation for the V2 evaluation (#1805) and for carry-removal fixtures. **Warrant:** `direct:` `docs/solutions/logic-errors/gateway-root-not-aborted-on-early-stop-2026-10-22.md:73-82` requires re-running the probe per bump, and that is a manual step today. See also `packages/harness/harness.config.json:4`. **Rationale:** A safety assumption that the checkout release depends on is currently backed only by mocks. **Downsides:** It needs a real harness binary in CI, which is slow and costs money. **Confidence:** 70% **Complexity:** Medium-High **Status:** Unexplored

### 7. Decide #1712 on evidence

**Description:**

1. A read-only contention census from the `agent: blocked` timeline history. It separates unrelated-issue contention, same-entity overlap, and scheduled declines.
2. Only if contention is real: a generation-manifest fence at publication, verified with an in-memory persistence-race lab.

**Warrant:** `direct:` #1712 asks for this evidence before it is unfrozen, and #1890 deferred the fence. See `src/harness/phases/coordination-decline.ts:191` and `packages/runtime/src/object-store/content-sync.ts:78-86`. **Rationale:** A small measurement decides whether a large design is warranted. **Downsides:** The census may show the fence is unneeded. That is still a result. **Confidence:** 65% **Complexity:** Low, then Medium **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
| --- | --- | --- |
| 1 | Structured background-completion protocol in the harness | Expensive patch carry. Notice handling has been stable since #1912. |
| 2 | Part-aware reply recovery after SSE gaps | No reported incident. Large. |
| 3 | Wait-state projection | Folded into #1. |
| 4 | Content-free lifecycle flight recorder | Overlaps existing logs. Retention needs justifying. Fold into #1 only if diagnosis needs it. |
| 5 | Per-conversation SQLite shards | Large data-layout change. A brainstorm variant of #7 at most. |
| 6 | Recovery snapshots for withheld publishes | No evidence that withheld work is lost. Adds retention machinery. |
| 7 | Per-generation workspaces | Large. Quarantine already covers stale writers. |
| 8 | Conversation-aware restore and separate pruning (#1778) | Part of the #1712 design phase (#7). |
| 9 | Snooze reminders, notify-when-done | No evidence of need. |
| 10 | Retry with prompt prefilled, edit queued prompt | No evidence of need. |
| 11 | Unavailable vs empty listings (#1875) | Tracked issue. Do it as a direct fix. |
| 12 | Carry-removal fixtures | Folded into #6. |
| 13 | Provider cache experiment (#1581) | Explicitly sequenced after #1805. |
| 14 | Eval model-selection driver | No current decision needs it. |
| 15 | Prevention-patterns index | Low value. The learnings search already covers it. |
| 16 | Docs-only pre-push fast path, test concurrency profile | Real friction, but small. Direct dev-loop fixes. |
| 17 | Bootstrap checkout-mutation test (#1882) | Tracked issue. Direct fix. |
| 18 | Source-authority receipts | The clone-pin rule already covers it. |
