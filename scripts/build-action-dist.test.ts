import {describe, expect, it, vi} from 'vitest'
import {runBuildOrchestration} from './build-action-dist.js'

// The orchestration function takes injectable step callbacks so we can test
// the ordering/exit-code contract without spawning real processes.

interface StepResult {
  exitCode: number
}

interface OrchestratorSteps {
  preflight: () => Promise<string>
  bundle: () => Promise<StepResult>
  escape: () => Promise<void>
  writeNotice: (content: string) => Promise<void>
}

describe('runBuildOrchestration — happy path', () => {
  it('runs preflight → bundle → escape → writes notice → returns 0', async () => {
    // #given all steps succeed
    const order: string[] = []

    const steps: OrchestratorSteps = {
      preflight: async () => {
        order.push('preflight')
        return 'NOTICE CONTENT'
      },
      bundle: async () => {
        order.push('bundle')
        return {exitCode: 0}
      },
      escape: async () => {
        order.push('escape')
      },
      writeNotice: async (content: string) => {
        order.push(`writeNotice:${content}`)
      },
    }

    // #when orchestration runs
    const exitCode = await runBuildOrchestration(steps)

    // #then exit code is 0 and steps ran in order
    expect(exitCode).toBe(0)
    expect(order).toEqual(['preflight', 'bundle', 'escape', 'writeNotice:NOTICE CONTENT'])
  })
})

describe('runBuildOrchestration — preflight failure', () => {
  it('exits non-zero without invoking bundle when preflight throws', async () => {
    // #given preflight throws
    const bundleCalled = vi.fn()

    const steps: OrchestratorSteps = {
      preflight: async () => {
        throw new Error('license collection failed; cannot produce THIRD_PARTY_NOTICES.txt: ENOENT')
      },
      bundle: async () => {
        bundleCalled()
        return {exitCode: 0}
      },
      escape: async () => {},
      writeNotice: async () => {},
    }

    // #when orchestration runs
    const exitCode = await runBuildOrchestration(steps)

    // #then exit code is non-zero and bundle was never called
    expect(exitCode).not.toBe(0)
    expect(bundleCalled).not.toHaveBeenCalled()
  })

  it('does not invoke writeNotice when preflight fails', async () => {
    // #given preflight throws
    const writeNoticeCalled = vi.fn()

    const steps: OrchestratorSteps = {
      preflight: async () => {
        throw new Error('preflight failed')
      },
      bundle: async () => ({exitCode: 0}),
      escape: async () => {},
      writeNotice: async () => {
        writeNoticeCalled()
      },
    }

    // #when / #then writeNotice is never called
    await runBuildOrchestration(steps)

    expect(writeNoticeCalled).not.toHaveBeenCalled()
  })

  it('does not invoke escape when preflight fails (escape is only for post-bundle partial dist)', async () => {
    // #given preflight throws before tsdown runs (no partial dist exists)
    const escapeCalled = vi.fn()

    const steps: OrchestratorSteps = {
      preflight: async () => {
        throw new Error('preflight failed')
      },
      bundle: async () => ({exitCode: 0}),
      escape: async () => {
        escapeCalled()
      },
      writeNotice: async () => {},
    }

    // #when / #then escape is never called
    await runBuildOrchestration(steps)

    expect(escapeCalled).not.toHaveBeenCalled()
  })
})

describe('runBuildOrchestration — bundle failure', () => {
  it('still runs escape after bundle fails', async () => {
    // #given bundle returns non-zero
    const escapeCalled = vi.fn()

    const steps: OrchestratorSteps = {
      preflight: async () => 'NOTICE',
      bundle: async () => ({exitCode: 2}),
      escape: async () => {
        escapeCalled()
      },
      writeNotice: async () => {},
    }

    // #when / #then escape still runs
    await runBuildOrchestration(steps)

    expect(escapeCalled).toHaveBeenCalledOnce()
  })

  it('returns the bundle non-zero exit code when bundle fails', async () => {
    // #given bundle returns exit code 2
    const steps: OrchestratorSteps = {
      preflight: async () => 'NOTICE',
      bundle: async () => ({exitCode: 2}),
      escape: async () => {},
      writeNotice: async () => {},
    }

    // #when / #then exit code matches bundle
    const exitCode = await runBuildOrchestration(steps)

    expect(exitCode).toBe(2)
  })

  it('does not write the notice when bundle fails', async () => {
    // #given bundle fails
    const writeNoticeCalled = vi.fn()

    const steps: OrchestratorSteps = {
      preflight: async () => 'NOTICE',
      bundle: async () => ({exitCode: 1}),
      escape: async () => {},
      writeNotice: async () => {
        writeNoticeCalled()
      },
    }

    // #when / #then writeNotice is never called
    await runBuildOrchestration(steps)

    expect(writeNoticeCalled).not.toHaveBeenCalled()
  })

  it('escape failure after bundle failure does not mask the bundle exit code', async () => {
    // #given bundle returns exit code 3 and escape also throws
    const steps: OrchestratorSteps = {
      preflight: async () => 'NOTICE',
      bundle: async () => ({exitCode: 3}),
      escape: async () => {
        throw new Error('escape also failed')
      },
      writeNotice: async () => {},
    }

    // #when orchestration runs
    const exitCode = await runBuildOrchestration(steps)

    // #then the exact bundle exit code is preserved (not masked by escape failure)
    expect(exitCode).toBe(3)
  })
})

describe('runBuildOrchestration — notice write failure on success', () => {
  it('returns non-zero when bundle succeeds but notice write fails', async () => {
    // #given bundle succeeds but writeNotice throws
    const steps: OrchestratorSteps = {
      preflight: async () => 'NOTICE',
      bundle: async () => ({exitCode: 0}),
      escape: async () => {},
      writeNotice: async () => {
        throw new Error('ENOSPC: no space left on device')
      },
    }

    // #when orchestration runs
    const exitCode = await runBuildOrchestration(steps)

    // #then exit code is 1 (notice write failure path returns 1)
    expect(exitCode).toBe(1)
  })
})
