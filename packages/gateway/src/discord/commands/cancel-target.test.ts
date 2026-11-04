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

function makeDeps(runs: readonly RunState[], binding: typeof BINDING | null = BINDING): CancelTargetDeps {
  return {
    bindingsStore: {
      getBindingByChannelId: vi.fn().mockImplementation(async (channelId: string) => ({
        success: true,
        data: binding !== null && channelId === binding.channelId ? binding : null,
      })),
    },
    runIndex: {listRunsForRepo: vi.fn().mockResolvedValue(runs)},
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
    expect(deps.runIndex.listRunsForRepo).toHaveBeenCalledWith('acme/widget')
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
    const deps = makeDeps([makeRun()], null)

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
    const deps: CancelTargetDeps = {
      bindingsStore: {
        getBindingByChannelId: vi.fn().mockResolvedValue({success: false, error: new Error('s3 down')}),
      },
      runIndex: {listRunsForRepo: vi.fn()},
    }

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'lookup-failed'})
    expect(deps.runIndex.listRunsForRepo).not.toHaveBeenCalled()
  })

  it('fails closed when the run scan throws', async () => {
    // #given
    const deps = makeDeps([])
    vi.mocked(deps.runIndex.listRunsForRepo).mockRejectedValue(new Error('scan failed'))

    // #when
    const target = await resolveCancelTarget({channelId: 'ch-bound', parentId: null}, deps)

    // #then
    expect(target).toEqual({kind: 'refused', reason: 'lookup-failed'})
  })
})
