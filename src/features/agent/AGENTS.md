# AGENT MODULE

OpenCode SDK execution with GitHub context injection, multi-section prompt construction, and UX feedback loops.

## WHERE TO LOOK

| Component     | File              | Responsibility                                                         |
| ------------- | ----------------- | ---------------------------------------------------------------------- |
| **Execution** | `opencode.ts`     | SDK server spawn, session events, prompt sending, streaming (634 L)    |
| **Context**   | `context.ts`      | Gathers event data from NormalizedEvent, diff, hydrated context        |
| **UX**        | `reactions.ts`    | Emojis (👀/🎉/😕), `agent: working` label state machine (140 L)        |
| **Prompting** | `prompt.ts`       | Multi-section prompt with response protocol and output contract (420L) |
| **Budgeting** | `diff-context.ts` | Context limits (50 files in context, 20 in prompt) (75 L)              |
| **Types**     | `types.ts`        | `AgentContext`, `AgentResult`, `PromptOptions`, `DiffContext` (138 L)  |

## KEY EXPORTS

- `executeOpenCode(prompt, config, logger)`: Main SDK execution entry point
- `ensureOpenCodeAvailable(options)`: Automated binary installation if missing
- `collectAgentContext(logger)`: Hydrates event metadata from NormalizedEvent
- `buildAgentPrompt(options, logger)`: Compiles multi-section prompt (see Prompt Architecture)
- `buildTaskSection(context, promptInput)`: Task directive with append-mode support
- `getTriggerDirective(context, promptInput)`: Per-event directive selection
- `buildResponseProtocolSection(...)`: CI output rules (single comment, Run Summary)
- `buildOutputContractSection(context)`: PR review action guidance
- `buildDiffContextSection(diffContext)`: PR diff summary injection
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

## PATTERNS

- **SDK Lifecycle (RFC-013)**: Spawn server → connect client → create session → send prompt → stream events → close
- **Connection Retry**: 30 retries with 1s delay to account for async server startup
- **Event Streaming**: SSE subscription provides real-time progress logging to CI console
- **Reaction-based UX**: Non-fatal state machine (Eyes → Hooray/Confused); failures never crash execution
- **Context Budgeting**: Two-tier enforcement (50 files fetched, 20 files injected into prompt)
- **NormalizedEvent Intake**: `collectAgentContext` reads from `NormalizedEvent` (not raw payloads)

## ANTI-PATTERNS

| Forbidden         | Reason                                                            |
| ----------------- | ----------------------------------------------------------------- |
| Blocking on UX    | Reactions are secondary; API failures must not halt execution     |
| Buffered output   | Linux environments require `stdbuf` to avoid log delay            |
| Implicit context  | Always use `AgentContext` instead of direct `process.env`         |
| Silent failures   | Never swallow errors; return `success: false` + error string      |
| Raw event access  | Use NormalizedEvent via `collectAgentContext`, never raw payloads |
| Multiple comments | Response Protocol: exactly ONE comment/review per invocation      |
