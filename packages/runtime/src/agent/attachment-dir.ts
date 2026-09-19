import * as path from 'node:path'

/**
 * The directory segment name (relative to `RUNNER_TEMP`) under which the
 * harness materializes PR-context reference-file attachments (`pr-description.txt`,
 * `pr-review-00N-fro-bot.txt`, etc. — see `packages/runtime/src/agent/reference-files.ts`
 * `materializeReferenceFiles`) for a run.
 *
 * This is a DEDICATED directory, deliberately distinct from `getOpenCodeLogPath()`
 * (`$XDG_DATA_HOME/opencode/log`, see `packages/runtime/src/shared/env.ts`), which is
 * where these files used to be materialized. Three reasons that directory cannot be
 * granted `external_directory` access instead:
 *
 * 1. It is not attachment-only — optional full prompt artifacts
 *    (`OPENCODE_PROMPT_ARTIFACT`) and operational logs also live there, so granting
 *    it would expose more than the attachments this directory exists to serve.
 * 2. `external_directory` is not a read-only gate upstream — the edit tool checks
 *    the same permission (vendored source: `packages/opencode/src/tool/edit.ts:75,93-101`
 *    at the pinned tag), so granting a directory removes the edit boundary for it
 *    wherever `edit` is otherwise permitted, not just read access.
 * 3. Per-filename grants cannot narrow the ask: upstream's `external_directory` ask
 *    is raised against the file's PARENT directory plus `*`
 *    (`packages/opencode/src/tool/external-directory.ts:25-35`), so any grant is
 *    necessarily directory-scoped, not file-scoped.
 *
 * Exported so CI OpenCode config's `external_directory` permission scoping
 * (`src/services/setup/ci-config.ts`) can import the exact segment instead of
 * duplicating the literal string, keeping the materialization site and the grant
 * in lockstep — mirrors `RESPONSE_FILE_DIR_SEGMENT` / `buildResponseFileDir`.
 */
export const ATTACHMENT_DIR_SEGMENT = 'fro-bot-attachments' as const

/**
 * Build the run-scoped attachment directory. Lives OUTSIDE the checkout (under
 * `RUNNER_TEMP`) for the same reason `buildResponseFileDir` does: a compromised or
 * malicious checkout can never plant or tamper with files materialized here.
 */
export function buildAttachmentDir(parts: {
  readonly runnerTemp: string
  readonly runId: string | number
  readonly runAttempt: string | number
}): string {
  return path.join(parts.runnerTemp, ATTACHMENT_DIR_SEGMENT, `${parts.runId}-${parts.runAttempt}`)
}
