import type {Result} from '../shared/types.js'
import type {CoordinationConfig} from './types.js'

import {buildObjectStoreKey} from '../object-store/key-builder.js'
import {err, ok} from '../shared/types.js'
import {resolveConditionalDelete, resolveConditionalPut} from './adapter-guards.js'

const PROBE_IDENTITY = 'self-test'
const PROBE_REPO = '_probe'
const PROBE_SUFFIX = 'semantics.json'
const STALE_ETAG = '"0000000000000000000000000000dead"'

function getProbeKey(config: CoordinationConfig): Result<string, Error> {
  const key = buildObjectStoreKey(config.storeConfig, PROBE_IDENTITY, PROBE_REPO, 'locks', PROBE_SUFFIX)
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

function getProbeCleanupEtag(firstEtag: string, secondEtag: string | null): string {
  return secondEtag ?? firstEtag
}

export async function validateProviderSemantics(
  config: CoordinationConfig,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<void, Error>> {
  const probeKey = getProbeKey(config)
  if (probeKey.success === false) {
    return err(probeKey.error)
  }

  const conditionalPut = resolveConditionalPut(config)
  if (conditionalPut.success === false) {
    return err(conditionalPut.error)
  }

  const conditionalDelete = resolveConditionalDelete(config)
  if (conditionalDelete.success === false) {
    return err(conditionalDelete.error)
  }

  logger.debug('Validating object-store conditional semantics', {probeKey: probeKey.data})

  // Phase 1: ifNoneMatch — second create-if-absent must be rejected
  const firstWrite = await conditionalPut.data(probeKey.data, JSON.stringify({probe: 1}), {ifNoneMatch: '*'})
  if (firstWrite.success === false) {
    return err(firstWrite.error)
  }

  const secondWrite = await conditionalPut.data(probeKey.data, JSON.stringify({probe: 2}), {ifNoneMatch: '*'})

  // Phase 2: ifMatch on PUT — overwrite with stale etag must be rejected
  const stalePutProbe = await conditionalPut.data(probeKey.data, JSON.stringify({probe: 3}), {ifMatch: STALE_ETAG})

  // Phase 3: ifMatch on DELETE — delete with stale etag must be rejected
  // Without this check a non-compliant provider (notably R2's historical DELETE behavior)
  // would silently allow racing deletes against active locks.
  const staleDeleteProbe = await conditionalDelete.data(probeKey.data, {ifMatch: STALE_ETAG})

  // Phase 4: Cleanup — best-effort. If the stale-DELETE probe wrongly succeeded, the
  // object is gone and cleanup will fail; the semantics error below takes priority.
  const cleanupEtag = getProbeCleanupEtag(
    firstWrite.data.etag,
    secondWrite.success === true ? secondWrite.data.etag : null,
  )
  const cleanupResult = await conditionalDelete.data(probeKey.data, {ifMatch: cleanupEtag})

  // Evaluate results: cleanup error must not shadow semantics failures.
  const semanticsError =
    secondWrite.success === true
      ? new Error("Provider does not enforce ifNoneMatch: '*' — cannot be used for lock coordination")
      : stalePutProbe.success === true
        ? new Error('Provider does not enforce ifMatch on PUT — cannot be used for lock coordination')
        : staleDeleteProbe.success === true
          ? new Error('Provider does not enforce ifMatch on DELETE — cannot be used for lock coordination')
          : null

  if (semanticsError != null) {
    return err(semanticsError)
  }

  if (cleanupResult.success === false) {
    return err(cleanupResult.error)
  }

  return ok(undefined)
}
