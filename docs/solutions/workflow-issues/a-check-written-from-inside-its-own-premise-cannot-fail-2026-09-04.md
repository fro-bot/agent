---
title: A check written from inside its own premise cannot fail
date: 2026-09-04
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Writing a regression test for a bug that involves ordering, shared state, or environment
  - Documenting a behavior in the same change that alters it
  - Correcting a derived fact such as a count, version, or line reference
  - Writing a filter, watch, or poll against an API whose field shape you have not confirmed
  - Changing a shared function's semantics, or triaging a failure from one branch's history
tags:
  - self-referential-check
  - shared-premise
  - false-confidence
  - neutralization-testing
  - test-isolation
  - verification
---

# A check written from inside its own premise cannot fail

## Context

In one working day, nine independent defects shared a single shape. Each was a check — a test, a documentation sentence, a watch filter, a derived count, a triage conclusion — that passed. Each was later found by a reader outside the author's frame asking a question the frame excluded. None of them was a mistake in the code being checked. Every one was a mistake in the check.

The common structure: the verifier and the thing verified shared a premise — visit order, mock state, which behavior was intended, what counts as a page, which field name an API uses, how many callers a function has. A check built inside that premise is structurally unable to detect its violation, and it passes, which is exactly what a correct check looks like.

This is distinct from two neighboring lessons. [A present signal is not evidence of the effect it implies](./verify-behavior-not-signal-2026-08-23.md) is about reading the wrong *property* of something fully observed. [A check reports clean for the part of the world it cannot observe](./checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) is about a check whose *population* is narrower than believed. Here the check sees the right thing and the right property — but was authored from the same assumption it exists to challenge, so the failure it was written to catch is the one failure it cannot see.

## Guidance

**Before trusting a check, name the premise the check and its subject share. Then find a verifier that does not share it.**

The concrete moves, each tied to the defect that taught it:

1. **Prove a test bites with a real break, and confirm the break is real.** Revert or mutate the fix and watch the test go red. Then confirm the mutation actually changed behavior — `const env = undefined ?? options?.env ?? fallback` still evaluates to `options.env`, so a test that stays green against it has proven nothing. Green-when-red-was-expected is itself a signal: the proof is broken, not the code.

2. **For fixtures read in unsorted order, make the files symmetric or assert on "whichever."** A test that names `b.jsonl` and assumes `a.log` was visited first is correct on APFS and inverted on Linux. Either make every file byte-identical so order cannot matter, or find the file that carries the marker rather than naming it.

3. **Clear mocks between tests, or read `lastCall`.** Under a file-level `vi.mock`, `mock.calls[0]` is the *first* call in the file — the previous test's. A test asserting on it measures a different invocation than the one it made.

4. **When a change alters behavior, grep the change's own diff for prose describing the old behavior.** A PR that adds a sentence and then removes the behavior it describes has contradicted itself, and the document it contradicted may be the one the repository designates as authoritative.

5. **A two-part guarantee needs two tests.** "Setup continues on install timeout *and* saves the cache" pinned both halves as one property. Continuing was correct. Saving was the regression. One assertion cannot be half right.

6. **Derive a count against its label, not against a directory listing.** `ls docs/wiki/*.md | wc -l` returns 9. The label says "deep-dive pages." `index.md` is not one. The correction introduced the drift the label had been avoiding.

7. **Confirm a filter's field exists in the shape you are querying before trusting its silence.** `gh pr view --json reviews` exposes `commit.oid`; REST `pulls/{n}/reviews` exposes `commit_id`. A filter on the wrong name matches nothing forever and reports "not yet" indefinitely.

8. **Triage a CI failure against `main`, not against one branch.** "Intermittent, 1 in 8" was derived from one pull request's history. `main` itself had been red for hours. `gh run list --branch main --workflow ci.yaml` was one command away.

9. **Before flipping a shared function's behavior, enumerate its callers.** Switching truncation from head-kept to tail-kept was right for the log caller. The response-file caller keeps its structured header at the top; the change deleted it. There were three callers, not one. The fix made the direction a required parameter with no default — because a default is precisely how one caller's assumption reaches another.

10. **A bound must clear the tail of the thing it bounds.** A 120-second timeout on an install that was measured stalling for 181–370 seconds would have fired on every slow-but-valid run and then fallen back to the unbounded path. Check the number against the measurements you gathered, not against the healthy case.

## Why This Matters

A passing check is the strongest false signal available, because it is indistinguishable from correctness. Every instance above reached a pull request with green tests, and several reached a review that approved them. The cost is not the bug — it is the *confidence*: a check that passes for the wrong reason converts "unknown" into "verified," and everything downstream inherits that.

The shape recurs because writing a check and writing its subject happen in the same head, in the same frame, with the same assumptions loaded. The author cannot see the premise from inside it. What broke each of these was something external: a Linux runner, a reviewer asking "what does run N+1 see," a `git ls-tree` at the commit that last wrote the number, a mutation that unexpectedly stayed green.

## When to Apply

- Writing a regression test for a bug involving ordering, shared state, platform differences, or environment.
- Documenting behavior in the same PR that changes it — especially in a file other documents defer to.
- "Correcting" a derived fact: a count, a version pin, a line reference.
- Writing any filter, watch, or poll loop against an API response.
- Triaging an intermittent failure — before writing "flaky," check the default branch.
- Changing the semantics of a function with more than one caller.
- Choosing a timeout, cap, or budget for a failure mode you have measured.

## Examples

### An order-dependent test for an ordering bug

Before — names the file and assumes visit order:

```ts
const persisted = await readFile(path.join(target, 'b.jsonl'), 'utf8')
expect(persisted.startsWith(DIAGNOSTIC_TRUNCATION_MARKER)).toBe(true)
```

After — symmetric fixtures, and the assertion finds whichever file was truncated (`evals/diagnostics.test.ts`):

```ts
const persistedLogs = ['a.log', 'b.jsonl'].map(fileName => readPersistedFile(diagnosticsPath, fileName))
const truncatedLog = persistedLogs.find(log => log.startsWith(expectedMarker))
expect(truncatedLog).toBeDefined()
```

Verified by the reviewer on the Linux runner: traversal order there was `b.jsonl, a.log` — the reverse of what the first version assumed.

### A test reading the previous test's call

Before — under a file-level mock, index 0 is not this test's call:

```ts
const spawnOptions = vi.mocked(childProcess.spawn).mock.calls[0]?.[2]
expect(spawnOptions?.env).toEqual(env)   // received 156 keys: the prior test's inherited env
```

After — the mock is cleared before each test (`src/services/setup/adapters-timeout.test.ts`):

```ts
beforeEach(() => {
  vi.mocked(childProcess.spawn).mockClear()
  vi.useFakeTimers()
})
```

Proven to bite by removing `options?.env ??` from the adapter and watching it fail — after a first mutation (`undefined ?? options?.env`) that changed nothing and left the test green.

### A document contradicted by the next commit

Before, in `ARCHITECTURE.md`, added by the same PR that then removed the behavior:

> …on timeout or failure it warns and lets the server's own install serve as the fallback it always was, and setup still proceeds to `saveToolsCache`.

After, matching `src/services/setup/setup.ts` where the save is gated on `status === 'installed'`:

> …and setup skips `saveToolsCache` entirely, so an incomplete install is never persisted into an immutable cache key.

The suite guarded the code. Nothing guarded the prose, and the prose lived in the file the repository tells agents to trust for invariants.

### One caller's semantics applied to three

Before — direction hardcoded inside the function:

```ts
function boundDiagnostic(content: string, maxBytes: number): string
```

After — every caller states which end it needs, with no default (`evals/diagnostics.ts`):

```ts
function boundDiagnostic(
  text: string,
  maxBytes: number,
  marker: (maxBytes: number) => string,
  keep: 'head' | 'tail',
): string
```

Logs keep the tail; `response.md` keeps the head, where its verdict and schema header live. A third caller, `readCapturedDiagnostics`, surfaced only when the parameter became required.

## Related

- [A present signal is not evidence of the effect it implies](./verify-behavior-not-signal-2026-08-23.md) — the neighbor about reading the wrong property of an observed thing.
- [A check reports clean for the part of the world it cannot observe](./checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — the neighbor about a check's population being narrower than believed.
- [Verify the signal before implementing the plan](./evidence-first-scope-correction-under-incomplete-signals-2026-08-08.md) — the planning-stage cousin: prove a signal exists before designing control flow around it. Its neutralization-testing rule is the same move as item 1 above.
- [A gate that cannot fail manufactures confidence](./non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — a gate with no reachable red state; here the red state is reachable but the check is blind to it.
- [Systematic plugin install stalls OpenCode bootstrap](../integration-issues/systematic-plugin-install-stalls-opencode-bootstrap-2026-09-04.md) — the incident whose fix produced items 4, 5, and 10.
- [#1528](https://github.com/fro-bot/agent/issues/1528) — items 2 and 8; [#1532](https://github.com/fro-bot/agent/issues/1532) — a redaction test whose fixture never truncates, so its assertion is trivially true.
