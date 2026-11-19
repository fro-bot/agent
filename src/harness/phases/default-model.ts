import type {Result} from '@bfra.me/es/result'
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {err, ok} from '@bfra.me/es/result'
import {boundedCredentialRequest} from '@fro-bot/runtime'
import {DEFAULT_MODEL} from '../../shared/constants.js'

/**
 * The run's model when the `model` input is not set. `executeOpenCodeV2` creates every session on
 * `config?.model ?? DEFAULT_MODEL`, so an unset input means this model whatever `auth-json` or `opencode-config` carry
 * (including a top-level `model` there, which only sets the server's own default). The start in `v2-server.ts` decides
 * once that the default is in use and calls the two helpers below; nothing else restates the decision.
 */
const DEFAULT_MODEL_ID = `${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The providers the caller supplied credentials or settings for: the `auth-json` keys and the `provider` entries of
 * `opencode-config`, each once. The built-in provider is left out: a key or setting for it is used by the default
 * model, so it is not "unused".
 */
export function suppliedProviderIds(options: {
  readonly keyProviderIds: readonly string[]
  readonly config: Readonly<Record<string, unknown>>
}): readonly string[] {
  const declared = isRecord(options.config.provider) ? Object.keys(options.config.provider) : []
  return [...new Set([...options.keyProviderIds, ...declared])].filter(id => id !== DEFAULT_MODEL.providerID)
}

/**
 * Says which model the run uses when the `model` input is not set. With provider credentials or provider config supplied
 * it warns: those are not used by the default model, and the caller most likely meant to set `model`. Without them it
 * records that the free default is in use. Logging only; the run is unchanged.
 */
export function logDefaultModelNotice(options: {
  readonly logger: Logger
  readonly suppliedProviders: readonly string[]
}): void {
  const {logger, suppliedProviders} = options
  if (suppliedProviders.length > 0) {
    logger.warning(
      `The run uses the default model ${DEFAULT_MODEL_ID}, a free model that needs no credentials. ` +
        `The credentials and provider settings supplied for ${suppliedProviders.join(', ')} are not used by it. ` +
        'Set the `model` input (provider/model) to run on your own provider.',
      {model: DEFAULT_MODEL_ID, suppliedProviders},
    )
    return
  }
  logger.info(`The run uses the default model ${DEFAULT_MODEL_ID}, a free model that needs no credentials.`, {
    model: DEFAULT_MODEL_ID,
  })
}

/** The provider ids in a `GET /api/provider` body, or null when the body is not the list this reads. */
function listedProviderIds(body: unknown): readonly string[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null
  return body.data.flatMap(entry => (isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []))
}

/**
 * With no `model` input the session is created on the default model, so its provider must be on the server. A caller who
 * restricts providers (`enabled_providers`, `disabled_providers`, a policy) without naming a model otherwise gets a
 * session that fails at the first turn with a bare `provider.no-route`. The failure names the cause and the remedy.
 *
 * Fail open on anything unreadable (a status other than 200, a body that is not the list, a throw): this check only turns
 * a known-bad configuration into an early, named failure, and must never block a run it cannot judge.
 */
export async function verifyDefaultModelProvider(options: {
  readonly handle: Pick<OpenCodeV2ServerHandle, 'fetch'>
  readonly requestTimeoutMs: number
  readonly signal?: AbortSignal
}): Promise<Result<undefined, string>> {
  const listed = await boundedCredentialRequest(options, async signal => {
    const response = await options.handle.fetch('/api/provider', {signal})
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    return listedProviderIds(await response.json())
  })
  if (listed == null || listed.includes(DEFAULT_MODEL.providerID)) return ok(undefined)
  return err(
    `The default model ${DEFAULT_MODEL_ID} is not available: its provider "${DEFAULT_MODEL.providerID}" is not enabled on ` +
      'the OpenCode server. `enabled_providers`, `disabled_providers` or a policy in opencode-config removes it. ' +
      'Set the `model` input to a model on a provider you enabled.',
  )
}
