/** Rejects `subagent` calls that resume a child session via `sessionID`, via the `execute.before` tool hook. */

/** The model-visible rejection text; it carries no ids or arguments. */
export const TASK_REUSE_REJECTION =
  'Session reuse is disabled in this environment. Start a new task and include the context it needs.'

/** The one tool the guard covers: a direct tool, never inside Code Mode. */
export const GUARDED_TOOL = 'subagent'

export interface ToolCallBefore {
  readonly tool: string
  readonly input: unknown
}

/** A resume is any `sessionID` other than absent, null or `""` (upstream treats `""` as absent); malformed values reject. */
function carriesResume(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const sessionID: unknown = Reflect.get(input, 'sessionID')
  return sessionID !== undefined && sessionID !== null && sessionID !== ''
}

export function rejectSubagentReuse(event: ToolCallBefore): void {
  if (event.tool !== GUARDED_TOOL) return
  if (carriesResume(event.input)) throw new Error(TASK_REUSE_REJECTION)
}
