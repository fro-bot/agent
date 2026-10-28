/**
 * Rejects `subagent` calls that resume a child session via `sessionID`, before they execute.
 *
 * Port of `deploy/plugins/no-task-reuse.mjs` (V1: `tool.execute.before`, `task` tool, `task_id`). Completion notices
 * name the child session, never the job, so jobs on a reused session cannot be told apart; every subagent must get a
 * fresh child session.
 *
 * V2 hook: `ctx.tool.hook('execute.before', cb)`. The core fires it for every tool call in `core/src/tool.ts`
 * (`beforeExecute`, ~L106) with `{tool, sessionID, agent, messageID, id, input}`; only this hook may fail, and a throw
 * in a Promise-API callback becomes a `Tool.Error` that rejects that one call
 * (`packages/plugin/src/promise/adapter.ts`, `toolHook["execute.before"]`). The tool is `subagent`
 * (`core/src/tool/plugin/subagent.ts`, `name = "subagent"`) and the resume field is its `sessionID` input.
 */

/** The fixed, model-visible rejection. No session ids, no arguments, no secrets. */
export const TASK_REUSE_REJECTION =
  'Session reuse is disabled in this environment. Start a new task and include the context it needs.'

/** The one tool the guard covers: V2's `subagent` (V1's `task`). It is a direct tool, never inside Code Mode. */
export const GUARDED_TOOL = 'subagent'

export interface ToolCallBefore {
  readonly tool: string
  readonly input: unknown
}

/**
 * A resume attempt is a present `sessionID`. Upstream's own `execute.before` normaliser deletes an empty-string
 * `sessionID` (so `""` starts a new conversation), which makes `""`, `undefined` and `null` all "no resume". Any other
 * value, including a malformed one, is rejected: the guard fails closed rather than judging whether it would resolve.
 * Input is never modified.
 */
function carriesResume(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const sessionID: unknown = Reflect.get(input, 'sessionID')
  return sessionID !== undefined && sessionID !== null && sessionID !== ''
}

export function rejectSubagentReuse(event: ToolCallBefore): void {
  if (event.tool !== GUARDED_TOOL) return
  if (carriesResume(event.input)) throw new Error(TASK_REUSE_REJECTION)
}
