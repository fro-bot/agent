---
date: 2026-11-19
topic: opencode-run-tracing
---

# OpenTelemetry Tracing of OpenCode Runs

## Summary

`@fro.bot/opencode-plugin` gains opt-in OpenTelemetry tracing. It records each model call, tool call and subagent of a run as `gen_ai` spans and sends them to a collector the operator controls. The first release covers local OpenCode sessions and the GitHub Action. In the Action, a relay outside the agent's sandbox holds the collector credential and forwards the spans.

---

## Problem Frame

An operator cannot see what an agent run sent to the model. The Action's logs and job summary show tool names and the final reply. They do not show the system prompt, the context OpenCode and its plugins add, the prompt a subagent was given, or what a tool returned. Questions such as "why did this subagent pick that model" or "what did the review subagent read" can only be answered by reconstructing the run from session records by hand.

OpenCode V1 could export this. Its `experimental.openTelemetry` setting turned on the AI SDK's telemetry, which records prompt messages, response text and tool arguments. OpenCode V2 replaced that code path with its own runner. Its exporter sends spans with model, token, cost and timing data and no content, and no setting adds the content back. The Action and the workspace also remove every `OTEL_*` variable from the server's environment, so even those spans are off today.

The repo's recorded telemetry policy (RFC-007, F83) says raw prompts are never sent to an external system. That rule was written for telemetry the project might collect. It also blocks an operator from sending their own runs to their own collector, which is the case here.

---

## Actors

- A1. Operator: the person who owns the repo workflow or the workstation, turns tracing on, chooses the collector and reads the traces.
- A2. Agent: the model and its tools, running inside the OpenCode server. Under `isolate-agent` it is untrusted and can read the server's environment and config.
- A3. Plugin: `@fro.bot/opencode-plugin`, loaded by the OpenCode server. It observes the run and produces spans.
- A4. Relay: a process the Action starts outside the agent's sandbox. It receives spans from the plugin, holds the collector credential and forwards to the collector.
- A5. Collector: an OpenTelemetry collector the operator runs or rents. It is outside this repo.

---

## Key Flows

- F1. Local session
  - **Trigger:** The operator enables tracing for a project on their workstation and starts an OpenCode session.
  - **Actors:** A1, A3, A5
  - **Steps:** The plugin reads the operator's tracing settings. It records each turn as a trace. It sends spans to the operator's local collector, which holds any remote credential.
  - **Outcome:** The operator opens the turn in their trace backend and reads each model call, tool call and subagent.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R9, R13

- F2. Action run
  - **Trigger:** A workflow that enables tracing through Action inputs runs on any trigger.
  - **Actors:** A1, A2, A3, A4, A5
  - **Steps:** The Action starts the relay before the agent. The plugin sends spans to the relay over loopback. The relay adds run identity, applies limits and forwards to the collector with the credential. At the end of the run the Action flushes the relay, within a time bound, then stops it.
  - **Outcome:** The run's trace is in the operator's backend, tagged with the repository and run. The agent never held the collector credential when the run was isolated.
  - **Covered by:** R1 to R8, R10, R11, R12, R14, R15, R16

---

## Requirements

**What a trace contains**

- R1. One trace covers one turn of a session, from the prompt to the end of the work it started.
- R2. Each model request is a span that follows the OpenTelemetry GenAI conventions for inference, with provider, model, agent, token usage and finish reason. This includes title and compaction requests.
- R3. Each tool call is a span that follows the GenAI conventions for tool execution, with the tool name, call id and outcome.
- R4. A subagent's spans are reachable from the tool call that started it. When the subagent outlives that call, the two are linked and not nested.
- R5. At the content level, a model span carries the system instructions and the messages OpenCode assembled for that request, and the model's output. A tool span carries the tool's input and result.
- R6. A span states where its data came from and marks anything it left out or cut short. A reader can tell a missing value from an empty one.

**Levels and consent**

- R7. Tracing has three levels: off, structure and content. Off is the default everywhere. Structure sends an allowlisted set of non-content fields. Content adds the fields in R5.
- R8. The operator sets the level and the destination. Nothing the agent can write changes either: not repo files, not session content, not tool output.
- R9. Content is scrubbed for known secret shapes and limited in size per value, per span and per run before it leaves the process that captured it. Attachments, binary data and request headers are never sent.
- R10. Turning tracing on never sends anything recorded before it was turned on.

**The Action**

- R11. The collector credential lives only in the relay. The plugin and the OpenCode server never receive it.
- R12. The relay accepts spans only in the expected shape, enforces size and rate limits, and sets the repository and run identity itself. It ignores any identity the sender supplies.
- R13. Tracing never fails a run. A collector that is down, a full buffer or a slow flush costs spans, and the run's log says how many were dropped without printing their content.
- R14. Tracing works with and without `isolate-agent`. Without it, the Action logs a warning that the agent can read the collector credential and can write spans, and the docs say the same.
- R15. When tracing is on, OpenCode's own exporter stays off for that run.

**Policy and docs**

- R16. RFC-007 F83 is revised: tracing is off by default, content leaves only by explicit operator opt-in, and only to an endpoint the operator configured. The project never receives trace data.
- R17. The docs state what each level sends, where the credential lives, that scrubbing cannot guarantee every secret is removed, and that retention and access are the operator's collector's concern.

---

## Acceptance Examples

- AE1. **Covers R2, R4, R5.** Given content level and a turn where the agent starts a review subagent, when the operator opens the trace, they can read the system instructions of the parent's model call, the prompt handed to the subagent, and each tool the subagent called with its input and result.
- AE2. **Covers R7.** Given structure level, when a model call and a shell tool call run, the trace shows both spans with model, tokens, tool name and outcome, and no prompt text, command text or output.
- AE3. **Covers R8.** Given tracing off in the workflow, when a file in the checkout or a tool result sets a tracing endpoint or level, no spans are sent anywhere.
- AE4. **Covers R9, R6.** Given content level, when a tool result contains a provider key and 5 MB of text, the span carries a scrubbed, truncated result and marks both the redaction and the truncation.
- AE5. **Covers R11, R14.** Given an isolated Action run with tracing on, when the agent searches its environment, its config and every file it can read, it does not find the collector credential.
- AE6. **Covers R14.** Given a non-isolated Action run with tracing on, the run proceeds, sends spans, and logs one warning naming the exposure.
- AE7. **Covers R13.** Given a collector that refuses connections, when a traced run finishes, it succeeds, and its log reports the number of dropped spans.
- AE8. **Covers R12.** Given an agent that posts a span to the relay claiming another repository, the forwarded span carries the real repository and run, or is dropped.

---

## Success Criteria

- The operator can answer "what was this subagent asked, and what did its tools return" for a local session and for an Action run by opening one trace, without reading session records.
- A traced run on a published install shows the system instructions of a model call in the backend the operator chose.
- A run with tracing off sends nothing, and behaves as it does today.
- Planning can start without deciding what a trace contains, who may enable it, where the credential lives, or what the first release covers.

---

## Scope Boundaries

- Gateway tracing per binding. It needs spans routed by run ownership on a shared workspace server and is the next release.
- Standing up a collector and a trace backend. That is a task for the operator's infrastructure.
- Capture of provider wire traffic, provider-side reasoning, and anything a provider adds after OpenCode sends the request.
- Metrics and logs export. This is traces only.
- Export of past sessions.
- Merging these spans into the same trace as OpenCode's own spans.
- A fro-bot hosted collector or any default destination.

---

## Key Decisions

- Capture lives in the plugin, not in the Action or gateway process: the plugin is the only place that sees the system instructions and the assembled messages. A host reading the event stream cannot recover them.
- Managed runs export through a relay the host owns: it keeps the collector credential away from the agent and lets the host set run identity. The cost is a second trusted relay beside the key proxy.
- Spans from the plugin are untrusted input: the agent shares a process with the plugin and can write to the relay. Traces are a debugging aid and not audit evidence.
- Non-isolated runs are allowed with a warning: requiring `isolate-agent` would keep tracing from callers who cannot isolate yet, and the exposure is the same one those runs already accept for the GitHub token.
- "Full exchange" means what OpenCode assembles before it sends: exact provider traffic is upstream's to expose.
- Prior items with the same surface, and how this differs:
  - Recorded as Completed in `RFCs/RFC-007-Observability-Run-Summary.md`, with its telemetry item F83 unimplemented: this work revises F83 and builds an operator-directed export, not project telemetry.
  - Recorded as active in `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md`: the operator stream stays payload-free. Traces are a separate surface with their own consent.
  - Recorded as done in `docs/plans/2026-04-15-001-feat-durable-object-storage-plan.md`: stored sessions persist a run's records for continuity. They are not a searchable trace.

---

## Dependencies / Assumptions

- A V2 plugin can read the assembled system instructions, messages and tool definitions of each model request, and tool inputs and results, through its hooks. This was read from the OpenCode 2.3.2 source and has not been run.
- The OpenTelemetry GenAI conventions are in Development status. The span shape pins one revision and may need to move with them.
- The operator has a collector and a backend that renders GenAI content. Accepting OTLP does not mean a backend shows a readable transcript.
- An upstream request asks OpenCode to restore opt-in content capture in its own exporter. If it lands, the model-call spans here can be retired. Subagent linkage, consent levels, credential placement and scrubbing stay.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2, R5][Needs research] Run a probe on the pinned binary: compare what the plugin hooks, the event stream, session records and OpenCode's own exporter each show for a text turn, a tool error, a retry, a compaction and a background subagent.
- [Affects R2][Technical] Token usage: OpenCode's stored input count excludes cached tokens and its output count excludes reasoning. Decide how these map to the convention's totals, and how a missing count differs from zero.
- [Affects R4][Technical] How a subagent's trace is joined to its parent when the child starts its own trace root.
- [Affects R9][Technical] What the scrubber matches, the size limits, and which tool payloads are excluded by default.
- [Affects R13][Technical] Flush on shutdown: the server gets five seconds after stdin closes before it is killed. Decide where spans are buffered so a forced stop loses a bounded amount.
- [Affects R8][Technical] Where a local operator puts tracing settings so that a project's own files cannot turn tracing on or redirect it.
- [Affects R7][Technical] The exact allowlist for structure level.
- [Affects F1][Needs research] Check the existing community V2 OTel plugin against the pinned version and these requirements before building the same structural spans.
- [Affects Success Criteria][User decision] Which backend the first release is proven against. Langfuse renders GenAI transcripts and is self-hostable. Tempo with Grafana is a general trace store with no model-specific view.

---

## Sources / Research

- Facts established by reading the OpenCode source at the pinned tag:
  - OpenCode 2.3.2 exporter: on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, OTLP over HTTP only, traces and logs, no content attributes.
  - OpenCode 1.19.x passed `experimental.openTelemetry` to the AI SDK's `experimental_telemetry` on each model call. 2.3.2 lists `openTelemetry` as an unsupported legacy key.
  - Upstream `anomalyco/opencode`: PR #60974 (per-turn native traces, merged before 2.3.2), PR #64438 (assistant message id on the request hook, open), PR #35935 (structural V2 tracing, closed, with a follow-up request for content opt-in), issue #47351 (managed OTLP settings, open).
- `packages/runtime/src/agent/filter-env.ts` and `apps/workspace-agent/src/opencode-server-v2.ts`: the env allowlists that drop `OTEL_*` today.
- `packages/opencode-plugin/`: the plugin that gains tracing. It ships four session tools and a subagent-reuse guard today.
- `packages/runtime/src/agent/key-proxy*.ts` and `src/harness/phases/key-proxy-process.ts`: the existing pattern for a trusted loopback process started outside the sandbox.
- `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md`: lessons for a relay that an untrusted process talks to.
- `docs/solutions/workflow-issues/published-install-live-check-before-rollout-2026-11-17.md`: an opt-in feature is proven on a published install with dummy credentials before rollout.
- OpenTelemetry GenAI semantic conventions: `https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai`.
