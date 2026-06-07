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

If the body already contains the marker <!-- fro-bot-narration-v1 -->, log "already-applied" and stop immediately. Do not make any edits. Exit with conclusion neutral.

## Rewrite instruction

Rewrite the release body to produce a human-readable narrative. The output MUST follow this exact structure:

1. A \`## What's new\` heading on its own line.
2. Immediately after the heading, the idempotency marker on its own line: <!-- fro-bot-narration-v1 -->
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

3. Verify the edit succeeded by fetching the release body again and confirming it contains <!-- fro-bot-narration-v1 -->.
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
}

export function selectDispatchedRun(runs: readonly DispatchedRun[], dispatchEpochSeconds: number): number | null {
  let newestEpoch = -Infinity
  let newestId: number | null = null

  for (const run of runs) {
    const runEpoch = Math.floor(new Date(run.createdAt).getTime() / 1000)
    if (runEpoch > dispatchEpochSeconds && runEpoch > newestEpoch) {
      newestEpoch = runEpoch
      newestId = run.databaseId
    }
  }

  return newestId
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

function hasAuthFailure(log: string): boolean {
  const stripped = stripAnsi(log)
  return AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(stripped))
}

export function classifyOutcome(input: ClassifyOutcomeInput): ClassifyOutcomeResult {
  const {watchExit, conclusion, log, bodyLen, targetTag} = input

  // Rule 1: timeout
  if (watchExit === 124) {
    return {level: 'warn', exitCode: 0, message: 'timed out waiting for run to complete'}
  }

  // Rule 2: unexpected watch exit
  if (watchExit !== 0) {
    return {level: 'error', exitCode: 1, message: `unexpected gh run watch exit (WATCH_EXIT=${watchExit})`}
  }

  // Rule 3: off-target release edit (scan ANSI-stripped log)
  if (hasOffTargetEdit(log, targetTag)) {
    return {level: 'error', exitCode: 1, message: `off-target release edit detected in run log`}
  }

  // Rule 4: auth failure keywords
  if (hasAuthFailure(log)) {
    return {level: 'error', exitCode: 1, message: 'auth failure detected in run log'}
  }

  // Rule 5: action_required
  if (conclusion === 'action_required') {
    return {level: 'error', exitCode: 1, message: 'run requires manual intervention (action_required)'}
  }

  // Rule 6: skipped
  if (conclusion === 'skipped') {
    return {level: 'error', exitCode: 1, message: 'run was skipped (policy/branch protection)'}
  }

  // Rule 7: success but body too short
  if (conclusion === 'success' && bodyLen < 200) {
    return {level: 'error', exitCode: 1, message: `body integrity check failed (BODY_LEN=${bodyLen})`}
  }

  // Rule 8: success with sufficient body
  if (conclusion === 'success') {
    return {level: 'ok', exitCode: 0, message: 'narrative applied successfully'}
  }

  // Rule 9: neutral (idempotent short-circuit)
  if (conclusion === 'neutral') {
    return {level: 'ok', exitCode: 0, message: 'no-action-taken (already-applied idempotent short-circuit)'}
  }

  // Rule 10: cancelled
  if (conclusion === 'cancelled') {
    return {level: 'warn', exitCode: 0, message: 'run was cancelled'}
  }

  // Rule 11: generic failure
  if (conclusion === 'failure') {
    return {level: 'warn', exitCode: 0, message: 'narrative-failure: run concluded with failure'}
  }

  // Rule 12: unknown conclusion
  return {level: 'warn', exitCode: 0, message: `unknown conclusion: ${conclusion}`}
}
