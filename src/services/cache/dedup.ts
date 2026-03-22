import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {DEDUP_CACHE_PREFIX, DEDUP_SENTINEL_DIR} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {defaultCacheAdapter, type CacheAdapter} from './types.js'

export type DedupEntityType = 'issue' | 'pr'

export interface DeduplicationMarker {
  readonly timestamp: string
  readonly runId: number
  readonly action: string
  readonly eventType: string
  readonly entityType: DedupEntityType
  readonly entityNumber: number
}

export interface DeduplicationEntity {
  readonly entityType: DedupEntityType
  readonly entityNumber: number
}

function sanitizeRepoName(repo: string): string {
  return repo.replaceAll('/', '-')
}

function buildEntitySentinelDir(repo: string, entity: DeduplicationEntity): string {
  const sanitizedRepo = sanitizeRepoName(repo)
  return path.join(DEDUP_SENTINEL_DIR, `${sanitizedRepo}-${entity.entityType}-${entity.entityNumber}`)
}

function buildDedupRestorePrefix(repo: string, entity: DeduplicationEntity): string {
  const sanitizedRepo = sanitizeRepoName(repo)
  return `${DEDUP_CACHE_PREFIX}-${sanitizedRepo}-${entity.entityType}-${entity.entityNumber}-`
}

export function buildDedupSaveKey(repo: string, entity: DeduplicationEntity, runId: number): string {
  return `${buildDedupRestorePrefix(repo, entity)}${runId}`
}

export async function restoreDeduplicationMarker(
  repo: string,
  entity: DeduplicationEntity,
  logger: Logger,
  cacheAdapter: CacheAdapter = defaultCacheAdapter,
): Promise<DeduplicationMarker | null> {
  const entityDir = buildEntitySentinelDir(repo, entity)
  const sentinelPath = path.join(entityDir, 'sentinel.json')
  const restoreKeyPrefix = buildDedupRestorePrefix(repo, entity)

  try {
    await fs.rm(entityDir, {recursive: true, force: true})
    await fs.mkdir(entityDir, {recursive: true})

    const restoredKey = await cacheAdapter.restoreCache([entityDir], restoreKeyPrefix, [])
    if (restoredKey == null) {
      return null
    }

    const content = await fs.readFile(sentinelPath, 'utf8')
    return JSON.parse(content) as DeduplicationMarker
  } catch (error) {
    logger.debug('Dedup marker restore failed; proceeding without marker', {
      error: toErrorMessage(error),
      entityType: entity.entityType,
      entityNumber: entity.entityNumber,
    })
    return null
  }
}

export async function saveDeduplicationMarker(
  repo: string,
  entity: DeduplicationEntity,
  marker: DeduplicationMarker,
  logger: Logger,
  cacheAdapter: CacheAdapter = defaultCacheAdapter,
): Promise<boolean> {
  const entityDir = buildEntitySentinelDir(repo, entity)
  const sentinelPath = path.join(entityDir, 'sentinel.json')
  const saveKey = buildDedupSaveKey(repo, entity, marker.runId)

  try {
    await fs.mkdir(entityDir, {recursive: true})
    await fs.writeFile(sentinelPath, JSON.stringify(marker), 'utf8')
    await cacheAdapter.saveCache([entityDir], saveKey)
    return true
  } catch (error) {
    const message = toErrorMessage(error).toLowerCase()
    if (message.includes('already exists')) {
      return true
    }

    logger.debug('Dedup marker save failed', {
      error: toErrorMessage(error),
      entityType: entity.entityType,
      entityNumber: entity.entityNumber,
      saveKey,
    })
    return false
  }
}
