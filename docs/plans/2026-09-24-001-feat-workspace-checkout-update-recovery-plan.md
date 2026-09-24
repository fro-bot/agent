---
title: "feat: Keep workspace checkouts current, with operator recovery"
type: feat
status: active
date: 2026-09-24
---

# feat: Keep workspace checkouts current, with operator recovery

## Overview

Before every gateway run (Discord mention or web launch), the workspace brings the repository's checkout up to date with its remote default branch, or refuses the run and says why. Credentials never touch the agent-owned checkout: fetches land in a protected, service-owned bare repository, objects cross into the checkout as a binary pack stream, and the checkout is fast-forwarded only when it is clean, on the default branch, and configured within an allowlist. An operator recovers a refused checkout from Discord with `/fro-bot recover-checkout`, or with the one-click Recover button on the refusal reply — both preserve the whole checkout by same-volume rename and install a fresh one. `/fro-bot checkout-backup` lists and deletes preserved generations. Provenance gains remote-freshness evidence.

This is PR 2 of #1634. PR 1 (#1656) added read-only inspection and the provenance line; #1661 added the uid boundary this plan depends on.

## Problem Frame

The workspace clones a repository once onto a persistent volume and never updates it (#1634). On the documented Compose deployment, every later run executes against the tree as it was on first clone, and the reply gives no sign that the code it reasoned about no longer exists. PR 1 made the starting commit visible; it did not make it current.

A naive `git pull` inside the checkout is wrong twice over. It discards or conflicts with work an agent left behind, and it runs agent-controlled git configuration (`url.*.insteadOf`, `http.proxy`, `credential.*`, `include.path`, and others) in the same process that holds an installation token. Oracle demonstrated on git 2.55.0 that a planted rewrite delivers the token to an allowlisted operator host and, through `NO_PROXY`, to a loopback listener. The egress allowlist is not a credential boundary; the uid split from #1661 is.

## Requirements Trace

- R1. Every gateway run (Discord mention or web launch) passes through preparation, under the repo lock, before `EXECUTING`.
- R2. Preparation advances an eligible checkout to the remote default branch tip, or reports it unchanged, and records remote evidence (branch, SHA, time observed).
- R3. An ineligible checkout — dirty, detached, non-default branch, diverged, unsupported config or layout, path obstruction, initialized submodule, unfinished operation or journal — refuses the run before `EXECUTING`, discards nothing, and names `/fro-bot recover-checkout` in a reply that also carries a Recover button for one-click entry.
- R4. A fetch or authentication failure fails the run closed. It is classified permanent only on positive evidence.
- R5. No credential-bearing git process ever reads configuration from, or runs with a working directory in, an agent-owned checkout.
- R6. An interrupted mutation is never reported as "nothing changed". Restart reconciliation resolves or blocks every journal phase.
- R7. `/fro-bot recover-checkout`, or the Recover button on a refusal reply, preserves the entire checkout and installs a fresh default-branch checkout, gated on a fresh guild-level `ManageChannels` check at invocation (slash command or button click) and again at confirmation, with a 60-second one-shot confirmation.
- R8. Recovery works even when git cannot safely inspect the checkout.
- R9. Retention is capped at 5 generations and 10 GiB per repository, with no automatic eviction. At the cap, recovery refuses before moving anything.
- R10. `/fro-bot checkout-backup list` and a confirmed `delete` of one backup by ID. No export.
- R11. The agent (uid 10001) cannot invoke any workspace control route that mutates or reads protected state.
- R12. Operator contract 1.8.0 carries checked remote evidence on `checkoutProvenance` and a separate optional `checkoutPreparation` for refused or failed attempts.

## Scope Boundaries

- The Action surface (`src/`, `action.yaml`) is untouched. Action runs check out fresh each time.
- `/clone` keeps its semantics and its `409 repo-exists` meaning.
- `/inspect` stays as a standalone diagnostic endpoint.
- No automatic eviction, stash, reset, or discard of any checkout content.
- #1655 (lease takeover while a previous holder is still writing) is not solved. The repo lock gives preparation and recovery the same cooperative exclusion runs already have, and no more.

### Deferred to Separate Tasks

- Backup export (a bounded, expiring object-store copy): follow-up once list/delete ships.
- #1663, the workspace has no init to reap orphaned processes: its own PR.
- Logging handoff entry counts and elapsed time from `/clone`: follow-up; needs a logger passed into `clone.ts`.
- Operator web surface actions for recovery: the web surface only displays the new contract fields in this plan.

## Context & Research

### Relevant Code and Patterns

- `apps/workspace-agent/src/server.ts` — Hono routes; `/clone` and `/inspect` show body-size guarding, JSON parsing, and `sanitizeOwner`/`sanitizeRepo`. There is **no authentication** on port 9100, and it binds `0.0.0.0` (`main.ts:31-32`), so uid 10001 reaches it over loopback today.
- `apps/workspace-agent/src/clone.ts` — sealed clone environment (`buildCloneGitEnv`), exact-prompt askpass helper, staging under `.workspace-agent/staging`, `handOffToAgent`, rename publication, and the private per-repo mutex `withRepoLock`. The mutex is clone-only today.
- `apps/workspace-agent/src/git-safety.ts` — `gitInvocation`, `buildNeutralGitEnv`, and `runGit`. `runGit` is `execFile`-based and buffers UTF-8; it cannot carry a binary stream between two subprocesses.
- `apps/workspace-agent/src/inspect.ts` — filter-driver enumeration, `--no-optional-locks`, operation detection, and real-git test fixtures in `inspect.test.ts`.
- `apps/workspace-agent/src/handoff.ts`, `identity.ts` — ownership handoff and the uid/path constants.
- `packages/gateway/src/execute/run.ts` (`executeWorkOnHeldSlot`) — the seam where `ensureClone → inspect → classifyInspectResult` runs under the lock and persists `CheckoutProvenance` with the `EXECUTING` transition. `PERMANENT_CLONE_ERROR_CODES` and the `workspace-unavailable` / `checkout-substituted` failure kinds and their replies live here.
- `packages/gateway/src/execute/provenance.ts` — `CheckoutProvenance`, `formatProvenanceLine`, `formatProvenanceForPrompt`.
- `packages/gateway/src/workspace-api/client.ts` — clone (300s), inspect (25s), readyz (5s), `CLONE_ERROR_CODES`.
- `packages/gateway/src/operator-contract/{provenance,run-status,version}.ts` — the 1.6.0 → 1.7.0 bump is the pattern for an additive field.
- `packages/gateway/src/discord/commands/fro-bot.ts`, `guild-command.ts` — `makeGuildCommand` pipeline; `force-release-lock` does the fresh `ManageChannels` fetch.
- `packages/gateway/src/discord/approvals.ts`, `program.ts`, `approvals/registry.ts` — namespaced button custom IDs, click routing, deadline ownership.
- `packages/gateway/src/runtime-effect.ts` — every new runtime coordination call is wrapped here first.
- `scripts/checkout-types-drift-guard.test.ts` — two-way assignability guard for types duplicated between the workspace-agent and the gateway.
- `deploy/tests/isolation-harness.sh` — real-container adversarial harness in the `workspace-smoke` job. `deploy/workspace.Dockerfile` installs `git` from apk **unpinned**.
- `deploy/scripts/migrate-repo-ownership.mjs` — treats every top-level entry except `.workspace-agent` as an owner directory. New protected state must live under `.workspace-agent/`.

### Institutional Learnings

- `docs/solutions/best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md` — ordering is not a boundary; the protected bare repo, the checkout, and recovery need explicit identity and path boundaries.
- `docs/solutions/logic-errors/fail-closed-against-an-unchecked-default-2026-09-19.md` — test the refusal gate against the real default state, including a never-cloned repo and a freshly cloned one.
- `docs/solutions/workflow-issues/verify-behavior-not-signal-2026-08-23.md` and `.../a-check-written-from-inside-its-own-premise-cannot-fail-2026-09-04.md` — assert the checkout actually moved, the sentinel outside the tree actually did not change, and the hook actually did not run; every exploit test carries a positive control.
- `docs/solutions/workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md` — fallible preflight, destructive mutation, and cleanup are separate lifecycle slots.
- `docs/solutions/logic-errors/repair-before-capture-sqlite-session-cache-loop-2026-09-02.md` — reconcile journals before acting on state, or a transient failure becomes permanent.
- `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md` — test the real registration and dispatch path, not only the handler.
- `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` — approval semantics differ by surface; do not port auto-deny behavior onto a surface with a human approver.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "apps/workspace-agent, packages/gateway/src, src/services/setup, packages/harness, deploy/tests",
  "freshness": {
    "vcs_reference": "main@28b6c9325"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "apps/workspace-agent/src/clone.ts::executeClone",
      "description": "Fresh clone into root-owned staging with sealed git environment, handoff to the agent uid, and rename publication.",
      "disposition": "extend",
      "insufficiency_reason": "Fresh clones only; its sealed environment, askpass helper, staging, handoff, and mutex are reused, but it cannot update an existing checkout."
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/inspect.ts::inspectCheckout",
      "description": "Read-only checkout observation with operation detection and filter neutralization.",
      "disposition": "extend",
      "insufficiency_reason": "Observes only; its checks are reused as part of eligibility."
    },
    {
      "path_or_symbol": "apps/workspace-agent/src/git-safety.ts::runGit",
      "description": "Neutralized, uid-dropped, UTF-8-buffered git runner with confirmed termination.",
      "disposition": "insufficient",
      "insufficiency_reason": "Cannot stream binary data between two subprocesses; pack transfer needs a new streaming runner."
    },
    {
      "path_or_symbol": "packages/gateway/src/execute/run.ts::executeWorkOnHeldSlot",
      "description": "Locked ensureClone, inspect, provenance, EXECUTING sequence.",
      "disposition": "extend",
      "insufficiency_reason": "Admission and provenance only; the preparation step replaces its inspect call."
    },
    {
      "path_or_symbol": "packages/gateway/src/discord/commands/fro-bot.ts::force-release-lock",
      "description": "ManageChannels-gated maintenance command through makeGuildCommand.",
      "disposition": "extend",
      "insufficiency_reason": "Authorization pattern reused; no confirmation step or checkout preservation exists."
    },
    {
      "path_or_symbol": "packages/gateway/src/operator-contract/provenance.ts::OperatorCheckoutProvenance",
      "description": "Wire DTO with explicit remote: not-checked.",
      "disposition": "extend",
      "insufficiency_reason": "Gains a checked remote variant; no preparation-attempt record exists."
    },
    {
      "path_or_symbol": "deploy/tests/isolation-harness.sh",
      "description": "Real-container adversarial harness in CI.",
      "disposition": "extend",
      "insufficiency_reason": "Verification host for the new real-git suite; no update or recovery coverage."
    }
  ],
  "excluded_scopes": [
    {
      "scope": "src/harness/phases",
      "reason": "Action runs check out fresh each invocation; session persistence is unrelated to checkout freshness."
    },
    {
      "scope": "packages/runtime/src",
      "reason": "Lock and run-state primitives are reached through the gateway's runtime-effect wrappers already surveyed."
    }
  ]
}
```

## Key Technical Decisions

- **Authenticate the 9100 control API with the existing gateway-to-workspace bearer.** Port 9100 has no authentication and uid 10001 reaches it over loopback. Once recovery and backup deletion exist, the agent could quarantine or destroy preserved work. Every route except `/healthz` and `/readyz` requires `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>`, the root-only secret the gateway already holds for 9200. Reusing it avoids a new secret: the gateway already holds the bearer, it is root-only in the workspace, the proxy strips `Authorization` before forwarding to OpenCode, and a dedicated secret would need a rollout to every deployment for little added blast-radius protection. The accepted tradeoff is that one secret now guards both surfaces, and the gateway and workspace images must roll back together, since an old gateway sends no bearer to a new workspace. Comparison is constant-time.
- **Credentials only in a protected bare repository.** Each repository gets a root-owned bare repo at `/workspace/repos/.workspace-agent/fetch/<owner>__<repo>.git`, created lazily with an empty template on first update. Fetches run as root with the hermetic network profile and a working directory inside the service's home. The migration never walks `.workspace-agent`, and uid 10001 cannot traverse it.
- **Objects cross as a pack stream, never by local fetch or alternates.** A local fetch still takes a URL that a rewrite can redirect; alternates tie the checkout to the protected store. On the update path, `pack-objects --stdout` runs as root against the bare repo and pipes into `index-pack --stdin --strict` running as uid 10001 in the checkout's `.git`; recovery differs (below). The first cut sends the complete, non-thin closure of the target for auditability over bandwidth.
- **Admission requires a closed configuration profile, not a sanitized one.** The checkout's `.git/config` is inventoried with `--no-includes` and must contain only allowlisted ordinary-clone keys. Includes, filters, HTTP settings, URL rewrites, executable settings, extensions, and sparse settings refuse the run. So do alternates, grafts, shallow or partial clones, linked worktrees, metadata symlinks, and unsupported index flags. Local git additionally runs with hooks, fsmonitor, attributes file, sparse checkout, and submodule recursion forced off, and with no transport allowed.
- **Cleanliness is measured against a fresh index built from HEAD.** The agent can edit the real index, including stat data and assume-unchanged or skip-worktree bits. A temporary index read from HEAD, compared against the working tree, is what decides "clean".
- **Fast-forward with `--no-overwrite-ignore`, after a path-obstruction preflight.** `merge --ff-only` alone overwrites ignored files that obstruct incoming paths. Preflight compares both trees against the filesystem in both prefix directions (`a` versus `a/b`) and refuses on any obstruction or symlink ancestor.
- **Refuse without fetching when the local state is already ineligible.** No token is minted or spent to confirm a dirty tree is dirty.
- **Preparation's threat model stops at the credential and root-service boundary; it does not protect the checkout from its own agent.** A leftover uid-10001 process can change `.git` between checks, and the worst outcome is code running as uid 10001 — which that process could already do. Mitigation: immediately before the merge, preparation re-runs the config inventory and filter-driver enumeration; after the merge, it verifies HEAD equals T and the working tree is clean against a temporary index built from T.
- **One per-repo operation mutex in the workspace shared by clone, update, recover, and backup delete.** Extracted from `clone.ts`. The workspace is a single container (a documented precondition of the #1661 migration), so an in-process mutex plus the gateway's repo lock is sufficient. `deploy/validate-stack.sh` refuses a `workspace` service declaring `deploy.replicas` greater than 1, making the assumption explicit rather than just documented. A workspace restart kills any in-flight git process along with the container; startup journal reconciliation (the table above) covers the aftermath.
- **Journals live under `.workspace-agent/journals/`, root-owned, written by temp-file-and-rename.** Never inside `.git/`, where the agent could forge one. Every update and recovery operation is reconciled on service start and again at the top of each operation, before anything else.
- **Mutation is never cancelled by a client disconnect.** A gateway timeout may abort the HTTP call only before the mutation phase starts; once the journal records `applying`, the workspace runs the mutation to completion or confirmed termination regardless of the disconnect, then clears the journal. The gateway reports a timeout as "checkout state not known"; the next preparation waits on the mutex and reads the fresh result, which is `ready` unless the workspace process itself died mid-merge, in which case the journal stays at `applying` and the checkout needs recovery.
- **Deadlines:** 90 seconds on the workspace (15 local, 45 network including one retry, 25 apply, 5 termination), 100 seconds on the gateway HTTP call, further bounded by the run's remaining budget. Unconfirmed subprocess termination keeps the mutex held and the repo reported as under maintenance.
- **Recovery preserves the whole directory by rename.** Stash or commit would run git in the distrusted checkout and would not capture ignored files, local refs, or operation metadata. Quarantine lives at `.workspace-agent/quarantine/<owner>__<repo>/<recovery-id>/` on the same volume.
- **The recovery preview is stateless — no server-side operation ID.** `POST /recover/preview` returns a `fingerprint`: a digest of the HEAD SHA (or its absence), the dirty counts, and the checkout's total size and entry count (size and entry count only, when inspection wasn't safe). `POST /recover` recomputes the fingerprint under the mutex and refuses with `checkout-changed` if it differs from what the operator saw. The gateway's in-memory one-shot nonce on the confirm button is unrelated: it binds a Discord click to a message, not a workspace operation.
- **Pack-import ownership differs by path.** A routine update pipes `pack-objects --stdout` (root, against the bare repo) into `index-pack --stdin --strict` (uid 10001, in the agent's checkout) — see "Objects cross as a pack stream" above. Recovery's fresh checkout is never touched by uid 10001 until it's ready: the whole bootstrap runs as root, in root-owned staging, in a fresh repo whose config the service wrote — `git init` with an empty template, pack import, `read-tree --reset -u <T>`, `update-ref`, `symbolic-ref HEAD`, then the canonical origin config. Then `handOffToAgent`, then rename. This order was verified on git 2.55.0 to produce a clean checkout. `read-tree --reset` never runs against an agent-owned checkout.
- **The preparation result is a discriminated union, not flags.** `ready` (unchanged or fast-forward, with checked remote evidence), `refused` (a reason, no mutation), and `failed` (a reason, plus whether mutation had started). A `ready` result cannot carry an unchecked remote.
- **`checkoutProvenance` keeps meaning "the starting state of a run that reached EXECUTING".** Refused and failed attempts go in a separate `checkoutPreparation` field, persisted with the failure.
- **Pin git's behaviour, not its package.** The harness asserts the image's git version and the fixture suite runs inside the image, so an apk bump that changes behaviour fails CI rather than production.

## Open Questions

### Resolved During Planning

- Ineligible checkout: refuse the run and point to recovery (decided).
- Fetch or auth failure: fail closed (decided).
- Recovery ships in this PR; backup commands are list and confirmed delete; export is deferred (decided).
- Journal location: `.workspace-agent/journals/`, not inside the checkout.
- Recovery while a run holds the lock: recovery refuses immediately with a named reason; it does not wait.
- Recovery with no checkout: skips quarantine and installs a fresh checkout.
- Upstream default-branch rename: refuses as non-default branch; recovery installs the new default.
- Gateway restart during a pending confirmation: the confirm button reports the request is no longer active; nothing persists across restarts. The refusal reply's entry button is unaffected — it carries no server-side state and still works after a restart.
- Backup delete takes one ID; there is no bulk delete.
- Binding changes between lock and preparation: bindings carry no branch; preparation re-resolves the binding under the lock exactly as the run path does today.

### Deferred to Implementation

- Exact allowlist of `.git/config` keys produced by the image's `git clone` — derive it from a real fresh clone inside the image in the fixture suite, not from documentation.
- Whether `index-pack` needs `--fix-thin` absent thin packs, and exact `pack-objects` flags — settled by the first fixture test.
- How the pack stream reports progress for very large repositories within the 25-second apply budget — measure in the suite, then tune the budget or split fetch from apply.
- Disk-space preflight margin for recovery — start at twice the estimated checkout size, adjust from measurement.
- Whether the 45-second network budget holds for the first update after the upgrade on the largest bound repositories — measure it before trusting the number.

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```mermaid
sequenceDiagram
    participant G as Gateway (run path, repo lock held)
    participant W as Workspace service (root)
    participant B as Bare repo (root, .workspace-agent/fetch)
    participant C as Checkout (uid 10001)
    G->>W: POST /update (bearer, owner, repo, token, deadline)
    W->>W: reconcile journals, take repo mutex
    alt no checkout, no journal
        W->>W: /clone path (existing)
    end
    W->>C: eligibility as uid 10001 (layout, config inventory, temp-index status)
    alt ineligible
        W-->>G: refused(reason), no fetch
    end
    W->>B: ls-remote --symref, fetch default branch (root, hermetic network profile)
    W->>B: ancestry H..T, trees for obstruction preflight
    alt diverged or obstructed
        W-->>G: refused(reason)
    end
    W->>W: write journal (phase: applying)
    B-->>C: pack-objects --stdout (root) | index-pack --stdin --strict (uid 10001)
    W->>C: merge --ff-only --no-overwrite-ignore (uid 10001, local profile)
    W->>W: verify HEAD == T, clean; clear journal
    W-->>G: ready(fast-forward | unchanged, remote evidence)
    G->>G: persist provenance with EXECUTING, or FAILED with checkoutPreparation
```

| Journal phase | Crash leaves | Reconciliation |
| --- | --- | --- |
| update: `fetched` (before apply) | Checkout untouched at H | Delete journal; next preparation starts over |
| update: `applying` | Checkout at H, T, or partly applied | Checkout marked needs-recovery; runs refuse until `/fro-bot recover-checkout` |
| update: `applied` (before clear) | Checkout at T | Verify HEAD == T and clean, then delete journal; otherwise needs-recovery |
| recovery: `building` | Original untouched, staging partial | Remove staging, delete journal |
| recovery: `quarantining` | Original at checkout path or in quarantine | If still at checkout path, rename to quarantine; continue |
| recovery: `installing` | Checkout path empty, staging complete | Rename staging into place; continue |
| recovery: `verifying` | Fresh checkout installed | Verify, record generation, delete journal |

A recovery journal is never resolved by deleting the quarantined original or by cloning into the empty path; `/clone` and `/update` both reconcile journals before acting.

## Phased Delivery

- PR A ships Unit 1 alone: control-API authentication for the workspace, as its own standalone PR.
- PR B ships Units 2–9, and depends on PR A being merged first.
- PR B must never ship the refusal gate (Unit 7) without recovery (Unit 8) available at the same time; Units 7 and 8 land together in PR B.

## Implementation Units

### Phase A — Foundations

- [ ] **Unit 1: Authenticate the workspace control API (ships as a standalone PR — PR A — before the rest of this plan)**

**Goal:** Only the gateway can call workspace control routes. See Phased Delivery.

**Requirements:** R11

**Dependencies:** None

**Files:**

- Modify: `apps/workspace-agent/src/server.ts`, `apps/workspace-agent/src/main.ts`
- Modify: `packages/gateway/src/workspace-api/client.ts`
- Modify: `apps/workspace-agent/AGENTS.md` (route list is stale; add the auth invariant)
- Modify: `deploy/tests/isolation-harness.sh`
- Test: `apps/workspace-agent/src/server.test.ts`, `packages/gateway/src/workspace-api/client.test.ts`

**Approach:**

- Middleware on every route except `/healthz` and `/readyz` requires the bearer read once at startup from the same secret the proxy uses. Missing or wrong bearer gets 401 before body parsing. Constant-time comparison.
- The gateway client sends the bearer it already holds for 9200 on every control call.
- This lands before any new route, so existing `/clone` and `/inspect` gain it too.

**Patterns to follow:** bearer validation in `apps/workspace-agent/src/opencode-proxy.ts`.

**Test scenarios:**

- Happy path: `/clone` and `/inspect` with the correct bearer behave exactly as today.
- Error path: no header, wrong scheme, wrong token, and a token differing only in the last byte all return 401 and never reach body parsing or git.
- Edge case: `/healthz` and `/readyz` answer without a bearer, so the compose healthcheck keeps working.
- Integration (harness): as uid 10001 inside the container, `POST /inspect` without the bearer is refused; as root with the bearer it succeeds. The agent cannot read the bearer (existing denial checks).

**Verification:** No control route answers an unauthenticated request; the gateway's calls still succeed end to end in the harness.

- [ ] **Unit 2: Adversarial real-git fixture suite in the workspace image**

**Goal:** Prove, inside the shipped image, which git behaviours the design relies on and which attacks it must block, before the endpoint exists.

**Requirements:** R5, R6

**Dependencies:** None (runs in parallel with Unit 1)

**Files:**

- Create: `apps/workspace-agent/src/update.fixtures.test.ts` (real git, skipped outside the image unless forced)
- Modify: `deploy/tests/isolation-harness.sh` (run the suite inside the image; assert git version)
- Modify: `.github/workflows/ci.yaml` only if the smoke job needs a new step (ask before changing CI)

**Approach:**

- Every exploit test pairs with an unprotected positive control that shows the fixture really triggers the behaviour.
- The suite exercises the primitives Unit 3 will provide, written first so Unit 3 is built to pass them.

**Execution note:** Test-first. These tests define Unit 3 and Unit 4's contract.

**Test scenarios:**

- Transport: a planted `url.*.insteadOf`, `http.proxy`, `http.<url>.proxy`, `http.extraHeader`, `http.sslVerify=false`, `http.sslCAInfo`, `http.cookieFile`, `credential.helper`, `core.askPass`, `core.sshCommand`, `protocol.ext.allow`, `include.path`, and `includeIf` in the checkout's config never influence the protected fetch; a loopback listener challenging for auth receives nothing. Each has a control where the same config, used naively, does reach the listener.
- Pack import: `pack-objects --stdout | index-pack --stdin --strict` stores the target closure with all transports disabled and a hostile rewrite configured; no alternates file appears; no credential material appears in the checkout.
- Filters: clean, smudge, process, and `required` drivers, including names with dots and `=`, from local config, includes, info attributes, and incoming `.gitattributes`, never execute during eligibility or merge (sentinel file never created); controls show they would.
- Hooks: `post-merge`, `reference-transaction`, and `post-checkout` never run; `core.fsmonitor` never runs.
- Collisions: untracked and ignored files and directories obstructing incoming paths, exact and prefix conflicts, identical-content obstruction, symlink-to-directory transitions — each refused by preflight; a sentinel outside the tree is unchanged; `--no-overwrite-ignore` refuses an ignored obstruction that plain `--ff-only` overwrites (control).
- Hidden dirty state: assume-unchanged, skip-worktree, sparse and split index, a manipulated stat cache, and `status.showUntrackedFiles=no` — the temp-index comparison still reports dirty.
- Metadata attacks: `core.worktree`, a gitfile, a symlinked `.git` or `.git/config`, alternates, replace refs, grafts, shallow, partial clone — each refused by layout checks.
- Policy: equal, behind, ahead, diverged, detached, non-default branch, remote moved between observations, initialized submodule.
- Config profile: the key set of a fresh clone made by the image's own `git clone` passes the allowlist; adding any single disallowed key refuses.
- Version: the image's git version is asserted and logged.

**Verification:** The suite passes in the `workspace-smoke` job, and every exploit test's control fails the way it should when the protection is removed.

- [ ] **Unit 3: Git primitives, mutex, and journal store**

**Goal:** The building blocks update and recovery share.

**Requirements:** R5, R6

**Dependencies:** Unit 2 (tests to pass)

**Files:**

- Modify: `apps/workspace-agent/src/git-safety.ts` (network and local profile builders)
- Create: `apps/workspace-agent/src/git-stream.ts` (two-process binary pipe with confirmed termination)
- Create: `apps/workspace-agent/src/checkout-profile.ts` (layout checks, config inventory, temp-index cleanliness, obstruction preflight)
- Create: `apps/workspace-agent/src/repo-mutex.ts` (extracted from `clone.ts`)
- Create: `apps/workspace-agent/src/journal.ts`
- Modify: `apps/workspace-agent/src/clone.ts` (use the shared mutex; reconcile journals first)
- Modify: `apps/workspace-agent/src/identity.ts` (fetch, journal, quarantine directory names)
- Test: `apps/workspace-agent/src/git-stream.test.ts`, `checkout-profile.test.ts`, `repo-mutex.test.ts`, `journal.test.ts`

**Approach:**

- The network profile runs as root with a fresh environment: sealed system and global config, `GIT_ALLOW_PROTOCOL=https`, no terminal prompt, the existing askpass helper, the trusted CA bundle, deployment proxy settings only, redirects off, TLS verification on, hooks off, credential helpers cleared, cwd in the service home, `--git-dir` pointing at the bare repo.
- The local profile runs as uid 10001 with an exact `safe.directory`, no credentials, askpass, or proxy, an empty transport allowlist, replace objects and lazy fetch disabled, and hooks, fsmonitor, attributes file, sparse checkout, and submodule recursion forced off.
- The stream runner spawns both processes in their own process groups, pipes stdout to stdin as bytes with backpressure, bounds total bytes and time, and reports `ok`, `failed`, `timeout`, or `termination-unconfirmed` for the pair.
- The journal store writes temp-then-rename under `.workspace-agent/journals/`, validates on read, and refuses to operate on a malformed journal.
- The mutex serializes clone, update, recover, and backup delete per repository.

**Patterns to follow:** `runGit` termination handling in `git-safety.ts`; `buildCloneGitEnv`; `ensure-protected-dir.mjs` for protected directory creation.

**Test scenarios:**

- Happy path: a 50 MB pack streams intact; hashes match.
- Error path: the reader exits early — the writer is terminated and both are reported; a subprocess that ignores SIGTERM is killed; a grandchild that holds the pipe yields `termination-unconfirmed`, never `timeout`.
- Edge case: zero-byte stream; byte cap exceeded mid-stream fails and terminates both.
- Journal: a crash between temp write and rename leaves the previous journal readable; a truncated or foreign-schema journal is refused, not treated as absent.
- Mutex: clone and update on the same repo serialize; different repos run concurrently; a rejected operation releases the mutex.
- Profile: allowlisted fresh-clone config passes; each disallowed key refuses with its key named.

**Verification:** Unit 2's suite passes against these primitives; unit tests pass; `clone.ts` behaviour is unchanged apart from sharing the mutex.

### Phase B — Workspace endpoints

- [ ] **Unit 4: `POST /update`**

**Goal:** Bring an eligible checkout up to date, or refuse or fail with a precise reason.

**Requirements:** R1–R6

**Dependencies:** Units 1, 3

**Files:**

- Create: `apps/workspace-agent/src/update.ts`
- Modify: `apps/workspace-agent/src/server.ts`, `apps/workspace-agent/src/types.ts`, `apps/workspace-agent/src/main.ts` (journal reconciliation at startup)
- Test: `apps/workspace-agent/src/update.test.ts`, `apps/workspace-agent/src/server.test.ts`

**Approach:**

- Order: reconcile journals, take the mutex, canonical-path containment (as `inspect.ts`), layout and config checks, operation state, temp-index cleanliness, submodules. Refuse here without any network call.
- Then create the bare repo if absent, `ls-remote --symref HEAD`, fetch the default branch into a unique ref, re-observe; retry the pair once inside the network budget, else fail as remote-moved.
- Require the local branch to equal the default branch, then ancestry from the bare repo's objects; H equal to T returns `ready/unchanged`.
- Obstruction preflight, journal `applying`, pack stream, re-check admission, fast-forward, verify, journal `applied`, clear.
- Result is the `ready | refused | failed` union with remote evidence; `failed` records whether mutation started.
- Missing checkout with no journal returns a distinct `no-checkout` so the gateway clones first.

**Test scenarios:**

- Happy path: behind by N commits advances to T and reports `fast-forward` with `fromSha` H; equal reports `unchanged`; both carry branch, SHA, and `checkedAt`.
- Refusals: each refusal reason from R3 returns `refused` with no network call made (assert the network profile was never spawned).
- Fetch failures: auth challenge rejected, host unreachable, and rate limit each return `failed` with mutation not started; only an explicit not-found or forbidden from GitHub is marked permanent.
- Interruption: killing the apply step after the journal is written leaves `applying`; the next `/update` refuses with needs-recovery and does not fetch.
- Crash after apply: journal `applied` with HEAD at T is reconciled to `ready`.
- Deadline: a hung fetch fails within the network budget; a hung apply runs to confirmed termination and reports `failed` with mutation possibly incomplete.
- Default configuration: a checkout freshly produced by `/clone` is eligible and returns `unchanged` (fail-closed-against-default check).
- Disconnect: a client abort before `applying` stops work; after `applying` the mutation completes.

**Verification:** Real-git tests pass in the image; a stale fixture checkout advances; no exploit fixture from Unit 2 regresses.

- [ ] **Unit 5: Recovery and backup endpoints**

**Goal:** Preserve-and-replace, plus list and delete of preserved generations.

**Requirements:** R6–R10

**Dependencies:** Units 3, 4

**Files:**

- Create: `apps/workspace-agent/src/recover.ts`, `apps/workspace-agent/src/backups.ts`
- Modify: `apps/workspace-agent/src/server.ts`, `apps/workspace-agent/src/types.ts`
- Test: `apps/workspace-agent/src/recover.test.ts`, `apps/workspace-agent/src/backups.test.ts`

**Approach:**

- `POST /recover/preview` returns HEAD, branch, dirty counts, operation in progress, ignored count, estimated size, retention usage, whether inspection was safe, and a `fingerprint`: a digest of the HEAD SHA (or its absence), the dirty counts, and the checkout's total size and entry count. When inspection was not safe, it returns an opaque preview with size and entry count only, and the fingerprint uses only those two values.
- `POST /recover` takes the fingerprint the operator saw, recomputes it under the mutex, and refuses with `checkout-changed` if it differs. It then checks quota (5 generations, 10 GiB) and free space, then builds the fresh checkout entirely as root in root-owned staging — pack import, `read-tree --reset -u`, ref setup, canonical origin config (see Key Technical Decisions) — hands it off, and runs the journaled quarantine and install renames. Neither call carries a server-side operation ID; the preview is stateless.
- No checkout: skip quarantine. A journal in progress for the repository: refuse with its phase.
- `GET /backups` lists generations with ID, time, size, original HEAD and branch. `DELETE /backups/:id` removes one generation after validating the ID is a direct child of that repository's quarantine directory.

**Test scenarios:**

- Happy path: a dirty checkout with untracked, ignored, and local-commit content is preserved byte for byte in quarantine, including `.git`; the installed checkout is clean on the default branch, agent-owned, and passes `/update` as `unchanged`.
- Opaque preview: a checkout with a hostile config still previews and recovers without running git in it.
- Fingerprint: the checkout changes between preview and confirm — a new commit lands, or a file is touched — so `/recover` refuses with `checkout-changed` and moves nothing.
- Quota: at 5 generations or over 10 GiB, recovery refuses before any rename, and nothing moves.
- Disk: insufficient space refuses before building.
- Crash at each recovery phase is reconciled per the journal table; at no phase is the original deleted or the path left empty after reconciliation.
- Backup delete: a valid ID removes exactly that generation; `..`, an absolute path, a symlinked generation, and another repository's ID are refused.
- Concurrency: recover and update on the same repository serialize; a second recover during the first is refused.

**Verification:** Real-git tests pass; crash-injection tests pass at every phase boundary.

### Phase C — Gateway

- [ ] **Unit 6: Types, client, provenance, and operator contract 1.8.0**

**Goal:** Carry the preparation result through the gateway and to operators.

**Requirements:** R2, R12

**Dependencies:** Units 4, 5 (response shapes)

**Files:**

- Modify: `packages/gateway/src/workspace-api/{types,client}.ts`
- Modify: `packages/gateway/src/execute/provenance.ts`
- Modify: `packages/gateway/src/operator-contract/{provenance,run-status,version}.ts`
- Modify: `scripts/checkout-types-drift-guard.test.ts`
- Test: `packages/gateway/src/workspace-api/client.test.ts`, `packages/gateway/src/execute/provenance.test.ts`, `packages/gateway/src/operator-contract/*.test.ts`

**Approach:**

- Mirror the workspace result types; extend the drift guard to cover them.
- Client methods for update (100-second ceiling, bounded by a caller deadline), recover preview, recover, and backups.
- `RemoteFreshness` gains `checked` with default branch, SHA, and `checkedAt`; the provenance line and prompt block report unchanged or fast-forward and the observation time.
- Contract 1.8.0: `checkoutProvenance.remote` may be `checked`; new optional `checkoutPreparation` for refused and failed attempts. Field-by-field parsing; malformed data projects to absent. Redaction runs before projection as today.

**Test scenarios:**

- Round trip: every result variant survives persist and parse unchanged.
- Parser: a `ready` with an unchecked remote, a fast-forward whose `fromSha` equals its SHA, and a missing reason are each rejected.
- Old data: 1.7.0-shaped provenance still parses and projects.
- Reply text: unchanged and advanced lines render the exact wording; branch names are escaped as today.
- Drift guard: adding a field to one side only fails `check-types`.

**Verification:** Types, drift guard, and contract tests pass; the contract version reads 1.8.0.

- [ ] **Unit 7: Preparation in the run path**

**Goal:** Replace `ensureClone → inspect` with preparation, and report every outcome.

**Requirements:** R1–R4, R6

**Dependencies:** Unit 6

**Files:**

- Modify: `packages/gateway/src/execute/run.ts`
- Modify: `packages/gateway/src/runtime-effect.ts` if new runtime calls are needed
- Test: `packages/gateway/src/execute/run.provenance.test.ts` and the relevant split `run.*.test.ts` files

**Approach:**

- Under the lock and heartbeat: call `/update`; on `no-checkout`, clone then update; `ready` persists provenance with `EXECUTING`; `refused` and `failed` transition to FAILED with `checkoutPreparation` and a reply.
- Refusal replies say what is wrong, that nothing was discarded, and name `/fro-bot recover-checkout`; they carry the Recover button described in R3/R7 so an operator can act in one click. Transient failures say to retry; positive-evidence access failures say to repair repository access. A timed-out call says the checkout state is not known and the next run will check it.
- The HTTP deadline is the lesser of 100 seconds and the run's remaining budget.
- A refused run never builds or sends a prompt.
- A gateway timeout during `/update`'s apply phase heals itself: the workspace finishes the mutation and clears its journal regardless of the disconnect, and the next preparation on that repo returns `ready`. Only a workspace process dying mid-merge leaves the journal at `applying`, which needs recovery.

**Reply text:**

Every refusal reply follows the same shape: what's wrong, that nothing was discarded, and a pointer to `/fro-bot recover-checkout` plus the Recover button. The table gives the first clause; append "Nothing was discarded. Use the button below, or run `/fro-bot recover-checkout`, to preserve this checkout and install a fresh one." to every refusal row.

| Outcome | Reply text |
| --- | --- |
| ready — unchanged | Provenance line only: the checkout is already at `<sha>` (branch `<branch>`), checked `<checkedAt>`. |
| ready — fast-forward | Provenance line only: the checkout advanced from `<fromSha>` to `<sha>` (branch `<branch>`), checked `<checkedAt>`. |
| refused — dirty | The checkout has uncommitted or untracked changes, so I can't update it safely. |
| refused — detached HEAD | The checkout isn't on a branch, so I can't update it safely. |
| refused — non-default branch | The checkout is on `<branch>`, not the repository's default branch, so I can't update it safely. |
| refused — diverged | The checkout has local commits the remote doesn't have, so a fast-forward isn't possible. |
| refused — unsupported config or layout | The checkout's git configuration or layout isn't one I can update safely. |
| refused — path obstruction | An incoming file or directory would overwrite something already in the checkout, so I can't update it safely. |
| refused — initialized submodule | The checkout has an initialized submodule, which I don't support updating. |
| refused — unfinished git operation | The checkout has a git operation in progress (merge, rebase, or similar), so I can't update it safely. |
| refused — needs recovery (interrupted update) | A previous update to this checkout was interrupted and needs recovery before I can run here. |
| failed — transient fetch failure | I couldn't reach the repository's remote right now. This is usually temporary — try again shortly. |
| failed — permanent access failure | I don't have access to this repository's remote anymore. Check that the GitHub App still has access, then try again. |
| failed — timeout, state unknown | The update didn't finish within its time budget, and I can't tell whether the checkout changed. The next run will check its state before doing anything. |

**Test scenarios:**

- Each outcome variant maps to the expected phase, failure kind, persisted record, and exact reply text.
- A refused run creates no OpenCode session (assert on the session client).
- A refused run's reply carries a working Recover button.
- A gateway timeout produces the state-unknown reply and releases the lock with the renewed etag.
- A gateway call that times out during `/update`'s apply phase heals itself: the workspace finishes the mutation and clears the journal, and the next preparation on that repo returns `ready`.
- The lock is held across clone-then-update; a clone failure still releases correctly.
- Web launch and Discord mention both go through preparation.

**Verification:** Gateway tests pass; the run-state and reply for each outcome match the plan.

- [ ] **Unit 8: Discord `recover-checkout` and `checkout-backup`**

**Goal:** Operator recovery and backup management without shell access.

**Requirements:** R7–R10

**Dependencies:** Units 5, 6

**Files:**

- Create: `packages/gateway/src/discord/commands/recover-checkout.ts`, `packages/gateway/src/discord/commands/checkout-backup.ts`
- Modify: `packages/gateway/src/discord/commands/fro-bot.ts`, `packages/gateway/src/program.ts` (button routing)
- Test: `packages/gateway/src/discord/commands/recover-checkout.test.ts`, `packages/gateway/src/discord/commands/checkout-backup.test.ts`

**Approach:**

- Both commands use `makeGuildCommand` with a fresh guild-level `ManageChannels` fetch, scoped to the invoking channel's binding.
- The refusal reply posted by preparation (Unit 7) carries a Recover entry button. Its custom ID identifies only the binding or channel, never an operation, and carries no authority; a click runs a fresh guild-level `ManageChannels` check, then starts the identical flow as `/fro-bot recover-checkout`. The entry button has no short expiry — it stays usable for as long as the refusal reply exists. A click from a user without `ManageChannels` gets an ephemeral refusal. The 60-second confirm window below is fine to miss: the entry button (or the slash command) stays usable, so a missed window costs one extra click, not a lost recovery path.
- Both the slash command and the entry button acquire the repo lock (refusing at once if a run holds it), create a maintenance run record with a heartbeat, fetch the preview, and show it ephemerally with Preserve-and-replace and Cancel buttons expiring after 60 seconds.
- The confirm button's custom ID carries a one-shot nonce bound to user, guild, channel, binding, and message; the nonce lives in memory only, binding the click to that specific message rather than to any server-side operation. On click: re-authorize, re-validate the binding, claim the nonce, call `/recover` with the fingerprint shown in the preview, report the outcome, release the lock. Expiry, cancel, a duplicate click, or an unknown nonce after restart release the lock and change nothing.
- On any terminal state (success, failure, cancel, expiry) the ephemeral preview is edited to a one-line status and its buttons are removed. A click on a confirm button that is no longer active (duplicate, expired, after a restart, or a different user) gets an ephemeral reply: "This request is no longer active. Run `/fro-bot recover-checkout` again."
- `checkout-backup list` shows generations; `delete <id>` shows a confirmation with the same nonce rules.

**`checkout-backup` reply text:**

- Empty list: "No preserved checkouts for `owner/repo`."
- List row: `<id>` · `<date>` · `<size>` · from branch `<branch>` at `<short-sha>`.
- Delete confirmation: "Delete backup `<id>` from `<date>`, `<size>`? This can't be undone."
- Success: "Deleted backup `<id>`."
- Cancel: "Cancelled. Backup `<id>` was not deleted."
- Expiry: "This confirmation expired. Run `/fro-bot checkout-backup delete <id>` again."

**Test scenarios:**

- Authorization: trigger-role-only user denied; permission revoked between preview and click denied at click.
- Entry button: clicked by a user without `ManageChannels` gets an ephemeral refusal; clicked while a run holds the lock refuses immediately with a named reason; clicked after the checkout was already recovered shows a clean-checkout preview and confirming it is still safe; clicked after a gateway restart still works, because the entry button carries no server-side state.
- Lock: a run in progress refuses recovery immediately with a named reason.
- Buttons: wrong user, replayed click, second click, expired click, and click after restart each do nothing and say why, with an ephemeral "no longer active" reply and no change to the underlying preview state.
- Outcomes: success, quota reached, disk full, and a failure mid-recovery each produce the exact reply, edit the preview to a one-line status, remove its buttons, and release the lock in every case.
- Registration: the real `/fro-bot` command registration exposes both subcommands (test the dispatch path, not only the handler).

**Verification:** Command tests pass; the maintenance run record and lock lifecycle are correct in every branch.

### Phase D — Documentation and rollout

- [ ] **Unit 9: Documentation and deployment notes**

**Goal:** Operators and future contributors can find, run, and reason about the feature.

**Requirements:** All

**Dependencies:** Units 1–8

**Files:**

- Modify: `deploy/README.md` (preparation behaviour, recovery and backup commands, retention, what refusal means)
- Modify: `ARCHITECTURE.md` (Checkout Provenance and data-flow sections; workspace control API authentication)
- Modify: `apps/workspace-agent/AGENTS.md`, `packages/gateway/AGENTS.md`
- Modify: `docs/wiki/Operator Web Control Surface.md` if contract fields are listed there
- Modify: `deploy/validate-stack.sh` (refuse a `workspace` service declaring `deploy.replicas` greater than 1)

**Approach:** Describe behaviour and invariants, not implementation history.

**Test expectation:** none — documentation only; `bun run lint` checks links.

**Verification:** Docs match shipped behaviour; link check passes.

## System-Wide Impact

- **Interaction graph:** every gateway run now makes a network call to GitHub from the workspace before executing; the gateway's mint of installation tokens moves from "on first clone" to "every run with an eligible checkout".
- **Error propagation:** workspace results are typed unions end to end; the gateway never infers success from a missing field.
- **State lifecycle risks:** partial mutation is recorded, never hidden; quarantine grows until an operator deletes generations.
- **API surface parity:** Discord mentions and web launches share the run path, so both get preparation. `/fro-bot dispatch` does not touch the workspace and is unaffected.
- **Integration coverage:** real-git behaviour, uid boundaries, and crash reconciliation are proven in the image, not with mocks.
- **Unchanged invariants:** `/clone` semantics and `409 repo-exists`; `/inspect` as a read-only diagnostic; the repo lock and its heartbeat; `checkoutProvenance` meaning the starting state of an executed run.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| A config key missed by the allowlist executes code during merge | Closed allowlist, not a denylist; local git also runs as uid 10001 with hooks, filters, and fsmonitor forced off; Unit 2 tests each vector with a positive control |
| A dirty checkout blocks a busy repository until someone recovers it | One click from the refusal reply, by anyone with `ManageChannels`; the slash command remains a fallback entry point |
| Every run adds GitHub round trips and token mints | Refuse without fetching when local state is already ineligible; `ls-remote` is one request; measure in Unit 2 |
| First update after upgrade fetches the whole default branch into the new bare repo | One-time cost per repository, inside the 45-second network budget for ordinary repositories; a timeout fails closed and the next run resumes the fetch |
| An apk git upgrade changes behaviour | The fixture suite runs inside the image in CI and asserts the version |
| Lease takeover while a previous holder still writes (#1655) | Out of scope; stated in the docs and replies do not claim more than the lock provides |

## Documentation / Operational Notes

- Upgrade: no operator action beyond pulling the images; the control API bearer is the existing `workspace-opencode-token` secret.
- Rollback: the previous gateway does not send the bearer, so the new workspace refuses its control calls. Roll back both images together.
- Monitoring: refusals and failures are persisted with `checkoutPreparation`; the operator surface shows them.

## Sources & References

- Issue: #1634 (PR 1: #1656; isolation: #1661)
- Related: #1655 (lease takeover), #1663 (no init in the workspace)
- Related code: `apps/workspace-agent/src/{clone,inspect,git-safety,handoff}.ts`, `packages/gateway/src/execute/{run,provenance}.ts`
