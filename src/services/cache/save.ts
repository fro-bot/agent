import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {createS3Adapter, syncSessionsToStore} from '@fro-bot/runtime'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {buildSaveCacheKey} from './cache-key.js'
import {checkpointDatabase} from './checkpoint.js'
import {buildSaveCachePaths, DB_FAMILY_BASENAMES, DB_MAIN_BASENAME, DB_WAL_BASENAME, deleteAuthJson} from './paths.js'
import {defaultCacheAdapter, type SaveCacheOptions} from './types.js'

async function writeStorageVersion(storagePath: string): Promise<void> {
  const versionFile = path.join(storagePath, '.version')
  await fs.mkdir(storagePath, {recursive: true})
  await fs.writeFile(versionFile, String(STORAGE_VERSION), 'utf8')
}

async function directoryHasContent(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * Returns true if there is any real cacheable content: either storagePath has files,
 * or a SQLite DB-family file that actually crosses the save boundary (opencode.db,
 * opencode.db-wal) exists and is non-empty in cachePaths.
 *
 * OpenCode 1.17.x persists sessions in opencode.db at path.dirname(storagePath), NOT
 * inside storagePath itself. Without this check the old guard would return false on every
 * real run, skipping the cache save and breaking session continuity.
 *
 * WAL mode note: server.close() sends proc.kill() without awaiting a checkpoint, so a
 * valid session can have opencode.db at 0 bytes with all data still in opencode.db-wal.
 * We must treat any non-empty DB-family file as sufficient evidence of cacheable content.
 *
 * opencode.db-shm is deliberately excluded: buildSaveCachePaths never includes it (it is
 * machine-local and stale by construction), so it never appears in cachePaths here. A
 * workspace whose only non-empty file is -shm correctly reports no cacheable content.
 */
async function hasCacheableContent(storagePath: string, cachePaths: readonly string[]): Promise<boolean> {
  if (await directoryHasContent(storagePath)) {
    return true
  }

  // Check every SQLite DB-family path already selected for save — any non-empty one is
  // sufficient. DB_FAMILY_BASENAMES is the single shared definition of these filenames
  // (see paths.ts); checking cachePaths membership is the right gate (avoids redundant
  // stat calls) and naturally excludes -shm since it is never in cachePaths.
  const dbFamilyPaths = cachePaths.filter(p => DB_FAMILY_BASENAMES.includes(path.basename(p)))

  for (const dbPath of dbFamilyPaths) {
    try {
      const stat = await fs.stat(dbPath)
      if (stat.size > 0) {
        return true
      }
    } catch {
      // file missing or inaccessible — not cacheable from this source
    }
  }

  return false
}

/**
 * A declined save must be loud: a silent skip here reproduces the read-only-token
 * incident, where a discarded signal hid lost session continuity for a month. This
 * writes directly via `core.summary` (the same primitive `writeJobSummary` and the
 * dedup-skip summary use) because `saveCache` runs in both the cleanup and post-hook
 * paths, neither of which carries the full `RunMetrics` that `writeJobSummary` expects.
 * Non-blocking: logs a warning on failure but never throws.
 */
async function writeCheckpointDeclineSummary(reason: string, logger: Logger): Promise<void> {
  try {
    core.summary
      .addHeading('Fro Bot Agent Run — Cache Save Declined', 2)
      .addRaw(
        'Session cache was not saved this run because the SQLite write-ahead log could not be checkpointed.\n\n' +
          `**Reason:** ${reason}\n\n` +
          '> The next run may restore an older session and pay recovery cost for any previously uncheckpointed state.\n',
      )
    await core.summary.write()
  } catch (error) {
    logger.warning('Failed to write cache-save-declined summary', {error: toErrorMessage(error)})
  }
}

export async function saveCache(options: SaveCacheOptions): Promise<boolean> {
  const {
    components,
    runId,
    logger,
    storagePath,
    authPath,
    projectIdPath,
    opencodeVersion,
    cacheAdapter = defaultCacheAdapter,
  } = options

  if (process.env.SKIP_CACHE === 'true') {
    logger.debug('Skipping cache save (SKIP_CACHE=true)')
    return true
  }

  const saveKey = buildSaveCacheKey(components, runId)
  const cachePaths = await buildSaveCachePaths(storagePath, projectIdPath, opencodeVersion)

  logger.info('Saving cache', {saveKey, paths: cachePaths})

  try {
    await deleteAuthJson(authPath, storagePath, logger)

    // Checkpoint before anything inspects file sizes or transports bytes: this moves
    // data out of the write-ahead log into the main database file, which changes which
    // files are non-empty for both hasCacheableContent below and the S3 sync at :97.
    const dbDir = path.dirname(storagePath)
    const dbPath = path.join(dbDir, DB_MAIN_BASENAME)
    const walPath = path.join(dbDir, DB_WAL_BASENAME)
    const checkpointOutcome = await checkpointDatabase({dbPath, walPath, logger})
    if (checkpointOutcome.status === 'failed') {
      logger.warning('Declining cache save: SQLite checkpoint did not complete', {
        reason: checkpointOutcome.reason,
      })
      await writeCheckpointDeclineSummary(checkpointOutcome.reason, logger)
      return false
    }

    const hasContent = await hasCacheableContent(storagePath, cachePaths)
    if (hasContent === false) {
      logger.info('No storage content to cache')
      return false
    }

    await writeStorageVersion(storagePath)

    if (options.storeConfig?.enabled === true) {
      try {
        const adapter = options.storeAdapter ?? createS3Adapter(options.storeConfig, logger)
        const syncResult = await syncSessionsToStore(
          adapter,
          options.storeConfig,
          components.agentIdentity,
          components.repo,
          storagePath,
          logger,
        )
        logger.info('Object store session sync completed', syncResult)
      } catch (error) {
        logger.warning('Object store session sync failed (non-fatal)', {
          error: toErrorMessage(error),
        })
      }
    }

    const cacheId = await cacheAdapter.saveCache(cachePaths, saveKey)
    // @actions/cache returns -1 for both write failures and reservation collisions. The
    // adapter exposes no reason, so report the save as unpersisted rather than claiming success.
    if (cacheId === -1) {
      logger.warning('Cache save did not persist', {saveKey})
      return false
    }

    logger.info('Cache saved', {saveKey})
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) {
      logger.info('Cache key already exists, skipping save')
      return true
    }

    logger.warning('Cache save failed', {
      error: toErrorMessage(error),
    })
    return false
  }
}
