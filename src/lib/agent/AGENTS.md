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
verifyOpenCodeAvailable(path, logger) // Binary validation
collectAgentContext(client, context, logger) // GitHub event context
buildAgentPrompt(options, logger) // Multi-section prompt
acknowledgeReceipt(ctx, logger) // Eyes + working label
markSuccess(ctx, logger) // Replace with 🎉
markFailure(ctx, logger) // Replace with 😕
```

## CONVENTIONS

- **Reaction-based UX**:
  - **Start**: 👀 (Eyes) reaction on triggering comment
  - **Success**: Replace 👀 with 🎉 (Hooray)
  - **Failure**: Replace 👀 with 😕 (Confused)
  - **Non-fatal**: Reaction failures are logged but never crash the agent

- **Working Label**:
  - `agent: working` (color: `fcf2e1`) added on start
  - Always removed on completion (success or failure)
  - Created lazily if missing

- **Execution Safety**:
  - **SDK Mode**: Spawn OpenCode server, connect via SDK client (RFC-013)
  - **Event Streaming**: SSE subscription for real-time logging (fire-and-forget)
  - **Connection Retry**: 30 attempts with 1s delay for server startup
  - **Timings**: `startTime` / `duration` tracked for all operations

## ANTI-PATTERNS

| Pattern              | Why to Avoid                                                        |
| -------------------- | ------------------------------------------------------------------- |
| **Blocking on UX**   | Reactions are "nice to have"; API failures shouldn't stop the agent |
| **Buffered Output**  | Running without `stdbuf` on Linux hides logs until process exit     |
| **Implicit Context** | Relying on `process.env` directly; use `AgentContext` passed down   |
| **Silent Failures**  | Always return `success: false` + `error` string in Result objects   |
