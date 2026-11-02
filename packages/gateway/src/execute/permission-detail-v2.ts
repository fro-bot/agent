/**
 * A V2 `permission.asked` has no `metadata`; the command or paths are in `resources`. The approval parser reads
 * `command`/`filepath` from `metadata` only, so this builds it (fro-bot/agent#2002).
 *
 * Per upstream 2.2.5 `packages/core/src`: `shell` resources are commands (`tool/plugin/shell.ts:133`);
 * `external_directory`, `read` and `edit` resources are paths (`file-access.ts:136,155`, `edit.ts:329`, `write.ts:79`,
 * `patch.ts:220`). Other actions carry patterns, URLs or names, so `patterns` stays their detail.
 */

/** Actions whose `resources` are paths (a directory glob for `external_directory`). */
const PATH_ACTIONS: ReadonlySet<string> = new Set(['external_directory', 'read', 'edit'])

/** Not a newline: `boundApprovalDetail` strips control characters, which would fuse the commands. */
const COMMAND_SEPARATOR = '; '

/** Upstream's separator for a multi-file patch (`patch.ts:224`). */
const PATH_SEPARATOR = ', '

export type V2ApprovalMetadata = Readonly<{command: string}> | Readonly<{filepath: string}>

/** Every resource is shown: an ask for `a && b` approves both. `undefined` when there is no command or path. */
export function synthesizeApprovalMetadata(
  action: string,
  resources: readonly string[],
): V2ApprovalMetadata | undefined {
  const present = resources.filter(resource => resource.length > 0)
  if (present.length === 0) return undefined
  if (action === 'shell') return {command: present.join(COMMAND_SEPARATOR)}
  if (PATH_ACTIONS.has(action)) return {filepath: present.join(PATH_SEPARATOR)}
  return undefined
}
