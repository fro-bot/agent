# AGENT MODULE

**Scope:** OpenCode SDK execution harness with GitHub context injection and UX feedback loops.

## WHERE TO LOOK

| Component     | File           | Responsibility                                   |
| ------------- | -------------- | ------------------------------------------------ |
| **Execution** | `opencode.ts`  | SDK server spawn, session events, prompt sending |
| **Context**   | `context.ts`   | Gathers event data, defaults, issue details      |
| **UX**        | `reactions.ts` | Emojis (👀/🎉/😕), `agent: working` label        |
| **Prompting** | `prompt.ts`    | Builds final prompt with session/cache context   |
| **Types**     | `types.ts`     | `AgentContext`, `AgentResult`, `ExecutionConfig` |

## KEY EXPORTS

```typescript
executeOpenCode(prompt, config, logger) // Main SDK execution
ensureOpenCodeAvailable(options) // Auto-setup if missing
collectAgentContext(logger) // GitHub event context
buildAgentPrompt(options, logger) // Multi-section prompt
acknowledgeReceipt(client, ctx, logger) // Eyes + working label
completeAcknowledgment(client, ctx, success, logger) // Finalize UX
```

## PATTERNS

- **SDK Lifecycle (RFC-013)**: Spawn server → connect client → create session → send prompt → stream events → close
- **Connection Retry**: 30 retries (1s delay) for server startup
- **Event Streaming**: SSE subscription for real-time logging
- **Reaction-based UX**:
  - Start: 👀 (Eyes) + `agent: working` label (`fcf2e1`)
  - Success: Replace 👀 with 🎉 (Hooray) + remove label
  - Failure: Replace 👀 with 😕 (Confused) + remove label
  - Non-fatal: UX failures logged but never crash execution

## ANTI-PATTERNS

| Forbidden        | Reason                                                          |
| ---------------- | --------------------------------------------------------------- |
| Blocking on UX   | Reactions are "nice to have"; API failures shouldn't stop agent |
| Buffered output  | Running without `stdbuf` on Linux hides logs until exit         |
| Implicit context | Don't use `process.env` directly; use `AgentContext`            |
| Silent failures  | Always return `success: false` + `error` string in Result       |
