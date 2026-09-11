import type {Result} from '../../shared/types.js'
import type {ExecAdapter, Logger} from './types.js'

import process from 'node:process'
import {err, ok} from '../../shared/types.js'

/** Matches `http.<url-subsection>.extraheader`, with or without a URL subsection. */
const EXTRAHEADER_REGEXP = String.raw`^http\.(.*\.)?extraheader$`

/** Canonical (English-locale) prefix `rev-parse` writes when the workspace has no repository. */
const NOT_A_REPOSITORY_STDERR_PREFIX = 'fatal: not a git repository (or any'

const ERR_HEADER_FOUND =
  'Persisted git credential found in the effective git config (local, global, system, worktree-scoped, or an ' +
  'includeIf/include target) on a withhold run — set persist-credentials: false on actions/checkout, and check ' +
  'for other host-level config that injects an HTTP auth header'

const ERR_CONFIG_VERIFICATION_FAILED =
  'Unable to verify the effective git config carries no persisted credential header on a withhold run — set ' +
  'persist-credentials: false on actions/checkout'

const ERR_REPO_CONTEXT_VERIFICATION_FAILED =
  'Unable to verify the git repository context for a persisted-credential check on a withhold run — set ' +
  'persist-credentials: false on actions/checkout'

const ERR_ORIGIN_EMBEDDED_CREDENTIAL =
  'Persisted git credential found embedded in the origin remote URL on a withhold run — ' +
  'set persist-credentials: false on actions/checkout'

const ERR_ORIGIN_VERIFICATION_FAILED =
  'Unable to verify the origin remote for a persisted-credential check on a withhold run — ' +
  'set persist-credentials: false on actions/checkout'

/**
 * True for the one infrastructure state where this check cannot run at all: git itself is not
 * installed. This is a compatibility exemption, not evidence no credential is persisted — it only
 * means there is no git binary available to look. Matches both the plain `Error` `@actions/io`'s
 * `which` throws when it cannot resolve the binary on PATH, and an `ENOENT`-coded spawn failure.
 */
function isMissingGitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
  return error.message.startsWith('Unable to locate executable file: git.')
}

/**
 * `process.env` filtered to defined string values, plus a forced `LC_ALL=C` so `rev-parse`'s
 * stderr wording is locale-stable and safe to prefix-match. Spreads the full environment (not
 * just `LC_ALL` alone) so the repo-context probe still sees whatever effective git environment
 * the run already has (`GIT_DIR`, `GIT_CONFIG_*`, etc.) rather than a stripped one.
 */
function inheritedEnvWithCLocale(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.LC_ALL = 'C'
  return env
}

/**
 * Preflight assertion for withhold runs: the checkout must carry no persisted git credential
 * before the model starts. Inspects the workspace's *effective* git configuration — local,
 * global, system, worktree-scoped, and anything pulled in via `include`/`includeIf` — for a
 * `http.*.extraheader` header, plus the `origin` remote URL for an embedded credential. Does not
 * enumerate every credential vector (helpers, askpass, netrc, nested/submodule checkouts).
 *
 * Fails closed on any config error, unreadable repository context, or verification failure. The
 * only two exceptions — an absent git binary and a genuinely non-repository workspace — are
 * compatibility exemptions, not proof a credential is absent: they mean part of this check could
 * not run, and are logged as warnings rather than silently allowed.
 */
export async function assertNoPersistedGitCredentials(
  execAdapter: ExecAdapter,
  workspaceDir: string,
  logger: Logger,
): Promise<Result<void, string>> {
  let configResult
  try {
    configResult = await execAdapter.getExecOutput(
      'git',
      ['config', '--includes', '--name-only', '--get-regexp', EXTRAHEADER_REGEXP],
      {cwd: workspaceDir, ignoreReturnCode: true, silent: true},
    )
  } catch (error) {
    if (isMissingGitError(error)) {
      logger.warning(
        'git-credential-check: git binary not found — verification skipped, not evidence a credential is absent',
      )
      return ok(undefined)
    }
    logger.warning('git-credential-check: effective config check threw unexpectedly, denying')
    return err(ERR_CONFIG_VERIFICATION_FAILED)
  }

  if (configResult.exitCode === 0 && configResult.stdout.trim().length > 0) {
    return err(ERR_HEADER_FOUND)
  }
  if (configResult.exitCode !== 1 || configResult.stdout.trim().length > 0) {
    logger.warning('git-credential-check: effective config check returned an unexpected result, denying')
    return err(ERR_CONFIG_VERIFICATION_FAILED)
  }

  let repoContextResult
  try {
    repoContextResult = await execAdapter.getExecOutput('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: workspaceDir,
      ignoreReturnCode: true,
      silent: true,
      env: inheritedEnvWithCLocale(),
    })
  } catch {
    logger.warning('git-credential-check: repository context check threw unexpectedly, denying')
    return err(ERR_REPO_CONTEXT_VERIFICATION_FAILED)
  }

  if (repoContextResult.exitCode === 128 && repoContextResult.stderr.startsWith(NOT_A_REPOSITORY_STDERR_PREFIX)) {
    logger.warning(
      'git-credential-check: workspace is not a git repository — origin check skipped (effective config check already ran and found no header)',
    )
    return ok(undefined)
  }
  if (repoContextResult.exitCode !== 0 || repoContextResult.stdout.trim().length === 0) {
    logger.warning('git-credential-check: repository context check returned an unexpected result, denying')
    return err(ERR_REPO_CONTEXT_VERIFICATION_FAILED)
  }

  let remoteResult
  try {
    remoteResult = await execAdapter.getExecOutput('git', ['remote', 'get-url', 'origin'], {
      cwd: workspaceDir,
      ignoreReturnCode: true,
      silent: true,
    })
  } catch {
    logger.warning('git-credential-check: origin remote check threw unexpectedly, denying')
    return err(ERR_ORIGIN_VERIFICATION_FAILED)
  }

  if (remoteResult.exitCode === 2) {
    return ok(undefined)
  }
  if (remoteResult.exitCode === 0 && remoteResult.stdout.trim().length > 0) {
    return hasEmbeddedCredential(remoteResult.stdout.trim()) ? err(ERR_ORIGIN_EMBEDDED_CREDENTIAL) : ok(undefined)
  }

  logger.warning('git-credential-check: origin remote check returned an unexpected result, denying')
  return err(ERR_ORIGIN_VERIFICATION_FAILED)
}

/**
 * Detects a credential embedded in a remote URL (e.g.
 * `https://x-access-token:<token>@github.com/owner/repo`) without ever
 * logging the matched substring — the caller only receives a boolean.
 *
 * Deliberately broad: ANY userinfo containing a `:` (a password/token
 * component, even an empty one) is treated as a credential, whatever its
 * shape — this check runs only on credential-withheld runs, where refusing
 * an unusual-but-legitimate remote is acceptable and letting a token
 * through is not. A bare username (`https://user@host/...`) carries no
 * secret and is allowed.
 */
function hasEmbeddedCredential(remoteUrl: string): boolean {
  const atIndex = remoteUrl.indexOf('@')
  if (atIndex === -1) {
    return false
  }
  const schemeSplit = remoteUrl.indexOf('://')
  const credentialSection = schemeSplit === -1 ? remoteUrl.slice(0, atIndex) : remoteUrl.slice(schemeSplit + 3, atIndex)
  return credentialSection.includes('x-access-token:') || credentialSection.includes(':')
}
