import type {CacheSaveResult} from '../../shared/cache-save-result.js'
import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {createS3Adapter, syncSessionsToStore} from '@fro-bot/runtime'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {getGitHubRunAttempt} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {buildSaveCacheKey} from './cache-key.js'
import {checkpointDatabase} from './checkpoint.js'
import {buildCachePaths, DB_FAMILY_BASENAMES, DB_MAIN_BASENAME, DB_WAL_BASENAME, deleteAuthJson} from './paths.js'
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
 * or opencode.db itself exists and is non-empty in cachePaths.
 *
 * OpenCode 1.17.x persists sessions in opencode.db at path.dirname(storagePath), NOT
 * inside storagePath itself. Without this check the old guard would return false on every
 * real run, skipping the cache save and breaking session continuity.
 *
 * WAL mode note: this function is only reached after checkpointDatabase has already run
 * and resolved to 'checkpointed' or 'nothing-to-checkpoint' — a 'failed' outcome returns a
 * checkpoint-declined CacheSaveResult before this is ever called (see the checkpoint block
 * above). A healthy run therefore has all its data already merged into opencode.db by the time this
 * runs: checkpointDatabase merges a hot write-ahead log into the main file before this
 * check ever sees it (checkpoint.test.ts pins that as 'checkpointed', not skipped as
 * 'nothing-to-checkpoint'). This matters more now than it used to: neither
 * buildCachePaths (paths.ts) nor the object-store upload set
 * (DB_TRANSPORTABLE_BASENAMES, packages/runtime/src/session/version.ts) includes the
 * write-ahead log at all any more, so if content were still sitting only in the WAL by
 * this point, it would be invisible here — not merely deprioritized. We still check every
 * DB-family path present in cachePaths here (not a hardcoded opencode.db reference), as a
 * defensive property rather than a load-bearing one: today that set is just opencode.db,
 * since neither the write-ahead log nor -shm are ever included.
 *
 * opencode.db-shm is deliberately excluded: buildCachePaths never includes it (it is
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
 *
 * A decline here rarely costs a run its session work: `runCleanup` sets `CACHE_SAVED` to
 * `not-persisted` on decline (via `toCacheSaveStateValue`), so `runPost` (post.ts) retries
 * the save later — by which point the main step has ended and the OpenCode child has
 * almost certainly exited, making the retry's checkpoint succeed.
 */
async function writeCheckpointDeclineSummary(reason: string, logger: Logger): Promise<void> {
  try {
    core.summary.addHeading('Fro Bot Agent Run — Cache Save Declined', 2).addRaw(
      'The session cache was not saved at this point because the SQLite write-ahead log could not be checkpointed.\n\n' +
        `**Reason:** ${reason}\n\n` +
        // core.summary.write() appends by default, so this block is never edited or
        // removed after the fact once written — it must describe only what is true right
        // now, not a predicted final outcome. It used to assert "the next run may restore
        // an older session," which reads as false the moment the post-action hook's
        // retry (src/harness/post.ts) succeeds — the documented, common recovery this
        // decline exists to make room for. That retry does not itself write a job summary
        // entry on success, so this wording is deliberately conditional rather than
        // promising a correction that may never visibly appear.
        '> A retry from the post-action hook may still save the cache later in this run. Only if that retry also fails does the next run risk restoring an older session.\n',
    )
    await core.summary.write()
  } catch (error) {
    logger.warning('Failed to write cache-save-declined summary', {error: toErrorMessage(error)})
  }
}

export async function saveCache(options: SaveCacheOptions): Promise<CacheSaveResult> {
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
    return {cachePersisted: false, storePersisted: false, outcome: 'skipped-by-configuration'}
  }

  // Sourced independently of options, the same way runId's caller derives it, rather than
  // widening SaveCacheOptions -- runAttempt is a process-wide runner fact, not per-call
  // configuration.
  const saveKey = buildSaveCacheKey(components, runId, getGitHubRunAttempt())
  // Tracked across the try block (and visible to the catch below) because the store sync
  // and the cache write are independent backends: a thrown error from the cache write
  // (including the caught "already exists" collision) must not erase whatever the object
  // store already durably persisted earlier in the same attempt.
  let storePersisted = false

  try {
    await deleteAuthJson(authPath, storagePath, logger)

    // Checkpoint before anything inspects file sizes, builds the save path list, or
    // transports bytes: this moves data out of the write-ahead log into the main database
    // file, which changes which files are non-empty for hasCacheableContent below and for
    // the S3 sync further down. buildCachePaths (paths.ts) never includes the
    // write-ahead log at all any more — neither transport does (see
    // DB_TRANSPORTABLE_BASENAMES, packages/runtime/src/session/version.ts) — so ordering
    // this checkpoint first is what guarantees a healthy save's data is actually reachable
    // through opencode.db by the time either transport looks for it, rather than sitting
    // unmerged in a file neither one will ever pick up.
    const dbDir = path.dirname(storagePath)
    const dbPath = path.join(dbDir, DB_MAIN_BASENAME)
    const walPath = path.join(dbDir, DB_WAL_BASENAME)
    const checkpointOutcome = await checkpointDatabase({dbPath, walPath, logger})
    if (checkpointOutcome.status === 'failed') {
      logger.warning('Declining cache save: SQLite checkpoint did not complete', {
        reason: checkpointOutcome.reason,
      })
      await writeCheckpointDeclineSummary(checkpointOutcome.reason, logger)
      return {cachePersisted: false, storePersisted: false, outcome: 'checkpoint-declined'}
    }

    const cachePaths = await buildCachePaths(storagePath, projectIdPath, opencodeVersion)
    logger.info('Saving cache', {saveKey, paths: cachePaths})

    const hasContent = await hasCacheableContent(storagePath, cachePaths)
    if (hasContent === false) {
      logger.info('No storage content to cache')
      return {cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'}
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
        storePersisted = syncResult.uploaded > 0 && syncResult.failed === 0
      } catch (error) {
        logger.warning('Object store session sync failed (non-fatal)', {
          error: toErrorMessage(error),
        })
      }
    }

    const cacheId = await cacheAdapter.saveCache(cachePaths, saveKey)
    // @actions/cache returns -1 for both write failures and reservation collisions. The
    // adapter exposes no reason, so report the save as unpersisted (cache-rejected) rather
    // than claiming success — see the CacheSaveOutcome doc comment for why this is one
    // outcome rather than two.
    if (cacheId === -1) {
      logger.warning('Cache save did not persist', {saveKey})
      return {cachePersisted: false, storePersisted, outcome: 'cache-rejected'}
    }

    logger.info('Cache saved', {saveKey})
    return {cachePersisted: true, storePersisted, outcome: 'persisted'}
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) {
      logger.info('Cache key already exists, skipping save')
      // Fold-in, not a separate outcome: the save key now includes both run ID and run
      // attempt, so a "key already exists" collision is confined to a genuine duplicate
      // save within the same attempt (e.g. a concurrent job) -- some other save already
      // committed this key, so the state is durably present under it regardless of which
      // one wrote it. Distinguishing it from a normal success would not change what a
      // caller should do with the result.
      return {cachePersisted: true, storePersisted, outcome: 'persisted'}
    }

    logger.warning('Cache save failed', {
      error: toErrorMessage(error),
    })
    return {cachePersisted: false, storePersisted, outcome: 'cache-error'}
  }
}
