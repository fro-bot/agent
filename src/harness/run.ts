import type {ObjectStoreConfig} from '@fro-bot/runtime'
import type {OpenCodeServerHandle} from '../features/agent/index.js'
import type {ReactionContext} from '../features/agent/types.js'
import type {AttachmentResult} from '../features/attachments/index.js'
import type {Octokit} from '../services/github/types.js'
import * as core from '@actions/core'
import {createMetricsCollector} from '../features/observability/index.js'
import {createLogger} from '../shared/logger.js'
import {setActionOutputs} from './config/outputs.js'
import {STATE_KEYS} from './config/state-keys.js'
import {runAcknowledge} from './phases/acknowledge.js'
import {runBootstrap} from './phases/bootstrap.js'
import {runCacheRestore} from './phases/cache-restore.js'
import {runCleanup} from './phases/cleanup.js'
import {runDedup, saveDedupMarker} from './phases/dedup.js'
import {runExecute} from './phases/execute.js'
import {runFinalize} from './phases/finalize.js'
import {runRouting} from './phases/routing.js'
import {runSessionPrep} from './phases/session-prep.js'

export async function run(): Promise<number> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: 'bootstrap'})
  const metrics = createMetricsCollector()
  metrics.start()

  let reactionCtx: ReactionContext | null = null
  let agentSuccess = false
  let exitCode = 0
  let githubClient: Octokit | null = null
  let attachmentResult: AttachmentResult | null = null
  let detectedOpencodeVersion: string | null = null
  let serverHandle: OpenCodeServerHandle | null = null
  let repo = ''
  let runId = ''
  let storeConfig: ObjectStoreConfig = {
    enabled: false,
    bucket: '',
    region: '',
    prefix: '',
  }

  core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
  core.saveState(STATE_KEYS.CACHE_SAVED, 'false')

  try {
    bootstrapLogger.info('Starting Fro Bot Agent')

    const bootstrap = await runBootstrap(bootstrapLogger)
    if (bootstrap == null) {
      setActionOutputs({
        sessionId: null,
        resolvedOutputMode: null,
        cacheStatus: 'miss',
        duration: Date.now() - startTime,
      })
      return 1
    }
    detectedOpencodeVersion = bootstrap.opencodeResult.version
    storeConfig = bootstrap.inputs.storeConfig

    const routing = await runRouting(bootstrap, startTime)
    if (routing == null) return 0
    githubClient = routing.githubClient

    repo = `${routing.triggerResult.context.repo.owner}/${routing.triggerResult.context.repo.repo}`
    runId = routing.agentContext.runId
    const dedup = await runDedup(bootstrap.inputs.dedupWindow, routing.triggerResult.context, repo, startTime)
    if (!dedup.shouldProceed) return 0

    reactionCtx = await runAcknowledge(routing, bootstrap.logger)

    const cacheRestore = await runCacheRestore(bootstrap, metrics)
    if (cacheRestore == null) return 1
    serverHandle = cacheRestore.serverHandle

    const sessionPrep = await runSessionPrep(bootstrap, routing, cacheRestore, metrics)
    attachmentResult = sessionPrep.attachmentResult

    const execution = await runExecute(bootstrap, routing, cacheRestore, sessionPrep, metrics, startTime)
    agentSuccess = execution.success

    if (agentSuccess && dedup.entity != null) {
      await saveDedupMarker(routing.triggerResult.context, dedup.entity, repo)
    }

    metrics.end()
    exitCode = await runFinalize(bootstrap, routing, cacheRestore, execution, metrics, startTime, bootstrap.logger)
  } catch (error) {
    exitCode = 1
    const duration = Date.now() - startTime
    const errorName = error instanceof Error ? error.name : 'UnknownError'
    const errorMessage = error instanceof Error ? error.message : String(error)

    metrics.recordError(errorName, errorMessage, false)
    metrics.end()

    setActionOutputs({
      sessionId: null,
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      duration,
    })

    if (error instanceof Error) {
      bootstrapLogger.error('Agent failed', {error: error.message})
      core.setFailed(error.message)
    } else {
      bootstrapLogger.error('Agent failed with unknown error')
      core.setFailed('An unknown error occurred')
    }
  } finally {
    await runCleanup({
      bootstrapLogger,
      reactionCtx,
      githubClient,
      agentSuccess,
      attachmentResult,
      serverHandle,
      detectedOpencodeVersion,
      storeConfig,
      metrics,
      agentIdentity: 'github',
      repo,
      runId,
    })
  }

  return exitCode
}
