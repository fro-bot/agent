/**
 * `/fro-bot cancel` target resolution.
 *
 * Decides, server-side, which single run a Discord invocation may cancel. The caller supplies only where the command
 * ran; the run id never comes from the user.
 *
 * - **Inside a run thread** (`parentId` set): the thread's own run. There is no thread → run index, so this is a
 *   bounded scan of the repo's newest runs (`listRunsForRepo`, capped by the run index) matching `thread_id`. The
 *   repo comes from the binding of the thread's PARENT channel, since a thread id never matches a binding.
 * - **In a bound channel**: the one executing run admitted from that channel.
 *
 * "Executing" is ACKNOWLEDGED or EXECUTING: past the queue, holding the channel slot. PENDING is queued work and is
 * never targeted (`/fro-bot clear-queue` owns that). Dashboard-launched runs (`surface: 'web'`, `channelId:
 * 'web:owner/repo'`) are unreachable: the surface check excludes them, and their channel string can never equal a
 * Discord id.
 */

import type {RunPhase, RunState} from '@fro-bot/runtime'
import type {BindingsStore} from '../../bindings/store.js'
import type {RunIndex} from '../../execute/run-index.js'

export interface CancelTargetDeps {
  readonly bindingsStore: Pick<BindingsStore, 'getBindingByChannelId'>
  readonly runIndex: Pick<RunIndex, 'listRunsForRepo'>
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

function resolveInThread(runs: readonly RunState[], threadId: string, parentId: string, repo: string): CancelTarget {
  const threadRuns = runs.filter(run => run.thread_id === threadId)
  if (threadRuns.length === 0) return refuse('not-a-run-thread')

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
  let runs: readonly RunState[]
  try {
    runs = await deps.runIndex.listRunsForRepo(repo)
  } catch {
    return refuse('lookup-failed')
  }

  // Discord-surface runs only: a dashboard-launched run is never reachable from here.
  const discordRuns = runs.filter(run => run.surface === 'discord')

  if (input.parentId !== null) {
    return resolveInThread(discordRuns, input.channelId, input.parentId, repo)
  }
  return pickOne(
    discordRuns.filter(run => admittedFrom(run) === input.channelId && EXECUTING_PHASES.has(run.phase)),
    repo,
    'no-executing-run',
  )
}
