import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {CacheResult} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {bootstrapOpenCodeServer} from '../../features/agent/index.js'
import {buildCacheKeyComponents, restoreCache} from '../../services/cache/index.js'
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

  const cacheResult = await restoreCache({
    components: cacheComponents,
    logger: cacheLogger,
    storagePath: getOpenCodeStoragePath(),
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

  const serverLogger = createLogger({phase: 'server-bootstrap'})
  const abortController = new AbortController()
  const bootstrapResult = await bootstrapOpenCodeServer(abortController.signal, serverLogger)

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
