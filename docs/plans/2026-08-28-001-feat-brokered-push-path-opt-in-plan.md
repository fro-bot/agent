---
title: 'Brokered push: consumer path opt-in and failure specificity'
type: feat
status: active
date: 2026-08-28
deepened: 2026-08-28
---

# Brokered push: consumer path opt-in and failure specificity

## Overview

Brokered push's path allowlist assumes this repo's layout (`src/`, `packages/*/src/`, `docs/`, three root docs). Consumer repos that keep deployable code elsewhere — the motivating case has seven units under `apps/<name>/src/` with 116 of 170 excluded files there — cannot receive delivery even when every trust gate passes. This plan adds a consumer-facing opt-in that widens the allowlist with additional path prefixes, and replaces the generic failure comment with one that names the failure class and, for path rejections, the offending paths.

## Problem Frame

Issue #1489. Two defects in practice: a trusted maintainer's requested change silently cannot be delivered because the allowlist is home-repo-shaped, and when delivery fails for any reason the PR comment says only `Brokered push delivery failed. The model response was not posted.` — the real reason lives in `core.setFailed()` and requires opening workflow logs. The origin plan anticipated the first ("maintainer-reviewed per-path opt-in to widen the allowlist," `docs/plans/2026-07-30-001-feat-brokered-push-trusted-mention-plan.md`).

## Requirements Trace

- R1. A consumer can add path prefixes to the brokered-push allowlist via an action input, without forking the harness.
- R2. Defaults are unchanged: consumers that do not set the input get exactly today's allowlist.
- R3. Execution surfaces (`.github/`, `scripts/`, manifests, lockfiles, Dockerfiles, deploy config) remain denied regardless of opt-in; the shared `validateFiles()` floor (traversal, `.git/`, secrets, key extensions, size) is unchanged and checked first.
- R4. A brokered-push failure comment names the failure class so the reader can distinguish a disallowed path from a moved head or an API failure without opening logs.
- R5. For path-allowlist rejections, the comment names the offending path(s).
- R6. A malformed or overlap-denied input value fails the run at parse time, on every trigger.

## Scope Boundaries

- No denylist migration — the allowlist model and its rationale (`docs/solutions/best-practices/net-diff-delivery-needs-an-allowlist-not-a-denylist-2026-07-30.md`) are retained.
- No auto-derivation of paths from repo layout; widening is explicit maintainer configuration only.
- No changes to trust gates (eligibility, live permission re-check, head anchor, identity re-resolution).
- No new delivery capabilities (new-PR-from-branch, non-PR mentions remain future iterations of the origin plan).

### Deferred to Separate Tasks

- Reason-taxonomy parity for the gateway dispatch surface: separate work, tracked in session note #292 territory.
- Comment-surface reason reporting for non-brokered response-file failures: unchanged here.

## Context & Research

### Relevant Code and Patterns

- `src/features/delegated/brokered-push-validation.ts` — `BROKERED_PUSH_ALLOWED_PATHS`, `BROKERED_PUSH_ALLOWED_ROOT_FILES`, `validateBrokeredPushFiles()`; enforcement happens here, after shared `validateFiles()`.
- `src/features/delegated/commit.ts` — `FILE_VALIDATION` shared floor; unchanged by this plan.
- `src/features/delegated/brokered-push.ts` — `runBrokeredPush()` six-step flow; validation is step 4, before the pre-write gate and any write API call.
- `src/harness/config/inputs.ts` — `parseActionInputs()`; `parseOmoProviders()` is the list-input precedent (comma-split, trim, drop empties, validate each, throw → `Result` error → `core.setFailed`).
- `src/harness/phases/finalize.ts` — `BROKERED_PUSH_ERROR_MESSAGE` constant, `createBrokeredPushError()`, comment-only-if-no-response-posted guard, `core.setFailed()` carrying the dropped reason.
- `review-skip-label` (commit `b6a763228`) — the most recent input added end-to-end: `action.yaml` → `ActionInputs` → bootstrap → consumer, with tests at each layer.

### Institutional Learnings

- Allowlist-not-denylist doctrine: widening must stay opt-in within the allowlist model (`net-diff-delivery-needs-an-allowlist-not-a-denylist-2026-07-30.md`).
- Failure text must be action-owned and context-derived, never model-output-derived (`response-file-is-untrusted-input-2026-07-11.md`).
- "Couldn't report the failure" is itself a failure; vague failure text repeats the pattern (`failed-run-reported-success-with-no-delivery-surface-2026-08-07.md`).
- Verify the posted comment's content, not that a branch was entered (`verify-behavior-not-signal-2026-08-23.md`).
- Security controls compose: test the widened path against hardened consumer-like config, not just this repo (`injected-deny-blocks-own-delivery-path-2026-07-13.md`).

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "src/ plus packages/runtime/src/",
  "freshness": {
    "vcs_reference": "a5695615b68b5221520e7a94c5766c544f79ebee"
  },
  "budget": {
    "max_search_passes": 2,
    "max_candidate_inspections": 4,
    "exhausted": true
  },
  "candidates": [
    {
      "path_or_symbol": "src/features/delegated/brokered-push-validation.ts:validateBrokeredPushFiles",
      "description": "Owns the brokered-push positive path predicates, root-file set, shared validation call, and file-count cap.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/harness/config/inputs.ts:parseActionInputs",
      "description": "Maps Actions inputs into the typed ActionInputs record; strict parser converting exceptions into failed Results.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/filter-env.ts:filterAgentEnv",
      "description": "Deny-by-default retention with explicit deny precedence over allow — the merge-precedence pattern to mirror.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/services/setup/ci-config.ts:scopeExternalDirectoryPermission",
      "description": "Fail-closed permission construction with deny-before-allow ordering.",
      "disposition": "insufficient",
      "insufficiency_reason": "Demonstrates deny-precedence merging but governs filesystem permission config, not the input-to-delivery validation contract."
    }
  ]
}
```

## Key Technical Decisions

- **Overlap and malformation are rejected at BOTH layers**: parse time and enforcement time. A prefix that is absolute, contains traversal, or overlaps a protected surface fails the run in `parseActionInputs()` on every trigger, matching the strict-parser precedent (`parseOmoProviders` throws; bootstrap `setFailed`s) — that is the UX layer, surfacing misconfiguration immediately. Independently, `validateBrokeredPushFiles()` re-rejects protected-surface prefixes before any allowlist match, fail-closed — so a future caller constructing `BrokeredPushParams` without passing the parser cannot silently widen delivery. Both layers consume one canonical definition (see Unit 1). *(Resolves the first synthesis call-out, strengthened by security review.)*
- **Prefix-only contract, globs deferred**: comma-separated path prefixes, not globs or per-file grants. The motivating consumer is served by a prefix, and glob matching ambiguity plus parser complexity outweigh a need no consumer has stated. A string-list input does not foreclose glob support later. Consumers accepting the coarser grant (`apps/` over `apps/*/src/`) is an explicit trade documented in README.
- **The input lives in workflow YAML, and that is self-anchoring**: brokered push triggers on `issue_comment`, which always executes the default-branch workflow definition — so the effective prefix list is changeable only by someone who can push workflow changes to the default branch, and never by fork-authored workflow files. A repo-file config would be mutable by the very flow it constrains; the allowlist itself denies brokered push any write to workflow files.
- **Coarse failure class everywhere; paths only for validation**: `BrokeredPushOutcome`'s failure arm gains a machine-distinguishable class covering all ten observed failure modes, and the comment renders an action-owned template per class. Offending paths appear only for the validation class — they are the only detail that is both safe for a public comment and actionable by the reader. Raw reason strings for other classes (API error text, internals) stay in logs and `core.setFailed()` only. The class union stays harness-local (`src/features/delegated/`): only finalize consumes it, and lifting it to `packages/runtime` for hypothetical gateway parity would be premature coupling. *(Resolves the second synthesis call-out.)*
- **Offending paths render under a pinned sanitizer contract**: the paths are model-influenced strings — the model chose the filenames — so "repo-relative" is not a rendering rule. The comment formatter renders them only as escaped plain text inside a fenced code block: `@` neutralized, markdown link syntax inert, HTML disallowed, never interpolated into link text or headings. A path like ``foo](https://evil)`` or one containing `@org/team` must render as literal characters.
- **Segment-boundary prefix matching**: an extra prefix matches at path-segment boundaries (`apps` matches `apps/x.ts`, never `apps-legacy/x.ts`), closing the sibling-directory evasion the flow analysis surfaced.
- **Normalization pipeline order is pinned**: trim → strip leading `./` and `/` → collapse `//` → NFC-normalize → reject malformed (traversal, absolute) → reject protected-surface overlap → dedupe. Ordering is what makes `docs/../.github/` a malformation rejection rather than a bypassable overlap check, and it must be test-pinned.
- **Comma-separated input** named `brokered-push-extra-paths`: matches the only established list-input convention (`omo-providers`).
- **Empty means empty**: unset, empty-string, and whitespace-only input all normalize to an empty list — never an empty-string prefix, which would compile to match-everything.

## Open Questions

### Resolved During Planning

- Loud vs silent overlap handling: loud (see Key Technical Decisions).
- Failure-reason breadth: coarse class for all failure modes, path detail for validation only (see Key Technical Decisions).

### Deferred to Implementation

- Exact class names for the failure taxonomy: derive from the observed failure table during implementation; the contract is "machine-distinguishable and stable," not specific strings.
- Whether `createBrokeredPushError()` grows a parameter or is replaced by a per-class template lookup: decide at the code.

## Implementation Units

- [x] **Unit 1: Input — parse, normalize, validate `brokered-push-extra-paths`**

**Goal:** A consumer can supply comma-separated path prefixes; malformed or overlap-denied values fail the run at parse time.

**Requirements:** R1, R2, R6

**Dependencies:** None

**Files:**
- Create: `src/shared/brokered-push-paths.ts` (protected-surface set + pure prefix-matching/normalization primitives)
- Modify: `action.yaml`, `src/harness/config/inputs.ts`, `packages/runtime/src/shared/types.ts` (`ActionInputs`)
- Modify: `README.md` (public input documentation — required by CONTRIBUTING for input changes)
- Test: `src/harness/config/inputs.test.ts`, plus colocated test for the new shared module

**Approach:**
- Follow `parseOmoProviders()` shape; implement the pinned normalization pipeline from Key Technical Decisions.
- The protected-surface set and matching primitives live in `src/shared/` — NOT `src/harness/config/` — because Unit 3's `src/features/delegated/` enforcement must import the same definition and the 4-layer rule forbids features importing from harness. Parser and validator both consume it; neither redefines it.

**Patterns to follow:** `parseOmoProviders()`; `review-skip-label` for end-to-end input threading.

**Test scenarios:**
- Happy path: `apps/, tools/cli` → `['apps/', 'tools/cli']` normalized.
- Edge: unset, `''`, `'  '`, and `','` all → empty list; duplicate entries deduped; `./apps//x` → `apps/x`; NFD input NFC-normalized.
- Error: `../etc`, `/abs/path`, `docs/../.github/` → parse failure naming the entry; `.github/`, `scripts/`, `package.json` overlap → parse failure naming the entry; ordering pinned — `docs/../.github/` reports malformation, not overlap.
- Error: parse failure occurs identically under a `workflow_dispatch` mock context (fail-fast on every trigger).

**Verification:** invalid input fails the run before any phase executes; `README.md` documents the input, its default, and the hard-deny guarantee.

- [x] **Unit 2: Structured failure taxonomy in the brokered-push outcome**

**Goal:** Finalize can distinguish failure classes and access offending paths without parsing strings.

**Requirements:** R4, R5

**Dependencies:** None (parallel with Unit 1)

**Files:**
- Modify: `src/features/delegated/brokered-push.ts` (`BrokeredPushOutcome`), `src/features/delegated/brokered-push-validation.ts` (structured validation result)
- Test: `src/features/delegated/brokered-push.test.ts`, `src/features/delegated/brokered-push-validation.test.ts`

**Approach:**
- Extend the `fail-loud` arm with a failure class and optional `readonly paths` populated only by validation rejections; `reason` string retained for logs/`setFailed` compatibility.
- Every internal failure site maps to exactly one class; no catch-all beyond a genuine `unknown` class for thrown exceptions.

**Test scenarios:**
- Happy path: each failure site returns its class (validation, reconstruction, moved-head, identity, permission, commit, timeout).
- Edge: validation rejection carries all offending paths; non-validation classes carry no paths.
- Integration: `runBrokeredPush()` end-to-end returns classed outcomes for a validation failure and a moved-head failure.

**Verification:** no call site inspects `reason` text to branch on failure kind.

- [x] **Unit 3: Merged allowlist enforcement**

**Goal:** Extra prefixes widen `validateBrokeredPushFiles()` at segment boundaries; the shared floor and default behavior are untouched.

**Requirements:** R1, R2, R3

**Dependencies:** Units 1, 2

**Files:**
- Modify: `src/features/delegated/brokered-push-validation.ts`, `src/features/delegated/brokered-push.ts` (`BrokeredPushParams`), `src/harness/phases/finalize.ts` (pass `bootstrap.inputs.brokeredPushExtraPaths` into the call)
- Modify: `src/features/delegated/AGENTS.md` (documents delegated validation but not the brokered-push allowlist or the new opt-in — add the boundary and the protected-surface invariant)
- Test: `src/features/delegated/brokered-push-validation.test.ts`, `src/features/delegated/brokered-push.test.ts`

**Approach:**
- No bootstrap change: `runFinalize()` already receives `BootstrapPhaseResult` and reads `bootstrap.inputs` today (`finalize.ts:147`); the new field rides the existing handoff.
- `validateBrokeredPushFiles(files, extraPrefixes)` — shared `validateFiles()` floor runs first, unchanged; then protected-surface prefixes are re-rejected fail-closed (enforcement does not trust that its caller used the parser); then extra prefixes are segment-boundary matched after the default allowlist. All against the single `src/shared/` definition from Unit 1 — consume, never redefine.

**Test scenarios:**
- Happy path: `apps/` admits `apps/web/src/index.ts`; default allowlist unchanged with empty extras (byte-identical behavior — the existing test corpus passes unmodified).
- Edge: `apps` does not admit `apps-legacy/x.ts`; prefix equal to a default (`src/`) is harmless; overlapping supplied prefixes (`apps/`, `apps/web/`) behave as union.
- Error: extra prefix never admits a `validateFiles()`-denied file (`.env` under `apps/`, oversized file, `.git/` traversal).
- Error: a protected-surface prefix passed directly to `validateBrokeredPushFiles()` (bypassing the parser) is rejected at enforcement time — the fail-closed recheck, pinned.
- Integration: `runBrokeredPush()` with `apps/` extras delivers a consumer-layout change set (`apps/<name>/src/...` fixture in `brokered-push.test.ts`) — the motivating case from #1489, proven end-to-end.

**Verification:** existing brokered-push validation tests pass unmodified; widened delivery works end-to-end in the feature test.

- [x] **Unit 4: Failure comment specificity in finalize**

**Goal:** The PR comment names the failure class; validation rejections name offending paths, truncated and scrubbed.

**Requirements:** R4, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `src/harness/phases/finalize.ts`
- Test: `src/harness/phases/finalize.test.ts`

**Approach:**
- Replace the constant message with an action-owned template per failure class; validation templates append offending paths — capped (first 10 + `and N more`), repo-relative only, workspace-prefix scrubbed, rendered under the sanitizer contract from Key Technical Decisions (escaped plain text in a fenced block; links, mentions, HTML inert).
- Preserve the existing guards exactly: comment posts only when no normal response landed; one comment per invocation; `core.setFailed()` keeps the full reason.
- Wrap the brokered-push call so a thrown (unclassified) exception becomes a classed `unknown` outcome and the comment still posts — "couldn't report the failure" is itself a failure.

**Test scenarios:**
- Happy path: validation failure comment contains class text and `apps-legacy/x.ts`; moved-head failure comment names the class with no path and no raw API text.
- Error path: a rejected path containing markdown link syntax (`foo](https://evil.example)`) and one containing `@org/team` render as inert literal text in the posted comment body.
- Edge: 25 offending paths → 10 listed + `and 15 more`; comment absent when a normal response was already posted; `setFailed` retains full reason in both cases.
- Error path: thrown exception from `runBrokeredPush()` → `unknown`-class comment still posts.
- Integration: full finalize run with a classed outcome posts exactly one comment whose text matches the template (assert content, not that a branch was entered).

**Verification:** a reader can distinguish disallowed-path vs moved-head vs API failure from the PR comment alone; no comment contains raw error internals or absolute paths.

## System-Wide Impact

- **Interaction graph:** input parsing (bootstrap) → finalize → delegated feature; no routing, trigger, or gateway surface touched. The `deploy/` compose stack and workspace flows are untouched.
- **Input provenance:** only maintainers can change the effective prefix list — `issue_comment` triggers execute the default-branch workflow definition, so fork-authored workflow files never supply the input, and the allowlist itself denies brokered push any write to workflow files.
- **Error propagation:** failure classes flow outcome → finalize comment; `reason` strings unchanged for logs/`setFailed`. No new throw paths escape finalize. No new metrics surface — classed failures are a diagnostic improvement; logs and `setFailed` remain the only sinks.
- **API surface parity:** the action input is new public contract (`action.yaml` + README). `docs/examples/fro-bot.yaml` deliberately does NOT gain it — that example shows only `workflow_dispatch.inputs.prompt` and has never mirrored Action `with:` configuration; README is the documentation surface.
- **Autonomous flows:** the input parses (and can fail the run) on every trigger, but brokered push only runs for eligible PR flows — the input is inert on `workflow_dispatch`/`schedule` and the plan makes no change there.
- **Unchanged invariants:** one comment per invocation; `force: false`; Git Data API delivery; trust gates; shared `validateFiles()` floor; Response Protocol for non-brokered flows.
- **Integration coverage:** Unit 3's end-to-end consumer-layout delivery and Unit 4's full-finalize comment assertion are the two cross-layer proofs; unit tests alone cannot prove either.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Opt-in becomes a widening vector into CI (`.github/`, scripts) | Dual-layer rejection: parse-time (UX) and enforcement-time fail-closed recheck in `validateBrokeredPushFiles()`, both against one shared definition; unchanged `validateFiles()` floor beneath both |
| Comment becomes an injection surface via model-chosen path strings | Pinned sanitizer contract: escaped plain text in fenced block; link syntax, mentions, HTML inert; pinned by Unit 4 test |
| Opt-in widens delivery to non-executable repo content (`deploy/` configs, `dist/`, `evals/`) | Accepted risk, stated explicitly: widening to non-execution content is the feature's purpose, bounded by the unchanged floor and the protected-surface set; README documents that the input must not stage secrets or execution surfaces |
| Comment leaks internals (API error text, absolute paths) | Per-class action-owned templates; raw text only in logs; scrubbing + truncation tests |
| Consumer sets input, forgets it, config rots silently | Loud parse failure covers malformation; dead-but-valid config is accepted as harmless (documented in README) |
| Failure-class taxonomy drifts from real failure sites | Unit 2 requires exactly-one-class mapping per site with a test per site |

## Sources & References

- Origin issue: fro-bot/agent#1489
- Origin plan (anticipating this iteration): `docs/plans/2026-07-30-001-feat-brokered-push-trusted-mention-plan.md`
- Boundary doctrine: `docs/solutions/best-practices/net-diff-delivery-needs-an-allowlist-not-a-denylist-2026-07-30.md`
- Related code: `src/features/delegated/brokered-push-validation.ts`, `src/harness/phases/finalize.ts`, `src/harness/config/inputs.ts`
- Input precedent: `review-skip-label` (#1234, commit `b6a763228`)
