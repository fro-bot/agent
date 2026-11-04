/**
 * Tests for the `/fro-bot cancel` target resolver.
 *
 * The resolver decides, server-side, which single run a Discord invocation may cancel. Everything it refuses is
 * covered here; the command's reply copy lives in `cancel.test.ts`.
 */

import type {RunPhase, RunState} from '@fro-bot/runtime'
import type {CancelTargetDeps} from './cancel-target.js'

import {describe, expect, it, vi} from 'vitest'

import {resolveCancelTarget} from './cancel-target.js'

const BINDING = {owner: 'acme', repo: 'widget', channelId: 'ch-bound'}

function makeRun(overrides: Partial<RunState> & {readonly channelId?: string} = {}): RunState {
  const {channelId = 'ch-bound', ...rest} = overrides
  return {
    run_id: 'run-1',
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: 'acme/widget',
    phase: 'EXECUTING',
    started_at: '2026-07-03T00:00:00.000Z',
    last_heartbeat: '2026-07-03T00:00:00.000Z',
    holder_id: 'discord-gateway',
    details: {channelId},
    ...rest,
  }
}

interface DepsOptions {
  readonly binding?: typeof BINDING | null
  /** What the capped run-index scan returns. Defaults to `runs` (a repo with fewer records than the cap). */
  readonly scan?: readonly RunState[]
  /** Which runs this process still runs. Defaults to the runs past the queue, as `run.ts` marks them. */
  readonly live?: readonly RunState[]
}

/** Runs the process holds live: past the queue and not yet ended. Queued (PENDING) and terminal runs are not. */
function liveByDefault(runs: readonly RunState[]): readonly RunState[] {
  return runs.filter(run => run.phase === 'ACKNOWLEDGED' || run.phase === 'EXECUTING')
}

function makeDeps(runs: readonly RunState[], options: DepsOptions = {}): CancelTargetDeps {
  const binding = options.binding === undefined ? BINDING : options.binding
  const live = options.live ?? liveByDefault(runs)
  return {
    bindingsStore: {
      getBindingByChannelId: vi.fn().mockImplementation(async (channelId: string) => ({
        success: true,
        data: binding !== null && channelId === binding.channelId ? binding : null,
      })),
    },
    runIndex: {
      listRunsForRepo: vi.fn().mockResolvedValue(options.scan ?? runs),
      readRun: vi.fn().mockImplementation(async (_repo: string, runId: string) => runs.find(r => r.run_id === runId)),
    },
    listLiveRuns: vi.fn().mockReturnValue(live.map(run => ({runId: run.run_id, repo: 'acme/widget'}))),
  }
}

describe('resolveCancelTarget — bound channel', () => {
  it('targets the single executing run of the channel', async () => {
    // #given
    const deps = makeDeps([makeRun()])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'run', runId: 'run-1', repo: 'acme/widget'})
  })

  it('targets an executing run even when the capped run scan no longer lists it', async () => {
    // #given — the repo has more than 200 newer records, so the newest-200 scan misses the long-running run
    const deps = makeDeps([makeRun()], {scan: []})

    // #when
    const fromChannel = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)
    const fromThread = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then — the live set is the source, so the scan cannot hide it
    expect(fromChannel).toEqual({kind: 'run', runId: 'run-1', repo: 'acme/widget'})
    expect(fromThread).toEqual({kind: 'run', runId: 'run-1', repo: 'acme/widget'})
  })

  it('does not trust a failed scan to say "nothing is executing": a live run is found regardless', async () => {
    // #given — the scan rejects outright
    const deps = makeDeps([makeRun()])
    vi.mocked(deps.runIndex.listRunsForRepo).mockRejectedValue(new Error('s3 down'))

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'run', runId: 'run-1', repo: 'acme/widget'})
  })

  it('ignores live runs of other repos without reading them', async () => {
    // #given — one live run belongs to another repo
    const deps = makeDeps([makeRun()])
    vi.mocked(deps.listLiveRuns).mockReturnValue([
      {runId: 'run-elsewhere', repo: 'acme/other'},
      {runId: 'run-1', repo: 'acme/widget'},
    ])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toMatchObject({kind: 'run', runId: 'run-1'})
    expect(deps.runIndex.readRun).toHaveBeenCalledTimes(1)
    expect(deps.runIndex.readRun).toHaveBeenCalledWith('acme/widget', 'run-1')
  })

  it.each<[RunPhase]>([['ACKNOWLEDGED'], ['EXECUTING']])('treats a %s run as executing', async phase => {
    // #given
    const deps = makeDeps([makeRun({phase})])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toMatchObject({kind: 'run', runId: 'run-1'})
  })

  it('leaves queued (PENDING) runs alone — there is no executing run to cancel', async () => {
    // #given — only a queued run
    const deps = makeDeps([makeRun({phase: 'PENDING', thread_id: ''})])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'no-executing-run'})
  })

  it('picks the executing run, not a queued sibling, when both exist', async () => {
    // #given
    const deps = makeDeps([
      makeRun({run_id: 'run-queued', phase: 'PENDING', thread_id: ''}),
      makeRun({run_id: 'run-live', phase: 'EXECUTING', thread_id: 'thread-live'}),
    ])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toMatchObject({kind: 'run', runId: 'run-live'})
  })

  it('refuses when only terminal runs exist', async () => {
    // #given
    const deps = makeDeps([makeRun({phase: 'COMPLETED'}), makeRun({run_id: 'run-2', phase: 'CANCELLED'})])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'no-executing-run'})
  })

  it('never reaches a dashboard-launched run (web channel scope, web surface)', async () => {
    // #given — an executing run launched from the dashboard for the same repo
    const dashboardRun = makeRun({
      run_id: 'run-web',
      surface: 'web',
      thread_id: '',
      channelId: 'web:acme/widget',
    })
    const deps = makeDeps([dashboardRun])

    // #when — from the bound channel and from a thread whose id the web run could never have
    const fromChannel = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)
    const fromThread = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then
    expect(fromChannel).toEqual({kind: 'refused', reason: 'no-executing-run'})
    expect(fromThread).toEqual({kind: 'refused', reason: 'not-a-run-thread'})
  })

  it('never reaches a web-surface run even when its details claim this channel', async () => {
    // #given — defense in depth: the surface check does not depend on the channel string
    const deps = makeDeps([makeRun({surface: 'web'})])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'no-executing-run'})
  })

  it('refuses a run that belongs to another channel of the same repo', async () => {
    // #given
    const deps = makeDeps([makeRun({channelId: 'ch-other'})])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'no-executing-run'})
  })

  it('refuses rather than guess when two runs look executing', async () => {
    // #given — e.g. a stranded record awaiting recovery plus a live run
    const deps = makeDeps([makeRun({run_id: 'run-a'}), makeRun({run_id: 'run-b', thread_id: 'thread-b'})])

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'ambiguous'})
  })

  it('refuses an unbound channel without scanning runs', async () => {
    // #given
    const deps = makeDeps([makeRun()], {binding: null})

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-unbound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'unbound-channel'})
    expect(deps.runIndex.listRunsForRepo).not.toHaveBeenCalled()
  })
})

describe('resolveCancelTarget — run thread', () => {
  it('resolves the thread to its run via the parent channel binding', async () => {
    // #given
    const deps = makeDeps([makeRun({run_id: 'run-other', thread_id: 'thread-2'}), makeRun()])

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then — the binding was looked up by the PARENT id, never the thread id
    expect(target).toEqual({kind: 'run', runId: 'run-1', repo: 'acme/widget'})
    expect(deps.bindingsStore.getBindingByChannelId).toHaveBeenCalledWith('ch-bound')
    expect(deps.bindingsStore.getBindingByChannelId).not.toHaveBeenCalledWith('thread-1')
  })

  it('cancels the thread run even while a sibling run is queued in the channel', async () => {
    // #given
    const deps = makeDeps([makeRun({run_id: 'run-queued', phase: 'PENDING', thread_id: ''}), makeRun()])

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then
    expect(target).toMatchObject({kind: 'run', runId: 'run-1'})
  })

  it('refuses a thread that is not a run thread', async () => {
    // #given
    const deps = makeDeps([makeRun()])

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-unrelated', parentId: 'ch-bound'}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'not-a-run-thread'})
  })

  it('refuses a thread under an unbound channel', async () => {
    // #given
    const deps = makeDeps([makeRun()])

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-unbound'}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'unbound-channel'})
  })

  it('refuses a thread whose run belongs to another channel', async () => {
    // #given — thread-1's run was admitted from ch-other, not the thread's parent
    const deps = makeDeps([makeRun({channelId: 'ch-other'})])

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'other-channel'})
  })

  it('reports a finished run thread as finished, not as missing', async () => {
    // #given
    const deps = makeDeps([makeRun({phase: 'COMPLETED'})])

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'run-finished'})
  })

  it('reports a run that is finishing (live, already terminal) as finished', async () => {
    // #given — the terminal write landed but the live set has not been cleared yet
    const run = makeRun({phase: 'COMPLETED'})
    const deps = makeDeps([run], {live: [run]})

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'run-finished'})
  })

  it('refuses a thread run still in the queue phase', async () => {
    // #given — PENDING cannot carry a thread today; the resolver still never targets it
    const deps = makeDeps([makeRun({phase: 'PENDING'})])

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'no-executing-run'})
  })
})

describe('resolveCancelTarget — lookup failures', () => {
  it('fails closed when the binding lookup returns an error result', async () => {
    // #given
    const deps = makeDeps([])
    vi.mocked(deps.bindingsStore.getBindingByChannelId).mockResolvedValue({
      success: false,
      error: new Error('s3 down'),
    } as never)

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'lookup-failed'})
    expect(deps.listLiveRuns).not.toHaveBeenCalled()
  })

  it.each([
    ['unreadable (the read returns nothing)', async () => undefined],
    ['throwing', async () => Promise.reject(new Error('read blew up'))],
  ])('fails with lookup-failed, never a silent skip, when a live run state is %s', async (_label, read) => {
    // #given — a live run in this repo whose state cannot be read, next to one that can
    const deps = makeDeps([makeRun()])
    vi.mocked(deps.listLiveRuns).mockReturnValue([
      {runId: 'run-unreadable', repo: 'acme/widget'},
      {runId: 'run-1', repo: 'acme/widget'},
    ])
    vi.mocked(deps.runIndex.readRun).mockImplementation(async (_repo, runId) =>
      runId === 'run-unreadable' ? read() : makeRun(),
    )

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then — the unreadable run might be the one the user means
    expect(target).toEqual({kind: 'refused', reason: 'lookup-failed'})
  })

  it('fails closed when a thread refusal needs the scan and the scan throws', async () => {
    // #given — nothing live matches the thread, so the scan is consulted for the reply
    const deps = makeDeps([], {scan: []})
    vi.mocked(deps.runIndex.listRunsForRepo).mockRejectedValue(new Error('scan failed'))

    // #when
    const target = await resolveCancelTarget({channelId: 'thread-1', parentId: 'ch-bound'}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'lookup-failed'})
  })
})
