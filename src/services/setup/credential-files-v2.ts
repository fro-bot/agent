import type {Result} from '@bfra.me/es/result'
import type {AuthConfig, Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {err, ok} from '@bfra.me/es/result'

/**
 * Provider credentials for an OpenCode V2 Action run (fro-bot/agent#1992, #1993).
 *
 * V2 reads `auth.json` in one place only, the legacy-import migration (m39). On a fresh database that migration is
 * skipped and every call answers 401; on a restored V1 database it would import `auth.json` as plaintext rows that the
 * post hook then caches. So the Action never writes `auth.json` on V2. Each `type: "api"` entry of the `auth-json` input
 * goes to its own 0600 file instead, and the V2 config references it with `{file:/abs/path}`. The saved `opencode.db`
 * therefore never holds a key, and a rotated key is picked up on the next run.
 *
 * SECURITY INVARIANTS:
 * - The key files live in a fresh 0700 directory under `RUNNER_TEMP` (the OS temp directory without it). No cache,
 *   object-store sync or artifact upload reads that directory (pinned by the test beside this file).
 * - A key and the path of a key file are never logged and never put in an error. Failures carry a provider id at most.
 * - A provider id names a file only after it passes `PROVIDER_ID_PATTERN`; anything else is refused without echoing it.
 */

export interface ProviderKeyEntryV2 {
  readonly providerId: string
  readonly key: string
}

export type CredentialFilesErrorKind =
  'invalid-credential' | 'invalid-provider-id' | 'unsafe-directory' | 'unsupported-credential-type' | 'write-failed'

/** A credential-file failure. `providerId` is set only when the id itself passed validation. Never a key or a path. */
export interface CredentialFilesError {
  readonly kind: CredentialFilesErrorKind
  readonly message: string
  readonly providerId?: string
}

export interface CredentialFilesV2 {
  /** The run-scoped directory holding the key files, or null when there was nothing to write. */
  readonly directory: string | null
  /** Provider id to the absolute path of its key file. */
  readonly keyFiles: Readonly<Record<string, string>>
}

/**
 * A provider id names a file, so it must start alphanumeric (no `.`, `..`, hidden names) and hold only word
 * characters, dots and hyphens (no separator, no `}` that would end a `{file:...}` reference early).
 */
const PROVIDER_ID_PATTERN = /^[A-Z0-9][\w.-]*$/i

/**
 * The directory path ends up inside a `{file:<path>}` reference in JSON text, and the server's substitution ends the
 * reference at the first `}`. Keep to a conservative alphabet so nothing needs escaping in either layer.
 */
const SAFE_DIRECTORY_PATTERN = /^\/[\w./ -]+$/

function fail(kind: CredentialFilesErrorKind, message: string, providerId?: string): CredentialFilesError {
  return {kind, message, ...(providerId === undefined ? {} : {providerId})}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrows the parsed `auth-json` input to API-key entries. Any other entry fails with a named error that carries the
 * provider id and nothing from the entry: an OAuth or well-known credential cannot be a `{file:}` key, and dropping it
 * silently would leave that provider unauthenticated.
 */
export function parseProviderKeysV2(
  authConfig: AuthConfig,
): Result<readonly ProviderKeyEntryV2[], CredentialFilesError> {
  const entries: ProviderKeyEntryV2[] = []
  for (const [providerId, entry] of Object.entries(authConfig)) {
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      return err(fail('invalid-provider-id', 'The auth-json input has a provider id with invalid characters'))
    }
    const value: unknown = entry
    if (!isRecord(value) || value.type !== 'api') {
      return err(
        fail(
          'unsupported-credential-type',
          `Provider "${providerId}": only API-key credentials (type "api") are supported on OpenCode V2`,
          providerId,
        ),
      )
    }
    if (typeof value.key !== 'string' || value.key.trim() === '') {
      return err(fail('invalid-credential', `Provider "${providerId}": the API key is missing or empty`, providerId))
    }
    entries.push({providerId, key: value.key})
  }
  return ok(entries)
}

/** `RUNNER_TEMP` when set and non-blank, else the OS temp directory. */
export function resolveCredentialBaseDir(env: NodeJS.ProcessEnv): string {
  const runnerTemp = env.RUNNER_TEMP?.trim() ?? ''
  return runnerTemp === '' ? os.tmpdir() : runnerTemp
}

/**
 * Writes one 0600 file per entry into a fresh 0700 directory under `baseDir`. The directory name is random, so it is
 * run-scoped by construction and a restored or planted path from an earlier run is never reused.
 */
export async function writeCredentialFilesV2(options: {
  readonly entries: readonly ProviderKeyEntryV2[]
  readonly baseDir: string
  readonly logger: Logger
}): Promise<Result<CredentialFilesV2, CredentialFilesError>> {
  const {entries, baseDir, logger} = options
  if (entries.length === 0) {
    logger.info('No API-key credentials to write for OpenCode V2')
    return ok({directory: null, keyFiles: {}})
  }

  const resolvedBase = path.resolve(baseDir)
  if (!path.isAbsolute(baseDir) || !SAFE_DIRECTORY_PATTERN.test(resolvedBase)) {
    return err(
      fail(
        'unsafe-directory',
        'The credential directory root must be an absolute path of word characters, dots, hyphens, slashes and spaces',
      ),
    )
  }

  let directory: string
  const keyFiles: Record<string, string> = {}
  try {
    await fs.mkdir(resolvedBase, {recursive: true})
    // `mkdtemp` creates the directory 0700, whatever the umask.
    directory = await fs.mkdtemp(path.join(resolvedBase, 'fro-bot-credentials-'))
    for (const {providerId, key} of entries) {
      const file = path.join(directory, `${providerId}.key`)
      // `wx`: never follow or overwrite anything already there. The mode is applied at creation, so the key is
      // never readable by another user, not even for an instant.
      await fs.writeFile(file, key, {mode: 0o600, flag: 'wx'})
      keyFiles[providerId] = file
    }
  } catch (error) {
    // The error text of a failed write names a path; only the code is reported.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
    return err(fail('write-failed', `Could not write the OpenCode V2 credential files (${code})`))
  }

  logger.info('Wrote OpenCode V2 credential files', {providers: Object.keys(keyFiles), count: entries.length})
  return ok({directory, keyFiles})
}

/**
 * Deletes an `auth.json` at the OpenCode data path. On V2 nothing writes it, but a restored cache or an earlier run on
 * the same runner may have left one, and m39 would import it into the database the post hook then saves.
 */
export async function removeStaleAuthJsonV2(authPath: string, logger: Logger): Promise<void> {
  try {
    await fs.rm(authPath, {force: true})
    logger.debug('Ensured no auth.json sits at the OpenCode data path')
  } catch (error) {
    // Not forwarded: the failure of a delete on this path must not quote what it points at.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
    throw new Error(`Could not remove a stale auth.json before the OpenCode V2 spawn (${code})`)
  }
}
