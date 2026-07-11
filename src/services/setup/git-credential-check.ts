import type {Result} from '../../shared/types.js'
import type {ExecAdapter, Logger} from './types.js'

import {err, ok} from '../../shared/types.js'

/**
 * Preflight assertion for withhold runs: the checkout must carry no
 * persisted git credentials before the model starts. Two vectors are
 * checked — a credential helper header (`http.<url>.extraheader`, the form
 * `actions/checkout` writes when `persist-credentials` is left at its
 * default `true`) and an embedded token in the `origin` remote URL.
 *
 * Fail-closed on either vector, fail-open on infrastructure absence: no git
 * binary, no repo, or a command error means there is nothing to leak, so
 * that resolves `ok`.
 */
export async function assertNoPersistedGitCredentials(
  execAdapter: ExecAdapter,
  workspaceDir: string,
  logger: Logger,
): Promise<Result<void, string>> {
  let extraheaderResult
  try {
    extraheaderResult = await execAdapter.getExecOutput(
      'git',
      ['config', '--local', '--get-regexp', String.raw`^http\..*\.extraheader$`],
      {cwd: workspaceDir, ignoreReturnCode: true, silent: true},
    )
  } catch (error) {
    logger.debug('git-credential-check: git unavailable or not a repo, treating as no persisted credentials', {
      error: error instanceof Error ? error.message : String(error),
    })
    return ok(undefined)
  }

  if (extraheaderResult.exitCode === 0 && extraheaderResult.stdout.trim().length > 0) {
    const matchedKey = extraheaderResult.stdout.trim().split('\n')[0]?.split(' ')[0] ?? 'http.*.extraheader'
    return err(
      `Persisted git credential found in local config (${matchedKey}) on a withhold run — ` +
        `set persist-credentials: false on actions/checkout`,
    )
  }

  let remoteResult
  try {
    remoteResult = await execAdapter.getExecOutput('git', ['remote', 'get-url', 'origin'], {
      cwd: workspaceDir,
      ignoreReturnCode: true,
      silent: true,
    })
  } catch (error) {
    logger.debug('git-credential-check: could not read origin remote, treating as no persisted credentials', {
      error: error instanceof Error ? error.message : String(error),
    })
    return ok(undefined)
  }

  if (remoteResult.exitCode === 0) {
    const remoteUrl = remoteResult.stdout.trim()
    if (hasEmbeddedCredential(remoteUrl)) {
      return err(
        'Persisted git credential found embedded in the origin remote URL on a withhold run — ' +
          'set persist-credentials: false on actions/checkout',
      )
    }
  }

  return ok(undefined)
}

/**
 * Detects a credential embedded in a remote URL (e.g.
 * `https://x-access-token:<token>@github.com/owner/repo`) without ever
 * logging the matched substring — the caller only receives a boolean.
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
