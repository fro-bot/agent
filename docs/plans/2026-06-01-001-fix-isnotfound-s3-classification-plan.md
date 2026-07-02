---
title: 'fix: isNotFound() misclassifies S3 NoSuchKey as fatal'
type: fix
status: done
date: 2026-06-01
---

> **Status: done.** Both units shipped: structured S3 error classification preserved through the object-store adapter (`packages/runtime/src/object-store/s3-adapter.ts`), and regression tests — verified on `main`.

# fix: isNotFound() misclassifies S3 NoSuchKey as fatal

## Overview

The first-ever `/fro-bot add-project` on a freshly deployed gateway always fails with "Internal error checking existing bindings." A valid S3 `NoSuchKey` 404 (the binding key legitimately does not exist yet) is misclassified as a fatal store error, so the flow aborts before writing the first binding — a deterministic first-use deadlock. This fixes the misclassification at its root by preserving the structured S3 error code through the object-store adapter, with a widened message regex as a fallback for non-AWS S3-compatible stores.

## Problem Frame

`getBindingByRepo()` uses `isNotFound()` to turn a missing-key 404 into `ok(null)` ("key absent → create the first binding"). Two compounding defects break this on AWS-style stores:

1. **Symptom** — `packages/gateway/src/bindings/store.ts:43` classifies not-found by message regex (`/not.?found|no.?such.?key|404/i`), which misses AWS's actual message "The specified key does not exist."
2. **Root cause** — `packages/runtime/src/object-store/s3-adapter.ts` (`logS3Error`, lines 26-47) extracts `errorCode` (`NoSuchKey`), `errorName`, and `httpStatusCode` (404), logs them, then returns an error carrying only a message string — discarding the structured fields that would classify the error unambiguously.

`isNotFound()` gates the not-found path in `getBindingByRepo`, `getBindingByChannelId`, and `listBindings`, so the defect affects every binding read path.

## Requirements Trace

- R1. A 404 / `NoSuchKey` getObject result for an absent binding key resolves to `ok(null)`, so the first `/fro-bot add-project` proceeds to create the binding.
- R2. Classification is robust across AWS S3 and S3-compatible stores (R2/B2/MinIO) whose error wording or codes differ.
- R3. Genuine fatal store errors (e.g. 403 `AccessDenied`, 500) remain classified as fatal — no false negatives.
- R4. Existing single-argument callers of the object-store error factory remain valid (no breaking change).

## Scope Boundaries

- Do not refactor the broader object-store error taxonomy; thread only the two fields needed for not-found classification (`errorCode`, `httpStatusCode`).
- Do not change the `add-project` flow beyond what the classification fix requires.

### Deferred to Separate Tasks

- **v0.46.3 maintenance backport**: cherry-pick this fix onto the `0.46.x` line (infra runs v0.46.2, which carries the deadlock) and cut a not-latest tag — same pattern as #707 → v0.46.2. Separate from this main-line PR.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/bindings/store.ts` — `isNotFound()` (line 43) and its call sites in `getBindingByRepo` (~176), `getBindingByChannelId` (~203, ~225), `listBindings` (~255).
- `packages/runtime/src/object-store/s3-adapter.ts` — `logS3Error()` (lines 26-47) already extracts `errorCode`/`httpStatusCode`.
- `packages/runtime/src/object-store/types.ts` — `ObjectStoreOperationError` interface + `createObjectStoreOperationError()` factory (lines 28-42), an `Object.assign(new Error(message), {code})` shape.
- `packages/gateway/src/bindings/store.test.ts` — existing `makeAdapter({getObject})` harness and the "returns null when the primary record does not exist" edge-case test pattern.

### Institutional Learnings

- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — runtime changes bundle into the committed action `dist/`; a build + dist commit is required (gateway `dist/` is gitignored).

## Key Technical Decisions

- **Root-cause fix over symptom patch**: preserve the SDK's structured `errorCode`/`httpStatusCode` rather than relying on message-string matching alone. Message regex is retained only as a fallback for stores that don't expose the same code/message.
- **Backward-compatible factory**: add an optional `details` second argument to `createObjectStoreOperationError()` so existing single-arg callers are unaffected (R4).
- **Type-guard narrowing, no banned casts**: the gateway reads the structured fields via a type guard (`error is ObjectStoreOperationError`), avoiding `as any`/`as unknown as` (project standard).

## Open Questions

### Resolved During Planning

- Does the structured S3 code survive to `isNotFound()` today? — No. `logS3Error` discards it; the fix threads it through. (Verified in source.)

### Deferred to Implementation

- Exact non-AWS provider message wording (R2/B2/MinIO) — covered defensively by the widened regex fallback; not separately enumerated.

## Implementation Units

- [x] **Unit 1: Preserve structured S3 error classification**

**Goal:** Thread the SDK error code/status from the adapter to `isNotFound()` and prefer structured classification, with a widened message regex fallback.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `packages/runtime/src/object-store/types.ts`
- Modify: `packages/runtime/src/object-store/s3-adapter.ts`
- Modify: `packages/gateway/src/bindings/store.ts`

**Approach:**
- `types.ts`: add optional `errorCode?: string` and `httpStatusCode?: number` to `ObjectStoreOperationError`; add an optional `details` arg to `createObjectStoreOperationError()` that attaches them when present.
- `s3-adapter.ts`: `logS3Error()` passes its already-extracted `{errorCode, httpStatusCode}` into the factory instead of dropping them.
- `store.ts`: `isNotFound()` checks `httpStatusCode === 404` or `errorCode === 'NoSuchKey'` first (via a type guard), then falls back to a widened regex including `does.?not.?exist`.

**Patterns to follow:**
- `createValidationError`/`createPathTraversalError` in `types.ts` (same `Object.assign` factory shape).

**Test scenarios:** covered in Unit 2.

**Verification:**
- A 404 / `NoSuchKey` getObject for an absent key yields `ok(null)`; a 403/`AccessDenied` yields `err`. Types + lint clean. No banned casts introduced.

- [x] **Unit 2: Regression tests**

**Goal:** Lock the classification behavior across structured and message-only error shapes, including the fatal negative case.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/bindings/store.test.ts`
- Create: `packages/runtime/src/object-store/types.test.ts`

**Approach:**
- Table-driven `getBindingByRepo` cases injecting adapter errors and asserting `ok(null)` vs `err`.
- Factory test asserting structured fields are attached with `details` and absent without it.

**Execution note:** Test-first — write the failing cases before Unit 1, confirm RED, then implement to GREEN.

**Patterns to follow:**
- `makeAdapter({getObject})` harness and `// #given/#when/#then` BDD comments in `store.test.ts`.

**Test scenarios:**
- Happy path: `getBindingByRepo` returns the binding for an existing repo (unchanged).
- Edge case: adapter errors with the real AWS message + `{errorCode:'NoSuchKey', httpStatusCode:404}` → `ok(null)`.
- Edge case: structured-only `httpStatusCode:404` (generic message) → `ok(null)`.
- Edge case: structured-only `errorCode:'NoSuchKey'` (generic message) → `ok(null)`.
- Edge case: message-only "no such key" (no structured fields, R2/B2-style) → `ok(null)`.
- Edge case: legacy `new Error('not found')` → `ok(null)` (no regression).
- Error path: fatal `{errorCode:'AccessDenied', httpStatusCode:403}` → `err` (not `ok(null)`).
- Happy path: `createObjectStoreOperationError(msg, {errorCode, httpStatusCode})` carries both fields + `code`; single-arg call leaves them `undefined`.

**Verification:**
- Tests fail before Unit 1, pass after. Gateway + runtime suites green.

## System-Wide Impact

- **Interaction graph:** `isNotFound()` gates `getBindingByRepo`, `getBindingByChannelId`, and `listBindings` — the single fix covers all three read paths.
- **Error propagation:** structured S3 fields now survive the adapter boundary; downstream classification prefers them over message strings.
- **API surface parity:** `createObjectStoreOperationError()` gains an optional arg only — no existing caller changes.
- **Build impact:** `packages/runtime/` bundles into the committed action `dist/` → `pnpm build` + dist commit required; gateway `dist/` is gitignored.
- **Unchanged invariants:** the `ObjectStoreOperationError.code` discriminant and all single-arg factory call sites are preserved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Non-AWS stores don't expose `NoSuchKey`/404 the same way | Widened message regex fallback (`does.?not.?exist`) covers message-only stores. |
| Over-broad not-found matching hides a real fatal error | Negative test asserts 403/`AccessDenied` stays `err`; structured checks are exact-match (`=== 404`, `=== 'NoSuchKey'`). |
| dist drift fails CI | Plan mandates `pnpm build` + dist commit; gateway-smoke and dist-diff gates verify. |

## Sources & References

- Issue: #713
- Related: `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md`
- Prior backport pattern: #707 → v0.46.2
