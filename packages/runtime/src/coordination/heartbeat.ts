import type {Result} from '../shared/types.js'
import type {CoordinationConfig, RunState} from './types.js'

import {buildObjectStoreKey} from '../object-store/key-builder.js'
import {err, ok} from '../shared/types.js'
import {requireConditionalPut, requireGetObject, resolveGetObject} from './adapter-guards.js'
import {renewLease} from './lock.js'
import {parseRunState} from './run-state.js'

export interface HeartbeatStopResult {
  /** Current ETag of the run-state object after the final heartbeat tick. */
  readonly runEtag: string
  /** Current run state after the final heartbeat tick. */
  readonly runState: RunState
  /** Current ETag of the lock record after the most recent lease renewal. */
  readonly lockEtag: string
}

export interface HeartbeatController {
  readonly start: () => void
  /**
   * Quiesce the heartbeat timer and return an authoritative snapshot of the run state.
   *
   * `stop()` is liveness-only: it does not perform a terminal `transitionRun`. The caller
   * owns the run lifecycle and uses the returned `runEtag` to transition the run to
   * `COMPLETED`, `FAILED`, or `CANCELLED` after handling any post-shutdown work.
   *
   * If a heartbeat tick failed since the last successful tick, returns the tick error.
   * Otherwise returns the freshest snapshot fetched after in-flight ticks complete.
   */
  readonly stop: () => Promise<Result<HeartbeatStopResult, Error>>
  readonly isRunning: boolean
}

function getRunKey(config: CoordinationConfig, identity: string, repo: string, runId: string): Result<string, Error> {
  const key = buildObjectStoreKey(config.storeConfig, identity, repo, 'runs', `${runId}.json`)
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

export function createHeartbeatController(
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runId: string,
  lockEtag: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): HeartbeatController {
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let running = false
  let inFlight: Promise<void> | null = null
  let tickError: Error | null = null
  let currentLockEtag = lockEtag

  const runKey = getRunKey(config, identity, repo, runId)
  if (runKey.success === false) {
    throw runKey.error
  }

  const writeHeartbeat = async (): Promise<void> => {
    const current = await requireGetObject(config)(runKey.data)
    if (current.success === false) {
      throw current.error
    }

    const parsedCurrent = parseRunState(current.data.data)
    if (parsedCurrent.success === false) {
      throw parsedCurrent.error
    }

    const nextState: RunState = {...parsedCurrent.data, last_heartbeat: new Date().toISOString()}

    // Renew lock lease BEFORE writing heartbeat — if renewal fails, the heartbeat
    // timestamp stays stale so findStaleRuns correctly flags this run. The reverse
    // order (heartbeat first, lease second) causes split-brain: run looks fresh but
    // lock TTL expires, allowing another gateway to steal the lock.
    const renewed = await renewLease(
      config,
      repo,
      {
        repo,
        holder_id: nextState.holder_id,
        surface: nextState.surface,
        acquired_at: nextState.last_heartbeat,
        ttl_seconds: config.lockTtlSeconds,
        run_id: nextState.run_id,
      },
      currentLockEtag,
      logger,
    )
    if (renewed.success === false) {
      throw renewed.error
    }

    currentLockEtag = renewed.data.etag

    const written = await requireConditionalPut(config)(runKey.data, JSON.stringify(nextState), {
      ifMatch: current.data.etag,
    })
    if (written.success === false) {
      throw written.error
    }
  }

  const runTick = (): void => {
    if (inFlight != null) {
      return
    }

    inFlight = writeHeartbeat()
      .then(() => {
        tickError = null
      })
      .catch(error => {
        tickError = error instanceof Error ? error : new Error(String(error))
      })
      .finally(() => {
        inFlight = null
      })
  }

  return {
    start: () => {
      if (running === true) {
        return
      }

      logger.debug('Starting heartbeat controller', {repo, runId})
      running = true
      intervalHandle = setInterval(runTick, config.heartbeatIntervalMs)
    },
    stop: async (): Promise<Result<HeartbeatStopResult, Error>> => {
      logger.debug('Stopping heartbeat controller', {repo, runId})
      running = false
      if (intervalHandle != null) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }

      await inFlight

      if (tickError != null) {
        return err(tickError)
      }

      const getObject = resolveGetObject(config)
      if (getObject.success === false) {
        return err(getObject.error)
      }

      const current = await getObject.data(runKey.data)
      if (current.success === false) {
        return err(current.error)
      }

      const parsedCurrent = parseRunState(current.data.data)
      if (parsedCurrent.success === false) {
        return err(parsedCurrent.error)
      }

      return ok({
        runEtag: current.data.etag,
        runState: parsedCurrent.data,
        lockEtag: currentLockEtag,
      })
    },
    get isRunning() {
      return running
    },
  }
}
