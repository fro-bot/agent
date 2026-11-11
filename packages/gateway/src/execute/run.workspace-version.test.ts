/**
 * The gateway runs OpenCode V2 only. A run is admitted when the workspace reports a V2 version on `GET /readyz`
 * (`opencodeVersion`, major 2 or above). A workspace that reports no version, an older one or one that cannot be read
 * is not ready: the run is failed with the existing not-ready reply, and no lock, thread or loop is started.
 */

/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module (it registers the vi.mock calls) */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  CHANNEL_ID,
  makeBinding,
  makeDeps,
  makeEnsureCloneFn,
  makeMessage,
  mockRunOpenCodeCoreV2,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import {attachOpencodeV2} from './opencode-attach-v2.js'
/* eslint-enable perfectionist/sort-imports */

function readyzReporting(version: unknown) {
  return vi.fn().mockResolvedValue({
    success: true as const,
    data: {ready: true, opencode: 'ready', ...(version === undefined ? {} : {opencodeVersion: version})},
  })
}

function transitionPhases(): string[] {
  return mockRuntime.transitionRun.mock.calls.map((call: unknown[]) => call[4] as string)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('run: workspace OpenCode version gate', () => {
  it('admits a run when the workspace reports a V2 version', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const deps = makeDeps({readyz: readyzReporting('2.2.6')})

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then the V2 loop runs with a V2 client and a form directory
    expect(mockRunOpenCodeCoreV2).toHaveBeenCalledOnce()
    expect(attachOpencodeV2).toHaveBeenCalledWith('http://workspace:9200', 'secret-bearer-token')
    const params = mockRunOpenCodeCoreV2.mock.calls[0]?.[0]
    expect(params).toMatchObject({client: {kind: 'v2-client'}, directory: '/workspace/repos/acme/widget'})
    expect(params?.runId).toBeDefined()
    expect(params?.forms).toBeDefined()
    expect(transitionPhases()).toContain('COMPLETED')
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    expect(deps.concurrency.release).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it.each([
    ['no version', undefined],
    ['a V1 harness build', '1.19.5+harness.bf7f7dfe'],
    ['a stock V1 build', '1.19.4'],
    ['a version no loop can read', 'latest'],
    ['garbage', '🦀'],
    ['a non-string value', 2],
  ])('does not admit a run when the workspace reports %s', async (_label, version) => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const ensureClone = makeEnsureCloneFn('success')
    const deps = makeDeps({readyz: readyzReporting(version), ensureClone})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then the operator sees the not-ready reply, and nothing was started
    expect(message.reply).toHaveBeenCalledOnce()
    const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(call.content).toContain('not reachable')
    expect(message.startThread).not.toHaveBeenCalled()
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()
    expect(ensureClone).not.toHaveBeenCalled()
    expect(attachOpencodeV2).not.toHaveBeenCalled()
    expect(mockRunOpenCodeCoreV2).not.toHaveBeenCalled()
    expect(deps.concurrency.release).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('treats a V2 loop failure as a terminal FAILED run with the lock released', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {RunCoreError} = await import('./run-core-shared.js')
    mockRunOpenCodeCoreV2.mockRejectedValue(new RunCoreError('stream-ended', 'lost'))
    const deps = makeDeps({readyz: readyzReporting('2.2.6')})

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(transitionPhases()).toContain('FAILED')
    expect(transitionPhases()).not.toContain('COMPLETED')
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
  })
})
