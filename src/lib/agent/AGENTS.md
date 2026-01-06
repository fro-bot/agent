# AGENT MODULE

**Overview**: OpenCode CLI execution harness with GitHub context injection and UX feedback loops.

## WHERE TO LOOK

| Component     | File           | Responsibility                                       |
| ------------- | -------------- | ---------------------------------------------------- |
| **Execution** | `opencode.ts`  | Runs `opencode` CLI (uses `stdbuf` on Linux)         |
| **Context**   | `context.ts`   | Gathers event data, defaults, and issue details      |
| **UX**        | `reactions.ts` | Manages emojis (👀/🎉/😕) and 'agent: working' label |
| **Prompting** | `prompt.ts`    | Builds final system prompt with session/cache state  |
| **Types**     | `types.ts`     | `AgentContext`, `AgentResult`, `ReactionContext`     |

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
  - **Linux**: Wraps with `stdbuf -oL -eL` for real-time log streaming
  - **Timings**: `startTime` / `duration` tracked for all operations
  - **Path**: Fallback to `opencode` in PATH if no binary provided

- **Code Style**:
  - **Parallelism**: `acknowledgeReceipt` runs reaction + label concurrently
  - **Pure Functions**: Logic separated from side effects where possible
  - **Result Types**: Returns `AgentResult` object, catches and wraps errors

## ANTI-PATTERNS

| Pattern              | Why to Avoid                                                        |
| -------------------- | ------------------------------------------------------------------- |
| **Blocking on UX**   | Reactions are "nice to have"; API failures shouldn't stop the agent |
| **Buffered Output**  | Running without `stdbuf` on Linux hides logs until process exit     |
| **Implicit Context** | Relying on `process.env` directly; use `AgentContext` passed down   |
| **Silent Failures**  | Always return `success: false` + `error` string in Result objects   |
