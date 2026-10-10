//#region deploy/plugins/no-task-reuse.mjs
/** The fixed, model-visible rejection. No session ids, no arguments, no secrets. */
const TASK_REUSE_REJECTION = "Session reuse is disabled in this environment. Start a new task and include the context it needs.";
/**
* Any truthy `task_id` is a resume attempt, matching upstream's own check. Args are never modified.
*
* @param {{tool?: unknown}} input
* @param {{args?: unknown}} output
*/
function rejectTaskReuse(input, output) {
	if (input?.tool !== "task") return;
	const args = output?.args;
	if (args === null || typeof args !== "object") return;
	if (args.task_id) throw new Error(TASK_REUSE_REJECTION);
}
var no_task_reuse_default = {
	id: "fro-bot.no-task-reuse",
	server: async () => ({ "tool.execute.before": rejectTaskReuse })
};

//#endregion
export { TASK_REUSE_REJECTION, no_task_reuse_default as default, rejectTaskReuse };