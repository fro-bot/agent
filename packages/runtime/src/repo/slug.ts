/**
 * The one owner/repo parsing contract.
 *
 * `parseRepoSlug` checks the SHAPE of an untrusted `owner/repo` string and nothing else: it never
 * lowercases, and it applies no GitHub naming rule. Callers that must also enforce names (the operator
 * web surface) add {@link isValidGitHubOwner} / {@link isValidGitHubRepoName} afterwards; callers that
 * canonicalise for a path (the workspace) lowercase on their own terms. Keeping the three steps apart is
 * what lets the Action accept whatever GitHub hands it while the gateway edge stays strict.
 *
 * Stored keys are out of scope: nothing here is applied inside a key builder, so object-store keys keep
 * the case the caller passes.
 */
import type {Result} from '../shared/types.js'

import {err, ok} from '../shared/types.js'

/**
 * Why a slug was rejected. Closed set; the order of the checks below is the order of this list.
 * - `empty`: nothing but whitespace.
 * - `forbidden-character`: whitespace, `#`, `?`, `\`, or a control character anywhere in the value.
 * - `missing-separator`: no `/`.
 * - `extra-separator`: more than one `/` (`owner/repo/x`, `owner/repo/`, `owner//repo`).
 * - `empty-owner` / `empty-repo`: exactly one `/`, with nothing on that side of it.
 */
export type RepoSlugError =
  'empty' | 'forbidden-character' | 'missing-separator' | 'extra-separator' | 'empty-owner' | 'empty-repo'

export interface RepoSlug {
  readonly owner: string
  readonly repo: string
}

// Whitespace (any Unicode space), the characters that start a fragment, query or Windows path, and control
// characters (`\p{Cc}`: C0, DEL, C1). `/` is handled by the separator count, not here.
const FORBIDDEN_CHARACTER = /[\s#?\\\p{Cc}]/u

/**
 * Parse an untrusted `owner/repo` string.
 *
 * Trims the input, then requires exactly one `/` with a non-empty owner and a non-empty repo, and rejects
 * whitespace, `#`, `?`, `\` and control characters anywhere. Does not change case. Never throws.
 */
export function parseRepoSlug(input: string): Result<RepoSlug, RepoSlugError> {
  const value = input.trim()
  if (value.length === 0) return err('empty')
  if (FORBIDDEN_CHARACTER.test(value)) return err('forbidden-character')

  const firstSlash = value.indexOf('/')
  if (firstSlash === -1) return err('missing-separator')
  if (value.includes('/', firstSlash + 1)) return err('extra-separator')

  const owner = value.slice(0, firstSlash)
  const repo = value.slice(firstSlash + 1)
  if (owner.length === 0) return err('empty-owner')
  if (repo.length === 0) return err('empty-repo')

  return ok({owner, repo})
}

// GitHub owner names: ASCII alphanumerics and hyphens, 1-39 characters, no leading or trailing hyphen.
const GITHUB_OWNER = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
// GitHub repo names: ASCII alphanumerics, hyphens, underscores and dots, 1-100 characters.
const GITHUB_REPO_NAME = /^[\w.-]{1,100}$/

/**
 * Whether `owner` is a GitHub account name. Intentionally strict: it keeps path traversal, NUL bytes and
 * injection out of anything built from the name, so a malformed name never reaches the object store.
 */
export function isValidGitHubOwner(owner: string): boolean {
  return GITHUB_OWNER.test(owner)
}

/**
 * Whether `repo` is a GitHub repository name. Rejects the single-segment names `.` and `..` (path
 * traversal); the character class already excludes NUL. A `.git` suffix and `..` inside a name are accepted.
 */
export function isValidGitHubRepoName(repo: string): boolean {
  if (repo === '.' || repo === '..') return false
  return GITHUB_REPO_NAME.test(repo)
}
