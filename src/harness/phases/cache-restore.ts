import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {bootstrapOpenCodeServer} from '../../features/agent/index.js'
import {buildCacheKeyComponents, checkpointDatabase, restoreCache} from '../../services/cache/index.js'
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

  const cacheResult = await restoreCache({
    components: cacheComponents,
    logger: cacheLogger,
    storagePath,
    authPath: getOpenCodeAuthPath(),
    projectIdPath,
    opencodeVersion: bootstrap.opencodeResult.version,
    storeConfig: bootstrap.inputs.storeConfig,
  })

  const cacheStatus: 'corrupted' | 'hit' | 'miss' = cacheResult.corrupted
    ? 'corrupted'
    : cacheResult.hit
      ? 'hit'
      : 'miss'
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
    const repairOutcome = await checkpointDatabase({
      dbPath: path.join(dbDir, DB_MAIN_BASENAME),
      walPath: path.join(dbDir, DB_WAL_BASENAME),
      logger: cacheLogger,
    })
    if (repairOutcome.status === 'checkpointed') {
      cacheLogger.info('Repaired restored database: checkpointed write-ahead log before bootstrap')
    } else if (repairOutcome.status === 'failed') {
      cacheLogger.warning('Failed to repair restored database before bootstrap', {reason: repairOutcome.reason})
    }
    // 'nothing-to-checkpoint' is the common healthy-run case and is deliberately silent.
  }

  const serverLogger = createLogger({phase: 'server-bootstrap'})
  const abortController = new AbortController()
  const bootstrapResult = await bootstrapOpenCodeServer(
    abortController.signal,
    serverLogger,
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
