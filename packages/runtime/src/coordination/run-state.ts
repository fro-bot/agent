import type {Result} from '../shared/types.js'
import type {CoordinationConfig, RunPhase, RunState} from './types.js'

import {buildObjectStoreKey} from '../object-store/key-builder.js'
import {err, ok} from '../shared/types.js'
import {requireConditionalPut, requireGetObject} from './adapter-guards.js'

const VALID_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  PENDING: ['ACKNOWLEDGED'],
  ACKNOWLEDGED: ['EXECUTING'],
  EXECUTING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
}

function getRunKey(config: CoordinationConfig, identity: string, repo: string, runId: string): Result<string, Error> {
  const key = buildObjectStoreKey(config.storeConfig, identity, repo, 'runs', `${runId}.json`)
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

function getRunPrefix(config: CoordinationConfig, identity: string, repo: string): Result<string, Error> {
  const key = buildObjectStoreKey(config.storeConfig, identity, repo, 'runs')
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

function hasValidRunStateShape(value: unknown): value is RunState {
  if (typeof value !== 'object' || value == null) {
    return false
  }

  const candidate = value as Partial<RunState>
  return (
    typeof candidate.run_id === 'string' &&
    (candidate.surface === 'github' || candidate.surface === 'discord') &&
    typeof candidate.thread_id === 'string' &&
    typeof candidate.entity_ref === 'string' &&
    (candidate.phase === 'PENDING' ||
      candidate.phase === 'ACKNOWLEDGED' ||
      candidate.phase === 'EXECUTING' ||
      candidate.phase === 'COMPLETED' ||
      candidate.phase === 'FAILED' ||
      candidate.phase === 'CANCELLED') &&
    typeof candidate.started_at === 'string' &&
    typeof candidate.last_heartbeat === 'string' &&
    typeof candidate.holder_id === 'string' &&
    typeof candidate.details === 'object' &&
    candidate.details != null &&
    Array.isArray(candidate.details) === false
  )
}

export function parseRunState(data: string): Result<RunState, Error> {
  try {
    const parsed: unknown = JSON.parse(data)
    if (hasValidRunStateShape(parsed) === false) {
      return err(new Error('Invalid run-state payload'))
    }

    return ok(parsed)
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

function requireList(config: CoordinationConfig): CoordinationConfig['storeAdapter']['list'] {
  return config.storeAdapter.list
}

function isTransitionAllowed(currentPhase: RunPhase, nextPhase: RunPhase): boolean {
  return VALID_TRANSITIONS[currentPhase].includes(nextPhase)
}

export async function createRun(
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runState: RunState,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<{etag: string}, Error>> {
  const key = getRunKey(config, identity, repo, runState.run_id)
  if (key.success === false) {
    return err(key.error)
  }

  logger.debug('Creating run-state record', {key: key.data, phase: runState.phase, repo, runId: runState.run_id})
  return requireConditionalPut(config)(key.data, JSON.stringify(runState), {ifNoneMatch: '*'})
}

export async function transitionRun(
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runId: string,
  newPhase: RunPhase,
  etag: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<{etag: string; state: RunState}, Error>> {
  const key = getRunKey(config, identity, repo, runId)
  if (key.success === false) {
    return err(key.error)
  }

  const current = await requireGetObject(config)(key.data)
  if (current.success === false) {
    return err(current.error)
  }

  if (current.data.etag !== etag) {
    return err(new Error(`optimistic concurrency failure for run ${runId}`))
  }

  const parsedCurrent = parseRunState(current.data.data)
  if (parsedCurrent.success === false) {
    return err(parsedCurrent.error)
  }

  if (isTransitionAllowed(parsedCurrent.data.phase, newPhase) === false) {
    return err(new Error(`Invalid run-state transition: ${parsedCurrent.data.phase} -> ${newPhase}`))
  }

  const nextState: RunState = {...parsedCurrent.data, phase: newPhase}
  logger.debug('Transitioning run-state', {
    key: key.data,
    from: parsedCurrent.data.phase,
    repo,
    runId,
    to: newPhase,
  })
  const writeResult = await requireConditionalPut(config)(key.data, JSON.stringify(nextState), {ifMatch: etag})
  if (writeResult.success === false) {
    return err(writeResult.error)
  }

  return ok({etag: writeResult.data.etag, state: nextState})
}

export async function findStaleRuns(
  config: CoordinationConfig,
  identity: string,
  repo: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<RunState[], Error>> {
  const prefix = getRunPrefix(config, identity, repo)
  if (prefix.success === false) {
    return err(prefix.error)
  }

  const listed = await requireList(config)(prefix.data)
  if (listed.success === false) {
    return err(listed.error)
  }

  const threshold = Date.now() - config.staleThresholdMs
  const staleRuns: RunState[] = []
  for (const key of listed.data) {
    const current = await requireGetObject(config)(key)
    if (current.success === false) {
      logger.debug('Skipping unreadable run-state file', {key, error: current.error.message})
      continue
    }

    const parsedCurrent = parseRunState(current.data.data)
    if (parsedCurrent.success === false) {
      logger.debug('Skipping malformed run-state file', {key, error: parsedCurrent.error.message})
      continue
    }

    if (parsedCurrent.data.phase !== 'EXECUTING') {
      continue
    }

    if (new Date(parsedCurrent.data.last_heartbeat).getTime() < threshold) {
      staleRuns.push(parsedCurrent.data)
    }
  }

  logger.debug('Found stale runs', {count: staleRuns.length, prefix: prefix.data, repo})
  return ok(staleRuns)
}
