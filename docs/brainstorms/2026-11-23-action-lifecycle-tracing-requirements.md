---
date: 2026-11-23
topic: action-lifecycle-tracing
---

# Action Lifecycle Tracing

## Summary

When tracing is on, the Action sends its own trace of each run to the operator's collector, next to the plugin's turn traces. Each run gets one trace, with a span per lifecycle phase from bootstrap to the post step. Lifecycle and turn traces share a Langfuse session per conversation, and each turn trace links to its run in Tempo.

---

## Problem Frame

Run tracing (`trace-endpoint`, `trace-headers`) shows what the model did: each turn's prompts, model requests, tool calls and subagents. It shows nothing of the Action around the model. Bootstrap, the OpenCode and plugin installs, cache restore and save, the isolation handoff, the gates and routing decisions, response delivery and cleanup all happen before the plugin loads or after the server stops.

These are where most CI questions start. A run was slow, but in which phase? A run did nothing, but which gate or skip reason stopped it? A cache missed, but on which tier? Today the answers are spread across one job's log lines and job summary, and they can't be compared across runs or repositories.

The earlier run-tracing requirements listed spans for the Action's own phases as out of scope (`docs/brainstorms/2026-11-19-opencode-run-tracing-requirements.md`). This document brings them in, before tracing rolls out to the operator's callers.

---

## Actors

- A1. Operator: enables tracing on their callers and reads traces in Langfuse and Tempo, one run at a time or across many.
- A2. The Action: runs the lifecycle and sends the lifecycle trace.
- A3. The plugin: sends the per-turn traces from inside the OpenCode server.
- A4. The collector: accepts traces for a sender group and sends every span to both Langfuse and Tempo. Tempo keeps only attribute keys on its keep-list.

---

## Requirements

**Enablement**

- R1. The lifecycle trace is sent only when tracing is on and the trace inputs are valid, with the same inputs and the same validation as turn tracing. With tracing off, the Action sends nothing and does no export work.
- R2. Tracing never changes a run's outcome. An export failure, a refused request or an unreachable collector is logged by category and the run continues.
- R3. The Action's sender keeps the relay's transport rules: it never follows a redirect, sends the credential only over TLS, and never logs the endpoint, the headers or the collector's response.

**Trace shape**

- R4. Each Action invocation produces one lifecycle trace. Its root span covers the main step.
- R5. Each phase of the run gets its own span, named after the run's phase functions: bootstrap, routing, dedup, coordination lock, acknowledge, repo skills, trace relay start, cache restore, server start, session prep, execution, release, isolation take-back, review reconciliation, finalize and cleanup. Finalize covers the final writes: the dedup marker, the terminal reaction, outputs and the job summary.
- R6. A phase that hides time inside it gets child spans for that work: the OpenCode and tool installs, the plugin install, each cache restore tier, the isolation handoff, response posting and the cache save.
- R7. Every span carries an outcome and a reason as attributes, using the Action's existing outcome values: invocation outcome, skip reason, lock result, cache status per tier and cache save result. Span status marks errors only.
- R8. Decisions that are not their own span are events on the phase span where they happen: the dedup result, gate decisions and dropped PATH entries.
- R9. An error is an exception event on the span where it happened. It carries the error's type and a scrubbed message capped in length, with no cause chain or stack.
- R10. The root span carries the main step's final outcome: the invocation outcome, the cache save result and the exit code.
- R11. A run that ends early has spans for every phase it reached, then cleanup. This covers a skip, an error, an execution timeout and a cancellation. The span where it ended carries the reason.
- R12. When the post step runs, it adds a span to the same trace, after the root has ended. Its outcome is a retried save, a skip or a safety skip. When it retries the save, its result is the run's final save result.

**Content**

- R13. Lifecycle spans carry the same data the Action's logs show for those phases: repository, ref, run id and attempt, job, invocation, trigger, the logical key, phase outcomes, durations, cache keys and error messages. Free-text values that come from outside, such as ref names and error messages, are capped in length.
- R14. Every string in a lifecycle span is scrubbed before export, at one point that covers attribute values, event attributes, status messages and span names. The scrub removes four kinds of value:
  - Values the Action registers as secrets.
  - Each value inside `auth-json` and `opencode-config`, raw and escaped.
  - Values of environment variables with secret-like names.
  - Strings shaped like tokens or keys.
- R15. A value that cannot be scrubbed is omitted and marked. A secret the caller registered with GitHub but never passed to the Action cannot be known to it, so it is outside this guarantee unless its shape is caught.
- R16. Lifecycle spans carry no prompt, model output or tool content. That content stays in the turn traces.

**Joining turns and runs**

- R17. Lifecycle spans carry the run identity that turn spans already carry, under the same names: repository, run id, run attempt, job and trigger. They also carry an invocation id that tells apart two Action steps in one job. Turn spans gain the same invocation id.
- R18. Lifecycle and turn traces use the Action's logical key, qualified by the repository, as their Langfuse session: one per issue, PR or discussion, and one per run for dispatch and schedule. Langfuse's session view then shows every run of a conversation in order: each lifecycle trace beside that run's turns, including runs that a gate skipped.
- R19. A run that fails before routing has no logical key. Its lifecycle trace is found by run id.
- R20. Each turn trace links to its run's root span. From a turn, Tempo leads to the run. From a run, a query on the link finds its turns. This needs a plugin release, the same one that carries the logical key and the invocation id.
- R21. Local sessions keep today's behaviour: with no Action, the plugin's Langfuse session stays the OpenCode root session.

**Delivery**

- R22. The Action waits for its spans to be sent before it exits, on success, an error or a cancellation the process can handle. The wait is bounded, so an unreachable collector cannot stall the run's end. Spans not sent by then are counted in the run log.
- R23. The Action sends lifecycle spans itself, not through the agent's relay. With isolation on, the agent cannot read the trace credential. An agent can still post spans of its own through the relay, so lifecycle traces help the operator diagnose a run but are not proof of what the Action did.
- R24. The post step reads the trace inputs again in its own process. It masks and removes them before anything that can fail, and never writes them to Action state. Only the trace's identity passes from the main step to the post step.

**Backend fit**

- R25. Every attribute the success criteria depend on is on Tempo's keep-list or sent through a channel Tempo always keeps: span names, durations, error status and its message, event names, run identity and exception events.
- R26. The planned field list is given to the collector operator before the first lifecycle span is sent. They add it to Tempo's keep-list and to the trace privacy page, which says that error text is exported.

---

## Acceptance Examples

- AE1. **Covers R1.** Given a caller with no `trace-endpoint`, when a run completes, nothing is sent and the run's log has no tracing lines beyond what it has today.
- AE2. **Covers R2, R22.** Given a caller whose collector refuses every request, when a run completes, its outcome and exit code are the same as with tracing off. Its end is delayed at most by the bounded wait, and the run log counts the spans not sent.
- AE3. **Covers R5, R7, R11.** Given an `issue_comment` run that routing skips, when the trace arrives, it has bootstrap, routing and cleanup spans. The routing span and the root carry outcome skipped with the skip reason. There is no span between routing and cleanup.
- AE4. **Covers R11, R22.** Given a run cancelled during execution that the process handles, when the trace arrives, it has spans for the phases before execution and an execution span with outcome cancelled. The root carries the cancellation.
- AE5. **Covers R6, R7.** Given a run that misses the Actions cache and restores from S3, when the trace arrives, the cache restore span has a child span per tier tried. The first carries a miss and the S3 span a hit.
- AE6. **Covers R18.** Given an issue conversation over three runs, where the second was skipped by a gate and the third started a new OpenCode session after a cache miss, when the operator opens the Langfuse session, all three lifecycle traces appear in order, each beside the turns its run produced.
- AE7. **Covers R14, R15.** Given a run whose error message contains the GitHub token, a provider key from `auth-json` and an MCP header token from `opencode-config`, when the trace arrives, the exception event's message has all three redacted.
- AE8. **Covers R12.** Given a run whose main step ended before saving the cache, when the post step retries the save, the trace has a post span after the root, carrying the retried save's result.
- AE9. **Covers R20.** Given a run with two turns, when the operator opens a turn trace in Tempo, its root span links to the run's root span. A query on that link from the run finds both turns.
- AE10. **Covers R17.** Given a job with two traced Action steps, when both traces arrive, they have the same run id and job and different invocation ids. Each step's turns carry their own step's invocation id.

---

## Success Criteria

- The operator can open one run's lifecycle trace in Tempo and tell where its time went and why it ended, without opening the job log.
- The operator can query across runs and repositories in Tempo: phase and install durations, cache hit rate by tier, and skip and failure reasons by repository or trigger.
- The operator can follow a conversation in a Langfuse session through every run, its lifecycle and its turns.
- Planning can name every span, attribute and event from R5 to R20 without inventing a phase, an outcome or a field. Infra can apply the keep-list from R26 without asking which keys are meant.

---

## Scope Boundaries

- Gateway tracing. It comes later with the same span model.
- A forced kill of the runner process, including a job-level timeout. Nothing can send after the process is killed, so spans not yet sent are lost.
- Changing the turn traces' shape. Turns stay one trace per turn. They gain the run link, the invocation id and the logical-key session.
- A link to the trace from the job summary.
- Native OpenCode telemetry.

---

## Key Decisions

- **Turn traces are linked to the run, not parented under it.** Langfuse's own guidance is one trace per turn and one session per conversation. Claude Code, the OpenAI Agents SDK and Phoenix shape agent work the same way. Tempo advises span links to break up long-running traces, which use a lot of memory and are cut above the size limit. Self-hosted Langfuse has open reports of very large traces breaking its trace view. Langfuse ignores span links, so the shared session (R18) is its join.
- **The conversation is the logical key, not the OpenCode session.** The OpenCode session changes on a cache miss, a lookup error or a context-overflow recovery, and doesn't exist for a run that a gate skipped. The logical key is how the Action already finds a conversation, and it is known right after routing.
- **The link goes from each turn to the run's root.** The plugin starts before the execution span exists, and the Action never learns the turn trace ids. A query on the link covers the other direction.
- **The Action sends directly, not through the relay.** The relay stops before finalize and cleanup, and the post step is a separate process. Both the plugin and the Action use the same validated endpoint and credential, but from different processes.
- **Lifecycle spans go to both backends.** The collector has no routing by service, and infra recommends against adding one. In Langfuse a lifecycle trace is cheap and sits in the same session as the turns.
- **Lifecycle spans carry what the logs carry.** The collector is the operator's own, and the same data is already in the job log. GitHub's log masking doesn't apply to spans the Action sends, so scrubbing (R14) is required.

---

## Dependencies / Assumptions

- The post step can read the trace inputs in its own process. GitHub sets `INPUT_*` for post steps, but this is unverified on a hosted runner and needs checking before R12 and R24 are built.
- Infra updates Tempo's keep-list and the trace privacy page from the R26 field list before the first lifecycle span is sent.
- This ships before tracing rolls out to the operator's callers, together with the plugin release R20 needs.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R14][Technical] Reuse the plugin's value scrubber or build an Action-side one. The Action's logger redacts by field name only.
- [Affects R22][Technical] The final wait's bound, and how a cancellation reaches the export on runs without isolation, which install no signal handler today.
- [Affects R12][Technical] How the post span is placed after the root: as its child, or beside it in the same trace.
- [Affects R18][Technical] How spans that end before routing get the logical key, or whether the session is set once on the trace.
- [Affects R20][Technical] How the plugin receives the run's root span context, the logical key and the invocation id through the launcher setting, whose parser rejects unknown keys today.
- [Affects R25, R26][Technical] Exact attribute keys and event names, derived from the success-criteria queries so the keep-list addition stays small.
- [Affects R4][Needs research] Whether the Action bundles the OpenTelemetry SDK or encodes OTLP JSON itself, decided on the measured `dist/` size and tested against a real receiver.

---

## Sources / Research

- Langfuse best practices (one trace per turn, one session per conversation): https://langfuse.com/docs/observability/best-practices
- Langfuse sessions: https://langfuse.com/docs/observability/features/sessions
- Langfuse ignores span links: https://langfuse.com/faq/all/opentelemetry-logs-metrics-span-links
- Langfuse OTel attribute mapping: https://langfuse.com/integrations/native/opentelemetry
- Tempo on large and long-running traces: https://grafana.com/docs/tempo/latest/troubleshooting/out-of-memory-errors/
- TraceQL link intrinsics: https://grafana.com/docs/tempo/latest/traceql/construct-traceql-queries/
- Run-tracing requirements and plan: `docs/brainstorms/2026-11-19-opencode-run-tracing-requirements.md`, `docs/plans/2026-11-19-001-feat-opencode-run-tracing-plan.md`
- Phase order and early exits: `src/harness/run.ts`, `src/harness/phases/`
- Outcome types: `src/harness/outcome.ts`, `src/shared/cache-save-result.ts`
- Session continuity and the logical key: `packages/runtime/src/session/logical-key.ts`, `src/harness/phases/session-prep.ts`
- Relay transport rules: `packages/runtime/src/agent/trace-relay.ts`
- Secrets the Action registers: `src/harness/config/inputs.ts`
