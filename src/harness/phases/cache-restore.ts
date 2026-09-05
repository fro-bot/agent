import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {bootstrapOpenCodeServer} from '../../features/agent/index.js'
import {
  buildCacheKeyComponents,
  checkpointDatabase,
  cleanStorage,
  restoreCache,
  verifyDatabaseUsable,
} from '../../services/cache/index.js'
import {DB_MAIN_BASENAME, DB_WAL_BASENAME} from '../../services/cache/paths.js'
import {ensureProjectId} from '../../services/setup/project-id.js'
import {getGitHubWorkspace, getOpenCodeAuthPath, getOpenCodeStoragePath} from '../../shared/env.js'
import {createLogger} from '../../shared/logger.js'

export interface CacheRestorePhaseResult {
  readonly cacheResult: CacheResult
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly serverHandle: OpenCodeServerHandle
}

export async function runCacheRestore(
  bootstrap: BootstrapPhaseResult,
  metrics: MetricsCollector,
): Promise<CacheRestorePhaseResult | null> {
  const cacheComponents = buildCacheKeyComponents()

  const cacheLogger = createLogger({phase: 'cache'})
  const workspacePath = getGitHubWorkspace()
  const projectIdPath = path.join(workspacePath, '.git', 'opencode')

  const storagePath = getOpenCodeStoragePath()

  let cacheResult = await restoreCache({
    components: cacheComponents,
    logger: cacheLogger,
    storagePath,
    authPath: getOpenCodeAuthPath(),
    projectIdPath,
    opencodeVersion: bootstrap.opencodeResult.version,
    storeConfig: bootstrap.inputs.storeConfig,
  })

  let cacheStatus: 'corrupted' | 'hit' | 'miss' = cacheResult.corrupted ? 'corrupted' : cacheResult.hit ? 'hit' : 'miss'
  metrics.setCacheStatus(cacheStatus)
  metrics.setCacheSource(cacheResult.source)
  bootstrap.logger.info('Cache restore completed', {cacheStatus, key: cacheResult.key})

  const projectIdResult = await ensureProjectId({workspacePath, logger: cacheLogger})
  if (projectIdResult.source === 'error') {
    cacheLogger.warning('Failed to generate project ID (continuing)', {error: projectIdResult.error})
  } else {
    cacheLogger.debug('Project ID ready', {projectId: projectIdResult.projectId, source: projectIdResult.source})
  }

  // Repair a restored database before the server ever opens it. Restore keys are
  // prefixes returning the most recent entry, and save keys are unique per run, so a run
  // that declines to save leaves a poisoned entry as the newest one for the next restore
  // to hit again. Checkpointing here — outside the bootstrap budget that only times
  // createOpencode — heals a stuck repository in place instead of discarding its history.
  // Only a 'hit' has a restored database to repair: a miss has nothing on disk yet, and a
  // 'corrupted' result already had its DB family deleted by cleanStorage.
  if (cacheStatus === 'hit') {
    const dbDir = path.dirname(storagePath)
    const dbPath = path.join(dbDir, DB_MAIN_BASENAME)

    // SQLite itself reports this file is not a usable database (e.g. "file is not a
    // database", "database disk image is malformed") — not a live writer and not a slow
    // truncation. Re-persisting it under a fresh key would trap the repository in the same
    // self-perpetuating loop this PR exists to break, reached through corruption instead of
    // a hot write-ahead log. Route it into the same clean-slate path restoreCache already
    // uses for corrupted or version-mismatched storage, and report the run as a corrupted
    // cache so the save that follows starts from a clean state instead of re-saving the
    // malformed database.
    const handleStructuralCorruption = async (reason: string): Promise<void> => {
      cacheLogger.warning('Restored database is structurally corrupt - cleaning storage before bootstrap', {
        reason,
      })
      await cleanStorage(storagePath)
      cacheStatus = 'corrupted'
      // Keep cacheResult in agreement with the downgraded cacheStatus: it is a public
      // field of CacheRestorePhaseResult, and a caller reading a stale {hit: true,
      // restoredPath} for storage that was just deleted would be a real, if currently
      // latent, bug. Mirrors the shape restoreCache itself returns for its own
      // corruption/version-mismatch paths (see restoreAfterCorruption in restore.ts).
      cacheResult = {
        hit: false,
        key: cacheResult.key,
        restoredPath: null,
        corrupted: true,
        source: null,
      }
      metrics.setCacheStatus(cacheStatus)
      metrics.setCacheSource(cacheResult.source)
    }

    const repairOutcome = await checkpointDatabase({
      dbPath,
      walPath: path.join(dbDir, DB_WAL_BASENAME),
      logger: cacheLogger,
    })
    if (repairOutcome.status === 'checkpointed') {
      cacheLogger.info('Repaired restored database: checkpointed write-ahead log before bootstrap')
    } else if (repairOutcome.status === 'failed') {
      if (repairOutcome.structural) {
        await handleStructuralCorruption(repairOutcome.reason)
      } else {
        // The usability probe below is deliberately not also run here. A database that is
        // locked or otherwise environmentally unavailable would fail the probe's own
        // schema read for the same reason it just failed the checkpoint attempt, so
        // re-probing would only spend another SQLite open for a second chance to
        // misclassify a transient fault as corruption — it cannot add information the
        // checkpoint attempt did not already have. A database that is both locked and
        // genuinely corrupt reaches bootstrap unprobed as a result; that is accepted as
        // the narrower, safer failure mode against the alternative of probing more often.
        cacheLogger.warning('Failed to repair restored database before bootstrap', {reason: repairOutcome.reason})
      }
    } else {
      // 'nothing-to-checkpoint' is the common healthy-run case: there was no write-ahead
      // log to merge, either because the database was cleanly closed or because there was
      // no database at all. Neither shape is visible to checkpointDatabase's WAL-driven
      // contract, so a structurally corrupt database with no hot WAL to betray it would
      // otherwise sail through untouched. This probe is the one place that catches it —
      // it is a no-op (reports usable) for a missing or empty database, matching
      // checkpointDatabase's own treatment of that case.
      const usability = await verifyDatabaseUsable(dbPath)
      if (usability.usable === false) {
        await handleStructuralCorruption(usability.reason)
      }
    }
  }

  const serverLogger = createLogger({phase: 'server-bootstrap'})
  const abortController = new AbortController()
  const bootstrapResult = await bootstrapOpenCodeServer(
    abortController.signal,
    serverLogger,
    workspacePath,
    bootstrap.inputs.serverBootstrapTimeoutMs,
  )

  if (!bootstrapResult.success) {
    core.setFailed(`OpenCode server bootstrap failed: ${bootstrapResult.error.message}`)
    return null
  }

  const serverHandle = bootstrapResult.data
  serverLogger.info('SDK server bootstrapped successfully')

  return {
    cacheResult,
    cacheStatus,
    serverHandle,
  }
}
