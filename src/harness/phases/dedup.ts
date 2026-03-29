import type {TriggerContext} from '../../features/triggers/types.js'
import type {CacheAdapter} from '../../services/cache/types.js'
import type {Logger} from '../../shared/logger.js'
import {
  restoreDeduplicationMarker,
  saveDeduplicationMarker,
  type DeduplicationEntity,
  type DeduplicationMarker,
} from '../../services/cache/dedup.js'
import {createLogger} from '../../shared/logger.js'
import {setActionOutputs} from '../config/outputs.js'

const DEDUP_EVENT_TYPES = new Set(['pull_request', 'issues'])

const DEDUP_BYPASS_ACTIONS = new Set(['synchronize', 'reopened'])

export interface DedupCheckResult {
  readonly shouldProceed: boolean
  readonly entity: DeduplicationEntity | null
}

export function extractDedupEntity(context: TriggerContext): DeduplicationEntity | null {
  if (context.target == null) {
    return null
  }

  if (!DEDUP_EVENT_TYPES.has(context.eventType)) {
    return null
  }

  if (context.eventType === 'pull_request' && context.target.kind === 'pr') {
    return {entityType: 'pr', entityNumber: context.target.number}
  }

  if (context.eventType === 'issues' && context.target.kind === 'issue') {
    return {entityType: 'issue', entityNumber: context.target.number}
  }

  return null
}

export async function runDedup(
  dedupWindow: number,
  triggerContext: TriggerContext,
  repo: string,
  startTime: number,
  logger: Logger = createLogger({phase: 'dedup'}),
  cacheAdapter?: CacheAdapter,
): Promise<DedupCheckResult> {
  const entity = extractDedupEntity(triggerContext)

  if (dedupWindow === 0) {
    return {shouldProceed: true, entity}
  }

  if (entity == null) {
    return {shouldProceed: true, entity: null}
  }

  if (triggerContext.action != null && DEDUP_BYPASS_ACTIONS.has(triggerContext.action)) {
    logger.debug('Dedup bypassed for action', {action: triggerContext.action})
    return {shouldProceed: true, entity}
  }

  const marker = await restoreDeduplicationMarker(repo, entity, logger, cacheAdapter)
  if (marker == null) {
    return {shouldProceed: true, entity}
  }

  if (marker.runId === triggerContext.runId) {
    return {shouldProceed: true, entity}
  }

  const markerTimestampMs = new Date(marker.timestamp).getTime()
  if (Number.isNaN(markerTimestampMs)) {
    logger.warning('Dedup marker timestamp is invalid; proceeding without dedup', {
      markerTimestamp: marker.timestamp,
    })
    return {shouldProceed: true, entity}
  }

  const CLOCK_SKEW_TOLERANCE_MS = 60_000
  const markerAge = Date.now() - markerTimestampMs
  if (markerAge < -CLOCK_SKEW_TOLERANCE_MS) {
    logger.warning('Dedup marker timestamp is too far in the future; proceeding without dedup', {
      markerTimestamp: marker.timestamp,
      markerAge,
    })
    return {shouldProceed: true, entity}
  }

  const effectiveAge = Math.max(0, markerAge)
  if (effectiveAge > dedupWindow) {
    return {shouldProceed: true, entity}
  }

  logger.info('Skipping duplicate trigger within dedup window', {
    eventType: triggerContext.eventType,
    action: triggerContext.action,
    runId: triggerContext.runId,
    markerRunId: marker.runId,
    markerTimestamp: marker.timestamp,
    dedupWindow,
    entityType: entity.entityType,
    entityNumber: entity.entityNumber,
  })

  setActionOutputs({
    sessionId: null,
    cacheStatus: 'miss',
    duration: Date.now() - startTime,
  })

  return {shouldProceed: false, entity}
}

export async function saveDedupMarker(
  triggerContext: TriggerContext,
  entity: DeduplicationEntity,
  repo: string,
  logger: Logger = createLogger({phase: 'dedup'}),
  cacheAdapter?: CacheAdapter,
): Promise<void> {
  const marker: DeduplicationMarker = {
    timestamp: new Date().toISOString(),
    runId: triggerContext.runId,
    action: triggerContext.action ?? 'unknown',
    eventType: triggerContext.eventType,
    entityType: entity.entityType,
    entityNumber: entity.entityNumber,
  }

  await saveDeduplicationMarker(repo, entity, marker, logger, cacheAdapter)
}
