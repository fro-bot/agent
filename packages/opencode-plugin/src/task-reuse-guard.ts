/**
 * Guards `subagent` calls that resume a child session via `sessionID`, through the `execute.before` and `execute.after`
 * tool hooks. A resume is refused unless the plugin itself saw this caller dispatch that child in this run, and the
 * server was started by the Action. Everything else gets one fixed refusal.
 */

/** The model-visible rejection text; it carries no ids or arguments. */
export const TASK_REUSE_REJECTION =
  'Session reuse is disabled in this environment. Start a new task and include the context it needs.'

/** The one tool the guard covers: a direct tool, never inside Code Mode. */
export const GUARDED_TOOL = 'subagent'

/** How many dispatched children one guard remembers. The oldest is forgotten first, which refuses its resume. */
export const DEFAULT_MAX_RECORDED_CHILDREN = 1024

/** The slice of the host's `execute.before` event the guard reads. `sessionID` is the calling session, host-supplied. */
export interface ToolCallBefore {
  readonly tool: string
  readonly input: unknown
  readonly sessionID?: string | undefined
}

export interface SubagentResumeGuardOptions {
  /** True only when the server's launcher names the Action as its host. Any other host refuses every resume. */
  readonly actionHost: boolean
  /** Bound on remembered children. Anything that is not a positive integer uses the default. */
  readonly maxRecordedChildren?: number | undefined
}

export interface SubagentResumeGuard {
  /** Throws the fixed refusal for a `subagent` resume that is not admitted; otherwise returns. */
  readonly before: (event: ToolCallBefore) => void
  /** Records the child of a successful fresh `subagent` dispatch. Never throws, whatever it is handed. */
  readonly after: (event: unknown) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A resume is any `sessionID` other than absent, null or `""` (upstream treats `""` as absent); malformed values reject. */
function resumeTarget(input: unknown): {readonly resume: false} | {readonly resume: true; readonly sessionID: unknown} {
  if (!isRecord(input)) return {resume: false}
  const sessionID: unknown = input.sessionID
  if (sessionID === undefined || sessionID === null || sessionID === '') return {resume: false}
  return {resume: true, sessionID}
}

/**
 * The caller and child of a successful fresh `subagent` dispatch, or `undefined` for anything else. Shapes, as of
 * OpenCode v2.4.1 (`packages/plugin/src/promise/tool.ts` `ToolHooks['execute.after']`, built in `packages/core/src/tool.ts`
 * `executeTool`): the event is `{tool, sessionID, input, id, …}` plus `{status: 'completed', result}` or
 * `{status: 'error', error}`. The `subagent` tool (`packages/core/src/tool/plugin/subagent.ts`) returns
 * `{output: {sessionID, status: 'running', output}, content, metadata: {sessionID, status}}`, and `result` carries those
 * as they are. The caller is the event's own `sessionID`, set by the host; nothing the model wrote names it.
 */
function parseDispatch(event: unknown): {readonly caller: string; readonly child: string} | undefined {
  if (!isRecord(event) || event.tool !== GUARDED_TOOL || event.status !== 'completed') return undefined
  // A call that carried a sessionID was a resume (or a forged event): it creates no child, so it records nothing.
  if (!isRecord(event.input) || resumeTarget(event.input).resume) return undefined
  const caller = nonEmptyString(event.sessionID)
  if (caller === undefined || !isRecord(event.result)) return undefined

  const {metadata, output} = event.result
  const fromMetadata = isRecord(metadata) ? metadata.sessionID : undefined
  const fromOutput = isRecord(output) ? output.sessionID : undefined
  // The two name one child. When both are present and differ, neither is trusted.
  if (fromMetadata !== undefined && fromOutput !== undefined && fromMetadata !== fromOutput) return undefined
  const child = nonEmptyString(fromMetadata ?? fromOutput)
  return child === undefined ? undefined : {caller, child}
}

export function createSubagentResumeGuard(options: SubagentResumeGuardOptions): SubagentResumeGuard {
  const {actionHost, maxRecordedChildren} = options
  const bound =
    maxRecordedChildren !== undefined && Number.isInteger(maxRecordedChildren) && maxRecordedChildren > 0
      ? maxRecordedChildren
      : DEFAULT_MAX_RECORDED_CHILDREN
  /** Child session id to the session that dispatched it. A Map iterates in insertion order, so the first key is oldest. */
  const children = new Map<string, string>()

  return {
    before(event) {
      if (event.tool !== GUARDED_TOOL) return
      const target = resumeTarget(event.input)
      if (!target.resume) return
      const caller = nonEmptyString(event.sessionID)
      const admitted =
        actionHost &&
        caller !== undefined &&
        typeof target.sessionID === 'string' &&
        children.get(target.sessionID) === caller
      if (!admitted) throw new Error(TASK_REUSE_REJECTION)
    },
    after(event) {
      const dispatch = parseDispatch(event)
      if (dispatch === undefined) return
      // Re-recording moves the child to the newest slot.
      children.delete(dispatch.child)
      children.set(dispatch.child, dispatch.caller)
      while (children.size > bound) {
        const oldest = children.keys().next()
        if (oldest.done === true) break
        children.delete(oldest.value)
      }
    },
  }
}
