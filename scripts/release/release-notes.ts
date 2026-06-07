const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/

// eslint-disable-next-line no-control-regex -- ANSI escape stripping requires the ESC control character
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;]*m/g

const RELEASE_EDIT_PATTERN = /release edit (v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/g

const AUTH_FAILURE_PATTERNS = [
  /HTTP 401/,
  /HTTP 403/,
  /Bad credentials/,
  /Resource not accessible/,
  /requires authentication/,
  /permission denied/i,
]

// CHANGE 4: extracted constants
export const NARRATION_MARKER = '<!-- fro-bot-narration-v1 -->'
export const MIN_RELEASE_BODY_LENGTH = 200

export type ValidateTagResult = {ok: true} | {ok: false; error: string}

export function validateTag(tag: string): ValidateTagResult {
  if (TAG_PATTERN.test(tag)) {
    return {ok: true}
  }
  return {ok: false, error: `Invalid tag format: "${tag}". Expected v<major>.<minor>.<patch>[-prerelease]`}
}

export interface NarrationPromptOpts {
  readonly tag: string
  readonly repo: string
  readonly correlationId: string
}

export function buildNarrationPrompt(opts: NarrationPromptOpts): string {
  const {tag, repo, correlationId} = opts

  return `correlation=${correlationId}

You are narrating the GitHub Release body for ${repo} tag ${tag}.

## Idempotency check

Before doing anything else, fetch the current release body for tag ${tag} in repo ${repo}:

  gh release view ${tag} --repo ${repo} --json body --jq '.body'

If the body already contains the marker ${NARRATION_MARKER}, log "already-applied" and stop immediately. Do not make any edits. Exit with conclusion neutral.

## Rewrite instruction

Rewrite the release body to produce a human-readable narrative. The output MUST follow this exact structure:

1. A \`## What's new\` heading on its own line.
2. Immediately after the heading, the idempotency marker on its own line: ${NARRATION_MARKER}
3. A 1-2 sentence summary of the release.
4. Highlights grouped by impact category. Only include categories that have entries:
   - **Features** — new capabilities
   - **Fixes** — bug fixes
   - **Security** — security improvements
   - **Performance** — performance improvements
   - **Breaking** — breaking changes
   Each entry should be a human-readable bullet linking the PR number (e.g. [#123](https://github.com/${repo}/pull/123)).
5. The original conventional-commit list preserved below under a collapsed block:

<details><summary>Full changelog</summary>

(paste the original commit list here verbatim)

</details>

## Application instruction

Once you have composed the new body:

1. Write the full new body text to a temporary file (e.g. /tmp/release-notes-${tag}.md).
2. Apply it with:

   gh release edit ${tag} --repo ${repo} --notes-file /tmp/release-notes-${tag}.md

3. Verify the edit succeeded by fetching the release body again and confirming it contains ${NARRATION_MARKER}.
4. Report: tag applied, chars-before, chars-after, and the release URL.

## Scope constraints (forbidden actions)

The ONLY mutating operation permitted is \`gh release edit ${tag}\` on repo ${repo}.

You MUST NOT:
- Comment on any PR, issue, or discussion
- Open or close any issue
- Edit any other release (any tag other than ${tag})
- Modify any file in the repository
- Create any branch, tag, or commit
- Perform any action not explicitly listed above

If you find yourself about to do any of the above, stop and report the anomaly instead.
`
}

export interface DispatchedRun {
  readonly databaseId: number
  readonly createdAt: string
  readonly displayTitle: string
}

// CHANGE 3: correlated run selection — filters by correlationId in displayTitle AND createdAt >= dispatchEpoch.
// Returns:
//   - null  → 0 matches (run not confirmed) OR >1 matches (ambiguous)
//   - number → exactly 1 match (the databaseId)
// Callers must distinguish null-from-zero vs null-from-ambiguous via the exported sentinel.
export const AMBIGUOUS_RUN_SENTINEL = Symbol('ambiguous')

export function selectDispatchedRun(
  runs: readonly DispatchedRun[],
  dispatchEpochSeconds: number,
  correlationId: string,
): number | null | typeof AMBIGUOUS_RUN_SENTINEL {
  const candidates = runs.filter(run => {
    const runEpoch = Math.floor(new Date(run.createdAt).getTime() / 1000)
    return runEpoch >= dispatchEpochSeconds && run.displayTitle.includes(correlationId)
  })

  if (candidates.length === 0) {
    return null
  }
  if (candidates.length === 1) {
    // candidates[0] is guaranteed by the length === 1 check above
    const only = candidates[0]
    return only === undefined ? null : only.databaseId
  }
  // >1 matches — ambiguous
  return AMBIGUOUS_RUN_SENTINEL
}

export interface ClassifyOutcomeInput {
  readonly watchExit: number
  readonly conclusion: string
  readonly log: string
  readonly bodyLen: number
  readonly targetTag: string
}

export interface ClassifyOutcomeResult {
  readonly level: 'ok' | 'warn' | 'error'
  readonly message: string
  readonly exitCode: 0 | 1
}

function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_ESCAPE_PATTERN, '')
}

function hasOffTargetEdit(log: string, targetTag: string): boolean {
  const stripped = stripAnsi(log)
  RELEASE_EDIT_PATTERN.lastIndex = 0
  let match = RELEASE_EDIT_PATTERN.exec(stripped)
  while (match !== null) {
    const foundTag = match[1]
    if (foundTag !== targetTag) {
      return true
    }
    match = RELEASE_EDIT_PATTERN.exec(stripped)
  }
  return false
}

export function hasAuthFailure(log: string): boolean {
  const stripped = stripAnsi(log)
  return AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(stripped))
}

// CHANGE 2: exported so dispatch-release-notes.ts can reuse it for dispatch-time auth detection
export function isAuthError(text: string): boolean {
  return hasAuthFailure(text)
}

// CHANGE 1: rewritten classifyOutcome with correct precedence
export function classifyOutcome(input: ClassifyOutcomeInput): ClassifyOutcomeResult {
  const {watchExit, conclusion, log, bodyLen, targetTag} = input

  // Rule 1 (FIRST): auth failure — the ONLY hard-fail path derived from log scanning.
  // Must come before timeout/watch-exit so a timed-out run that also shows auth failure still hard-fails.
  if (hasAuthFailure(log)) {
    return {level: 'error', exitCode: 1, message: 'auth failure detected in run log'}
  }

  // Rule 2: timeout (watchExit === 124)
  if (watchExit === 124) {
    return {level: 'warn', exitCode: 0, message: 'timed out waiting for run to complete'}
  }

  // Rule 3: any other non-zero watchExit — observation only, NOT a hard-fail.
  // gh run watch --exit-status returns non-zero when the watched run fails; that's a narrative
  // failure, not a release failure.
  if (watchExit !== 0) {
    return {
      level: 'warn',
      exitCode: 0,
      message: `run watch reported non-zero exit (WATCH_EXIT=${watchExit}); see run conclusion`,
    }
  }

  // Rule 4: off-target release edit — DEMOTED to warn (best-effort signal only).
  // Log-forensics is not a sound security boundary; real prevention is PAT scope + prompt.
  if (hasOffTargetEdit(log, targetTag)) {
    return {
      level: 'warn',
      exitCode: 0,
      message: 'possible off-target release edit detected in run log (best-effort signal)',
    }
  }

  // Rule 5: success — prefer positive proof
  if (conclusion === 'success') {
    if (bodyLen >= MIN_RELEASE_BODY_LENGTH) {
      return {level: 'ok', exitCode: 0, message: 'narrative applied successfully'}
    }
    // Short body is a quality signal, not a security signal — soft-warn
    return {
      level: 'warn',
      exitCode: 0,
      message: `narrative applied but body shorter than expected (BODY_LEN=${bodyLen})`,
    }
  }

  // Rule 6: neutral (idempotent short-circuit)
  if (conclusion === 'neutral') {
    return {level: 'ok', exitCode: 0, message: 'no-action-taken (already-applied idempotent short-circuit)'}
  }

  // Rule 7: action_required — soft-warn, not hard-fail
  if (conclusion === 'action_required') {
    return {
      level: 'warn',
      exitCode: 0,
      message: 'run requires manual intervention (action_required); narration skipped',
    }
  }

  // Rule 8: skipped — soft-warn, not hard-fail
  if (conclusion === 'skipped') {
    return {level: 'warn', exitCode: 0, message: 'run was skipped; narration skipped'}
  }

  // Rule 9: cancelled — soft-warn
  if (conclusion === 'cancelled') {
    return {level: 'warn', exitCode: 0, message: 'run was cancelled'}
  }

  // Rule 10: generic failure — soft-warn
  if (conclusion === 'failure') {
    return {level: 'warn', exitCode: 0, message: 'narrative-failure: run concluded with failure'}
  }

  // Rule 11: unknown conclusion — soft-warn
  return {level: 'warn', exitCode: 0, message: `unknown conclusion: ${conclusion}`}
}
