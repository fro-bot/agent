// Rejects `task` calls that resume a session via `task_id`, before they execute.
// Completion notices name the child session, never the job, so jobs on a reused
// session cannot be told apart; every task must get a fresh child session.
// `tool.execute.before` runs for every session's tool calls; a throw ends the
// tool part in `error` with this message and the model continues.
// Loaded root-owned through the managed config layer (/etc/opencode/opencode.json).

/** The fixed, model-visible rejection. No session ids, no arguments, no secrets. */
export const TASK_REUSE_REJECTION =
  'Session reuse is disabled in this environment. Start a new task and include the context it needs.'

/**
 * Any truthy `task_id` is a resume attempt, matching upstream's own check. Args are never modified.
 *
 * @param {{tool?: unknown}} input
 * @param {{args?: unknown}} output
 */
export function rejectTaskReuse(input, output) {
  if (input?.tool !== 'task') return
  const args = output?.args
  if (args === null || typeof args !== 'object') return
  if (args.task_id) throw new Error(TASK_REUSE_REJECTION)
}

export default {
  id: 'fro-bot.no-task-reuse',
  server: async () => ({'tool.execute.before': rejectTaskReuse}),
}
