#!/usr/bin/env node

// Trusted apply-phase script (docs/plans/2026-07-17-001-feat-two-phase-release-notes-narration-plan.md,
// Unit 1). Runs in a separate job on a fresh runner from the model's generate job — the model's
// workspace never existed here, so this file contains NO model-controlled code paths. It:
//   1. Fetches the current release body (idempotency check — marker present → skip, no edit).
//   2. Reads the candidate narrative file the generate job produced (missing → warn, fail-soft).
//   3. Deterministically validates the candidate (validateCandidate) and, if valid, assembles the
//      final body (assembleReleaseBody) embedding the ORIGINAL body verbatim — the model never
//      copies the changelog, so preservation cannot drift.
//   4. Performs the single permitted `gh release edit` and re-verifies the marker stuck.
//
// This file uses .ts import because it runs directly under Node's
// --experimental-strip-types / --experimental-transform-types.
// The test file (assemble-release-notes.test.ts) uses .js because it runs under
// Vitest with bundler module resolution. Both are correct for their runtime.

import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {NARRATION_MARKER} from './release-notes.ts'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const MAX_CANDIDATE_LENGTH = 20_000

export type ValidationRejectionReason =
  'empty' | 'oversized' | 'contains-marker' | 'contains-details' | 'commit-list-dump' | 'missing-pr-link'

export type ValidateCandidateResult = {readonly ok: true} | {readonly ok: false; readonly reason: string}

// Matches semantic-release-shaped conventional-commit bullet restatements, e.g.:
//   * **api:** add rate limit retry
//   - **fix(api):** retry transient errors
//   * fix(api): retry transient errors
// One match anywhere in the candidate is enough to treat it as a restated commit-list dump
// rather than genuine narrative prose.
const COMMIT_LIST_BULLET_PATTERN = /^[ \t]*[*-][ \t]+(?:\*\*[a-z]+(?:\([^()\r\n]*\))?:\*\*|[a-z]+\([^()\r\n]*\):)/im

const PR_REFERENCE_PATTERN = /\/(?:issues|pull)\/\d+/
const PR_LINK_PATTERN = /\]\([^)]*\/(?:issues|pull)\/\d[^)]*\)/

/**
 * Pure validation of an untrusted narrative candidate against the original (trusted) release body.
 * Every rejection carries a distinct, machine-readable reason. This is the only gate standing
 * between model-authored text and a live release body — it must never throw on adversarial input.
 */
export function validateCandidate(candidate: string, originalBody: string): ValidateCandidateResult {
  if (candidate.trim().length === 0) {
    return {ok: false, reason: 'empty'}
  }

  if (candidate.length > MAX_CANDIDATE_LENGTH) {
    return {ok: false, reason: 'oversized'}
  }

  if (candidate.includes(NARRATION_MARKER)) {
    return {ok: false, reason: 'contains-marker'}
  }

  if (candidate.includes('<details>')) {
    return {ok: false, reason: 'contains-details'}
  }

  if (COMMIT_LIST_BULLET_PATTERN.test(candidate)) {
    return {ok: false, reason: 'commit-list-dump'}
  }

  if (PR_REFERENCE_PATTERN.test(originalBody) && !PR_LINK_PATTERN.test(candidate)) {
    return {ok: false, reason: 'missing-pr-link'}
  }

  return {ok: true}
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Deterministically assembles the final release body: heading + marker + narrative + the
 * ORIGINAL body embedded verbatim inside a collapsed `<details>` block. The original body is
 * never touched by model output — code copies it byte-for-byte.
 */
export function assembleReleaseBody(candidate: string, originalBody: string): string {
  return [
    "## What's new",
    NARRATION_MARKER,
    '',
    candidate,
    '',
    '<details><summary>Full changelog</summary>',
    '',
    originalBody,
    '',
    '</details>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// CLI plumbing (dependency-injected for tests)
// ---------------------------------------------------------------------------

export interface RunApplyDeps {
  readonly tag: string
  readonly repo: string
  readonly ghView: () => string
  readonly ghEdit: (notesFile: string) => void
  readonly readCandidate: () => string | null
}

export interface RunApplyResult {
  readonly exitCode: 0 | 1
  readonly message: string
}

function extractBody(rawJson: string): string {
  const parsed = JSON.parse(rawJson) as {body?: unknown}
  return typeof parsed.body === 'string' ? parsed.body : ''
}

/**
 * Orchestrates the apply phase. Pure control flow with injected I/O so it is fully testable
 * without a real `gh` binary or filesystem. Fail-soft everywhere except the post-edit
 * verification, which hard-fails (exitCode 1) because a silently-unstuck edit is a correctness
 * bug, not a narrative-quality issue.
 */
export function runApply(deps: RunApplyDeps): RunApplyResult {
  const {tag, ghView, ghEdit, readCandidate} = deps

  // Step 1: idempotency check
  const currentBody = extractBody(ghView())
  if (currentBody.includes(NARRATION_MARKER)) {
    return {exitCode: 0, message: `already-applied: release ${tag} body already contains the narration marker`}
  }

  // Step 2: read candidate (missing → fail-soft)
  const candidate = readCandidate()
  if (candidate === null) {
    return {exitCode: 0, message: `no candidate file found for ${tag}; narration skipped (fail-soft)`}
  }

  // Step 3: validate (reject → fail-soft, release keeps semantic-release body)
  const validation = validateCandidate(candidate, currentBody)
  if (!validation.ok) {
    return {exitCode: 0, message: `candidate rejected (${validation.reason}); release ${tag} left untouched`}
  }

  // Step 4: assemble + edit
  const assembled = assembleReleaseBody(candidate, currentBody)
  const tmpDir = mkdtempSync(join(tmpdir(), 'release-notes-'))
  const notesFile = join(tmpDir, `${tag}.md`)
  writeFileSync(notesFile, assembled, 'utf8')
  ghEdit(notesFile)

  // Step 5: verify the edit stuck
  const verifiedBody = extractBody(ghView())
  if (!verifiedBody.includes(NARRATION_MARKER)) {
    return {exitCode: 1, message: `edit applied but marker missing from release ${tag} on re-fetch`}
  }

  return {exitCode: 0, message: `narrative applied to release ${tag}`}
}

// ---------------------------------------------------------------------------
// Main (real gh/fs wiring)
// ---------------------------------------------------------------------------

function resolveRepo(argv: readonly string[]): string {
  const repoFlagIndex = argv.indexOf('--repo')
  if (repoFlagIndex !== -1 && argv[repoFlagIndex + 1] !== undefined) {
    return argv[repoFlagIndex + 1] as string
  }
  return process.env.GITHUB_REPOSITORY ?? ''
}

function readCandidateFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function main(): void {
  const tag = process.argv[2]
  if (tag === undefined || tag === '') {
    process.stdout.write('::error::Missing required argument: tag\n')
    process.exit(1)
  }

  const candidateFile = process.argv[3] ?? 'release-notes-candidate.md'
  const repo = resolveRepo(process.argv.slice(4))

  const result = runApply({
    tag,
    repo,
    ghView: () => execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'body'], {encoding: 'utf8'}),
    ghEdit: notesFile => {
      execFileSync('gh', ['release', 'edit', tag, '--repo', repo, '--notes-file', notesFile], {stdio: 'inherit'})
    },
    readCandidate: () => readCandidateFile(candidateFile),
  })

  if (result.exitCode === 1) {
    process.stdout.write(`::error::${result.message}\n`)
  } else if (result.message.startsWith('candidate rejected') || result.message.startsWith('no candidate')) {
    process.stdout.write(`::warning::${result.message}\n`)
  } else {
    process.stdout.write(`${result.message}\n`)
  }

  process.exit(result.exitCode)
}

// Only run when executed directly (node --experimental-strip-types ...), not when imported
// by the test file under Vitest.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
