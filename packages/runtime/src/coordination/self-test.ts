import type {Result} from '../shared/types.js'
import type {CoordinationConfig} from './types.js'

import {err, ok} from '../shared/types.js'
import {requireConditionalDelete, requireConditionalPut} from './adapter-guards.js'

function getProbeKey(config: CoordinationConfig) {
  return `${config.storeConfig.prefix}/_probe/ifnonematch-test`
}

function getProbeCleanupEtag(firstEtag: string, secondEtag: string | null): string {
  return secondEtag ?? firstEtag
}

export async function validateProviderSemantics(
  config: CoordinationConfig,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<void, Error>> {
  const probeKey = getProbeKey(config)
  logger.debug('Validating object-store conditional semantics', {probeKey})
  const conditionalPut = requireConditionalPut(config)
  const conditionalDelete = requireConditionalDelete(config)

  // Phase 1: Verify ifNoneMatch — second create-if-absent must be rejected
  const firstWrite = await conditionalPut(probeKey, JSON.stringify({probe: 1}), {ifNoneMatch: '*'})
  if (firstWrite.success === false) {
    return err(firstWrite.error)
  }

  const secondWrite = await conditionalPut(probeKey, JSON.stringify({probe: 2}), {ifNoneMatch: '*'})

  // Phase 2: Verify ifMatch — overwrite with stale etag must be rejected
  // Use a fabricated stale etag; a correct provider rejects the write.
  const staleEtag = '"0000000000000000000000000000dead"'
  const ifMatchProbe = await conditionalPut(probeKey, JSON.stringify({probe: 3}), {ifMatch: staleEtag})

  // Phase 3: Cleanup — delete the probe object using the correct etag
  const cleanupEtag = getProbeCleanupEtag(
    firstWrite.data.etag,
    secondWrite.success === true ? secondWrite.data.etag : null,
  )
  const cleanupResult = await conditionalDelete(probeKey, {ifMatch: cleanupEtag})

  // Evaluate results: cleanup error should not shadow semantics failures
  const semanticsError =
    secondWrite.success === true
      ? new Error("Provider does not enforce ifNoneMatch: '*' — cannot be used for lock coordination")
      : ifMatchProbe.success === true
        ? new Error('Provider does not enforce ifMatch — cannot be used for lock coordination')
        : null

  if (semanticsError != null) {
    // Return semantics error even if cleanup also failed — the semantics verdict is primary
    return err(semanticsError)
  }

  if (cleanupResult.success === false) {
    return err(cleanupResult.error)
  }

  return ok(undefined)
}
