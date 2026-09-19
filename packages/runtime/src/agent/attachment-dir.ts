import * as fs from 'node:fs/promises'
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Create a single directory segment exclusively, refusing to follow anything already occupying
 * that exact path.
 *
 * `fs.mkdir(dir)` (no `recursive`) has no follow-a-symlink gap: the underlying `mkdir(2)` syscall
 * fails with `EEXIST` if ANYTHING already occupies that exact path -- symlink, file, or directory
 * -- without ever resolving/following it. On `EEXIST`, this function then `lstat`s (never `stat`s)
 * the path itself to see what is actually there, and refuses a symlink (or any other
 * non-directory) outright instead of writing through it.
 */
async function mkdirExclusiveNoFollow(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir)
    return
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') throw error
  }

  const stats = await fs.lstat(dir)
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use attachment directory ${dir}: a symlink already exists at this path`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to use attachment directory ${dir}: a non-directory entry already exists at this path`)
  }
}

/**
 * Create the run-scoped attachment directory (`buildAttachmentDir`), refusing to follow a symlink
 * at EITHER path segment this call controls: the shared `fro-bot-attachments` segment AND the
 * run-attempt leaf beneath it.
 *
 * The segment name is a fixed, predictable string and the leaf name (`<runId>-<runAttempt>`) is
 * predictable too, so a plain recursive `fs.mkdir(dirname(attachmentDir), {recursive: true})` for
 * everything above the leaf is NOT safe: libuv's recursive-mkdir treats an `EEXIST` at any
 * intermediate segment as "already there" by `stat`-ing it (which FOLLOWS symlinks) and accepting
 * anything that stats as a directory. A symlink planted at the segment directory -- pointing at an
 * attacker-controlled real directory elsewhere -- would be followed there, the leaf would then be
 * created for real *inside the attacker's target*, and the leaf's own no-follow guard would pass
 * cleanly because the leaf genuinely does not exist at the (attacker's) resolved location. The
 * guard looked complete but validated only the last of two attacker-reachable segments.
 *
 * This validates both controlled segments individually with `mkdirExclusiveNoFollow`, each via a
 * plain (non-recursive) `mkdir` plus an `lstat`-on-`EEXIST` fallback, so a symlink at either one is
 * refused before anything is created through it. It deliberately does NOT walk further up to
 * `RUNNER_TEMP` (or beyond): `RUNNER_TEMP` is runner-provisioned and pre-existing, not a path
 * segment this code names or creates, so it is outside this guard's trust boundary.
 */
export async function createAttachmentDirExclusive(attachmentDir: string): Promise<void> {
  await mkdirExclusiveNoFollow(path.dirname(attachmentDir))
  await mkdirExclusiveNoFollow(attachmentDir)
}
