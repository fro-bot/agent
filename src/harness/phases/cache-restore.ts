import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as path from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {DB_V2_MAIN_BASENAME} from '@fro-bot/runtime'
import {bootstrapOpenCodeServer} from '../../features/agent/index.js'
import {resolveSessionGeneration} from '../../services/cache/cache-key.js'
import {
  buildCacheKeyComponents,
  checkpointDatabase,
  cleanStorage,
  restoreCache,
  verifyDatabaseUsable,
} from '../../services/cache/index.js'
import {DB_MAIN_BASENAME, DB_WAL_BASENAME} from '../../services/cache/paths.js'
import {ensureProjectId} from '../../services/setup/project-id.js'
import {
  getGitHubRunAttempt,
  getGitHubRunId,
  getGitHubWorkspace,
  getOpenCodeAuthPath,
  getOpenCodeStoragePath,
} from '../../shared/env.js'
import {createLogger} from '../../shared/logger.js'
import {normalizeWorkspacePath} from '../../shared/paths.js'
import {startActionOpenCodeV2} from './v2-server.js'

export interface CacheRestorePhaseResult {
  readonly cacheResult: CacheResult
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly serverHandle: OpenCodeServerHandle
}

/**
 * What U12a's execution loop receives on V2: the restored cache facts and a server that is spawned, gated (plugins,
 * permissions, credentials) and past its V1 import. No prompt has been sent.
 */
export interface CacheRestoreV2PhaseResult {
  readonly cacheResult: CacheResult
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly serverHandle: OpenCodeV2ServerHandle
}

/**
 * Why a V2 run stops after the start. The V2 execution loop (U12a) does not exist yet, so a run that selects V2 does
 * everything up to the prompt, which proves the start, and then fails here instead of silently running the V1 loop
 * against a V2 server. The default OpenCode version stays V1 until U13, so no production run reaches this.
 */
export const V2_EXECUTION_UNSUPPORTED_MESSAGE =
  'OpenCode V2 execution is not supported yet. Use an OpenCode 1.x version (the default) until the V2 execution loop lands.'

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

  if (resolveSessionGeneration(bootstrap.opencodeResult.version) === 'v2') {
    // The V1 server bootstrap below is not reachable on V2. This is the only place that selects the generation's
    // server: the repair above is generation-neutral (the V1 and V2 databases share a file name and a WAL).
    const started = await startV2Server(bootstrap, workspacePath, storagePath, cacheResult, cacheStatus)
    if (started == null) return null

    // SEAM (U12a): hand `started` (a spawned, gated server past its import) to the V2 execution loop here, and return
    // its result instead of failing. Until then the server is stopped cleanly and the run fails closed.
    await shutdownV2Server(started.serverHandle, bootstrap.logger)
    core.setFailed(V2_EXECUTION_UNSUPPORTED_MESSAGE)
    return null
  }

  const serverLogger = createLogger({phase: 'server-bootstrap'})
  const abortController = new AbortController()
  // Normalized to match what the harness's own session-scoped calls use
  // (session-prep.ts, cleanup.ts) -- the probe must warm the same instance the harness
  // will actually address, or a divergence here silently defeats the readiness check.
  const bootstrapResult = await bootstrapOpenCodeServer(
    abortController.signal,
    serverLogger,
    normalizeWorkspacePath(workspacePath),
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

async function startV2Server(
  bootstrap: BootstrapPhaseResult,
  workspacePath: string,
  storagePath: string,
  cacheResult: CacheResult,
  cacheStatus: 'corrupted' | 'hit' | 'miss',
): Promise<CacheRestoreV2PhaseResult | null> {
  const serverLogger = createLogger({phase: 'server-bootstrap'})
  const {inputs, opencodeResult} = bootstrap
  const started = await startActionOpenCodeV2({
    binaryPath: opencodeResult.path,
    // Normalized to match what the harness's own session-scoped calls use: the gates and every later request address
    // the same location the spawn was given.
    workspacePath: normalizeWorkspacePath(workspacePath),
    authJson: inputs.authJson,
    opencodeConfig: inputs.opencodeConfig,
    systematicVersion: inputs.systematicVersion,
    model: inputs.model == null ? null : `${inputs.model.providerID}/${inputs.model.modelID}`,
    dbPath: path.join(path.dirname(storagePath), DB_V2_MAIN_BASENAME),
    authPath: getOpenCodeAuthPath(),
    env: process.env,
    runId: getGitHubRunId(),
    runAttempt: getGitHubRunAttempt(),
    logger: serverLogger,
    maskSecret: value => core.setSecret(value),
  })

  if (!started.success) {
    core.setFailed(`OpenCode V2 start failed (${started.error.stage}): ${started.error.message}`)
    return null
  }
  serverLogger.info('OpenCode V2 server started and gated')
  return {cacheResult, cacheStatus, serverHandle: started.data}
}

async function shutdownV2Server(handle: OpenCodeV2ServerHandle, logger: BootstrapPhaseResult['logger']): Promise<void> {
  try {
    const result = await handle.shutdown()
    if (result.exit.outcome === 'unconfirmed') {
      logger.error('OpenCode V2 server exit could not be confirmed')
    }
  } catch (error) {
    logger.error('OpenCode V2 server shutdown failed', {error: error instanceof Error ? error.message : String(error)})
  }
}
