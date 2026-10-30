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

import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime/workspace-v2'
import type {Logger} from './opencode-server.js'

/** One provider's API key, parsed from the credential blob. */
export interface ProviderKeyEntry {
  readonly providerId: string
  readonly key: string
}

export type CredentialErrorKind =
  'credential-blob-invalid' | 'credential-missing' | 'credential-provision-failed' | 'model-config-invalid'

/** A credential failure. `message` and `providers` carry provider ids and statuses, never a key or a response body. */
export interface CredentialError {
  readonly kind: CredentialErrorKind
  readonly message: string
  readonly providers?: readonly string[]
}

export type CredentialResult<T> =
  {readonly success: true; readonly data: T} | {readonly success: false; readonly error: CredentialError}

function fail(kind: CredentialErrorKind, message: string, providers?: readonly string[]): CredentialResult<never> {
  return {success: false, error: {kind, message, ...(providers === undefined ? {} : {providers})}}
}

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
 * The model the spawn will use, read from the merged `opencode.json` the entrypoint wrote and the server loads. That
 * file is the one place `deploy/scripts/merge-config.mjs` has already resolved env model against overlay model, so
 * this does not re-implement that rule. Undefined when the file names no model. The error never quotes the file,
 * which may hold an inline provider key from the operator's overlay.
 */
export function modelFromMergedConfig(raw: string): CredentialResult<string | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('model-config-invalid', 'The merged OpenCode config is not valid JSON')
  }
  if (!isRecord(parsed)) return fail('model-config-invalid', 'The merged OpenCode config is not a JSON object')
  const model = typeof parsed.model === 'string' ? parsed.model.trim() : ''
  return {success: true, data: model === '' ? undefined : model}
}

/** The provider half of a `provider/model` string, or undefined when no model is configured. */
export function modelProviderId(model: string | undefined): string | undefined {
  const trimmed = model?.trim() ?? ''
  if (trimmed === '') return undefined
  const provider = trimmed.split('/')[0] ?? ''
  return provider === '' ? undefined : provider
}

export interface CredentialRequestOptions {
  /** The spawned server. Its `fetch` carries the Basic credential. */
  readonly handle: Pick<OpenCodeV2ServerHandle, 'fetch'>
  /** Bound on each request, headers and body together. */
  readonly requestTimeoutMs: number
  /** Service cancellation, joined with the per-request bound. */
  readonly signal?: AbortSignal
}

/**
 * Runs one bounded request. The bound covers a body that stalls after its headers, which the transport may not honour
 * on its own. Any thrown error (network, timeout, abort) becomes `undefined`; the caller reports a status-free failure.
 */
async function boundedRequest<T>(
  options: CredentialRequestOptions,
  send: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const bound = AbortSignal.timeout(options.requestTimeoutMs)
  const signal = options.signal === undefined ? bound : AbortSignal.any([options.signal, bound])
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason)
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, {once: true})
      send(signal)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort))
    })
  } catch {
    return undefined
  }
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
    const status = await boundedRequest(options, async signal => {
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

/** True when the integration response lists a connection that can authenticate a request. */
function hasUsableConnection(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.connections)) return false
  return body.data.connections.some(
    connection => isRecord(connection) && (connection.type === 'credential' || connection.type === 'env'),
  )
}

/**
 * The fail-loud gate. For each required provider, `GET /api/integration/<provider>` must list a `credential` (or
 * `env`) connection, or the server never goes ready. That route returns connection ids, labels and methods only.
 */
export async function verifyCredentialGate(
  options: CredentialRequestOptions & {readonly providers: readonly string[]},
): Promise<CredentialResult<readonly string[]>> {
  const missing: string[] = []
  for (const providerId of options.providers) {
    const usable = await boundedRequest(options, async signal => {
      const response = await options.handle.fetch(`/api/integration/${encodeURIComponent(providerId)}`, {signal})
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        return false
      }
      return hasUsableConnection(await response.json())
    })
    if (usable !== true) missing.push(providerId)
  }
  if (missing.length > 0) {
    return fail(
      'credential-missing',
      `No credential for provider(s): ${missing.join(', ')}. Provision the workspace-opencode-auth secret.`,
      missing,
    )
  }
  return {success: true, data: options.providers}
}
