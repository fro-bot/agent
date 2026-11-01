/**
 * The credential gate of an OpenCode V2 spawn (fro-bot/agent#1992, #1993), shared by the workspace agent and the
 * Action.
 *
 * V2 reads `auth.json` in exactly one place, the legacy-import migration, and a fresh database bootstraps by marking
 * that migration applied without running it. So a spawn that is given no other credential resolves its model with no
 * auth and every request answers 401. Each surface gives the spawn a credential its own way (the workspace provisions
 * it over REST; the Action points the config at a key file with `{file:...}`). This module is the part they share: it
 * decides whether the provider a run needs can authenticate, and refuses when it cannot.
 *
 * - `spawnConfigFromConfig` reads which providers the config already carries an inline credential for. A `{file:...}`
 *   or `{env:...}` reference with a non-empty target counts, because the server substitutes it before it resolves
 *   provider settings. Presence only: the reference is never resolved here.
 * - `verifyCredentialGate` requires each needed provider to either be in that list or have a `credential` (or `env`)
 *   connection on `GET /api/integration/<provider>`. That route lists connection ids and labels, never a secret.
 *
 * SECURITY INVARIANTS: nothing here reads `GET /api/credential` (it returns secret values), and no error or log line
 * carries a key, a key path, a config value or a response body. Failures name provider ids and HTTP statuses only.
 */

import type {OpenCodeV2ServerHandle} from './server-v2.js'

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

export function credentialFailure(
  kind: CredentialErrorKind,
  message: string,
  providers?: readonly string[],
): CredentialResult<never> {
  return {success: false, error: {kind, message, ...(providers === undefined ? {} : {providers})}}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What a config says about the model and about authentication, with no secret value in it. */
export interface SpawnConfig {
  /** The `model` the spawn will use (`provider/model`), when the config names one. */
  readonly model?: string
  /** Providers that carry a non-empty inline credential setting in the config. Presence only: never the value. */
  readonly authenticatedProviders: readonly string[]
}

/** The provider settings the resolver counts as configured authentication (`hasConfiguredAuth`, model-resolver.ts). */
const INLINE_AUTH_KEYS = ['apiKey', 'authToken', 'accessToken'] as const

/** A `{env:X}` or `{file:X}` reference whose target is empty or only whitespace: it can name nothing. */
const EMPTY_REFERENCE = /\{(?:env|file):\s*\}/g

/**
 * Whether an inline credential setting is present. A literal counts, and so does a `{file:...}` or `{env:...}`
 * reference with a non-empty target. The reference is NEVER resolved here: a caller must not read a path or an
 * environment variable the agent controls, and the value would be a secret in memory for nothing.
 *
 * Residual, accepted: a reference that resolves to nothing at load time (a missing or unreadable file, an unset
 * variable) passes the gate and then fails at the first model call with a 401. An empty string, or a reference with an
 * empty target (`{file:}`, `{env:}`), does not count.
 */
function isConfiguredKey(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.replaceAll(EMPTY_REFERENCE, '').trim() !== ''
}

function hasInlineAuth(provider: unknown): boolean {
  if (!isRecord(provider)) return false
  // V1-shaped `options` is migrated into V2 `settings`; V2-native config writes `settings` directly. Both are read.
  return [provider.options, provider.settings].some(
    bag => isRecord(bag) && INLINE_AUTH_KEYS.some(key => isConfiguredKey(bag[key])),
  )
}

/** The model and the authenticated providers of a parsed config. Carries provider ids only. */
export function spawnConfigFromConfig(config: Readonly<Record<string, unknown>>): SpawnConfig {
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  const providers = isRecord(config.provider) ? config.provider : {}
  const authenticatedProviders = Object.entries(providers)
    .filter(([, provider]) => hasInlineAuth(provider))
    .map(([providerId]) => providerId)
  return {...(model === '' ? {} : {model}), authenticatedProviders}
}

/**
 * Same as `spawnConfigFromConfig` for the merged `opencode.json` text the workspace entrypoint wrote. The error never
 * quotes the file, which may hold an inline provider key from the operator's overlay.
 */
export function spawnConfigFromMergedConfig(raw: string): CredentialResult<SpawnConfig> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return credentialFailure('model-config-invalid', 'The merged OpenCode config is not valid JSON')
  }
  if (!isRecord(parsed)) {
    return credentialFailure('model-config-invalid', 'The merged OpenCode config is not a JSON object')
  }
  return {success: true, data: spawnConfigFromConfig(parsed)}
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
export async function boundedCredentialRequest<T>(
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

/** True when the integration response lists a connection that can authenticate a request. */
function hasUsableConnection(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.connections)) return false
  return body.data.connections.some(
    connection => isRecord(connection) && (connection.type === 'credential' || connection.type === 'env'),
  )
}

export interface VerifyCredentialGateOptions extends CredentialRequestOptions {
  readonly providers: readonly string[]
  /** Providers whose config carries an inline credential setting: usable without a stored connection. */
  readonly configuredAuth?: readonly string[]
  /** What the operator does about a missing credential. Surface-specific; appended to the failure message. */
  readonly remedy?: string
}

/**
 * The fail-loud gate. Each required provider must either carry an inline credential setting in the config
 * (`configuredAuth`; the integration listing omits those) or have `GET /api/integration/<provider>` list a `credential`
 * (or `env`) connection, or the server never goes ready.
 */
export async function verifyCredentialGate(
  options: VerifyCredentialGateOptions,
): Promise<CredentialResult<readonly string[]>> {
  const missing: string[] = []
  for (const providerId of options.providers) {
    if (options.configuredAuth?.includes(providerId) === true) continue
    const usable = await boundedCredentialRequest(options, async signal => {
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
    return credentialFailure(
      'credential-missing',
      `No credential for provider(s): ${missing.join(', ')}.${options.remedy === undefined ? '' : ` ${options.remedy}`}`,
      missing,
    )
  }
  return {success: true, data: options.providers}
}
