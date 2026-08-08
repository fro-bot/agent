---
title: "refactor: Make the harness improve when the models do"
type: refactor
status: active
date: 2026-08-07
---

# refactor: Make the harness improve when the models do

## Summary

Audit the harness against Sutton's Bitter Lesson and remove the structure that will cap capability as models improve, without touching the structure that constrains what the agent may cause. The audit found the ceiling is not where expected: the prompt is disciplined, but the harness cannot represent what happened during a failed attempt, and there is no way to measure whether any agent-facing change helped or hurt.

## Problem Frame

Sutton's essay makes two claims that are usually collapsed. The first is that general methods leveraging computation beat hand-encoded human knowledge over time. The second, and the one that matters here, is: "We want AI agents that can discover like we can, not which contain what we have discovered."

A harness is not a learning system, so the essay does not apply uniformly. The distinction that makes it actionable:

| Structure constrains         | Example                                            | Durability                    |
| ---------------------------- | -------------------------------------------------- | ----------------------------- |
| How the model **thinks**     | prescribed step order, mandated tool sequence      | Rots as models improve        |
| What the model may **cause** | auth gates, target binding, one-response invariant | Durable at any model strength |

"Post exactly one comment per invocation" is an execution contract and stays. "Before investigating any issue, first call `session_search`" encodes our theory of how to work, and caps a model that would do better unaided.

The audit covered prompt architecture, execution and error handling, routing and delivery, and config and tooling. Three findings reframed the work:

1. **The prompt is not where the ceiling is.** Emphasis markers across `packages/runtime/src/agent/prompt.ts` and `packages/runtime/src/agent/prompt-thread.ts` total 16 (7 MUST, 5 REQUIRED, 2 ONLY, 1 NEVER, 1 EXACTLY), and composition is roughly 35% environment facts, 35% safety and output contract, 20% reasoning scaffold, 10% workaround. Marker count is weak evidence on its own — a prompt can be bloated with redundant constraints and zero emphatic language — so the conclusion rests on the composition breakdown and on the specific redundancy identified in finding 4, not on the count. What the count rules out is an emphasis-escalation spiral, not bloat generally. A broad prompt diet is therefore unjustified; one targeted removal is.
2. **The harness cannot describe its own failures.** The retry path does not distinguish failure before prompt acceptance, failure during inference, failure after external side effects, or failure after valid output was written. Only a successful attempt assigns `final`. An attempt that already pushed a commit can be retried as though it never ran.
3. **Nothing measures agent outcomes.** 237 test files, zero agent-outcome evaluations. Every `eval`/`golden` match in the tree is inside vendored `.slim/clonedeps`. Coverage of plumbing is strong; coverage of whether the agent is any good is absent.
4. **The prompt prescribes work the harness already did.** `packages/runtime/src/agent/prompt.ts:219-230` instructs the model to run `session_search` and `session_read` before investigating, but `src/harness/phases/session-prep.ts:52,93` already called both and injected the results as `priorWorkContext`. Every run pays for the retrieval, receives the answers, and is then told to repeat it.

## Assumptions

These are load-bearing and unproven. Each is a place the plan could be wrong.

- Models improve in ways that make current scaffolding unnecessary, rather than in ways that require different scaffolding. If capability shifts sideways instead of upward, removals may need to be re-added in another form.
- Outcome quality is measurable enough for subjective work like code review. U1 assumes hard executable gates capture most of what matters; if they do not, the corpus produces confident noise.
- Removing a prescribed workflow raises capability rather than merely reducing predictability. Less prescription is not automatically better; it is a bet that the model's judgment beats ours.
- The OpenCode substrate keeps exposing the signals U3, U4, and U7 depend on. A substrate change could invalidate parts of this plan.
- The think/cause distinction is separable in practice. It is not perfectly clean — the response protocol constrains output format (a cause constraint) while also shaping how the model approaches the task (a think constraint). Where an item is genuinely both, the plan treats it as durable and leaves it alone.

## Requirements

- R1. Changes to prompt, model, plugin set, or OpenCode pin can be evaluated against a frozen baseline before merge.
- R2. Recovery decisions account for whether an attempt produced external side effects.
- R3. Error classification prefers structured provider signals; prose matching is a bounded, instrumented fallback.
- R4. The prompt states what is available rather than prescribing a working method.
- R5. Context selection surfaces the newest evidence rather than the oldest.
- R6. Upstream carries and model-weakness accommodations carry explicit removal conditions — carries in a ledger, code accommodations alongside the code that owns them.
- R7. Execution and retry policy has exactly one owning implementation.
- R8. No safety structure identified as durable is weakened by this work.

## Scope Boundaries

- No changes to auth, fork, or draft gates (`src/features/triggers/skip-conditions-pr.ts`).
- No changes to review guards blocking APPROVE on self or fork PRs (`src/features/reviews/review-guards.ts`).
- No changes to the response-file trust boundary — target and surface derive from the trusted event, never from model output.
- No changes to the exactly-one-response invariant, credential scrubbing, env filtering, the execution deadline as a cost bound, or fail-closed delivery.
- No changes to the `.github/workflows` strip in the integration commit — a hard GitHub App platform constraint.
- No simplification of the four-layer `src/` architecture or the XML-tagged prompt sections. Both express dependency direction and authority boundaries; neither constrains model intelligence.
- No broad prompt diet. The measurement does not support one.
- No conversion of timing constants into configuration. Adaptive timeouts without a hard deadline produce indefinite hangs.
- No restoration of `gh` credentials to enable model-driven retrieval. That trades a real security boundary for a theoretical flexibility gain.

### Deferred to Separate Tasks

- **Release-integration driver split.** `packages/harness/prompt.txt` uses the model as a shell-script runner: it prescribes an exact clone, fetch, merge, squash, strip, build, verify, and push transcript. That is a genuine ceiling and the largest one this plan does not close — deferring it is a sequencing decision, not a judgement that it is unimportant. The correct split is that code owns the deterministic, security-sensitive procedure and the model owns only merge-conflict resolution, where judgement is actually required. It is deferred because it restructures a production release pipeline that shipped three failed attempts this week, and because it must be dry-run against multiple upstream releases before cutover. This plan is a first pass, not a full harness extraction. Track as a named follow-on with that boundary.
- Deleting the vestigial `extractCommand` action/args split (`src/features/triggers/mention-command.ts`). Its result is consumed only by a log statement at `src/harness/phases/routing.ts:71`. Cleanup, not a ceiling.

## Context & Research

### Relevant Code and Patterns

- `packages/runtime/src/agent/error-format/format.ts` — already contains the target pattern. `classifyContextOverflowError` and `classifyProviderAuthError` match structured signals (exact error `name`, `retry-status.reason`, HTTP 402). `isLlmFetchError` (`:86-95`) and `isAgentNotFoundError` (`:129-136`) match prose. The fix extends a pattern already present.
- `src/harness/phases/session-prep.ts:52,93` — already calls `listSessions` and `searchSessions` and injects results as `priorWorkContext`.
- `src/features/agent/live-probe-1.17.20.test.ts` — exercises the real SDK, event, and poll path. The correct seed for an eval runner; it tests transport, not effectiveness.
- `src/features/context/graphql.ts:22,66,77,87` — uses `first:` for comments, commits, and files.
- The current eval corpus has exactly two scenarios, with PR-review-specific types, runner logic, and gates. U1 generalizes the eval-only surface rather than changing production harness files.
- `PromptOptions` can inject `sessionContext`, `isContinuation`, `currentThreadSessionId`, `logicalKey`, and `hydratedContext` without GitHub calls; `EvalExecution` injection already supports deterministic missing/malformed response tests.
- The eval runner currently hardcodes the `pr-review` response surface; U1 replaces that local choice with production `resolveResponseSurface`.
- Duplicate execution stacks:

| Path                                      | Live                                        | Lines |
| ----------------------------------------- | ------------------------------------------- | ----- |
| `src/features/agent/execution.ts`         | yes, via `src/harness/phases/execute.ts:14` | 268   |
| `packages/runtime/src/agent/execution.ts` | exported, parallel                          | 245   |
| `src/features/agent/retry.ts`             | yes                                         | 542   |
| `packages/runtime/src/agent/retry.ts`     | parallel                                    | 131   |

`MAX_LLM_RETRIES = 4` is declared in both `src/features/agent/retry.ts:257` and `packages/runtime/src/agent/retry.ts:43`.

### Institutional Learnings

- `docs/solutions/logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md` — cleanup may degrade metadata but must never rewrite an accepted outcome. Directly constrains U3.
- `docs/solutions/logic-errors/failed-run-reported-success-with-no-delivery-surface-2026-08-07.md` — exit codes must not encode a claim ("the failure was reported") that may be false.
- `docs/solutions/best-practices/response-file-is-untrusted-input-2026-07-11.md` — model output never selects its own delivery target.
- `docs/solutions/workflow-issues/integrate-push-strips-workflow-files-2026-08-07.md` — a pipeline step that works only because the agent improvises is not a working step. Why `packages/harness/src/prompt-template.test.ts:65-92` must keep exact assertions.

### External References

- Sutton, _The Bitter Lesson_ — http://www.incompleteideas.net/IncIdeas/BitterLesson.html
- Anthropic, _SWE-bench Sonnet_ — https://www.anthropic.com/engineering/swe-bench-sonnet — "The scaffold allows the model to use its own judgment of how to pursue the problem, rather than be hardcoded into a particular pattern or workflow."
- Anthropic, _Building Effective Agents_ — https://www.anthropic.com/engineering/building-effective-agents — simple composable patterns over frameworks; routing, parallelization, and evaluator-optimizer workflows still help with frontier models.
- Anthropic, _Writing Tools for Agents_ — https://www.anthropic.com/engineering/writing-tools-for-agents — leverage lives in tool ergonomics and context economy; return only high-signal information.

Sourcing caveat: the widely repeated claim that named products "deleted scaffolding after a model upgrade" did not survive a source check. This plan does not rest on it.

## Key Technical Decisions

- KTD1. Build a regression corpus, not an evaluation platform. An over-built eval becomes the ceiling it was meant to remove. Both architecture reviews flagged this independently.

- KTD2. Evals assert outcomes, never method. No assertion that the agent called a particular tool, used N steps, or reasoned in a given order. Asserting method fossilizes current behavior more effectively than any prompt.

- KTD3. The harness decides whether recovery is safe; the model decides how to repair the task. Side-effect safety is a code concern. Task repair, given a structured account of the failure, is a model concern. Today the harness does both.

- KTD4. Prose error matching is demoted, not deleted. Some JavaScript network failures genuinely arrive without stable structured fields. Removing the fallback blind would convert recoverable failures into terminal ones.

- KTD5. Context caps stay; page selection changes. The caps are cost, latency, and prompt-injection controls. Fetching the oldest N comments is the defect.

- KTD6. Timing constants stay fixed. The 500 ms poll, two-poll race guard, three grace cycles, and bounded backoff are ordinary reliability controls. Only the 90-second silence-as-failure proxy encodes a model assumption, and the fix is protocol signals rather than configuration.

- KTD7. Prompt test assertions split by mutability. Contract assertions (response-file path, verdict tokens, one-response rule, credential and push semantics, workflow strip) stay exact. Only coaching copy is retargeted.

## Acceptance Examples

- AE1. A prompt edit is merged only after the eval corpus runs against the frozen baseline and reports no regression on hard gates.
- AE2. An attempt that pushes a commit and then fails is not retried by replaying the original prompt; the harness detects the side effect and reconciles.
- AE3. A provider failure arriving with a structured error name is classified without any prose match, and the classification-path metric records `structured`.
- AE4. A provider failure arriving with no structured fields still classifies via bounded prose fallback, and the metric records `fallback`.
- AE5. An agent run where prior session context is irrelevant still reaches the correct task outcome; irrelevant context does not degrade the answer.
- AE6. A PR with 80 comments where the decisive evidence is in the newest 10 surfaces that evidence in the assembled context.
- AE7. A clean PR produces a PASS verdict with no invented blocking findings.

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

Current recovery collapses every failure into one boolean, losing the facts needed to decide safely:

```mermaid
graph TB
  A[attempt fails] --> B{shouldRetry?}
  B -->|true| C[resend continuation prompt]
  B -->|false| D[terminal]
  C -.->|side effects unknown| E[may replay pushed commit]
```

Proposed shape — a discriminated outcome the recovery policy can reason over. The signal investigation in U3 dropped `completed_with_side_effects`, because no observable input can populate it honestly; side-effect risk is carried by the credential axis instead, and the decision the lattice actually drives is _resend versus continue_:

```mermaid
graph TB
  A[attempt ends] --> B[classify outcome]
  B --> C[submit_failed]
  B --> D[turn_failed_retryable]
  B --> E[turn_failed_terminal]
  B --> F[timeout]
  B --> G[completed]
  C --> H[resend original prompt]
  D --> I[continuation carrying structured failure]
  E --> J[stop]
  F --> J
  G --> K[done]
  I -.gated by.-> L{{deliverable present?}}
  L -->|yes| M[reconcile, never re-run]
```

## Implementation Units

U1 and U2 are independent and may run in parallel. U3 → U4 → U7 is a serial chain. U5 cannot start before U1e, because the continuation scenarios are its only meaningful verification path — without them, prompt edits are unverifiable opinion. U6 is independent but should be validated against the U1 corpus once that exists.

```mermaid
graph TB
  U1[U1 eval corpus + baseline] --> U1e[U1e continuation scenarios]
  U1e --> U5[U5 prompt: retarget tests, remove ritual]
  U1 -.validates.-> U6[U6 context page selection]
  U2[U2 consolidate execution stacks] --> U3[U3 structured attempt outcomes]
  U3 --> U4[U4 structured-first classification]
  U4 --> U7[U7 liveness signals + carry ledger]
```

If U1e slips or is abandoned, U5 must not proceed on judgement alone — that is the failure mode where prompt refactors become unverifiable edits.

- [ ] **U1. Differential eval corpus and baseline**

**Goal:** Make agent-facing change measurable before anything is deleted.

**Requirements:** R1

**Dependencies:** None

**Files:**

- Create: `evals/scenarios/` (fixture repos and normalized event payloads)
- Create: `evals/runner.ts`
- Create: `evals/gates.ts`
- Test: `evals/runner.test.ts`
- Test: `evals/gates.test.ts`

**Approach:**

- **At-most-eight hard cap; seven live scenarios maximum.** Eight is capacity, not a target or a requirement to run eight live models. The planned live shape is: existing clean PR; planted defect; issue answer; prior-work relevant; prior-work irrelevant; newest-thread evidence; and an opt-in implementation task. The malformed/missing response case is deterministic injected-execution runner coverage, not a live-model scenario.
- The current two PR-review scenarios become the first two entries in the generalized corpus. Inputs use a small discriminated surface model; free-prose outcome expectations use required signal groups only, and absence is asserted only through single-valued structured fields such as a verdict.
- Continuation scenarios are **U1e**. They synthesize frozen `sessionContext` and prior-work input through `PromptOptions` rather than running two nondeterministic live turns.
- The implementation scenario is optional-live behind `FRO_BOT_EVAL_ALLOW_MUTATION=1`. It uses an `issue_comment` event with `file-convention` delivery, fixture-scoped allowed mutation paths, and a zero-setup `.mjs` / `node --test` fixture. It never uses `workflow_dispatch` or provisions GitHub credentials; mutation detection is fixture-scoped, not host containment.
- Keep production harness files out of U1's planned scope. U1 stays in `evals/` unless a live scenario exposes a separate real defect; using production `resolveResponseSurface` does not authorize changing its implementation here.
- No per-scenario hooks, builders, scorers, judge, dashboard, second runner, retry layer, or parallel execution. Adding coverage beyond eight requires deleting an existing scenario first.
- Seven frozen live scenario definitions run through the real `executeOpenCode` path when enabled, against disposable fixture repos.
- The real path is **not** "just a test": it spins up an OpenCode server, creates a session, and runs a live SDK session. `src/features/agent/live-probe-1.17.20.test.ts` shows the required shape — gated execution, isolated `HOME`/`PATH`/`XDG_*`, and a pinned low-cost model. Budget the server lifecycle, env isolation, and model-cost strategy as part of this unit rather than discovering them during implementation.
- The runner is **credentialless**. `file-convention` delivery covers the delivery surface only, not every GitHub-backed action the agent might attempt, so no GitHub token is provisioned to the eval environment at all. The implementation case remains constrained by fixture-scoped allowed paths rather than a claim of host containment.
- Fixture content is **untrusted input**. Scenario repos and event payloads carry adversarial text by design (a PR body containing instructions is a legitimate scenario), so the runner treats fixtures as a prompt-injection surface and never grants them more authority than a real untrusted PR would have.
- Hard executable gates cover response parsing, the expected structured verdict/outcome, exactly one delivery, required-signal presence, mutation safety, secret leakage, and scenario-specific executable outcomes where applicable. These expectations remain independent of response surface.
- Corpus law: gates may assert signal presence in free prose, never signal absence. Presence proves access, not application; correct rejection contains the same token. Absence may be asserted only over single-valued structured fields such as a review verdict.
- A scenario that does not pass persists its response body to the gitignored diagnostics path. A failed quality gate without the body is unreproducible and cannot be recalibrated honestly.
- Record the full tuple per run: model, OpenCode build, plugin versions, prompt hash, scenario commit, cost, duration. Cost and duration are advisory provenance, never gates.
- Scenario execution uses the injected `EvalExecution` path for missing/malformed response tests; no live model is required for those cases.

**Patterns to follow:**

- `src/features/agent/live-probe-1.17.20.test.ts` for driving the real SDK and poll path.

**Test scenarios:**

- Happy path: a scenario with a planted defect scores a blocking verdict naming the defect.
- Happy path: a clean-PR scenario scores PASS and fails if the agent invents findings.
- Happy path: an issue-answer scenario reaches the expected answer outcome from known files.
- Continuation U1e: relevant frozen prior work still reaches its expected outcome.
- Non-degradation U1e: irrelevant frozen prior work still reaches the correct task outcome; no gate checks whether the response mentioned that context.
- U1f newest-comment scenario: discriminate through the expected `request-changes` frontmatter verdict, not forbidden stale-marker text. Decisive newest evidence must not be inferable from the diff alone; otherwise the case measures review skill, not surfaced-evidence use. The live scenario tests use of surfaced evidence; deterministic GraphQL tests own selection and pagination correctness.
- Optional live: the implementation fixture changes only allowed paths, passes its zero-setup test, and delivers through the file convention.
- Deterministic runner test: injected missing and malformed responses fail the delivery/parse gates without requiring a live model.
- Error path: a scenario whose fixture repo is missing fails loudly with the scenario name, not silently.
- Integration: the runner captures the full provenance tuple and writes a JSON report consumable in CI.

**Verification:**

- Baseline captured for every enabled live scenario against the current prompt and model, with the mutation case included only when explicitly enabled, and committed as the reference artifact.
- No gate asserts tool usage, step count, or reasoning order.
- Cost and duration are present in provenance but do not gate acceptance.

- [x] **U2. Consolidate duplicate execution stacks**

**Goal:** One owning implementation of execution and retry policy.

**Requirements:** R7

**Dependencies:** None (may run parallel to U1)

**Files:**

- Modify: `src/features/agent/execution.ts`
- Modify: `src/features/agent/retry.ts`
- Modify: `packages/runtime/src/agent/execution.ts`
- Modify: `packages/runtime/src/agent/retry.ts`
- Modify: `packages/runtime/src/agent/index.ts`
- Test: `src/features/agent/opencode.test.ts`

**Approach:**

- Establish which stack owns execution and retry policy, then remove or reduce the other to a re-export.
- Collapse the duplicated `MAX_LLM_RETRIES` and backoff constants to a single declaration.
- `src/features/agent/execution-adapter.ts` is an **abandoned consolidation attempt**: it delegates to the runtime implementation but is imported nowhere outside its own test. Its existence is evidence this merge was already started once. Decide deliberately whether to finish that direction or delete the adapter — do not leave a third partial path.
- Precision on the duplication: `src/features/agent/execution.ts:53` genuinely defines `executeOpenCode` and is the live path via `src/features/agent/index.ts:18`. The runtime copy at `packages/runtime/src/agent/execution.ts` is separately exported from `packages/runtime/src/agent/index.ts` and serves its own consumers. These are parallel implementations with different consumers, not one wrapper around the other, which makes consolidation higher-risk than a mechanical merge.

**Execution note:** Characterization-first — capture current behavior before collapsing, since both stacks are exported.

**Patterns to follow:**

- The runtime-owns-primitive split already used for `packages/runtime/src/agent/prompt.ts`, re-exported by the action layer.

**Test scenarios:**

- Happy path: the live Action path resolves to the owning implementation and existing execution tests pass unchanged.
- Edge case: importing the retry constants from either entry point yields the same value.
- Integration: a full execute-phase run produces byte-identical behavior to the pre-consolidation baseline.

**Verification:**

- Exactly one declaration of retry count and backoff exists in the tree.
- No public export is silently dropped.

- [x] **U3. Structured attempt outcomes and recovery policy**

**Goal:** Make recovery decisions account for observed side effects.

**Requirements:** R2, R8

**Dependencies:** U2

**Files:**

- Modify: `src/features/agent/retry.ts`
- Modify: `src/features/agent/execution.ts`
- Modify: `src/harness/phases/execute.ts`
- Test: `src/features/agent/opencode.test.ts`

**Signal investigation outcome (2026-08-07): the premise was refuted.**

This unit required naming the side-effect signal before building the lattice, and explicitly allowed for the answer being negative. It is. There is **no sufficient pre-replay detector** for "this attempt caused an external effect."

Evidence, verified against source:

- `prsCreated`, `commitsCreated`, and `commentsPosted` (`src/features/agent/streaming.ts:22-26`) are populated by artifact detection over SSE events and tool-output text, not by a write confirmation. They evidence _attempted_, never _landed_.
- They read empty exactly when an attempt dies mid-flight, which is the unsafe direction: a write that reached GitHub before the stream died leaves the counters at zero, and a replay keyed on them would duplicate the effect.
- The signals that genuinely prove an effect — the return values of `createCommit`, `postComment`, `submitReview`, and `runResponsePost` — exist only in the delivery/finalize path, downstream of the retry decision.

The investigation also corrected the shape of the defect. `src/features/agent/execution.ts:167` already sends `CONTINUATION_PROMPT` on every attempt after the first, so the harness never resends the original prompt. The replay hazard is not the harness repeating an instruction — it is the continuation itself, which is a fixed string that both misstates the cause and invites redoing work:

> "The previous request was interrupted by a network error (fetch failed). Please continue where you left off. If you were in the middle of a task, resume it."

Only three error types are retryable (`packages/runtime/src/agent/error-format/format.ts`): `rate_limit`, `llm_timeout`, and `llm_fetch_error`. The prompt asserts a fetch failure for all of them, so it states a cause the harness did not observe in two of the three cases, and "resume it" is the instruction most likely to make a model repeat a write that already landed. This is the unit's core defect: a fabricated narrative substituted for the structured signal the harness already holds.

Two signals _are_ trustworthy, and the design rests only on these:

1. **Credential disposition.** `resolveResponseDelivery` (`packages/runtime/src/agent/response-delivery.ts`) withholds the GitHub credential entirely for `pull_request`, `issue_comment`, and `issues`. On those events the agent structurally cannot write to GitHub, so undetectable external effects are confined to credential-provisioned runs (`workflow_dispatch`, `schedule`, and the unknown-event default).
2. **Response-file presence.** `src/harness/phases/execute.ts:117` removes the response file before the run, so its presence after a failed attempt proves the model produced a deliverable during _this_ attempt.

**Approach:**

- **Separate the two operations the boolean conflated.** The hazard was never "retry" — it is _resending the original prompt_, which redoes work. A continuation carrying the structured failure and the remaining objective is safe even when effects occurred, because it does not repeat the original instruction. The lattice exists to decide between resend, continue, and stop.
- Replace the boolean `shouldRetry` with a discriminated outcome: `submit_failed`, `turn_failed_retryable`, `turn_failed_terminal`, `timeout`, `completed`.
- **`completed_with_side_effects` is dropped.** Nothing can populate it honestly. A variant whose only inputs are inference-derived counters would assert a fact the harness cannot observe, which is the "wider lattice resting on false confidence" this unit was told to avoid. Side-effect risk is carried instead by the credential axis, which is structural.
- Carry `deliverablePresent` and `credentialProvisioned` as orthogonal facts rather than outcome variants — both are observable, and neither describes _why_ the turn ended.
- Recovery policy: `submit_failed` resends the original prompt (the sole case where nothing was accepted, so nothing ran); `turn_failed_retryable` sends a continuation carrying the structured failure and never resends; a deliverable present reconciles rather than re-runs; terminal and timeout stop; anything unclassifiable is treated as effect-bearing and never resends.
- **Replace the fixed continuation string with the observed failure.** The continuation must name the actual error type rather than asserting a fetch failure, and must not instruct the model to "resume" blindly. On a credential-provisioned event it should direct the model to verify what already landed before acting, since that is exactly the case where an unobserved write may have succeeded.
- **Outcome classification never upgrades run status.** The outcome describes what happened, not whether the run succeeded. A failed attempt remains a failed run unless delivery independently succeeded, preserving the invariant from `docs/solutions/logic-errors/failed-run-reported-success-with-no-delivery-surface-2026-08-07.md`: an exit code must not encode a claim that may be false.
- **Delivery bookkeeping is authoritative over recovery.** If a response was already delivered, recovery must not produce a second one. The exactly-one-response invariant is enforced by delivery state, never inferred from the outcome variant.
- **Unknown is treated as side-effect-bearing.** Where observability is absent, the policy assumes effects occurred and declines to resend.
- **Accept that observability is partial.** Effects outside the harness's inspection surface are undetectable by construction. The policy is safe only because unknown declines to resend; it must never be tightened into "unknown means no side effects."
- Accumulate artifacts from failed attempts so a later attempt can see what already happened.
- Instrument the combined attempt budget across OpenCode's internal retries and the harness's own.

**Execution note:** Test-first. The dangerous cases are side-effect-bearing failures, and those tests should exist before the policy changes.

**Patterns to follow:**

- `packages/runtime/src/agent/error-format/format.ts` discriminated `ErrorType` union.
- The terminal-outcome preservation rule in `docs/solutions/logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md`.

**Test scenarios:**

- Happy path: a transport failure before prompt acceptance resends the original prompt.
- Happy path: an interrupted turn sends a continuation containing the structured failure rather than the original prompt.
- Error path: a failed attempt on a credential-provisioned event never resends, because effects are undetectable there.
- Error path: an attempt that wrote a valid response file and then failed does not overwrite that delivery.
- Edge case: a terminal provider error stops immediately without consuming the retry budget.
- Edge case: an unclassifiable failure does not resend the original prompt.
- Integration: the combined OpenCode-plus-harness attempt count is recorded in the run summary.

**Verification:**

- No path resends the original prompt after the prompt was accepted.
- The continuation prompt carries the structured failure, not a generic string.
- No branch consults `prsCreated`, `commitsCreated`, or `commentsPosted` to decide recovery.

- [x] **U4. Structured-first error classification**

**Goal:** Stop parsing provider prose to make control-flow decisions.

**Requirements:** R3, R6

**Dependencies:** U3

**Files:**

- Modify: `packages/runtime/src/agent/error-format/format.ts`
- Modify: `src/features/agent/streaming.ts`
- Modify: `src/features/comments/error-format.ts`
- Test: `packages/runtime/src/agent/error-format/format.test.ts`

**Investigation outcome (2026-08-08): two assumptions corrected, and the real conversion target is different.**

The structured surface was estimated as roughly `type`, `reason`, `name`, `status`, `code`, `message`, `resetAt`. Verified against the vendored SDK types, `session.error` payloads expose only `name` plus a per-variant `data` object:

- `ProviderAuthError` — `{name, data: {providerID, message}}`
- `ContextOverflowError` — `{name, data: {message, responseBody?}}`
- `ApiError` — `{name: 'APIError', data: {message, statusCode?, isRetryable, responseHeaders?, responseBody?, metadata?}}`

There is no top-level `type`, `reason`, or `resetAt` on the SDK error. `reason` and `resetAt` exist only on the harness-normalized retry-status path, and `status` appears as `data.statusCode`. The classification tiers below are written against the real shape.

The prediction that network failures and agent-not-found are not convertible held. Neither has a structured SDK marker, so both prose matchers stay. Their true reach is also narrower than it appears: at `streaming.ts` the generic branch runs `isLlmFetchError` over `normalizeSessionError`'s output, which is a synthesized `provider=…; name=…; status=…; code=…` summary that deliberately excludes raw message text — so that call is already matching structured fields, via regex over a formatted string. Genuine prose matching survives only at `execution.ts` and `prompt-sender.ts`, where the input is a Node/undici transport exception with no SDK payload at all.

The conversion target the estimate missed is **`ApiError.data.isRetryable`** — a required boolean the SDK always populates, consumed nowhere in the harness. Today an `APIError` whose summary matches no pattern and is not a 429 falls through to `createAgentError(…)`, which is `retryable: false`. When such an error carries `isRetryable: true`, the provider has stated the request may succeed on retry and the harness classifies it terminal anyway. That is the concrete instance of deciding from inference while a structured signal sits unread.

**Approach:**

- Classification order: exact structured signal, then stable error `name`/`data.statusCode`/`data.code`, then narrowly bounded prose fallback, then generic unclassified failure.
- Extend the pattern already established by `classifyContextOverflowError` and `classifyProviderAuthError`. Note that `classifyQuotaError` is already the hybrid shape this unit generalizes: structured-first on `statusCode === 402` and an allowlisted `code`, with a bounded message fallback behind them.
- **Read `ApiError.data.isRetryable` in the generic branch.** It is authoritative for retryability where present, and it applies only after the terminal classifiers have declined, so it can never reach an auth or quota failure.
- **Keep both prose matchers.** Neither has a structured replacement. Record that removal condition beside each one in code rather than in the plan, so it travels with the fallback.
- **The removal gate is correctness, not coverage.** A high structured-coverage percentage can coexist with the remaining fallback cases being precisely the critical ones. Removing a fallback requires evidence that the specific error shapes it handles are covered structurally — not that the aggregate percentage looks good.
- Emit a classification-path metric (`structured` / `name` / `fallback` / `unclassified`) into the job summary as a structured local metric, not external telemetry. This is net-new plumbing: the existing observability layer records error `type`, `message`, and `recoverable`, but nothing records how a classification was reached.
- Keep the prose fallback until there is evidence the shapes it handles are covered structurally. The metric is what produces that evidence; until it has run against real traffic, no fallback removal is justified.
- **Auth and quota failures fail closed.** Reclassification must never move a provider-auth or quota failure from terminal to retryable. Retrying a credential failure burns credentials and produces noise; absent an explicit credential-refresh path, these stay terminal regardless of what the structured signal suggests.

**Patterns to follow:**

- `classifyProviderAuthError` in `packages/runtime/src/agent/error-format/format.ts`.

**Test scenarios:**

- Happy path: a structured provider error classifies without touching prose patterns, and the metric records `structured`.
- Happy path: an `APIError` carrying `isRetryable: true` that matches no prose pattern classifies as retryable rather than falling through to a terminal configuration error, and the metric records `structured`.
- Happy path: an error with a stable `data.statusCode` or `data.code` but no recognized `name` classifies at the name/code tier.
- Edge case: an error with neither structured fields nor a matching prose pattern yields `unclassified` rather than a wrong terminal verdict.
- Error path: a transport failure with no SDK payload still classifies as retryable via fallback, and the metric records `fallback`.
- Error path: `isRetryable` is never consulted for an auth or quota failure, because the terminal classifiers claim those first — asserted directly, not left to branch ordering.
- Integration: the classification path appears in the job summary for a full run.

**Verification:**

- No classifier reachable from control flow depends on prose when a structured signal for the same decision exists.
- Retry and terminal decisions are unchanged for every currently-covered error shape, except an `APIError` with `isRetryable: true` that previously became a terminal configuration error.
- `provider_auth_error` and `quota_exceeded` remain terminal under every input, including one carrying `isRetryable: true`.

- [ ] **U5. Retarget prompt assertions and remove the redundant session ritual**

**Goal:** Stop prescribing a working method the harness already performed.

**Requirements:** R4, R8

**Dependencies:** U1e (continuation baseline required before prompt changes)

**Files:**

- Modify: `packages/runtime/src/agent/prompt.ts`
- Modify: `packages/runtime/src/agent/prompt.test.ts`
- Modify: `packages/runtime/src/agent/prompt-thread.test.ts`
- Test: `packages/runtime/src/agent/prompt.test.ts`

**Approach:**

- Split prompt assertions by an **enumerated** contract inventory rather than judgement. The following must remain exact assertions, and the unit is not complete until each is confirmed still exact: the response-file path; the verdict token set; the exactly-one-response rule; the `gh`-unavailable statement in `file-convention` mode; the non-posting prohibition in `responseDelivery: 'none'`; the delivery-mode authority over user-supplied instructions; and the bot identification marker requirement. Everything outside that list is coaching copy and may become behavioral.
- Enumerating rather than judging is deliberate: a fuzzy split lets a test refactor silently downgrade a contract assertion, which would make a later prompt edit look safe while relaxing a boundary.
- Replace the prescribed sequence at `packages/runtime/src/agent/prompt.ts:219-230` with an affordance stating that prior session context may be provided and the session tools are available when further history would help.
- Consolidate delivery rules that currently appear in multiple sections into one authoritative statement.
- Keep the completion-summary requirement. The automatic writeback does not capture qualitative decisions; evaluate that gap separately.
- One block per change, each measured against the U1 baseline.

**Patterns to follow:**

- Existing semantic substring assertions in `packages/runtime/src/agent/prompt.test.ts`.

**Test scenarios:**

- Happy path: the prompt still states the response-file path, verdict enum, and one-response rule exactly.
- Happy path: the prompt no longer mandates a tool call order.
- Edge case: `responseDelivery: 'none'` still produces the silent-run contract unchanged.
- Edge case: `file-convention` mode still states that `gh` is unavailable.
- Integration: eval corpus shows the relevant prior-work scenario still reaches the expected outcome.
- Integration: the eval corpus scenario with irrelevant prior work still produces the correct outcome; no gate inspects whether prior work was mentioned.

**Verification:**

- `packages/harness/src/prompt-template.test.ts` is untouched and still pins the workflow strip and its ordering.
- No safety or output-contract assertion was relaxed.

- [ ] **U6. Context page selection**

**Goal:** Surface the newest evidence rather than the oldest.

**Requirements:** R5

**Dependencies:** None

**Investigation outcome (2026-08-08): three premises corrected, and the change is smaller than written.**

The approach warned this is "not a local edit" because `budget.ts` assumes a forward-ordered capped list. It does not. `budget.ts` performs no list slicing or reordering at all — its only `slice` calls are byte-level body truncation and `oid.slice(0, 7)` for display. The formatters iterate whatever list they are given, and the truncation notice is driven by a `commentsTruncated` boolean rather than by position. The budget layer needs no change.

The file list was incomplete. `fallback.ts` is the REST hydration path and applies the same `.slice(0, max)` across five collections. Changing only the GraphQL path would leave oldest-first selection in place whenever the fallback fires — a silent split where the two paths disagree about which evidence the model sees.

Files have no temporal dimension. `ContextFile` is `{path, additions, deletions, status?}`, and a pull request's file list is a set rather than a timeline. "Newest files" is not a meaningful selection, so taking the tail would substitute one arbitrary subset for another while appearing to be an improvement. Only comments and reviews carry `createdAt`; commits have a real chronological order in a pull request even without a timestamp field.

**Files:**

- Modify: `src/features/context/graphql.ts`
- Modify: `src/features/context/pull-request.ts`
- Modify: `src/features/context/issue.ts`
- Modify: `src/features/context/fallback.ts`
- Test: `src/features/context/graphql.test.ts`

**Approach:**

- Change comment, review, and commit selection from oldest-first to newest-tail while preserving every cap in `src/features/context/types.ts`. Files are excluded: no timestamp exists, so recency cannot be expressed for them.
- Apply the same tail selection on the REST fallback path so both hydration paths surface the same evidence.
- `last:` returns the final N of a connection in its natural ascending order, so the returned lists stay chronological. Formatters, truncation math, and the `*Truncated` booleans are unaffected — those compare a total count against a length, not a position.
- Keep the truncation disclosure in the assembled prompt so the model knows the set is partial.
- Leave `budget.ts` alone.

**Patterns to follow:**

- Existing budget and truncation handling in `src/features/context/budget.ts`.

**Test scenarios:**

- Happy path: a thread longer than the comment cap yields the newest comments up to the cap, still in chronological order.
- Happy path: reviews and commits past their caps yield the most recent entries.
- Edge case: a thread shorter than the cap is unchanged.
- Edge case: an empty comment set produces no error and no misleading truncation notice.
- Edge case: the REST fallback path selects the same tail as the GraphQL path for an over-cap thread.
- Regression: files remain path-ordered and unaffected.

The U1f newest-comment eval scenario remains in U1. Its expected `request-changes` frontmatter verdict, rather than a prose-marker absence check, discriminates the outcome. Decisive newest evidence must not be inferable from the diff alone; the live scenario tests use of surfaced evidence, while deterministic GraphQL tests own evidence selection and pagination correctness.

**Verification:**

- All existing caps are unchanged in value.
- Truncation is still disclosed in the prompt.
- Both hydration paths agree on which end of an over-cap list is kept.
- `budget.ts` is unchanged.

- [x] **U7. Liveness signals and the carry ledger**

**Goal:** Give the twelve upstream carries an exit path. The silence-as-failure proxy stays; see the investigation below for why replacing it is not currently possible.

**Requirements:** R6

**Dependencies:** U4 (classification metric feeds the register)

**Files:**

- Modify: `src/features/agent/session-poll.ts`
- Modify: `packages/harness/harness.config.json`
- Create: `docs/reference/carry-ledger.md`
- Test: `src/features/agent/opencode.test.ts`

**Approach:**

**Signal investigation outcome (2026-08-08): the named signal does not exist, and the dismissed one does.**

`server.heartbeat` is not an event. The SDK's server-level events are `server.connected` and `server.instance.disposed`; neither is periodic, so there is no server-level liveness signal to consume. The distinction the approach drew between server-level heartbeat and session-level progress is therefore moot — only session-level evidence exists.

> [!NOTE]
>
> These signal claims were verified against upstream `v1.18.14` — the harness `base_version`, so the source checked is the source shipped. The relevant mechanism is unchanged from `v1.17.20`: same absent heartbeat, same bare `{type: 'busy'}`, and `status.set` at identical positions in the prompt loop and run-state. Re-check against the base in force whenever this is revisited; a signal being absent is the kind of claim that ages silently.

The approach also dismissed `busy` as internal pool state. That conflates two different things. `run-state.ts` keeps an internal `busy` flag used to reject concurrent prompts, which is indeed not consumable. But `SessionStatus` is a published union of `{type:'idle'} | {type:'retry', …} | {type:'busy'}`, and the server writes `{type:'busy'}` through `SessionStatus.set` from three call sites. `set` persists every non-idle status in the instance map (idle deletes the entry and returns early), and `list` backs the `/session/status` endpoint.

That makes `busy` observable in the response the poll loop already requests every iteration. But observable is not the same as useful, and a further check refuted the idea of building on it — including an earlier revision of this section, which proposed exactly that.

`busy` is **latched state, not a heartbeat.** The server sets it at the top of each prompt-loop iteration and clears it only on idle. The payload is `{type: 'busy'}` with no timestamp and no progress field, so an observer cannot distinguish a session that set it one second ago from one that set it twenty minutes ago. Re-setting it to the same value carries no information.

That matters because of which failure the 90-second timeout actually catches. A crashed server does not answer `session.status()` at all; that path fails and is handled separately. The timeout exists for the case where the process is _responsive_ but the session is wedged mid-prompt — and that is precisely the case where the status stays `busy` forever. Suppressing the timeout on `busy` would delete the only detector for the failure it was written for, trading a 90-second failure for one that burns the entire execution deadline.

This was already settled. `opencode.test.ts` carries a test named "does not treat matching busy session status as activity", added deliberately by an earlier fix. The prior decision considered `busy` and rejected it for these reasons; it was correct.

**Outcome: the liveness half of this unit cannot be implemented as specified.** Of the three signals named, one does not exist, one is declared in the SDK types but never emitted by the server, and the third carries no progress information. The only real progress signal, `message.part.delta`, is already consumed and is what sets the activity flag today. There is no unused signal to promote.

The honest result is therefore the same discipline applied in U3 and U4: where no sufficient signal exists, narrow the unit rather than build on false confidence. The 90-second heuristic stays until a signal that distinguishes _slow_ from _wedged_ becomes available — a per-session progress timestamp, or a tool-progress event the server actually emits.

**Approach (carry ledger only):**

- Leave `session-poll.ts` unchanged. The poll interval, race guard, grace cycles, backoff, and the initial-activity timeout all stay as they are.
- The absolute deadline remains the sole hard bound, as before.
- Scope the ledger to the twelve upstream carries only. A generalised "expiry register" covering every accommodation is process overhead ahead of demonstrated need; the carries have that need already — the same carry has been wrongly proposed for removal in two consecutive base-bump audits, each time costing a source-level re-litigation.
- For each carry, record the capability it provides, which surface it serves, upstream status, the evidence it is still needed, and its removal condition. The exact version pin stays; the liability is fork-delta with no exit path.
- **Record absent evidence as absent.** A survey of the twelve found that six (`#33134`, `#33159`, `#31922`, `#34975`, `#34977`, `#36361`) have no in-repo test, consumer, or assertion establishing they are still needed — only a line in a prior bump note. No carry has an in-repo record of the upstream version that would contain it. A schema that demands those fields invites inventing them, which is worse than the gap: a fabricated justification survives the next audit unchallenged. Entries state what the repo actually supports and mark the rest unestablished.
- The ledger's first job is to stop re-derivation. `#33444` is the worked example: it has been proposed for removal in two consecutive audits and kept both times, because the reason — a downstream consumer reads the aggregate session summary that stock still does not populate — lived only in session history rather than in the repo.
- Ordinary deadlines, safety gates, and race guards get no entry. Prose-fallback and prompt-coaching removal conditions live with the code that owns them (U4, U5), not in a central register.
- The ledger is **documentation, not enforcement**, and is explicitly non-authoritative for auth, delivery, and retry policy. An entry never justifies weakening a guard; removal still requires the normal review path.

**Patterns to follow:**

- The carry-value policy already applied during OpenCode base bumps: absence from stock plus value to a served surface is the KEEP case.

**Test scenarios:**

The polling scenarios are dropped along with the liveness change. The existing coverage stands unmodified, including the test asserting that a `busy` status is not treated as activity — that test now guards a decision this unit re-confirmed rather than one it replaced.

**Verification:**

- `session-poll.ts` is unchanged, and its existing tests pass untouched.
- Every carry in `packages/harness/harness.config.json` has a ledger entry, with either a removal condition or an explicit note that its justification is unestablished in-repo.
- The ledger is discoverable from where a base-bump operator already reads.

## System-Wide Impact

- **Interaction graph:** U3 touches the execute phase and finalize; U4 touches streaming, comments error formatting, and the runtime error surface; U5 touches every prompt consumer including the gateway.
- **Error propagation:** U3 and U4 change how failures are represented but must not change which failures are terminal for any currently-covered shape.
- **State lifecycle risks:** U3 is the highest-risk unit. A mistake in side-effect detection could either duplicate an external effect or wrongly suppress a legitimate retry.
- **API surface parity:** `packages/runtime` exports are consumed by both the Action and the gateway. U2 must not silently drop an export.
- **Integration coverage:** U5's continuation behavior is only observable through U1e; unit tests cannot prove it.
- **Unchanged invariants:** the exactly-one-response rule, response-file trust boundary, review guards, credential scrubbing, execution deadline, fail-closed delivery, and the workflow strip are explicitly unchanged by every unit above.

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The eval corpus encodes today's behavior as the ceiling | Medium | High | Assert outcomes only; explicitly forbid assertions on tool usage, step count, or reasoning order (KTD2) |
| Removing prose fallback turns recoverable failures terminal | Medium | High | Demote rather than delete; gate removal on the classification-path metric (KTD4) |
| Side-effect detection in U3 is wrong in either direction | Medium | High | Test-first on side-effect-bearing failures; characterization baseline from U2 first |
| Prompt change regresses continuation quality | Medium | Medium | U5 depends on U1e; one block per change, measured against baseline |
| Execution-stack consolidation drops a consumed export | Low | Medium | Characterization-first; verify both entry points before removal |
| Eval corpus grows into a platform | Medium | Medium | One eval runner only; no per-scenario extension points, judge, dashboard, second runner, retry layer, or parallel execution; adding a ninth case requires deletion (KTD1) |

## Open Questions

### Resolved During Planning

- Are the fixed timing constants Bitter Lesson violations? No. The poll interval, two-poll race guard, grace cycles, and backoff are ordinary reliability controls. Only the 90-second silence proxy encodes a model assumption.
- Do the wording-pinned prompt tests entrench the scaffold? Only partly. `packages/harness/src/prompt-template.test.ts` must stay exact — it pins the workflow strip that broke three consecutive releases.
- Is the four-layer architecture over-structured for an agent harness? No. Both architecture reviews were explicit that layers and XML sections express dependency direction and authority, not reasoning constraints.
- Is pinning an exact upstream OpenCode build a Bitter Lesson problem? No. The pin is good dependency management. The liability is the twelve carries accumulating without exit paths.
- Is `isAgentNotFoundError` dead code? No. One review claimed it was; verification found it live via `src/features/comments/error-format.ts:11`.
- What is U1's final scenario shape? Seven live scenarios maximum: the existing clean PR, planted defect, issue answer, relevant and irrelevant prior-work continuations, newest-thread evidence, and an opt-in implementation task. Missing/malformed responses are deterministic injected-execution tests; the at-most-eight cap is capacity, not a live-run target.

### Deferred to Implementation

- Which execution stack should own policy after U2 — the action layer or the runtime package. Requires reading both call graphs against current consumers.
- Whether the automatic session writeback can be extended to capture qualitative decisions, which would let the completion-summary requirement drop from the prompt.
- The exact protocol signals available for liveness in the current OpenCode build, and whether they cover the cases the 90-second timeout currently catches.

## Documentation / Operational Notes

- The carry ledger (`docs/reference/carry-ledger.md`) becomes a maintained artifact reviewed at each OpenCode base bump.
- Eval baselines are versioned artifacts; a model or pin change requires a re-baseline, not a silent comparison against a stale reference.
- `AGENTS.md` should gain a pointer to the eval corpus once U1 lands, so agent-facing changes route through it.

## Sources & References

- Sutton, _The Bitter Lesson_ — http://www.incompleteideas.net/IncIdeas/BitterLesson.html
- Anthropic, _SWE-bench Sonnet_ — https://www.anthropic.com/engineering/swe-bench-sonnet
- Anthropic, _Building Effective Agents_ — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, _Writing Tools for Agents_ — https://www.anthropic.com/engineering/writing-tools-for-agents
- Related learnings: [terminal outcomes must survive deadline cleanup](../solutions/logic-errors/terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md), [failed run reported success with no delivery surface](../solutions/logic-errors/failed-run-reported-success-with-no-delivery-surface-2026-08-07.md), [integrate push strips workflow files](../solutions/workflow-issues/integrate-push-strips-workflow-files-2026-08-07.md)
