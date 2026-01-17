# AGENT MODULE

**Overview**: OpenCode SDK execution harness with GitHub context injection and UX feedback loops.

## WHERE TO LOOK

| Component     | File           | Responsibility                                       |
| ------------- | -------------- | ---------------------------------------------------- |
| **Execution** | `opencode.ts`  | SDK server spawn, connection, session events, exec   |
| **Context**   | `context.ts`   | Gathers event data, defaults, and issue details      |
| **UX**        | `reactions.ts` | Manages emojis (👀/🎉/😕) and 'agent: working' label |
| **Prompting** | `prompt.ts`    | Builds final prompt with session/cache context       |
| **Types**     | `types.ts`     | `AgentContext`, `AgentResult`, `ExecutionConfig`     |

## KEY EXPORTS

```typescript
executeOpenCode(prompt, config, logger) // Main SDK execution
ensureOpenCodeAvailable(options) // Auto-setup if missing
collectAgentContext(logger) // GitHub event context
buildAgentPrompt(options, logger) // Multi-section prompt
acknowledgeReceipt(client, ctx, logger) // Eyes + working label
completeAcknowledgment(client, ctx, success, logger) // Finalize UX
```

## CONVENTIONS

- **Reaction-based UX**:
  - **Start**: 👀 (Eyes) on trigger + `agent: working` label (`fcf2e1`)
  - **Success**: Replace 👀 with 🎉 (Hooray) + remove label
  - **Failure**: Replace 👀 with 😕 (Confused) + remove label
  - **Non-fatal**: UX failures logged but never crash execution

- **Execution Safety**:
  - **SDK Mode**: Spawn OpenCode server, connect via SDK client (RFC-013)
  - **Connection**: 30 retries (1s delay) for server startup
  - **Event Streaming**: SSE subscription for real-time logging
  - **Timings**: `startTime` / `duration` tracked for all operations

## ANTI-PATTERNS

| Pattern              | Why to Avoid                                                        |
| -------------------- | ------------------------------------------------------------------- |
| **Blocking on UX**   | Reactions are "nice to have"; API failures shouldn't stop the agent |
| **Buffered Output**  | Running without `stdbuf` on Linux hides logs until process exit     |
| **Implicit Context** | Relying on `process.env` directly; use `AgentContext` passed down   |
| **Silent Failures**  | Always return `success: false` + `error` string in Result objects   |
