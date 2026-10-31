/**
 * Provider credentials for a fresh OpenCode V2 spawn (fro-bot/agent#1992).
 *
 * V2 reads `auth.json` in exactly one place, the legacy-import migration, and a fresh per-spawn database bootstraps by
 * marking that migration applied without running it. So every spawn starts with an empty credential store and the model
 * resolves with no auth. The supervisor therefore provisions the credentials itself, over loopback, after the server
 * is up and before it reports ready:
 *
 * 1. `parseAuthBlob` turns the root-only secret (the same `{"<provider>":{"type":"api","key":"…"}}` blob the V1 path
 *    writes to `auth.json`) into typed entries, once, before any spawn.
 * 2. `provisionCredentials` calls `POST /api/credential` once per provider (`value: {type: "key", key}`).
 * 3. `verifyCredentialGate` reads `GET /api/integration/<provider>` back and refuses unless the provider has a
 *    connection. That response lists connection ids and labels only, never the secret.
 *
 * SECURITY INVARIANTS:
 * - The key travels in one HTTP body over 127.0.0.1 with the per-spawn Basic credential. It is never in argv, the
 *   child environment, `OPENCODE_CONFIG_CONTENT`, a log line, an error message, or `/readyz`.
 * - Nothing here ever reads `GET /api/credential` (it returns secret values) and nothing logs or parses a response body
 *   from the create route (it echoes the stored value). Failures name the provider id and an HTTP status only.
 * - `JSON.parse` errors quote the input, so they are never forwarded.
 */

import type {CredentialRequestOptions, CredentialResult} from '@fro-bot/runtime/workspace-v2'
import type {Logger} from './opencode-server.js'
import {
  boundedCredentialRequest,
  credentialFailure,
  modelProviderId,
  spawnConfigFromMergedConfig,
  verifyCredentialGate as verifySharedCredentialGate,
} from '@fro-bot/runtime/workspace-v2'

// The gate half (what counts as configured auth, the integration read-back) is shared with the Action and lives in
// the runtime. These names stay importable from here.
export {modelProviderId, spawnConfigFromMergedConfig}
export type {
  CredentialError,
  CredentialErrorKind,
  CredentialRequestOptions,
  CredentialResult,
  SpawnConfig,
} from '@fro-bot/runtime/workspace-v2'

/** One provider's API key, parsed from the credential blob. */
export interface ProviderKeyEntry {
  readonly providerId: string
  readonly key: string
}

const fail = credentialFailure

/** Same alphabet `deploy/scripts/validate-auth.mjs` enforces on provider ids. */
const PROVIDER_ID_PATTERN = /^[\w.-]+$/

/** The label stored with every credential this module creates. */
export const WORKSPACE_CREDENTIAL_LABEL = 'workspace'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses the credential blob. The entrypoint has already run `validate-auth.mjs` on it, so a failure here means the
 * secret changed under the supervisor or the two validators drifted; either way it must be loud.
 *
 * The blob holds API keys only. Any other `type` (oauth, wellknown, …) is refused by naming the provider id, because
 * silently dropping it would leave that provider without a credential.
 */
export function parseAuthBlob(raw: string): CredentialResult<readonly ProviderKeyEntry[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('credential-blob-invalid', 'The provider credential blob is not valid JSON')
  }
  if (!isRecord(parsed)) {
    return fail('credential-blob-invalid', 'The provider credential blob must be a JSON object keyed by provider id')
  }
  const entries: ProviderKeyEntry[] = []
  for (const [providerId, value] of Object.entries(parsed)) {
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      return fail('credential-blob-invalid', 'The provider credential blob has a provider id with invalid characters')
    }
    if (!isRecord(value) || value.type !== 'api') {
      return fail('credential-blob-invalid', `Provider "${providerId}": only API-key credentials are supported`, [
        providerId,
      ])
    }
    if (typeof value.key !== 'string' || value.key.trim() === '') {
      return fail('credential-blob-invalid', `Provider "${providerId}": the API key is missing or empty`, [providerId])
    }
    entries.push({providerId, key: value.key})
  }
  if (entries.length === 0) {
    return fail('credential-blob-invalid', 'The provider credential blob has no provider entries')
  }
  return {success: true, data: entries}
}

/**
 * Stores each key in the spawn's credential store. Stops at the first failure, so a half-provisioned server never
 * reaches the gate. Returns the provider ids it stored.
 */
export async function provisionCredentials(
  options: CredentialRequestOptions & {readonly entries: readonly ProviderKeyEntry[]; readonly logger: Logger},
): Promise<CredentialResult<readonly string[]>> {
  const stored: string[] = []
  for (const {providerId, key} of options.entries) {
    const status = await boundedCredentialRequest(options, async signal => {
      const response = await options.handle.fetch('/api/credential', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          integrationID: providerId,
          label: WORKSPACE_CREDENTIAL_LABEL,
          value: {type: 'key', key},
        }),
        signal,
      })
      // The create route echoes the stored value. Discard the body unread.
      await response.body?.cancel().catch(() => undefined)
      return response.status
    })
    if (status === undefined) {
      return fail('credential-provision-failed', `Provider "${providerId}": the credential request did not complete`, [
        providerId,
      ])
    }
    if (status < 200 || status >= 300) {
      return fail('credential-provision-failed', `Provider "${providerId}": credential route answered HTTP ${status}`, [
        providerId,
      ])
    }
    stored.push(providerId)
  }
  options.logger.info('opencode-server-v2: provider credentials provisioned', {
    providers: stored,
    count: stored.length,
  })
  return {success: true, data: stored}
}

/**
 * The fail-loud gate. Each required provider must either carry an inline credential setting in the merged config
 * (`configuredAuth`; the integration listing omits those) or have `GET /api/integration/<provider>` list a `credential`
 * (or `env`) connection, or the server never goes ready. That route returns connection ids, labels and methods only.
 */
export async function verifyCredentialGate(
  options: CredentialRequestOptions & {
    readonly providers: readonly string[]
    /** Providers whose merged config carries an inline credential setting: usable without a stored connection. */
    readonly configuredAuth?: readonly string[]
  },
): Promise<CredentialResult<readonly string[]>> {
  return verifySharedCredentialGate({...options, remedy: 'Provision the workspace-opencode-auth secret.'})
}
