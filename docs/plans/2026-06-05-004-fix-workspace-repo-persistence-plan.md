---
title: "fix: Persist and rehydrate workspace repos"
type: fix
status: done
date: 2026-06-05
origin: https://github.com/fro-bot/agent/issues/791
---

> **Status: done.** All 4 units shipped: the `workspace-repos` named volume in `deploy/compose.yaml`, the gateway ensure-clone helper, rehydration before mention execution, and the already-bound recovery UX — verified on `main`.

# fix: Persist and rehydrate workspace repos

## Overview

Issue #791 reports that bound Gateway repos lose their workspace checkouts after ordinary workspace container
recreation because `/workspace/repos` is not backed by a persistent Docker volume. S3 bindings survive, so later
mentions run against an empty workspace and `/fro-bot add-project` refuses to recreate the binding.

This plan fixes both sides: persist `/workspace/repos` across deploys, and lazily rehydrate a bound repo before any
mention execution when the checkout is absent.

## Problem Frame

Gateway has two state stores for a bound repo: the S3 binding record and the workspace checkout. The binding is durable;
the checkout is currently container-local. After `docker compose up --force-recreate workspace`, the binding still points
at `/workspace/repos/{owner}/{repo}`, but that path is empty or missing. OpenCode then starts in a directory that does not
contain the repo, producing a successful but useless run.

Fro Bot triage confirmed `deploy/compose.yaml` has no `workspace-repos` volume and proposed a named volume plus README
warning that `docker compose down -v` destroys clones.

## Requirements Trace

- R1. Workspace repo checkouts survive normal workspace container recreation and daemon upgrades.
- R2. Bound mentions never start OpenCode against a missing or empty checkout path.
- R3. A stale binding with a missing checkout self-heals by reusing the existing workspace clone contract.
- R4. Existing `/fro-bot add-project` partial-failure recovery through `repo-exists` remains intact.
- R5. Operators are warned that `docker compose down -v` destroys repo clones.

## Scope Boundaries

- Do not add a new binding schema or S3 migration; the existing binding remains the source of truth.
- Do not add an auto-resync or fetch-on-every-run feature; recovery is clone-or-exists only.
- Do not attempt to protect against `docker compose down -v`; document it as destructive Docker behavior.
- Do not expose internal paths, token/auth failures, or S3 details in Discord replies.

## Context & Research

### Relevant Code and Patterns

- `deploy/compose.yaml` mounts workspace secrets and `mitmproxy-certs`, but not `/workspace/repos`.
- `deploy/validate-stack.sh` already parses compose config for static invariants; extend it for persistence invariants.
- `apps/workspace-agent/src/clone.ts` implements atomic clone and returns `repo-exists` when the target checkout exists.
- `packages/gateway/src/workspace-api/client.ts` validates clone success paths with `workspaceRepoPath(owner, repo)`.
- `packages/gateway/src/discord/commands/add-project.ts` treats `repo-exists` as resumable when clone exists but binding is absent.
- `packages/gateway/src/discord/mentions.ts` currently trusts the binding and only checks workspace readiness before `runMention`.

### Institutional Learnings

- `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md`: add-project flows should be
  idempotent/self-healing across partial failures, and store errors must fail closed.
- `apps/workspace-agent/AGENTS.md`: `POST /clone` is already idempotent at the workspace boundary; `repo-exists` is a valid
  existing-checkout signal.
- `docs/plans/2026-05-23-001-feat-gateway-unit-5-add-project-plan.md`: workspace repo volumes were intended to survive
  container recreation; #791 is a deploy wiring gap, not a new architecture.

### External References

- Skipped. Docker named volume behavior is stable, and the repo already has direct compose/test patterns to follow.

## Key Technical Decisions

- Persist `/workspace/repos` with a named Docker volume: This matches the existing `mitmproxy-certs` pattern and survives
  `up --force-recreate` without binding host paths into the sandbox.
- Rehydrate by calling `POST /clone`, not by adding a separate `exists` endpoint: the workspace agent already owns path
  derivation, atomic clone, per-repo locking, and `repo-exists` semantics.
- Put recovery in the mention path after binding lookup and before `readyz`/`runMention`: this repairs stale bindings before
  OpenCode can start, while `runMention` continues to own visible execution threads, locks, heartbeat, and concurrency.
- Use an injected `ensureWorkspaceClone` seam for mention handling: the helper can own GitHub App auth plus clone semantics,
  while tests avoid live GitHub/workspace calls.
- Treat `repo-exists` as success during rehydration: concurrent recovery or already-present checkouts must not produce false
  user-facing errors.

## Open Questions

### Resolved During Planning

- Should lazy rehydration be in scope? Yes — the user chose to include it with the volume fix.
- Should `/fro-bot add-project` repair an existing binding? No — keep add-project binding-owned; mention execution performs
  lazy checkout repair for already-bound repos.

### Deferred to Implementation

- Exact helper file/function names: choose names that fit local conventions once implementation starts.
- Exact compose parser assertions: extend the existing shell/Python validation in the smallest readable shape.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The
> implementing agent should treat it as context, not code to reproduce.*

```mermaid
flowchart LR
  A[@mention in bound channel] --> B[lookup binding]
  B -->|none| C[reply: use /add-project]
  B -->|binding| D[ensure workspace clone]
  D -->|clone ok or repo-exists| E[check /readyz]
  D -->|auth/clone/network failure| F[reply: workspace unavailable]
  E -->|ready| G[runMention]
  E -->|not ready| H[reply: workspace not reachable]
```

## Implementation Units

- [x] **Unit 1: Persist workspace repos in deploy compose**

**Goal:** Add durable storage for `/workspace/repos` and pin it with static validation.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `deploy/compose.yaml`
- Modify: `deploy/validate-stack.sh`
- Modify: `deploy/validate-stack.test.sh`
- Modify: `deploy/README.md`

**Approach:**
- Add a named `workspace-repos` volume mounted at `/workspace/repos` on the `workspace` service.
- Extend stack validation to assert the workspace service mounts `workspace-repos` at exactly `/workspace/repos`.
- Document that ordinary recreate/upgrade preserves clones, while `docker compose down -v` removes `workspace-repos` and
  `mitmproxy-certs`.

**Execution note:** Add the validation regression before changing compose if practical.

**Patterns to follow:**
- `deploy/compose.yaml` `mitmproxy-certs` named-volume style.
- `deploy/validate-stack.sh` Python compose-config invariant checks.

**Test scenarios:**
- Happy path: real `deploy/compose.yaml` passes topology/persistence validation with `workspace-repos:/workspace/repos`.
- Error path: a crafted compose file without the workspace repo volume fails with a message naming `/workspace/repos`.
- Error path: a crafted compose file mounting the wrong volume or target path fails validation.

**Verification:**
- Static stack validation proves the persistence mount exists without requiring a live Docker stack.
- README clearly distinguishes safe recreate from destructive `down -v`.

- [x] **Unit 2: Add a gateway ensure-clone helper**

**Goal:** Provide a reusable gateway seam that guarantees a workspace checkout exists for a bound repo.

**Requirements:** R2, R3, R4

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/workspace-api/ensure-clone.ts`
- Create: `packages/gateway/src/workspace-api/ensure-clone.test.ts`
- Modify: `packages/gateway/src/workspace-api/client.ts`
- Modify: `packages/gateway/src/workspace-api/types.ts`

**Approach:**
- Build a helper that takes owner/repo, a GitHub App auth dependency, the existing `WorkspaceClient`, and a logger.
- Mint a repo-scoped installation token through the same app-client path used by `/fro-bot add-project`.
- Call `workspaceClient.clone({owner, repo, token})` and return `workspaceRepoPath(owner, repo)` on clone success or
  `clone-error/repo-exists`.
- Return structured failure kinds for auth, timeout/network, clone, response mismatch, and unexpected errors so callers can
  log precisely but reply coarsely.

**Patterns to follow:**
- `packages/gateway/src/discord/commands/add-project.ts` auth + clone handling.
- `packages/gateway/src/workspace-api/client.ts` `workspaceRepoPath()` and `Result` style.

**Test scenarios:**
- Happy path: auth succeeds and clone succeeds -> helper returns the validated workspace path.
- Happy path: auth succeeds and clone returns `repo-exists` -> helper returns `workspaceRepoPath(owner, repo)`.
- Error path: GitHub App auth fails -> helper returns an auth failure and does not call clone.
- Error path: clone timeout/network/HTTP/parse failure -> helper returns a recoverable workspace failure.
- Error path: clone response mismatch -> helper fails closed and does not synthesize a path from the bad response.

**Verification:**
- Helper tests prove rehydration does not duplicate add-project's binding/channel behavior and treats `repo-exists` as
  successful recovery.

- [x] **Unit 3: Rehydrate before mention execution**

**Goal:** Prevent mention runs from reaching OpenCode unless the bound repo checkout exists or was re-created.

**Requirements:** R2, R3

**Dependencies:** Unit 2

**Files:**
- Modify: `packages/gateway/src/discord/mentions.ts`
- Modify: `packages/gateway/src/discord/mentions.test.ts`
- Modify: `packages/gateway/src/program.ts`

**Approach:**
- Add an injected `ensureClone` dependency to `MentionDeps` and wire it in `program.ts` using the helper from Unit 2.
- In `handleMention`, after binding lookup and before `readyz`, call `ensureClone(binding.owner, binding.repo)`.
- Continue to `readyz` and `runMention` only when ensure-clone succeeds.
- On ensure-clone failure, log owner/repo/channel and structured failure kind; reply with a coarse workspace-unavailable
  message using `safeReply`.
- Leave `runMention` unchanged for execution lifecycle ownership.

**Patterns to follow:**
- Existing mention fail-closed readiness gate.
- Existing no-internal-detail Discord replies.

**Test scenarios:**
- Happy path: binding exists, ensure-clone succeeds, readyz succeeds -> `runMention` is called with the original binding.
- Happy path: ensure-clone reports recovered via `repo-exists` -> readyz and `runMention` still proceed.
- Error path: ensure-clone fails -> `runMention` is not called, readyz is not called, and the user sees a coarse retry-later
  message.
- Error path: ensure-clone succeeds but readyz is false -> existing workspace-not-ready reply remains unchanged.
- Edge case: no binding -> ensure-clone is not called.
- Edge case: unauthorized mention -> ensure-clone is not called.
- Integration: two mentions for the same stale repo can both call ensure-clone safely; workspace-agent's per-repo clone lock
  and `repo-exists` semantics make the second heal a no-op.

**Verification:**
- Mention tests prove there is no path from a stale binding directly into `runMention` without clone assurance.

- [x] **Unit 4: Clarify already-bound recovery UX**

**Goal:** Keep `/fro-bot add-project` binding-owned while giving operators a recovery path that does not require deleting S3 keys.

**Requirements:** R3, R4

**Dependencies:** Unit 3

**Files:**
- Modify: `packages/gateway/src/discord/commands/add-project.ts`
- Modify: `packages/gateway/src/discord/commands/add-project.test.ts`
- Modify: `deploy/README.md`

**Approach:**
- Preserve the existing already-bound short-circuit; do not make add-project rebind or delete channels.
- Update the already-bound message to point users to the existing bound channel and state that mentioning Fro Bot there will
  repair a missing checkout if the workspace volume was recreated.
- Remove or soften manual S3 deletion guidance where it is no longer the correct first recovery step for #791.

**Patterns to follow:**
- Existing add-project no-`rm -rf` / no destructive-ops messaging.
- Existing binding-is-source-of-truth behavior.

**Test scenarios:**
- Happy path: already-bound repo replies with the bound channel and no S3 deletion instruction.
- Edge case: existing `repo-exists` partial-failure resume path still creates/binds a channel when no binding exists.
- Error path: binding store failure still fails closed and does not attempt clone or recovery.

**Verification:**
- Add-project remains safe for partial setup recovery and no longer implies manual binding deletion is required for missing
  checkout recovery.

## System-Wide Impact

- **Interaction graph:** Mentions gain an auth/clone recovery step before workspace readiness and execution. Add-project keeps
  its current clone/channel/binding pipeline.
- **Error propagation:** Detailed auth/clone failures stay in logs; Discord receives coarse retry-later copy.
- **State lifecycle risks:** S3 binding remains durable state; Docker named volume becomes durable checkout state. If the
  volume is destroyed, mention-time clone rehydrates it.
- **API surface parity:** The workspace-agent HTTP API can remain unchanged because `/clone` already expresses both create and
  exists states.
- **Integration coverage:** Mention tests should prove stale bindings do not start OpenCode. Stack validation should prove the
  persistence volume exists in rendered compose config.
- **Unchanged invariants:** Workspace has no direct egress; repo clone path remains `/workspace/repos/{owner}/{repo}`;
  Discord replies never expose tokens, raw paths beyond documented operator text, or internal S3 keys.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Mention recovery adds GitHub App auth latency before each run | Reuse existing app-client cache/token path; keep errors coarse and logged. |
| Concurrent stale mentions trigger duplicate clone attempts | Rely on workspace-agent per-repo clone lock and `repo-exists` success semantics. |
| Operators still run `docker compose down -v` | Document it as destructive and rely on lazy rehydration for recovery. |
| Compose validation becomes brittle across Docker Compose output formats | Extend the existing parsed-config validator rather than grepping raw YAML. |

## Documentation / Operational Notes

- `deploy/README.md` should state that normal upgrades/recreates preserve repo checkouts through `workspace-repos`.
- `deploy/README.md` should state that `docker compose down -v` removes cloned repos and mitmproxy CA state.
- Recovery guidance should prefer “mention Fro Bot in the bound channel to rehydrate” over manual S3 binding deletion.

## Sources & References

- Origin issue: https://github.com/fro-bot/agent/issues/791
- Triage comment: https://github.com/fro-bot/agent/issues/791#issuecomment-4634279579
- Related code: `deploy/compose.yaml`
- Related code: `deploy/validate-stack.sh`
- Related code: `apps/workspace-agent/src/clone.ts`
- Related code: `packages/gateway/src/workspace-api/client.ts`
- Related code: `packages/gateway/src/discord/mentions.ts`
- Related code: `packages/gateway/src/discord/commands/add-project.ts`
