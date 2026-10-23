import {beforeEach, describe, expect, it, vi} from 'vitest'

import {awaitLaunchWorkRun, makeDeps, makeInMemoryRequest, mockRunOpenCodeCore, setupHappyPath} from './test-helpers.js'

// ---------------------------------------------------------------------------
// #1889 — the run id must reach the execution core, whose termination barrier stamps it on every
// settle-owned-sessions log line. Without it, an abort/quarantine log cannot be joined to a run.
// ---------------------------------------------------------------------------

describe('run id hand-off to the execution core', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes the admitted run id to runOpenCodeCore', async () => {
    // #given
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const request = makeInMemoryRequest()
    const deps = makeDeps()

    // #when
    const admission = await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    const runId = admission.accepted === true ? admission.runId : undefined
    expect(runId).toBeDefined()
    expect(mockRunOpenCodeCore).toHaveBeenCalledWith(expect.objectContaining({runId}))
  })
})
