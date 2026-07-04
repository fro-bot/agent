/**
 * Startup stale-run recovery.
 *
 * On gateway boot, scans every bound repo for runs that were left in a
 * non-terminal active phase (EXECUTING, PENDING, or ACKNOWLEDGED) by a prior
 * crash or shutdown. EXECUTING runs hold a lock+lease; PENDING and ACKNOWLEDGED
 * runs can be stranded when a crash or shutdown occurs after admission but
 * before the run reaches EXECUTING.
 *
 * For each stranded run the sweep:
 *  1. Transitions the run state to FAILED.
 *  2. Releases the repo lock — only for EXECUTING runs (PENDING and ACKNOWLEDGED
 *     runs have not yet acquired the lock, so no release is needed).
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
import {
  findStaleRuns,
  forceReleaseStaleLock,
  getLockKey,
  getRunKey,
  parseRunState,
  releaseLock,
  transitionRun,
} from '@fro-bot/runtime'

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

interface LockFetchResult {
  readonly etag: string
  readonly runId: string | null
}

/**
 * Fetch the current lock object and parse the `run_id` from its content.
 *
 * Returns `null` when the adapter does not support `getObject`, the key does
 * not exist, or any other fetch error occurs. Returns a result with
 * `runId: null` when the content cannot be parsed or lacks a `run_id` field.
 */
async function fetchLockRecord(
  config: CoordinationConfig,
  key: string,
  logger: GatewayLogger,
): Promise<LockFetchResult | null> {
  if (config.storeAdapter.getObject == null) {
    logger.warn({key}, 'recovery: store adapter does not support getObject — cannot verify lock ownership')
    return null
  }

  const result = await config.storeAdapter.getObject(key)
  if (result.success === false) {
    logger.warn({key, err: result.error.message}, 'recovery: getObject failed — cannot verify lock ownership')
    return null
  }

  const {etag, data: rawJson} = result.data

  let runId: string | null = null
  try {
    const parsed: unknown = JSON.parse(rawJson)
    if (parsed !== null && typeof parsed === 'object' && 'run_id' in parsed && typeof parsed.run_id === 'string') {
      runId = parsed.run_id
    }
  } catch {
    // Unparseable lock content — treat run_id as unknown.
  }

  return {etag, runId}
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
    if (staleRuns.length > 0) {
      logger.info({repo, count: staleRuns.length}, 'recovery: found stale runs')

      for (const run of staleRuns) {
        await recoverOneRun({run, repo, coordinationConfig, identity, resolveThread, coordLogger, logger})
      }
    }

    // A crash between committing the CANCELLED transition and releasing the repo
    // lock is invisible to findStaleRuns (its phase filter only matches
    // EXECUTING/PENDING/ACKNOWLEDGED — CANCELLED is terminal and intentionally
    // skipped there). Reconcile separately: if the repo's lock is still held by
    // a run whose committed state is CANCELLED, release it. The run itself is
    // already terminal and must NOT be re-transitioned.
    await reconcileCancelledLock({repo, coordinationConfig, identity, coordLogger, logger})
  }

  logger.info({}, 'recovery: stale-run sweep complete')
}

// ---------------------------------------------------------------------------
// Cancelled-run lock reconciliation
// ---------------------------------------------------------------------------

interface ReconcileCancelledLockOpts {
  readonly repo: string
  readonly coordinationConfig: CoordinationConfig
  readonly identity: string
  readonly coordLogger: {debug: (message: string, context?: Record<string, unknown>) => void}
  readonly logger: GatewayLogger
}

/**
 * Release a repo's lock when it is still held by a run whose committed
 * run-state phase is CANCELLED.
 *
 * The run itself is terminal and is never re-transitioned — only the lock is
 * reconciled. Release goes through `forceReleaseStaleLock`, which independently
 * re-verifies both dead-run signals (lease + heartbeat staleness) and performs
 * an `IfMatch`-conditional delete, so a newer run that re-acquired the lock
 * after this one's lease expired is never clobbered.
 *
 * No-ops (logged at debug) when: no lock exists, the lock belongs to a
 * different run_id, the owning run-state cannot be read, or the owning run's
 * phase is not CANCELLED. Any error is logged and swallowed — one repo's
 * failure must not block the rest of the startup sweep.
 */
async function reconcileCancelledLock(opts: ReconcileCancelledLockOpts): Promise<void> {
  const {repo, coordinationConfig, identity, coordLogger, logger} = opts

  const lockKeyResult = getLockKey(coordinationConfig, repo)
  if (lockKeyResult.success === false) {
    logger.warn(
      {repo, err: lockKeyResult.error.message},
      'recovery: could not build lock key — skipping cancelled-lock reconciliation',
    )
    return
  }

  const lockFetch = await fetchLockRecord(coordinationConfig, lockKeyResult.data, logger)
  if (lockFetch === null || lockFetch.runId === null) {
    // No lock, or lock content unreadable/lacks run_id — nothing to reconcile.
    return
  }

  const runKeyResult = getRunKey(coordinationConfig, identity, repo, lockFetch.runId)
  if (runKeyResult.success === false) {
    logger.warn(
      {repo, runId: lockFetch.runId, err: runKeyResult.error.message},
      'recovery: could not build run key — skipping cancelled-lock reconciliation',
    )
    return
  }

  if (coordinationConfig.storeAdapter.getObject == null) {
    logger.warn({repo}, 'recovery: store adapter does not support getObject — skipping cancelled-lock reconciliation')
    return
  }

  const runResult = await coordinationConfig.storeAdapter.getObject(runKeyResult.data)
  if (runResult.success === false) {
    // Absent or unreadable run-state for the lock's run_id — not this reconciliation's
    // concern (forceReleaseStaleLock's own dead-run check handles absence separately).
    return
  }

  const parsedRun = parseRunState(runResult.data.data)
  if (parsedRun.success === false || parsedRun.data.phase !== 'CANCELLED') {
    // Only CANCELLED-held locks are in scope for this pass — live/other-terminal
    // runs are left alone (EXECUTING is handled by the stale-run sweep above;
    // COMPLETED/FAILED runs release their own lock before reaching that phase).
    return
  }

  const releaseResult = await forceReleaseStaleLock(coordinationConfig, repo, identity, coordLogger)
  if (releaseResult.success === false) {
    logger.warn(
      {repo, runId: lockFetch.runId, err: releaseResult.error.message},
      'recovery: forceReleaseStaleLock errored while reconciling cancelled-run lock — continuing',
    )
    return
  }

  const outcome = releaseResult.data
  if (outcome.outcome === 'released') {
    logger.info(
      {repo, runId: lockFetch.runId},
      'recovery: released repo lock stranded by a crash between CANCELLED commit and lock release',
    )
  } else if (outcome.outcome === 'live-holder' || outcome.outcome === 'conflict') {
    logger.info(
      {repo, runId: lockFetch.runId, outcome: outcome.outcome},
      'recovery: cancelled-lock reconciliation skipped release — lock is live or was re-acquired by a newer run',
    )
  } else {
    logger.debug(
      {repo, runId: lockFetch.runId, outcome: outcome.outcome},
      'recovery: cancelled-lock reconciliation outcome',
    )
  }
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

  const runKeyResult = getRunKey(coordinationConfig, identity, repo, run.run_id)

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

  // ── 2. Release the repo lock (EXECUTING only) ───────────────────────────
  //
  // Only EXECUTING runs hold the repo lock. PENDING and ACKNOWLEDGED runs have
  // not yet reached the lock-acquisition step, so attempting a lock release for
  // them would be incorrect (and could release a lock held by a different run).

  if (run.phase === 'EXECUTING') {
    const lockKeyResult = getLockKey(coordinationConfig, repo)

    if (lockKeyResult.success === false) {
      logger.warn({runId: run.run_id, repo, err: lockKeyResult.error.message}, 'recovery: could not build lock key')
    } else {
      const lockFetch = await fetchLockRecord(coordinationConfig, lockKeyResult.data, logger)

      if (lockFetch !== null) {
        // Only release the lock when it belongs to this stale run. If another run
        // acquired the lock after the stale run's lease expired, releasing here would
        // delete an active run's lock and allow concurrent execution.
        if (lockFetch.runId === run.run_id) {
          const releaseResult = await releaseLock(coordinationConfig, repo, lockFetch.etag, coordLogger)

          if (releaseResult.success === false) {
            logger.warn(
              {runId: run.run_id, repo, err: releaseResult.error.message},
              'recovery: releaseLock failed — continuing',
            )
          } else {
            logger.info({runId: run.run_id, repo}, 'recovery: lock released')
          }
        } else {
          logger.warn(
            {runId: run.run_id, repo, lockRunId: lockFetch.runId},
            'recovery: lock.run_id does not match stale run — skipping release (lock belongs to a different run)',
          )
        }
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
