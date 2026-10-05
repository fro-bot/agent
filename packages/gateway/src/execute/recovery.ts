/**
 * Startup stale-run recovery.
 *
 * On gateway boot, scans every bound repo for runs that were left in a
 * non-terminal active phase (EXECUTING, PENDING, or ACKNOWLEDGED) by a prior
 * crash or shutdown.
 *
 * For each stranded run the sweep:
 *  1. Checks the repo's OpenCode workspace status. `busy` or `unknown` leaves the
 *     run's phase and the repo lock untouched (logged as blocked recovery) — a
 *     gateway restart is not a workspace restart, and the server may still be
 *     running work this process no longer remembers. Persisted ownership is never
 *     consulted, so missing/malformed ownership cannot bypass the check.
 *  2. Only when the workspace is `clear`, re-reads the run, re-checks staleness on that
 *     fresh record (a heartbeat during the check means it is alive — skipped), and
 *     transitions it to FAILED with a write conditioned on that read's ETag (a lost race
 *     never overwrites newer state).
 *  3. Posts a brief "previous task interrupted" note to the original thread
 *     (best-effort — skipped if the transition failed or the thread cannot be resolved).
 *
 * Startup recovery NEVER deletes the coordination lock. A lease left behind lapses by
 * TTL and is replaced by the next acquisition, which re-runs the same workspace check.
 *
 * Any per-run error is logged and the sweep continues — one corrupted record
 * must not block recovery for the rest.
 */

import type {CoordinationConfig, RunState} from '@fro-bot/runtime'

import type {BindingsStore} from '../bindings/store.js'
import type {GatewayLogger} from '../discord/client.js'
import type {SinkThread} from '../discord/streaming.js'
import type {RepoQuiescenceChecker} from './repo-quiescence.js'
import {findStaleRuns, getRunKey, isRunStale, parseRunState, transitionRun} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Upper bound for the per-run workspace check; the checker enforces its own, shorter, deadline too. */
const WORKSPACE_CHECK_DEADLINE_MS = 5_000

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
  /** Required: a stale run is only terminalized once its repo workspace is confirmed clear. */
  readonly checkRepoQuiescence: RepoQuiescenceChecker
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
 * Read the run record fresh, returning its parsed state and the etag of THAT read.
 *
 * Returns `null` when the adapter lacks `getObject`, or the read/parse fails — all logged. The caller re-checks
 * staleness on the returned state and conditions its write on the returned etag, so a heartbeat landing before this
 * read is seen (not stale → skip) and one landing after it fails the CAS.
 */
async function readFreshRun(
  config: CoordinationConfig,
  key: string,
  logger: GatewayLogger,
): Promise<{readonly state: RunState; readonly etag: string} | null> {
  if (config.storeAdapter.getObject == null) {
    logger.warn({key}, 'recovery: store adapter does not support getObject — cannot re-read run')
    return null
  }

  const result = await config.storeAdapter.getObject(key)
  if (result.success === false) {
    logger.warn({key, err: result.error.message}, 'recovery: getObject failed — cannot re-read run')
    return null
  }

  const parsed = parseRunState(result.data.data)
  if (parsed.success === false) {
    logger.warn({key, err: parsed.error.message}, 'recovery: fresh run record malformed — skipping')
    return null
  }

  return {state: parsed.data, etag: result.data.etag}
}

// ---------------------------------------------------------------------------
// recoverStaleRuns
// ---------------------------------------------------------------------------

/**
 * Sweep all bound repos for stale active runs and recover them on startup.
 *
 * Should be called once after the Discord client login completes and before
 * the gateway begins handling new mentions.
 */
export async function recoverStaleRuns(deps: RecoverStaleRunsDeps): Promise<void> {
  const {coordinationConfig, identity, bindingsStore, resolveThread, checkRepoQuiescence, logger} = deps
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

    try {
      const staleResult = await findStaleRuns(coordinationConfig, identity, repo, coordLogger)
      if (staleResult.success === false) {
        logger.warn({repo, err: staleResult.error.message}, 'recovery: findStaleRuns failed — skipping repo')
        continue
      }

      const staleRuns = staleResult.data
      if (staleRuns.length > 0) {
        logger.info({repo, count: staleRuns.length}, 'recovery: found stale runs')

        for (const run of staleRuns) {
          await recoverOneRun({
            run,
            repo,
            coordinationConfig,
            identity,
            resolveThread,
            checkRepoQuiescence,
            coordLogger,
            logger,
          })
        }
      }
    } catch (error: unknown) {
      // Fail-soft per the module docstring: an unexpected throw from either helper
      // must not abort recovery for the remaining repos.
      logger.warn(
        {repo, err: error instanceof Error ? error.message : String(error)},
        'recovery: unexpected error recovering repo — continuing to next repo',
      )
    }
  }

  logger.info({}, 'recovery: stale-run sweep complete')
}

// ---------------------------------------------------------------------------
// Per-run recovery helper
// ---------------------------------------------------------------------------

interface RecoverOneRunOpts {
  readonly run: RunState
  readonly repo: string
  readonly coordinationConfig: CoordinationConfig
  readonly identity: string
  readonly resolveThread: (threadId: string) => Promise<SinkThread | null>
  readonly checkRepoQuiescence: RepoQuiescenceChecker
  readonly coordLogger: {debug: (message: string, context?: Record<string, unknown>) => void}
  readonly logger: GatewayLogger
}

async function recoverOneRun(opts: RecoverOneRunOpts): Promise<void> {
  const {run, repo, coordinationConfig, identity, resolveThread, checkRepoQuiescence, coordLogger, logger} = opts

  logger.info({runId: run.run_id, repo, threadId: run.thread_id}, 'recovery: recovering stale run')

  // ── 1. Workspace check — gates every terminalization ────────────────────
  let quiescence: Awaited<ReturnType<RepoQuiescenceChecker>>
  try {
    quiescence = await checkRepoQuiescence({repo, signal: AbortSignal.timeout(WORKSPACE_CHECK_DEADLINE_MS)})
  } catch (error: unknown) {
    logger.warn(
      {runId: run.run_id, repo, phase: run.phase, err: error instanceof Error ? error.name : typeof error},
      'recovery: blocked — workspace check threw; run and lock left unchanged',
    )
    return
  }

  if (quiescence.kind !== 'clear') {
    logger.warn(
      {
        runId: run.run_id,
        repo,
        phase: run.phase,
        workspace: quiescence.kind,
        reason: quiescence.kind === 'unknown' ? quiescence.reason : undefined,
        busyCount: quiescence.kind === 'busy' ? quiescence.sessionIds.length : undefined,
      },
      'recovery: blocked — workspace not confirmed clear; run and lock left unchanged',
    )
    return
  }

  // ── 2. Transition run state to FAILED (ETag-conditional; never overwrites newer state) ──
  const runKeyResult = getRunKey(coordinationConfig, identity, repo, run.run_id)
  if (runKeyResult.success === false) {
    logger.warn(
      {runId: run.run_id, repo, err: runKeyResult.error.message},
      'recovery: could not build run key — skipping',
    )
    return
  }

  // The workspace check can take seconds; the run may have heartbeated meanwhile. Re-evaluate the same staleness
  // predicate on a fresh record and condition the write on that read's etag — never one fetched without looking.
  const fresh = await readFreshRun(coordinationConfig, runKeyResult.data, logger)
  if (fresh === null) return
  if (isRunStale(coordinationConfig, fresh.state) === false) {
    logger.info(
      {runId: run.run_id, repo, phase: fresh.state.phase, lastHeartbeat: fresh.state.last_heartbeat},
      'recovery: run no longer stale after workspace check — leaving it untouched',
    )
    return
  }
  const runEtag = fresh.etag

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
      'recovery: transitionRun FAILED did not apply — leaving the current record untouched',
    )
    return
  }
  logger.info({runId: run.run_id, repo}, 'recovery: run transitioned to FAILED')

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
