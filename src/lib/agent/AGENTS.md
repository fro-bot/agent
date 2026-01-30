# AGENT MODULE

OpenCode SDK execution with GitHub context injection and UX feedback loops.

## WHERE TO LOOK

| Component     | File              | Responsibility                                                      |
| ------------- | ----------------- | ------------------------------------------------------------------- |
| **Execution** | `opencode.ts`     | SDK server spawn, session events, prompt sending, streaming (634 L) |
| **Context**   | `context.ts`      | Gathers event data, defaults, issue details (125 L)                 |
| **UX**        | `reactions.ts`    | Emojis (👀/🎉/😕), `agent: working` label state machine (140 L)     |
| **Prompting** | `prompt.ts`       | Builds multi-section prompt with session/cache context (350 L)      |
| **Budgeting** | `diff-context.ts` | Context limits (50 files in context, 20 in prompt) (75 L)           |
| **Types**     | `types.ts`        | `AgentContext`, `AgentResult`, `ExecutionConfig` (135 L)            |

## KEY EXPORTS

- `executeOpenCode(prompt, config, logger)`: Main SDK execution entry point
- `ensureOpenCodeAvailable(options)`: Automated binary installation if missing
- `collectAgentContext(logger)`: Hydrates event metadata from GitHub environment
- `buildAgentPrompt(options, logger)`: Compiles instruction sections and context
- `acknowledgeReceipt(client, ctx, logger)`: Posts 👀 reaction and "working" label
- `completeAcknowledgment(client, ctx, success, logger)`: Finalizes UX state on completion

## PATTERNS

- **SDK Lifecycle (RFC-013)**: Spawn server → connect client → create session → send prompt → stream events → close
- **Connection Retry**: 30 retries with 1s delay to account for async server startup
- **Event Streaming**: SSE subscription provides real-time progress logging to CI console
- **Reaction-based UX**: Non-fatal state machine (Eyes → Hooray/Confused); failures never crash execution
- **Context Budgeting**: Two-tier enforcement (50 files fetched, 20 files injected into prompt)

## ANTI-PATTERNS

| Forbidden        | Reason                                                        |
| ---------------- | ------------------------------------------------------------- |
| Blocking on UX   | Reactions are secondary; API failures must not halt execution |
| Buffered output  | Linux environments require `stdbuf` to avoid log delay        |
| Implicit context | Always use `AgentContext` instead of direct `process.env`     |
| Silent failures  | Never swallow errors; return `success: false` + error string  |
