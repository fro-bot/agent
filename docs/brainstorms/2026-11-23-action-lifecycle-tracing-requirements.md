---
date: 2026-11-23
topic: action-lifecycle-tracing
---

# Action Lifecycle Tracing

## Summary

When tracing is on, the Action sends its own trace of each run to the operator's collector, next to the plugin's turn traces. Each run gets one trace, with a span per lifecycle phase from setup to the post step. The trace joins the conversation's Langfuse session, and the plugin's turn traces link to it in Tempo.

---

## Problem Frame

Run tracing (`trace-endpoint`, `trace-headers`) shows what the model did: each turn's prompts, model requests, tool calls and subagents. It shows nothing of the Action around the model. Setup, the OpenCode and plugin installs, cache restore and save, the isolation handoff, the gates and routing decisions, response delivery and cleanup all happen before the plugin loads or after the server stops.

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
- R2. Tracing never changes a run's outcome. An export failure, a refused request or an unreachable collector is logged and the run continues.

**Trace shape**

- R3. Each run produces one lifecycle trace, with one root span covering the whole run.
- R4. Each lifecycle phase gets its own span, named by the phase names the Action's logs already use. The phases are bootstrap, routing, dedup, coordination lock, acknowledge, repo skills, cache restore, server start, session prep, execution, release, isolation take-back, review reconciliation, finalize and cleanup.
- R5. A phase that hides time inside it gets child spans for that work: the OpenCode and tool installs, the plugin install, each cache restore tier, the isolation handoff, response posting and the cache save.
- R6. Decisions inside a phase are span events: routing and skip reasons, the dedup result, the lock result, gate decisions, cache hit or miss per tier, dropped PATH entries, and the save result.
- R7. A phase's outcome is its span status, with the reason as the status message. An error is an exception event on the span where it happened.
- R8. The root span carries the run's final outcome: the invocation outcome, the cache save result and the exit code.
- R9. A run that ends early has spans for every phase it reached. This covers a skip, an error, a timeout and a cancellation. The span where it ended is marked with the reason.
- R10. The post step adds its own span to the same run trace, with its outcome: a retried save, a skip, or a safety skip.

**Content**

- R11. Lifecycle spans carry the same data the Action's logs show for those phases: repository, ref, run id and attempt, job, trigger, the logical key, phase outcomes, durations, cache keys and error messages.
- R12. No secret reaches an exported span. This covers every value GitHub masks in the log (registered secrets and the trace credential), GitHub and provider tokens, and the key proxy's values. Error messages and any other free text are redacted before export.
- R13. Lifecycle spans carry no prompt, model output or tool content. That content stays in the turn traces.

**Joining turns and runs**

- R14. Lifecycle spans carry the run identity that turn spans already carry (repository, run id, run attempt, job, trigger) under the same names. Either trace is found from the other by run id in both Langfuse and Tempo.
- R15. Once the OpenCode session is known, lifecycle spans carry it as their Langfuse session. Langfuse's session view then shows each run's lifecycle trace in order beside that run's turns, across every run of the conversation.
- R16. Each turn trace links to the run's execution span. From a turn, Tempo leads to the run that started it; from a run, a query on the link finds its turns. This needs a plugin release.

**Delivery**

- R17. Every span leaves the Action before it exits, including on an error or a cancellation. The final wait is bounded, so an unreachable collector cannot stall the run's end.
- R18. The Action sends lifecycle spans itself, never through the agent's relay. With isolation on, the agent cannot read the trace credential, and nothing in the agent's reach can write lifecycle spans.

**Backend fit**

- R19. Every attribute a lifecycle span relies on is either on Tempo's keep-list or is sent through a channel Tempo always keeps: span names, durations, status and status message, event names, run identity and exception events.
- R20. The planned field list is given to the collector operator before the first lifecycle span is sent. They add it to Tempo's keep-list and to the trace privacy page.

---

## Acceptance Examples

- AE1. **Covers R1.** Given a caller with no `trace-endpoint`, when a run completes, nothing is sent and the run's log has no tracing lines beyond what it has today.
- AE2. **Covers R2, R17.** Given a caller whose collector refuses every request, when a run completes, the run's outcome and exit code are the same as with tracing off, and the run's end is delayed at most by the bounded final wait.
- AE3. **Covers R4, R6, R9.** Given an `issue_comment` run that routing skips, when the trace arrives, it has the bootstrap and routing spans, a skip-reason event on the routing span, and a root span ending as skipped. It has no later phase spans.
- AE4. **Covers R9, R17.** Given a run cancelled during execution, when the trace arrives, it has spans for the phases before execution, an execution span ending as cancelled, and a root span carrying the cancellation.
- AE5. **Covers R5, R6.** Given a run that misses the Actions cache and restores from S3, when the trace arrives, the cache restore span has a child span per tier tried, with a miss event on the first and a hit event on S3.
- AE6. **Covers R15.** Given an issue conversation continued across three runs, when the operator opens the Langfuse session, the three lifecycle traces appear in order, each beside the turns its run produced.
- AE7. **Covers R12.** Given a run whose error message contains the GitHub token, when the trace arrives, the exception event's message has the token redacted.
- AE8. **Covers R10.** Given a run whose main step ended before saving the cache, when the post step retries the save, the run trace has a post span with the retried save's result.

---

## Success Criteria

- The operator can open one run's lifecycle trace in Tempo and tell where its time went and why it ended, without opening the job log.
- The operator can query across runs and repositories in Tempo by phase span name and event name: install time, cache hit rate by tier, and skip and failure reasons by repository or trigger.
- The operator can follow a conversation in a Langfuse session through every run's lifecycle and every turn.
- Planning can name every span, event and attribute from R4 to R16 without inventing a phase, a decision or a field. Infra can apply the keep-list from R20 without asking which keys are meant.

---

## Scope Boundaries

- Gateway tracing. It comes later with the same span model.
- A forced kill of the runner process. Nothing can send after the process is killed, so the spans not yet sent are lost.
- Changing the turn traces' shape. Turns stay one trace per turn. They gain only the link to the run.
- A link to the trace from the job summary.
- Native OpenCode telemetry.

---

## Key Decisions

- **Turn traces are linked to the run, not parented under it.** Langfuse's own guidance is one trace per turn and one session per conversation. Claude Code, the OpenAI Agents SDK and Phoenix shape agent work the same way. Tempo advises span links to break up long-running traces, which spike memory and are cut above the size limit. Self-hosted Langfuse has open reports of very large traces breaking its trace view. Langfuse ignores span links, so the shared session (R15) is its join.
- **The link goes from each turn to the run.** The plugin learns the run's execution span when it starts, but the Action never learns the turn trace ids. A query on the link covers the other direction.
- **The Action sends directly, not through the relay.** The relay stops before finalize and cleanup, the post step is a separate process, and the agent can post to the relay. Both the plugin and the Action use the same validated endpoint and credential, but from different processes.
- **Lifecycle spans go to both backends.** The collector has no routing by service, and infra recommends against adding one. In Langfuse a lifecycle trace is cheap and sits in the same session as the turns.
- **Lifecycle spans carry what the logs carry.** The collector is the operator's own, and the same data is already in the job log. GitHub's log masking doesn't apply to spans the Action sends, so redaction (R12) is required.

---

## Dependencies / Assumptions

- The plugin's Langfuse session is the root OpenCode session, and a continued conversation keeps the same root session across runs. Planning confirms this against the session continuity code.
- The post step must read the trace inputs in its own process. This is unverified and needs a hosted-runner check before R10 is built.
- Infra updates Tempo's keep-list and the trace privacy page from the R20 field list before the first lifecycle span is sent.
- This ships before tracing rolls out to the operator's callers, together with the plugin release R16 needs.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R12][Technical] Reuse the plugin's value scrubber or build an Action-side redactor. The Action's logger redacts by field name only.
- [Affects R17][Technical] The final wait's bound, and how a cancellation reaches the export on runs without isolation, which install no signal handler today.
- [Affects R10][Technical] How the post step gets the run's trace context, which must be an opaque id and never the credential.
- [Affects R16][Technical] How the plugin receives the execution span's context through the launcher setting, whose parser rejects unknown keys today.
- [Affects R19, R20][Technical] Exact attribute keys and event names, and the shortest keep-list addition that serves the success criteria.
- [Affects R3][Needs research] Whether the Action bundles the OpenTelemetry SDK or encodes OTLP JSON itself, decided on the measured `dist/` size and tested against a real receiver.

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
