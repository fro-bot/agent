/**
 * Startup stale-run recovery.
 *
 * On gateway boot, scans every bound repo for execution runs that were left
 * in the EXECUTING phase by a prior crash (the only phase that can be stranded
 * with a held lock+lease, since PENDING→ACKNOWLEDGED→EXECUTING all complete
 * within a synchronous setup block before any interruptible await).
 *
 * For each stranded run the sweep:
 *  1. Transitions the run state to FAILED.
 *  2. Releases the repo lock (frees the next mention to proceed).
 *  3. Posts a brief "previous task interrupted" note to the original thread
 *     (best-effort — skipped if the thread cannot be resolved).
 *
 * Any per-run error is logged and the sweep continues — one corrupted record
 * must not block recovery for the rest.
 */

import type {CoordinationConfig} from '@fro-bot/runtime'

import type {BindingsStore} from '../bindings/store.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import {buildObjectStoreKey, findStaleRuns, releaseLock, transitionRun} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RecoverStaleRunsDeps {
  /** Coordination config (provides store adapter, store config, stale threshold). */
  readonly coordinationConfig: CoordinationConfig
  /** Gateway identity — must match the identity used when runs were created. */
  readonly identity: string
  /** Bindings store used to enumerate all repos to scan. */
  readonly bindingsStore: BindingsStore
  /**
   * Resolve a Discord thread by its ID.
   *
   * Returns the thread if reachable, or `null` if not. Called once per stale
   * run to post a brief interruption note; a `null` return simply skips the
   * note without failing the recovery sweep.
   */
  readonly resolveThread: (threadId: string) => Promise<SinkThread | null>
  readonly logger: GatewayLogger
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Lock identity constant — matches the hardcoded value in coordination/lock.ts */
const COORDINATION_IDENTITY = 'coordination'

/** Narrow logger adapter for runtime coordination functions. */
function toCoordLogger(logger: GatewayLogger): {debug: (message: string, context?: Record<string, unknown>) => void} {
  return {
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
  }
}

/**
 * Resolve the current object-store etag for a given key.
 *
 * Returns `null` when the adapter does not expose `getObject`, the key does
 * not exist, or any other error occurs — all of which are logged.
 */
async function resolveEtag(
  config: CoordinationConfig,
  key: string,
  label: string,
  logger: GatewayLogger,
): Promise<string | null> {
  if (config.storeAdapter.getObject == null) {
    logger.warn({key, label}, 'recovery: store adapter does not support getObject — cannot resolve etag')
    return null
  }

  const result = await config.storeAdapter.getObject(key)
  if (result.success === false) {
    logger.warn({key, label, err: result.error.message}, 'recovery: getObject failed — cannot resolve etag')
    return null
  }

  return result.data.etag
}

// ---------------------------------------------------------------------------
// recoverStaleRuns
// ---------------------------------------------------------------------------

/**
 * Sweep all bound repos for stale EXECUTING runs and recover them on startup.
 *
 * Should be called once after the Discord client login completes and before
 * the gateway begins handling new mentions.
 */
export async function recoverStaleRuns(deps: RecoverStaleRunsDeps): Promise<void> {
  const {coordinationConfig, identity, bindingsStore, resolveThread, logger} = deps
  const coordLogger = toCoordLogger(logger)

  // Enumerate all repos that have bindings
  const bindingsResult = await bindingsStore.listBindings()
  if (bindingsResult.success === false) {
    logger.error({err: bindingsResult.error.message}, 'recovery: listBindings failed — skipping stale-run sweep')
    return
  }

  const bindings = bindingsResult.data
  if (bindings.length === 0) {
    logger.info({}, 'recovery: no bindings found — stale-run sweep is a no-op')
    return
  }

  logger.info({repoCount: bindings.length}, 'recovery: scanning repos for stale runs')

  for (const binding of bindings) {
    const repo = `${binding.owner}/${binding.repo}`

    const staleResult = await findStaleRuns(coordinationConfig, identity, repo, coordLogger)
    if (staleResult.success === false) {
      logger.warn({repo, err: staleResult.error.message}, 'recovery: findStaleRuns failed — skipping repo')
      continue
    }

    const staleRuns = staleResult.data
    if (staleRuns.length === 0) {
      continue
    }

    logger.info({repo, count: staleRuns.length}, 'recovery: found stale runs')

    for (const run of staleRuns) {
      await recoverOneRun({run, repo, coordinationConfig, identity, resolveThread, coordLogger, logger})
    }
  }

  logger.info({}, 'recovery: stale-run sweep complete')
}

// ---------------------------------------------------------------------------
// Per-run recovery helper
// ---------------------------------------------------------------------------

interface RecoverOneRunOpts {
  readonly run: {
    readonly run_id: string
    readonly thread_id: string
    readonly phase: string
    readonly entity_ref: string
  }
  readonly repo: string
  readonly coordinationConfig: CoordinationConfig
  readonly identity: string
  readonly resolveThread: (threadId: string) => Promise<SinkThread | null>
  readonly coordLogger: {debug: (message: string, context?: Record<string, unknown>) => void}
  readonly logger: GatewayLogger
}

async function recoverOneRun(opts: RecoverOneRunOpts): Promise<void> {
  const {run, repo, coordinationConfig, identity, resolveThread, coordLogger, logger} = opts

  logger.info({runId: run.run_id, repo, threadId: run.thread_id}, 'recovery: recovering stale run')

  // ── 1. Transition run state to FAILED ───────────────────────────────────

  const runKeyResult = buildObjectStoreKey(coordinationConfig.storeConfig, identity, repo, 'runs', `${run.run_id}.json`)

  if (runKeyResult.success === false) {
    logger.warn(
      {runId: run.run_id, repo, err: runKeyResult.error.message},
      'recovery: could not build run key — skipping',
    )
    return
  }

  const runEtag = await resolveEtag(coordinationConfig, runKeyResult.data, 'run', logger)

  if (runEtag !== null) {
    const transitionResult = await transitionRun(
      coordinationConfig,
      identity,
      repo,
      run.run_id,
      'FAILED',
      runEtag,
      coordLogger,
    )

    if (transitionResult.success === false) {
      logger.warn(
        {runId: run.run_id, repo, err: transitionResult.error.message},
        'recovery: transitionRun FAILED — continuing',
      )
    } else {
      logger.info({runId: run.run_id, repo}, 'recovery: run transitioned to FAILED')
    }
  }

  // ── 2. Release the repo lock ─────────────────────────────────────────────

  const lockKeyResult = buildObjectStoreKey(
    coordinationConfig.storeConfig,
    COORDINATION_IDENTITY,
    repo,
    'locks',
    'repo.json',
  )

  if (lockKeyResult.success === false) {
    logger.warn({runId: run.run_id, repo, err: lockKeyResult.error.message}, 'recovery: could not build lock key')
  } else {
    const lockEtag = await resolveEtag(coordinationConfig, lockKeyResult.data, 'lock', logger)

    if (lockEtag !== null) {
      const releaseResult = await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)

      if (releaseResult.success === false) {
        logger.warn(
          {runId: run.run_id, repo, err: releaseResult.error.message},
          'recovery: releaseLock failed — continuing',
        )
      } else {
        logger.info({runId: run.run_id, repo}, 'recovery: lock released')
      }
    }
  }

  // ── 3. Best-effort thread note ───────────────────────────────────────────

  try {
    const thread = await resolveThread(run.thread_id)
    if (thread === null) {
      logger.info({runId: run.run_id, threadId: run.thread_id}, 'recovery: thread not resolved — skipping note')
    } else {
      await thread.send({
        content: 'The previous task was interrupted when the service restarted. Please re-send your request.',
        allowedMentions: {parse: []},
      })
      logger.info({runId: run.run_id, threadId: run.thread_id}, 'recovery: interruption note posted')
    }
  } catch (error: unknown) {
    logger.warn(
      {runId: run.run_id, threadId: run.thread_id, err: error instanceof Error ? error.message : String(error)},
      'recovery: failed to post thread note — continuing',
    )
  }
}
