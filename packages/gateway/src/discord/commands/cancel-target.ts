/**
 * `/fro-bot cancel` target resolution.
 *
 * Decides, server-side, which single run a Discord invocation may cancel. The caller supplies only where the command
 * ran; the run id never comes from the user.
 *
 * Candidates come from the in-process LIVE set (`execute/live-run-registry.ts`), not from a run-index scan: the scan
 * is capped at the newest 200 records and turns a listing failure into an empty list, so a busy repo or a storage
 * hiccup would read as "nothing is executing". Each live run of the bound repo has its state read individually (a
 * handful of runs), and an unreadable one fails the whole lookup rather than being skipped, because it might be the
 * run the user means.
 *
 * - **Inside a run thread** (`parentId` set): the live run whose `thread_id` is this thread. The binding comes from
 *   the thread's PARENT channel, since a thread id never matches a binding, and the run must have been admitted
 *   from that channel.
 * - **In a bound channel**: the one live run admitted from that channel.
 *
 * "Executing" is ACKNOWLEDGED or EXECUTING in the run's record. PENDING is queued work and is never targeted
 * (`/fro-bot clear-queue` owns that); a run is marked live slightly before its ACKNOWLEDGED write commits, so the
 * phase filter, not set membership, is what keeps a still-PENDING record out. Dashboard-launched runs (`surface:
 * 'web'`, `channelId: 'web:owner/repo'`) are unreachable: the surface check excludes them, and their channel string
 * can never equal a Discord id.
 *
 * The capped scan is consulted only to choose the refusal copy in a thread when no live run matches (finished vs
 * not a run thread vs another channel). A scan that fails by THROWING is `lookup-failed`; one that fails by returning
 * an empty list is indistinguishable from an empty repo, so that case keeps the "not a run thread" copy.
 */

import type {RunPhase, RunState} from '@fro-bot/runtime'
import type {BindingsStore} from '../../bindings/store.js'
import type {LiveRun} from '../../execute/live-run-registry.js'
import type {RunIndex} from '../../execute/run-index.js'

export interface CancelTargetDeps {
  readonly bindingsStore: Pick<BindingsStore, 'getBindingByChannelId'>
  readonly runIndex: Pick<RunIndex, 'listRunsForRepo' | 'readRun'>
  /** The runs this process still runs (`listLiveRuns`). */
  readonly listLiveRuns: () => readonly LiveRun[]
}

export interface CancelTargetInput {
  /** The channel the command ran in — the thread id when invoked inside a thread. */
  readonly channelId: string
  /** The thread's parent channel id, or `null` when the command did not run in a thread. */
  readonly parentId: string | null
}

export type CancelRefusal =
  | 'unbound-channel'
  | 'not-a-run-thread'
  | 'other-channel'
  | 'run-finished'
  | 'no-executing-run'
  | 'ambiguous'
  | 'lookup-failed'

export type CancelTarget =
  | {readonly kind: 'run'; readonly runId: string; readonly repo: string}
  | {readonly kind: 'refused'; readonly reason: CancelRefusal}

const EXECUTING_PHASES: ReadonlySet<RunPhase> = new Set(['ACKNOWLEDGED', 'EXECUTING'])
const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

function refuse(reason: CancelRefusal): CancelTarget {
  return {kind: 'refused', reason}
}

function admittedFrom(run: RunState): string | undefined {
  return typeof run.details.channelId === 'string' ? run.details.channelId : undefined
}

function pickOne(candidates: readonly RunState[], repo: string, none: CancelRefusal): CancelTarget {
  const [only, ...rest] = candidates
  if (only === undefined) return refuse(none)
  if (rest.length > 0) return refuse('ambiguous')
  return {kind: 'run', runId: only.run_id, repo}
}

/** Why a thread with no matching live run cannot be cancelled, from the (capped) run scan. */
function refusalForThread(scan: readonly RunState[], threadId: string, parentId: string): CancelRefusal {
  const threadRuns = scan.filter(run => run.surface === 'discord' && run.thread_id === threadId)
  if (threadRuns.length === 0) return 'not-a-run-thread'
  const ownRuns = threadRuns.filter(run => admittedFrom(run) === parentId)
  if (ownRuns.length === 0) return 'other-channel'
  return ownRuns.some(run => TERMINAL_PHASES.has(run.phase)) ? 'run-finished' : 'no-executing-run'
}

/** Read the state of every live run of `repo`. `undefined` when any read fails: never a partial list. */
async function readLiveRuns(repo: string, deps: CancelTargetDeps): Promise<readonly RunState[] | undefined> {
  const states: RunState[] = []
  for (const live of deps.listLiveRuns()) {
    if (live.repo !== repo) continue
    const state = await deps.runIndex.readRun(repo, live.runId).catch(() => undefined)
    if (state === undefined) return undefined
    states.push(state)
  }
  return states
}

async function resolveInThread(
  live: readonly RunState[],
  threadId: string,
  parentId: string,
  repo: string,
  deps: CancelTargetDeps,
): Promise<CancelTarget> {
  const threadRuns = live.filter(run => run.thread_id === threadId)
  if (threadRuns.length === 0) {
    // Nothing live: the run (if any) is finished or this is not a run thread. Only the scan can tell which.
    try {
      return refuse(refusalForThread(await deps.runIndex.listRunsForRepo(repo), threadId, parentId))
    } catch {
      return refuse('lookup-failed')
    }
  }

  // The thread's parent is the bound channel; the run must have been admitted from it.
  const ownRuns = threadRuns.filter(run => admittedFrom(run) === parentId)
  if (ownRuns.length === 0) return refuse('other-channel')

  const executing = ownRuns.filter(run => EXECUTING_PHASES.has(run.phase))
  if (executing.length === 0) {
    return refuse(ownRuns.some(run => TERMINAL_PHASES.has(run.phase)) ? 'run-finished' : 'no-executing-run')
  }
  return pickOne(executing, repo, 'no-executing-run')
}

export async function resolveCancelTarget(input: CancelTargetInput, deps: CancelTargetDeps): Promise<CancelTarget> {
  const scopeChannelId = input.parentId ?? input.channelId

  const bindingResult = await deps.bindingsStore.getBindingByChannelId(scopeChannelId).catch(() => null)
  if (bindingResult === null || bindingResult.success === false) return refuse('lookup-failed')
  if (bindingResult.data === null) return refuse('unbound-channel')

  const repo = `${bindingResult.data.owner}/${bindingResult.data.repo}`
  const liveStates = await readLiveRuns(repo, deps)
  if (liveStates === undefined) return refuse('lookup-failed')

  // Discord-surface runs only: a dashboard-launched run is never reachable from here.
  const live = liveStates.filter(run => run.surface === 'discord')

  if (input.parentId !== null) {
    return resolveInThread(live, input.channelId, input.parentId, repo, deps)
  }
  return pickOne(
    live.filter(run => admittedFrom(run) === input.channelId && EXECUTING_PHASES.has(run.phase)),
    repo,
    'no-executing-run',
  )
}
