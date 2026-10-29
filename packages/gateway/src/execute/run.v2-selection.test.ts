/**
 * The run picks the OpenCode V1 or V2 loop from the version the workspace reports when the gateway attaches
 * (`GET /readyz`, field `opencodeVersion`). Everything around the loop (lock, run state, heartbeat, terminal writes,
 * reply flush) is shared, so a V2 run must leave exactly the trail a V1 run leaves.
 */

/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module (it registers the vi.mock calls) */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  CHANNEL_ID,
  makeBinding,
  makeDeps,
  makeMessage,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import {attachOpencode} from './opencode-attach.js'
import {attachOpencodeV2} from './opencode-attach-v2.js'
import {runOpenCodeCoreV2} from './run-core-v2.js'
/* eslint-enable perfectionist/sort-imports */

vi.mock('./run-core-v2.js', () => ({runOpenCodeCoreV2: vi.fn().mockResolvedValue(undefined)}))
vi.mock('./opencode-attach-v2.js', () => ({attachOpencodeV2: vi.fn().mockReturnValue({kind: 'v2-client'})}))

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
  vi.mocked(runOpenCodeCoreV2).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('run: OpenCode generation selection', () => {
  it('runs the V2 loop, with a V2 client and a form directory, when the workspace reports a 2.x version', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const deps = makeDeps({readyz: readyzReporting('2.2.0')})

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(runOpenCodeCoreV2).toHaveBeenCalledOnce()
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    expect(attachOpencodeV2).toHaveBeenCalledWith('http://workspace:9200', 'secret-bearer-token')
    expect(attachOpencode).not.toHaveBeenCalled()
    const params = vi.mocked(runOpenCodeCoreV2).mock.calls[0]?.[0]
    expect(params).toMatchObject({client: {kind: 'v2-client'}, directory: '/workspace/repos/acme/widget'})
    expect(params?.runId).toBeDefined()
    expect(params?.forms).toBeDefined()
  })

  it.each([['1.19.4'], [undefined]])('keeps the V1 loop when the workspace reports %s', async version => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const deps = makeDeps({readyz: readyzReporting(version)})

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    expect(runOpenCodeCoreV2).not.toHaveBeenCalled()
    expect(attachOpencodeV2).not.toHaveBeenCalled()
  })

  it('treats a workspace whose version cannot be read as not ready, and runs neither loop', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const deps = makeDeps({readyz: readyzReporting('latest')})

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    expect(runOpenCodeCoreV2).not.toHaveBeenCalled()
    expect(mockRuntime.acquireLock).not.toHaveBeenCalled()
  })

  it('writes the same terminal run-state trail for a completed V2 run as for a V1 run', async () => {
    // #given — one V1 run, one V2 run, same mocks
    const {runMention} = await import('./run.js')
    setupHappyPath()
    await runMention(makeMessage(), makeBinding(), makeDeps({readyz: readyzReporting(undefined)}))
    const v1 = transitionPhases()
    vi.clearAllMocks()
    setupHappyPath()
    vi.mocked(runOpenCodeCoreV2).mockResolvedValue(undefined)

    // #when
    const deps = makeDeps({readyz: readyzReporting('2.2.0')})
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(transitionPhases()).toEqual(v1)
    expect(transitionPhases()).toContain('COMPLETED')
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    expect(deps.concurrency.release).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('treats a V2 loop failure like a V1 failure: terminal FAILED, lock released', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {RunCoreError} = await import('./run-core.js')
    vi.mocked(runOpenCodeCoreV2).mockRejectedValue(new RunCoreError('stream-ended', 'lost'))
    const deps = makeDeps({readyz: readyzReporting('2.2.0')})

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(transitionPhases()).toContain('FAILED')
    expect(transitionPhases()).not.toContain('COMPLETED')
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
  })
})
