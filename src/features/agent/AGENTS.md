# AGENT MODULE

OpenCode V2 execution with GitHub context injection, multi-section prompt construction, and UX feedback loops.

## WHERE TO LOOK

| Component     | File               | Responsibility                                                          |
| ------------- | ------------------ | ----------------------------------------------------------------------- |
| **Execution** | `execution-v2.ts` | V2 session creation, prompt attempts, result collection |
| **Prompting** | `prompt-sender-v2.ts` | Prompt submission to a V2 session, model resolution |
| **Retry**     | `retry-v2.ts`      | `runPromptAttemptV2` with the event stream |
| **Polling**   | `session-poll-v2.ts` | Completion observation, event processor shutdown |
| **Streaming** | `streaming-v2.ts`  | V2 event stream processing, artifact detection |
| **Context**   | `context.ts`       | Gathers event data from NormalizedEvent, diff, hydrated context         |
| **UX**        | `reactions.ts`     | Emojis (👀/🎉/😕), `agent: working` label state machine (140 L)         |
| **Prompt**    | `prompt.ts`        | Multi-section prompt with response protocol and output contract (420 L) |
| **Budgeting** | `diff-context.ts`  | Context limits (50 files in context, 20 in prompt) (75 L)               |
| **Types**     | `types.ts`         | `AgentContext`, `AgentResult`, `PromptOptions`, `DiffContext` (138 L)   |
| **OutputMode** | `output-mode.ts`  | `resolveOutputMode()` for manual triggers; `auto` safely aliases `working-dir` |

## KEY EXPORTS

- `executeOpenCodeV2(...)`: Main execution entry point (V2 server, raw HTTP/SSE)
- `collectAgentContext(logger)`: Hydrates event metadata from NormalizedEvent
- `buildAgentPrompt(options, logger)`: Compiles multi-section prompt
- `buildTaskSection(context, promptInput, resolvedMode)`: Task directive with append-mode and Delivery Mode preamble
- `getTriggerDirective(context, promptInput)`: Per-event directive selection
- `resolveOutputMode(eventType, configuredMode)`: Resolves the operator-level Delivery Mode contract for manual triggers (returns `null` for non-manual)
- `buildResponseProtocolSection(...)`: CI output rules (single comment, Run Summary)
- `buildOutputContractSection(context)`: PR review action guidance
- Diff summary is merged inline into `buildHydratedContextSection()` PR metadata
- `buildSessionContextSection(sessionContext)`: Prior work metadata injection
- `acknowledgeReceipt(client, ctx, logger)`: Posts 👀 reaction and "working" label
- `completeAcknowledgment(client, ctx, success, logger)`: Finalizes UX state on completion

## PROMPT ARCHITECTURE

`buildAgentPrompt` assembles sections conditionally:

```
Agent Context (always)
  └─ Operating Environment (CI, non-interactive)
Task Section (from TriggerDirective or fallback)
  ├─ Directive (event-specific default action)
  └─ Additional Instructions (custom prompt, appended or replaced)
Output Contract (PR triggers only)
  ├─ Review action guidance
  └─ Author association context
Environment (always)
  └─ Repo, branch, actor, event, cache status
Trigger Comment / Issue Body / PR Body (when available)
Diff Context (PR triggers only)
  └─ Changed files table, +/- stats
Hydrated Context (issue/PR when available)
  └─ Via formatContextForPrompt()
Session Context (when sessions exist)
  ├─ Recent Sessions table
  └─ Relevant Prior Work excerpts
Response Protocol (REQUIRED, always)
  └─ Single comment rule, Run Summary template, bot marker
gh CLI Reference (always)
  └─ Comment, review, API call examples
```

### TriggerDirective System

`getTriggerDirective()` returns `{directive, appendMode}` per event:

| Event                          | Append Mode | Behavior                                            |
| ------------------------------ | ----------- | --------------------------------------------------- |
| `issue_comment`                | true        | Directive + custom prompt appended                  |
| `discussion_comment`           | true        | Directive + custom prompt appended                  |
| `pull_request_review_comment`  | true        | Dynamic: includes file, line, diffHunk context      |
| `issues` (opened)              | true        | Triage directive + custom appended                  |
| `issues` (edited w/ mention)   | true        | Mention-response directive + custom appended        |
| `pull_request`                 | true        | Code review directive + custom appended             |
| `schedule`/`workflow_dispatch` | false       | Custom prompt IS the directive (replaces, required) |

### Response surfaces

The Action derives the response surface from trusted routing context and carries it through prompting, parsing, and delivery. A `pull_request` run requires a review; an authorized `issue_comment` mention on a pull request permits either a review when the response includes a verdict or a comment when it does not; other response-file paths are comment-only. Mention authorization uses the existing `OWNER`/`MEMBER`/`COLLABORATOR` association gate. The response file supplies response content, never the delivery target or surface.

## PATTERNS

- **Lifecycle**: Start the V2 server (`startActionOpenCodeV2`) → create or continue a session → send prompt → stream events → shut down
- **No `question` tool in CI**: nobody can answer in CI and a pending question blocks until the deadline (#1756), so the V2 permission rules (`buildPermissionRulesV2`) deny it
- **Task-reuse guard**: the `@fro.bot/opencode-plugin` guard rejects a `subagent` call that carries a `sessionID`, so each background job has its own child session
- **Per-message usage accounting**: Upstream reports `tokens`/`cost` on each assistant MESSAGE for that message only (new message per prompt-loop iteration; one message re-fires `message.updated`). `processEventStreamV2` keeps `usageByMessage` keyed by message id (latest wins), `summarizeMessageUsage` sums it across all owned sessions, and `executeOpenCode` merges retry attempts by message id via `mergeAttemptUsage`. Never reduce this to per-session latest-wins (drops every turn but the last). No resumed-session baseline filter is needed — SSE delivers only post-subscribe events
- **V2 has no post-send retry**: a V2 turn that fails after the prompt was sent ends the run (V2 retries transient provider errors itself); only a stream that never connected, or a prompt the server refused, is sent again. A transport failure of the POST is `sendUncertain`: never resent, save declined. V1 keeps its continuation-prompt loop
- **Event Streaming**: SSE subscription provides real-time progress logging to CI console. The SDK stream is lazy and OpenCode replays nothing to a late connection, so `runPromptAttemptV2` waits for the stream's `server.connected` frame (reported by `processEventStream`'s `onStreamConnected`, handled before the unarmed-turn guard) before the baseline read and `startPrompt`, bounded by `EVENT_STREAM_CONNECT_TIMEOUT_MS` (10 s) and the execution deadline. Only a new prompt waits; a stream that ends or stays silent first fails the attempt as `submit_failed` with nothing sent, and a deadline expiry rejects as `DeadlineExceededError`
- **Reaction-based UX**: Non-fatal state machine (Eyes → Hooray/Confused); failures never crash execution
- **Context Budgeting**: Two-tier enforcement (50 files fetched, 20 files injected into prompt)
- **NormalizedEvent Intake**: `collectAgentContext` reads from `NormalizedEvent` (not raw payloads)
- **Setup Option Pass-through**: `EnsureOpenCodeOptions` includes `systematicVersion` and `systematicConfig` for setup handoff

## ANTI-PATTERNS

| Forbidden         | Reason                                                            |
| ----------------- | ----------------------------------------------------------------- |
| Blocking on UX    | Reactions are secondary; API failures must not halt execution     |
| Buffered output   | Linux environments require `stdbuf` to avoid log delay            |
| Implicit context  | Always use `AgentContext` instead of direct `process.env`         |
| Silent failures   | Never swallow errors; return `success: false` + error string      |
| Raw event access  | Use NormalizedEvent via `collectAgentContext`, never raw payloads |
| Multiple comments | Response Protocol: exactly ONE comment/review per invocation      |
