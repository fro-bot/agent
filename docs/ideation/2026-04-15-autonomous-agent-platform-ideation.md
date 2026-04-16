---
date: 2026-04-15
topic: autonomous-agent-platform
focus: "Evolve fro-bot/agent from reactive GitHub Action to autonomous agent with gateway, event streaming, Discord interface, and S3-compatible object storage"
---

# Ideation: Autonomous Agent Platform

## Codebase Context

**Current state:** TypeScript ESM-only GitHub Action (Node 24). ~145 source files, ~15k LoC across a strict 4-layer architecture: `shared/` → `services/` → `features/` → `harness/`. Bundled via tsdown, `dist/` committed. 19 RFCs document the architecture.

**Key leverage points:**
- Adapter pattern isolates I/O (cache, exec, GitHub API) — clean seams for swapping implementations
- `NormalizedEvent` discriminated union + `routeEvent()` — event normalization that could generalize beyond GitHub
- Session persistence layer (`src/services/session/`) is well-abstracted
- XML-tagged prompt architecture is composable and directive-based
- RFC-019 (S3 backend) already specced with action inputs (`s3-backup`, `s3-bucket`, `aws-region`)
- Compounding wiki (just shipped) + `ce:compound` learnings + session memory = 70% of Karpathy pattern

**Current gaps relative to autonomous agent:**
1. Tightly coupled to GitHub Actions runtime (ephemeral, per-invocation)
2. No event streaming infrastructure (no pub/sub, queue, or event bus)
3. No gateway/API surface (no HTTP server, WebSocket, or Discord)
4. Storage is GitHub Actions cache only (fragile, size-limited, branch-scoped)
5. Single-tenant, single-invocation model (one prompt → one response → die)

**Reference architectures studied:**
- **OpenClaw** — gateway hub-and-spoke, ChannelPlugin interface, multi-level memory, capability registration
- **clawhip** — Rust daemon, source→queue→dispatcher→router→renderer→sink pipeline, multi-delivery routing
- **NanoClaw** — channel factory self-registration, Docker isolation, SQLite
- **Hermes Agent** — self-improving skills, FTS5 search + LLM summarization

## Ranked Ideas

### 1. Agent Platform Core — Gateway + Event Bus
**Description:** Extract a persistent gateway daemon that receives events from GitHub webhooks, Discord, scheduled triggers, and future sources through a unified event bus. GitHub Action becomes a thin relay. Events flow through source → queue → dispatcher → router → renderer → sink pipeline (clawhip pattern). Gateway owns sessions, routing, and orchestration; workers handle execution.
**Rationale:** Every other idea depends on a persistent runtime. The existing `NormalizedEvent` union, `routeEvent()`, adapter pattern, and session persistence are strong foundations — the evolution is adding persistence and generalized ingress, not rebuilding.
**Downsides:** Highest complexity. Requires infrastructure (hosting, persistence, networking). Changes operational model. Risk of over-engineering v1.
**Confidence:** 95%
**Complexity:** High
**Status:** Unexplored

### 2. Durable Object Storage Substrate
**Description:** Implement S3-compatible object storage as the canonical backend for sessions, artifacts, attachments, and cross-runner state. GitHub Actions cache becomes an optional local accelerator. RFC-019 already specced — promote from "backup" to "primary." Any S3-compatible provider works (Cloudflare R2, Backblaze B2, MinIO).
**Rationale:** Prerequisite for everything else: Discord can't use GitHub cache, gateway needs persistent state, memory tiering needs a cold tier. Inputs already exist in `action.yaml`, session layer is adapter-based.
**Downsides:** Infrastructure dependency. Eventual consistency, auth, cost. Migration from cache-only needs careful testing.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 3. Discord as First-Class Interface
**Description:** Add a Discord channel adapter mapping messages, threads, reactions, and slash commands into the normalized interaction model. Discord becomes the rich interactive surface for live sessions, approvals, and oversight. GitHub comments become high-signal projections (audit trail), not the primary workspace.
**Rationale:** User explicitly wants this. Discord is where humans sit — GitHub comments are too narrow for real-time agent interaction. Key insight: the agent's real workspace is the session; it projects summaries to wherever humans watch.
**Downsides:** Discord API complexity (gateway, intents, rate limits). Requires persistent gateway (#1). New operational surface.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 4. Memory Router with Tiered Stores
**Description:** Write-routing layer that directs raw transcripts to short-term storage, distilled facts to long-term memory, and durable patterns to `docs/solutions/` and wiki pages. Hot working set loaded first; cold history fetched on demand. Follows clawhip's memory-offload architecture.
**Rationale:** Makes every future retrieval, planning, and autonomy feature cheaper. Current `searchSessions()` does flat substring matching. The compounding wiki is already the "durable patterns" tier — this connects the pipeline.
**Downsides:** Routing rules hard to get right. Risk of over-classifying or losing raw context.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 5. Self-Improving Skill Distillation
**Description:** Mine successful sessions, tool traces, and `docs/solutions/` to automatically propose prompt refinements, new Systematic skills, and wiki updates. Good runs become training data for the agent's own operating system — Hermes Agent's "self-improving skills" pattern.
**Rationale:** Ultimate compounding lever. Infrastructure is 70% there: `ce:compound` captures learnings, wiki generates docs, session persistence keeps history. Missing piece is the pipeline connecting execution outcomes back into reusable skills.
**Downsides:** Hard to validate automatically. Risk of reinforcing bad patterns. Needs human review gates.
**Confidence:** 75%
**Complexity:** High
**Status:** Unexplored

### 6. Historical Replay and Eval Harness
**Description:** Promote real session histories into replayable fixtures that re-run prompts, routers, and output parsing against past incidents. Measure regressions in retrieval, routing, and review quality before changes ship.
**Rationale:** Every production edge case becomes a permanent test asset. Sessions exist, prompt architecture is deterministic, router is pure. Catches prompt regressions that unit tests can't — like the backslash escaping bug that required artifact analysis.
**Downsides:** Replaying LLM calls is expensive. Deterministic vs stochastic replay strategy needed. Fixture maintenance.
**Confidence:** 70%
**Complexity:** Medium
**Status:** Unexplored

## Sequencing

```
#2 (Storage) → #1 (Gateway) → #3 (Discord)    ← infrastructure spine
#4 (Memory)  → #5 (Distillation)               ← compounds on top
#6 (Replay)                                     ← independent, start anytime
```

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Prebake runner image/tool bundle | Tactical optimization, not transformative. Setup time already mitigated by cache warming. |
| 2 | Multi-tenant identity model | Premature — no gateway exists yet to need multi-tenancy. |
| 3 | Capability registry | Subsumes into gateway architecture. Not standalone. |
| 4 | Durable operator inbox | Low leverage vs gateway/Discord which solves this naturally. |
| 5 | Streaming egress bus (standalone) | Subsumes into event bus in platform core. |
| 6 | Session compaction/summarization | Subsumes into memory router. |
| 7 | Autonomous maintenance loops | Already partially implemented (DMR, wiki). Gateway scheduler subsumes. |
| 8 | Artifact lineage graph | Novel but expensive relative to value at current scale. |
| 9 | Workspace isolation/sandboxing | Important but premature — depends on gateway + storage first. |
| 10 | Transactional write-through persist | Good refactor but tactical — durable storage makes it moot. |

## Session Log
- 2026-04-15: Initial ideation — 39 candidates generated across 5 frames (operator pain, missing capabilities, inversion/automation, assumption-breaking, leverage/compounding), 3 cross-cutting combinations synthesized, 6 survived adversarial filtering
