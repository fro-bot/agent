---
date: 2026-11-19
topic: opencode-run-tracing
---

# OpenTelemetry Tracing of OpenCode Runs

## Summary

`@fro.bot/opencode-plugin` gains opt-in OpenTelemetry tracing. It records each model call, tool call and subagent of a run as `gen_ai` spans, with their content, and sends them to a collector the operator controls. The first release covers local OpenCode sessions and the GitHub Action. In the Action, a relay started by the Action holds the collector credential and forwards the spans.

---

## Problem Frame

An operator cannot see what an agent run sent to the model. The Action's logs and job summary show tool names and the final reply. They do not show the system prompt, the context OpenCode and its plugins add, the prompt a subagent was given, or what a tool returned. Questions such as "why did this subagent pick that model" or "what did the review subagent read" can only be answered by reconstructing the run from session records by hand.

OpenCode V1 could export this. Its `experimental.openTelemetry` setting turned on the AI SDK's telemetry, which records prompt messages, response text and tool arguments. OpenCode V2 replaced that code path with its own runner. Its exporter sends spans with model, token, cost and timing data and no content, and no setting adds the content back. The Action and the workspace also remove every `OTEL_*` variable from the server's environment, so even those spans are off today.

The repo's recorded telemetry policy (RFC-007, F83) says raw prompts are never sent to an external system. That rule was written for telemetry the project might collect. It also blocks an operator from sending their own runs to their own collector, which is the case here.

---

## Actors

- A1. Operator: the person who owns the repo workflow or the workstation, turns tracing on, chooses the collector and reads the traces.
- A2. Agent: the model and its tools, running inside the OpenCode server. Always untrusted. Under `isolate-agent` it also cannot read the Action's files, environment or processes.
- A3. Plugin: `@fro.bot/opencode-plugin`, loaded by the OpenCode server. It observes the run and produces spans. It shares a process with the agent.
- A4. Relay: a loopback process the Action starts beside the existing key proxy. It receives spans from the plugin and forwards them to the collector with the credential.
- A5. Collector: an OpenTelemetry collector the operator runs or rents. It is outside this repo.

---

## Key Flows

- F1. Local session
  - **Trigger:** The operator enables tracing in their own user settings and starts an OpenCode session.
  - **Actors:** A1, A3, A5
  - **Steps:** The plugin reads the operator's user-scope tracing settings. It records each turn as a trace. It sends spans to the operator's collector. No relay is used. Keeping a remote backend's credential in that collector, and out of plugin settings, is the operator's choice.
  - **Outcome:** The operator opens the turn in their trace backend and reads each model call, tool call and subagent.
  - **Covered by:** R1 to R11, R15

- F2. Action run
  - **Trigger:** A workflow that enables tracing through Action inputs runs. Tracing follows the run: any trigger and actor the workflow lets through is traced.
  - **Actors:** A1, A2, A3, A4, A5
  - **Steps:** The Action starts the relay before the agent and gives the plugin the relay's address and the run's identity. The plugin sends spans to the relay over loopback. The relay forwards them to the collector with the credential. At the end of the run the plugin drains to the relay, the relay flushes to the collector, each within a time bound, and the Action stops the relay.
  - **Outcome:** The run's trace is in the operator's backend, tagged with the repository and run. In an isolated run the agent never held the collector credential.
  - **Covered by:** R1 to R16

---

## Requirements

**What a trace contains**

- R1. One trace covers one turn of a session: the prompt, the model and tool work it starts, the subagents that work starts, and the follow-on work when a background subagent reports back. OpenCode has no turn id, so the plugin defines the turn from execution and idle events. Two exceptions, both marked on the spans: a turn with no activity for a bounded time is closed as incomplete, and a report that arrives after that starts a new trace that names the first; a report delivered inside a later turn's execution has its follow-on work in that later turn's trace, which names the turn that dispatched it. Both traces carry the same root session id, so they are found together through the session.
- R2. Each model request is a span that follows the OpenTelemetry GenAI conventions for inference. It carries the provider, model and agent, and the token usage and finish reason when OpenCode reports them. This includes title and compaction requests, where OpenCode reports less. A retried request is one span per attempt where OpenCode exposes the attempt. Where it retries below what a plugin can see, the request is one span that says its attempt count is unknown.
- R3. Each tool call is a span that follows the GenAI conventions for tool execution, with the tool name, call id, input, result and outcome. The result is what the model received, after the tool's own truncation. A rejected or interrupted call is recorded as such. A call the provider executes itself is a span built from session events alone, with whatever input and result those events carry.
- R4. A subagent's spans are in the same trace as the turn that started it, under the tool call that started it. This holds for a background subagent that is still running after that call returned. Reading a subagent never depends on span links, which Langfuse does not show.
- R5. A model span carries the system instructions, the messages and the tool definitions as the plugin's hook saw them, and the model's output. The hook sees the request before OpenCode's own filtering and before any plugin listed after it, so the span is labelled as the hook-time view and not the bytes sent to the provider. The Action lists this plugin last.
- R6. Every span carries the session id and agent name, and a subagent's spans also carry the root session's id, in the attributes a backend uses to group a session. In the Action a span also carries the repository, run id and trigger, which the Action supplies.
- R7. A span marks any value it redacted or truncated. An absent attribute means the value was not captured.

**Consent and settings**

- R8. Tracing is off by default everywhere and has one switch. On means every span in R1 to R7 with its content. There is no default destination and no fallback when the operator's endpoint is unset.
- R9. Only the operator turns tracing on and sets the destination. In the Action both come from workflow inputs, handed to the plugin once at server start. The plugin reads no tracing settings from the checkout, from repo-supplied OpenCode config, from restored session or cache state, or from session content. In a local session they come from user-scope settings only, and a project's own config can neither enable tracing nor redirect it.
- R10. Content is scrubbed for known secret shapes over the whole value, then bounded in size, before it leaves the plugin. Attachments, binary data and request headers are never sent.
- R11. No spans are created for turns that ended before tracing was on. A model span on a traced turn carries the session history that OpenCode sent with that request, including turns restored from earlier runs.

**The Action relay**

- R12. The Action gives the collector credential only to the relay. The plugin and the OpenCode server are never handed it.
- R13. The relay forwards only to the operator-configured endpoint. It binds to loopback on an ephemeral port, serves one route, never follows redirects, sends the credential only over HTTPS or to a loopback collector, caps request size and total bytes per run, and never returns a collector response body to the sender.
- R14. Tracing works with and without `isolate-agent`. Without it, the Action logs one warning that the agent can read the collector credential.
- R15. Tracing never fails a run. A relay that cannot start, a collector that is down, a full buffer or a slow flush costs spans. In the Action, the run's log reports what happened to each batch the relay received: acknowledged by the collector, to be retried, or dropped. It also reports the plugin's own span totals as of the last batch the plugin sent, which cannot include that batch's outcome or anything dropped after it. The log has no content, and says when the counts are incomplete because a process was killed. In a local session the plugin logs its own span totals at exit. Buffered spans are held in memory only.
- R16. The Action keeps `OTEL_*` out of the server's environment, so OpenCode's own exporter stays off. A local operator who also sets `OTEL_EXPORTER_OTLP_ENDPOINT` gets OpenCode's spans as a second, separate export.

**Release and policy**

- R17. The plugin does nothing when tracing is off, and adds no install or start-up failure to a run that does not use it. Outside a local session and the Action it stays off whatever its settings say, until gateway tracing ships. A local session is any OpenCode process the operator runs as themselves on a machine their own settings file names, with no launcher-declared host and no headless marker. That includes a server the operator starts by hand on that machine. The file is the operator's consent for that machine, not for one front-end.
- R18. RFC-007 F83 is revised to match R8 and R9, and states that the project never receives trace data. The docs state what a trace contains, that it includes session history and may include secrets and other people's text, that scrubbing is best-effort, that an agent can write misleading spans to the operator's collector, and that the collector needs the same access control and retention as CI logs. They recommend an ingest-only credential scoped to one project.

---

## Acceptance Examples

- AE1. **Covers R2, R3, R4, R5.** Given tracing on and a turn where the agent starts a review subagent, when the operator opens the trace, they can read the system instructions of the parent's model call, the prompt handed to the subagent, and each tool the subagent called with its input and result.
- AE2. **Covers R1, R4.** Given a background subagent still running after its tool call returned, its spans appear in the turn's trace under that tool call, and so does the parent's follow-on work when the subagent reports back.
- AE3. **Covers R9.** Given tracing off in the workflow, when a file in the checkout, a tool result, or state restored from an earlier run names a tracing endpoint, no spans are sent anywhere.
- AE4. **Covers R9.** Given a cloned repository whose project config enables tracing, when the operator opens a local session with tracing off in their user settings, no spans are sent.
- AE5. **Covers R7, R10.** Given a tool result that contains a provider key and 5 MB of text, the span carries a scrubbed, truncated result and marks both the redaction and the truncation.
- AE6. **Covers R12.** Given an isolated Action run with tracing on, the collector credential is absent from the server's environment, its config files and the arguments of every process the agent can list.
- AE7. **Covers R14.** Given a non-isolated Action run with tracing on, the run proceeds, sends spans, and logs one warning naming the exposure.
- AE8. **Covers R15.** Given a collector that refuses connections, when a traced run finishes, it succeeds, and its log reports the batches that were not acknowledged.
- AE9. **Covers R13.** Given a request to the relay that names another host, in its path, a header or its body, the relay still forwards only to the configured endpoint.
- AE10. **Covers R1, R7, R15.** Given a long session with a compaction, a retried model call, a background subagent and several multi-megabyte tool results, the trace still shows every model and tool span with its identity, and each span that lost content says so.

---

## Success Criteria

- The operator can answer "what was this subagent asked, and what did its tools return" for a local session and for an Action run from one trace, without reading session records.
- This is shown end to end on a published install with a dummy credential, with the content readable in Langfuse. Tempo holds the same traces with content cut to its attribute limit.
- A run with tracing off sends nothing and behaves as it does today.

---

## Scope Boundaries

- Gateway tracing per binding. It needs spans routed by run ownership on a shared workspace server and is the next release.
- A structure-only level that sends spans without content.
- Decoding spans in the relay: enforcing fields, rewriting identity or span ids, re-scrubbing, rate limiting.
- Standing up the collector and backends. That is a task for the operator's infrastructure.
- Capture of provider wire traffic, provider-side reasoning, and anything changed after the plugin's hook runs.
- Metrics and logs export, sampling, and OTLP over gRPC.
- Spans for the Action's own phases, and a job-summary link to the trace.
- Export of past sessions.
- Merging these spans into the same trace as OpenCode's own spans.
- A fro-bot hosted collector.

---

## Key Decisions

- Capture lives in the plugin, not in the Action or gateway process: the plugin's hooks see the system instructions and the assembled messages, and a process reading the event stream cannot recover them.
- Action runs export through a relay the Action owns: it keeps the collector credential out of the server the agent shares. The cost is a second loopback process beside the key proxy.
- The relay is a fixed-destination forwarder and does not inspect spans: the agent can write misleading spans to the operator's own collector, the genuine spans still arrive, and traces are a debugging aid and not audit evidence.
- One switch, content included: the purpose is to read prompts, tool data and model output, so a level without them has no user yet.
- Session history is exported as part of each model span: the span shows what the model was sent.
- A subagent joins its parent's trace: the plugin builds the spans, so it chooses the trace, and OpenCode 2.3.2 runs every subagent as a separate execution that would otherwise be a separate trace.
- Non-isolated runs are allowed with a warning: the exposure is the one those runs already accept for the GitHub token.
- The first release is proven against Langfuse for reading transcripts. The operator's collector also sends to Tempo for general trace storage.
- RFC-007's telemetry item F83 is recorded as unimplemented in `RFCs/RFC-007-Observability-Run-Summary.md`. This work revises it and builds an operator-directed export, not project telemetry.

---

## Dependencies / Assumptions

- A probe on the pinned 2.3.2 binary (darwin-arm64, scripted provider) confirmed what a plugin sees. The request hook carries the system instructions with their sources, the messages and the tool definitions, for primary, retry, compaction, title and subagent requests. Usage and finish reason come from step events for primary requests. Title requests report no finish reason, and compaction reports tokens without one. Tool results and failures arrive as session events keyed by call id. A tool's after-hook does not fire for a rejected or interrupted call. The subagent tool returns in milliseconds with the child's session id, before the child's first model request.
- Not yet run: `isolate-agent`, Linux, real providers, multi-megabyte tool results, parallel subagents, and the published plugin's install cost.
- Three community V2 tracing plugins exist. None meets these requirements: each sends only to one vendor, captures content with no switch or scrubbing, or reads repo-supplied settings. Their secret scrubber and user-scope settings file are worth borrowing.
- Langfuse does not show span links and groups traces by session id. Tempo cuts attributes at 2,048 bytes by default. Content is bounded in the plugin, because a collector cannot truncate structured values.
- The project moves the OpenCode pin every few days. The probe runs again on each pin change, and a hook that changes shape must show up as marked gaps in spans, not as silently thinner traces.
- The OpenTelemetry GenAI conventions are in Development status. The span shape pins one revision.
- Accepting OTLP does not mean a backend renders a transcript. Langfuse's ingestion code reads the current GenAI message attributes and its keys can be limited to ingestion. Both are confirmed on a real instance before release.
- An upstream request asks OpenCode to restore opt-in content capture in its own exporter. If it ships, it is evaluated against these requirements before any of this capture is retired.
- Adding OpenTelemetry code to the plugin changes its published package. Its install and start-up cost with tracing off is measured, not assumed.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R4][Technical] The exact rule for where a turn's trace starts and ends, given that a prompt sent mid-run joins the running execution and a subagent's report starts a new execution with no prompt. Also parallel and reused subagents, and concurrent sessions.
- [Affects R2][Technical] Whether to read title, compaction and generate output from the response body the plugin can clone, or to mark those fields absent.
- [Affects R2][Technical] How OpenCode's token counts map to the convention's totals. Its stored input count excludes cached tokens and its output count excludes reasoning.
- [Affects R10][Technical] What the scrubber matches, the size bounds, and whether the repo's existing log redaction can be reused.
- [Affects R11, AE10][Technical] How repeated session history across many model spans stays within the size bounds without losing the spans that matter.
- [Affects R15][Technical] The drain and flush order and time budget inside the existing shutdown window. The probe measured about five seconds for the plugin's cleanup before the server is killed.
- [Affects R9, R13][Technical] How the Action hands the plugin the relay address and run identity through the server's filtered environment, and how the relay's lifecycle sits beside the key proxy's, including two traced steps in one job.
- [Affects R9][Technical] Where user-scope tracing settings live for a local session.

---

## Sources / Research

- OpenCode at tag `v2.3.2`: the exporter is on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, speaks OTLP over HTTP, sends traces and logs, and has no content attributes. OpenCode 1.19.x passed `experimental.openTelemetry` to the AI SDK's `experimental_telemetry`. 2.3.2 lists `openTelemetry` as an unsupported legacy key.
- Upstream `anomalyco/opencode`: PR #60974 (per-turn native traces, merged before 2.3.2), PR #64438 (assistant message id on the request hook, open), PR #35935 (structural V2 tracing, closed, with a follow-up request for content opt-in), issue #47351 (managed OTLP settings, open).
- `packages/runtime/src/agent/filter-env.ts` and `apps/workspace-agent/src/opencode-server-v2.ts`: the env allowlists that drop `OTEL_*` today.
- `packages/opencode-plugin/`: the plugin that gains tracing.
- `src/harness/phases/key-proxy-process.ts` and `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md`: the existing pattern, and its lessons, for a loopback process that holds a credential for an untrusted client.
- `docs/solutions/workflow-issues/published-install-live-check-before-rollout-2026-11-17.md`: an opt-in feature is proven on a published install with dummy credentials before rollout.
- OpenTelemetry GenAI semantic conventions: `https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai`.
