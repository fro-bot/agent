---
date: 2026-10-18
topic: action-gateway-consolidation
---

# Action and Gateway Consolidation

## Summary

Duplicated Action and gateway behavior moves into `packages/runtime` one concern per PR. Pure leaves go first. Stateful concerns each get their own plan. Leaves that are still copied are pinned by drift tests until they move. Both surfaces map their S3 and object-store settings onto one typed schema. The end state is a single runtime run entry point with per-surface policy hooks.

---

## Problem Frame

The Action (`src/`) and the gateway (`packages/gateway/src`) run the same OpenCode agent, and much of the code around that run exists twice. `packages/gateway/src/execute/run-core.ts` says it mirrors `src/features/agent/streaming.ts` "exactly". It copies that code by hand, and the copies have drifted. Two examples: the Action fails fast on a provider quota error and the gateway does not, and the shared task-notice pattern is byte-identical in two files with nothing keeping them in sync.

Fixes have landed on one side only. #1752 and #1771 are gateway-only, and #1715 and #1457 are Action-only. Provider fail-fast was built twice, three months apart (#1283, #1854). The task-reuse guard reached the two sides a day apart (#1759, #1769). Every hardening is designed, reviewed, and tested twice, or it lands on one side only.

Config shares almost nothing. The Action reads inputs. The gateway reads env and `_FILE` values. The S3 settings conflict outright:

- Region is `aws-region` on the Action.
- In the gateway it is `S3_REGION` in `config.ts` and compose, but `AWS_REGION` in `bindings/backfill-runner.ts` and in the docs.
- The Action validates the S3 endpoint (HTTPS required, with an address blocklist and an opt-in escape). The gateway does not validate it at all.

The concerns fall into two groups (full inventory: [2026-10-18-action-gateway-consolidation-inventory.md](2026-10-18-action-gateway-consolidation-inventory.md)):

| Concern | Kind | Disposition |
| --- | --- | --- |
| Provider-failure classification | Duplicated behavior | Ladder, rung 1 (delivered in #1869) |
| Payload accessors, task-notice parser | Duplicated behavior | Ladder, rung 2 (delivered in #1872) |
| Entity-ref parser, sleep, gateway logger adapter, SHA validator, byte formatter | Small duplicates | Ladder, small-helpers rung (delivered in #1888). The run-timeout default stays per surface on purpose |
| Bounded abort and settle (teardown) | Duplicated behavior, stateful | Separately planned rung |
| Lock lease renewal and takeover | Duplicated behavior, stateful | Separately planned rung, after a takeover-policy decision |
| S3 and object-store config | Duplicated parsing and validation | Config spine, block 1 (delivered in #1883; one object-store settings parser in runtime) |
| Event-stream loop | Duplicated behavior | Later, after leaves and seams prove out |
| Timeouts and inactivity | Partly shared (runtime timer unused by the Action) | Later, with the event-stream loop |
| GitHub App token minting, log redaction wrappers | Small duplicates | Ladder, low priority. Not small-helper merges (see R7) |
| Server lifecycle | Three spawn models by design | Out. workspace-agent is its own trust boundary |
| Env scrub | Action vs workspace-agent only | Out. The `NODE_OPTIONS` fix ships separately |
| Session persistence and continuity | Action-only. The gateway has none | Later phase (#1712, #1778) |
| Run outcomes and records | Different by design | Out until the run entry point exists |
| Prompt building | Concept overlap only | Out |
| Reply posting | Different delivery models by design | Out |
| Permissions and questions | Different policy by design (auto-deny vs approvals) | Out. Becomes a policy hook |

Session persistence is the largest Action-side concern. It is deferred because the gateway has no implementation to merge. Wiring the gateway's unused sync wrappers as written would skip three Action-side fixes (#1519, #1373, #1389). Doing it properly depends on safe concurrent publication (#1712). Meanwhile, every gateway mention starts a fresh session.

---

## Requirements

**Extraction ladder**

- R1. Each consolidation PR moves one duplicated concern into `packages/runtime`, and both surfaces switch to the shared implementation in the same PR.
- R2. Each consolidation PR deletes the copies it replaces. A PR that relocates code without deleting the originals does not count.
- R3. If a shared implementation changes behavior on one surface, the PR description says so and a test pins the change.
- R4. Policy tests for a shared concern live once, in runtime. Each surface tests only how it maps the shared result.
- R5. Rung 1 is provider-failure classification. One shared function decides both the failure kind and whether the run stops. Confirmed structured signals and the established text patterns stop a run. Looser text hints only label it.
- R6. Rung 1 gives the gateway quota fail-fast on the `session.status` retry path. Quota is reported as a new operator reason, `provider-quota-exceeded`, which ships in the next operator-contract MINOR together with the paired dashboard release.
- R7. Pure-leaf rungs follow rung 1 in this order unless planning finds a better one: payload accessors and the task-notice parser, then the remaining small duplicated helpers (delivered in the small-helpers rung). GitHub App token minting and the redaction wrappers are not small-helper merges. Token minting stays separate because the Action and the gateway use different credential models. The redaction wrappers live in `evals/` and the harness package, not in Action or gateway code.
- R8. Bounded abort and settle, and lock lease renewal, are stateful. Each needs its own plan, and its own tests for takeover and quarantine paths. Lease renewal also needs a takeover-policy decision first, because the Action reclaims an expired holder without corroboration and the gateway requires `ConfirmExpiredHolder`.

**Drift guards**

- R9. A rung that leaves a concern copied across surfaces adds a test that fails when the copies disagree. A rung that removes every copy in one PR needs no guard.
- R10. Delete each drift guard in the PR that consolidates its concern.

**Config spine (S3 and object store)**

- R11. A typed schema in runtime defines the S3 and object-store settings once. Each entry has a name, type, default, and validation. The settings are bucket, region, endpoint, insecure-endpoint opt-in, prefix, server-side encryption, and expected bucket owner. The schema reuses runtime's existing endpoint validator. The encryption default stays a derived rule that depends on the endpoint.
- R12. Each surface maps its own sources onto the schema: Action inputs, or gateway env and `_FILE` values. Neither surface keeps its own defaults or validation for these settings.
- R13. The canonical gateway region variable is `S3_REGION`. `AWS_REGION` is accepted as a fallback when `S3_REGION` is unset. `backfill-runner.ts` reads region through the schema. The docs match the code.
- R14. The gateway gains the Action's endpoint validation, with an `S3_ALLOW_INSECURE_ENDPOINT` opt-in. This is a gateway behavior change. Check the production endpoint before rollout.
- R15. Other config blocks join the schema only when a second consumer needs them.

**Run entry point (north star)**

- R16. A design note defines the end state. Runtime owns the event loop, error classification, teardown, and lock lifecycle. Each surface owns trigger parsing, prompt context, its delivery sink, its permission policy, and its config sources. The north star is reached when both surfaces call one runtime run entry point and pass those policies as hooks.
- R17. Each consolidation PR names which part of that end state it advances.

**Guardrails**

- R18. A test keeps `@actions/*` imports out of `packages/runtime`.

---

## Acceptance Examples

- AE1. **Covers R5, R6.** Given a gateway run whose provider reports `account_rate_limit` on a `session.status` retry, after rung 1 the run fails fast with `provider-quota-exceeded` instead of waiting out OpenCode's retry budget. The PR says this is a gateway behavior change.
- AE2. **Covers R5.** Given a terminal payload whose message text matches only an auth hint, the shared function labels the failure as auth and does not stop the run on that evidence.
- AE3. **Covers R9, R10.** Given a concern that stays copied after a rung, editing one copy fails its drift test, and the PR that consolidates it deletes that test. The payload accessors and task-notice parser moved to runtime in one PR, so they never needed one.
- AE4. **Covers R12, R13.** Given a gateway deployment that sets only `AWS_REGION`, the gateway resolves the region from it. Given one that sets `S3_REGION`, that value wins.
- AE5. **Covers R14.** Given a gateway configured with an `http://` endpoint and no opt-in, startup fails with a configuration error. With `S3_ALLOW_INSECURE_ENDPOINT` set, it starts.

---

## Success Criteria

- Each consolidated concern is fixed once and both surfaces get the fix.
- Each PR on the ladder removes more lines from `src/` and `packages/gateway/src` than it adds to runtime, not counting tests.
- The "mirrors exactly" comment in `run-core.ts` is gone, replaced by shared imports. Done in #1872.
- S3 and object-store settings are defined once, and the docs match the code.
- A planner can start rung 1 or config block 1 from this doc without inventing scope.

---

## Scope Boundaries

- The event-stream loops stay separate. Unifying them is the step toward the run entry point after the leaves and seams prove out.
- Delivery models do not change. The Action keeps one comment or review per run (ARCH invariant 5). The gateway keeps streaming replies.
- workspace-agent's spawn, supervisor, and env policy stay as they are.
- Session continuity for the gateway and safe concurrent session publication (#1712) are a later phase, as a shared runtime capability. #1778 closes into that phase.
- The `NODE_OPTIONS` env-scrub fix ships separately.
- The Action's and gateway's GitHub credential models are not merged.
- Inline error-message extraction (about 86 sites) moves onto runtime `toErrorMessage` separately: [fro-bot/agent#1885](https://github.com/fro-bot/agent/issues/1885).
- One owner/repo parsing contract across the surfaces is separate work: [fro-bot/agent#1886](https://github.com/fro-bot/agent/issues/1886). The entity-ref parser keeps its own `owner/repo#n` contract.

---

## Key Decisions

- Pure leaves before stateful work. Leaves fix skew at low risk. Teardown and lock lifecycle are correctness-critical and need their own plans.
- Rung 1 is provider classification. It has the clearest one-sided gap, and its classifiers already live in runtime.
- Gateway quota fail-fast is approved. The Action already fails fast on quota, and the gateway waiting out the retry budget is the drift this work removes.
- Structured signals and two established text patterns (usage-limit wording, `Model not found:`) decide when a run stops. Looser text only labels the failure, which keeps runtime's rule that message text is not auth evidence.
- `S3_REGION` stays canonical with an `AWS_REGION` fallback, so existing deployments keep working.
- Runtime stays lean. New shared code returns plain values or `Result`, never Effect, and never imports `@actions/*`.

---

## Dependencies / Assumptions

- The layering rule holds. The gateway cannot import `src/`, and runtime imports neither `src/` nor `apps/`.
- Runtime changes bundled into the Action rebuild the committed `dist/` in the same PR.
- R6 depends on the dashboard accepting `provider-quota-exceeded`. The 1.12.0 handoff already asks it to treat unknown reasons as open-ended.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R11, R12][Technical] Where does the schema live in runtime, and how does each surface report errors with the right source name (input name vs env name)?
- [Affects R16][Technical] Does the design note live in ARCHITECTURE.md, as a cross-cutting summary with a wiki page, or as a standalone design doc?
- [Affects R8][User decision, when that rung is planned] Which takeover policy wins for an expired lock holder?

---

## Sources / Research

- Inventory with per-concern evidence, config divergence, constraints, and duplicated tests: [2026-10-18-action-gateway-consolidation-inventory.md](2026-10-18-action-gateway-consolidation-inventory.md).
- Event-stream copies: `src/features/agent/streaming.ts`, `src/features/agent/session-poll.ts`, `packages/gateway/src/execute/run-core.ts`, `packages/gateway/src/execute/drain-completion.ts`.
- Provider classification: `packages/runtime/src/agent/error-format/format.ts`, `packages/gateway/src/execute/provider-failure.ts`, `packages/gateway/src/operator-contract/provider-failure-reason.ts`.
- S3 config: `action.yaml`, `src/harness/config/inputs.ts`, `packages/gateway/src/config.ts`, `packages/gateway/src/bindings/backfill-runner.ts`, `packages/runtime/src/object-store/validation.ts`, `packages/gateway/AGENTS.md`.
- Drift-guard precedent: `scripts/checkout-types-drift-guard.test.ts`.
- Related issues: #1712, #1778, #1885, #1886.
