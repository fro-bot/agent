---
title: A present signal is not evidence of the effect it implies
date: 2026-08-23
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - A check confirms a field, path, symbol, or call exists rather than what it causes
  - An optional request field or a default decides the shape of a successful response
  - A typed call compiles and returns 2xx without performing the state transition it names
  - A path string is correct but resolves against an unexpected base directory
  - Completion is inferred from an occurrence count instead of the stated requirement
  - Research is written into a plan without recording that it was unverified
tags:
  - behavioral-verification
  - false-confidence
  - optional-fields
  - integration-boundaries
  - evidence-first
---

# A present signal is not evidence of the effect it implies

## Context

Four defects in one session shared a shape. In each, something was confirmed present — a request field, a path string, a typed call, a symbol — and its presence was treated as proof of an effect it never established.

**A request field that was removed as obsolete.** Research concluded that GitHub's `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` no longer needs `return_run_details: true`, and that conclusion was written into a plan as settled fact. The documentation says otherwise: `200` with run details when the flag is `true`, `204` with an empty body when it is not. The implementation required `parseWorkflowRun()` to succeed and returned `dispatch-rejected` otherwise, so **every successful dispatch would have reported as failed**. It passed type-check, lint, and 10,000+ tests. A pre-push review caught it; CI would not have.

**A path string that was correct.** The response file was written to a relative path, character-for-character the intended one. OpenCode resolved it against `instance.directory` rather than `RUNNER_TEMP`, landing it inside the checkout. Comparing the string proved the model transcribed it correctly and nothing about where the bytes went.

**A call that type-checked.** The v1 SDK permission reply compiled cleanly but omitted `query: {directory}`. That route returns `200` without settling the pending permission, so the responder looked correct and still hung the run to its execution deadline. The gateway already had a regression test pinning this exact behaviour.

**A symbol count read as dead code.** `detectArtifacts` and `detectArtifactsFromMessageParts` appear six times in `src/features/agent/streaming.ts`. That count was cited five separate times — three in session, twice by automated PR review — as proof that Unit 6 of the credential-removal plan never landed. The unit never asked for deletion. Its stated approach was to re-source `commentsPosted` from the finalize post and *keep autonomous-flow scraping intact*. Both halves had shipped.

## Guidance

Name the effect the change is supposed to produce, then verify that effect at the boundary where it occurs. Presence of the mechanism is not the effect.

**For an external API, read the response table before removing or adding a field.** Status code and body shape are usually a matrix, not a single row. An endpoint that returns `204` with no body on success will break any consumer that treats an unparseable body as failure. Establish success from the status, and treat response details as optional once it is established.

**For a filesystem write, assert the resolved location, not the string.** Exercise the real resolver and check where the file actually landed — inside the intended directory, outside the checkout. A path built by hand in a test is a second copy of the assumption under test.

**For an SDK call that drives a remote state transition, assert the transition.** A method that was invoked, accepted, and returned `200` has proven only that the request was well-formed. Test that the pending thing settles.

**For completion, read what the unit required.** A symbol count establishes that a name exists. An unticked checkbox establishes that nobody ticked it. Neither establishes that the required behaviour is missing — and where the requirement was deliberate retention rather than deletion, the surviving symbol is the evidence of success, not of failure.

**Record uncertainty in plans.** Research that has not been validated becomes implementation truth for whoever picks the plan up, with no signal that the claim was ever provisional. If a conclusion rests on a doc that was not read or an API that was not exercised, say so in the plan.

Type systems and large suites are structurally blind to this class. Every instance above turned on an optional field, a context-dependent default, or a symbol whose presence was never in question — none of which a compiler or a passing suite can distinguish from correctness.

## Why This Matters

The cost is asymmetric in both directions.

A false positive ships. The dispatch defect would have reported every successful run as rejected, on a command whose entire output is a success-or-failure verdict. The permission responder would have hung runs until their deadline while appearing to answer.

A false negative burns effort and compounds. The `detectArtifacts` misreading survived five independent passes, including two automated reviews that repeated it. Each pass treated the previous conclusion as corroboration rather than re-deriving it. Nobody read the unit's stated approach until the work was actually scheduled.

## When to Apply

- Integrating or changing an external API, especially around optional fields, defaults, and status codes
- Writing a file across a trust or directory boundary
- Driving an asynchronous or remote state transition through an SDK
- Judging whether an implementation unit landed
- Writing a research conclusion into a plan another person or session will implement
- Reviewing a change whose gates are green and whose behaviour is not directly asserted

## Examples

**Dispatch acceptance.** The flag is sent so GitHub returns run details, but acceptance is established by status, and details stay optional (`packages/gateway/src/github/dispatch.ts`):

```ts
const response = await octokit.request('POST .../dispatches', {
  ref: defaultBranch,
  return_run_details: true,
  inputs: {prompt: task},
})

if (isSuccessStatus(responseStatus(response)) === false) {
  return {outcome: 'dispatch-rejected', owner, repo}
}

const parsed = parseWorkflowRun(response)
if (parsed === null) return {outcome: 'accepted', owner, repo}
```

A `204` with no body now degrades the reply to omit the run link rather than claiming the dispatch was refused.

**Permission settlement.** `query: {directory}` is required for the route to settle the permission rather than silently succeed (`src/features/agent/execution.ts:170-175`):

```ts
await sessionClient.postSessionIdPermissionsPermissionId({
  path: {id: request.sessionID, permissionID: request.requestID},
  body: {response: 'reject'},
  query: {directory},
  signal: deadline.signal,
})
```

The assertion that matters is that the pending permission settles, not that the method was called.

**Deliberate retention documented at the symbol.** Unit 6's checkbox now carries the reason its symbols survive, so the next reader does not repeat the inference:

```text
Done by re-sourcing, not deletion. `metrics.incrementComments()` fires at
`src/harness/phases/finalize.ts:347` once the file-convention response is
delivered, and `detectArtifacts`/`detectArtifactsFromMessageParts` stay in
`src/features/agent/streaming.ts` for autonomous flows that self-post via
`gh`. The two sources are mutually exclusive per run.
```

## Related

- [A check reports clean for the part of the world it cannot observe](checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — the adjacent failure mode, and the distinction is worth keeping straight. That doc covers checks that observe a *narrower population* than believed: the question is what the check could see at all. This one covers cases where the thing was fully observed and the wrong property of it was read. A check can have perfect coverage and still confirm presence where effect was needed.
- [A gate that cannot fail manufactures confidence](non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — gates with no reachable red state.
- [Dependency majors that CI cannot verify](../best-practices/dependency-majors-that-ci-cannot-verify-2026-08-22.md) — the same false confidence where the affected behaviour is release-only or runtime-only, so a green suite proves nothing about it.
- [Verify the signal before implementing the plan](evidence-first-scope-correction-under-incomplete-signals-2026-08-08.md) — verifying a premise before building on it.
- [A relative response-file write silently lost a review](../security-issues/relative-response-file-write-silently-lost-review-2026-08-21.md) — the full incident behind the path-resolution instance.
- [`Promise.race` bounds the await, not the subprocess](../best-practices/promise-race-bounds-await-not-subprocess-2026-07-30.md) — a bounded wait that does not bound the work it appears to.
