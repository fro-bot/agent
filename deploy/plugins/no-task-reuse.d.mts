// Types for no-task-reuse.mjs, so the Action's vitest suite can import the plugin that both the gateway image
// and the Action bundle (dist/no-task-reuse.js) ship. Keep in step with the .mjs exports.

export const TASK_REUSE_REJECTION: string

export function rejectTaskReuse(
  input: {readonly tool?: unknown} | undefined,
  output: {readonly args?: unknown} | undefined,
): void

declare const plugin: {
  readonly id: string
  readonly server: () => Promise<{readonly 'tool.execute.before': typeof rejectTaskReuse}>
}
export default plugin
