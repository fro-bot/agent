import {describe, expect, it, vi} from 'vitest'
import {formatBundleFailureOutput, runBuildOrchestration} from './build-action-dist.js'

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

describe('formatBundleFailureOutput', () => {
  it('surfaces stdout diagnostics with command context (tsc writes errors to stdout, not stderr)', () => {
    // #given a child failure whose diagnostics landed on stdout with empty stderr
    const error = new Error('Command failed: bunx tsc --noEmit -p tsconfig.json')
    const stdout = 'tsdown.config.ts(60,5): error TS2769: No overload matches this call.\n'
    const stderr = ''

    // #when formatting the failure output
    const output = formatBundleFailureOutput(error, stdout, stderr)

    // #then the stdout diagnostics are surfaced with the failing command identified,
    // not swallowed behind the bare (no-diagnostics) spawn-failed message
    expect(output).toBe(
      '[build-action-dist] bundle command failed: Command failed: bunx tsc --noEmit -p tsconfig.json\n' +
        '[build-action-dist] bundle stdout:\n' +
        'tsdown.config.ts(60,5): error TS2769: No overload matches this call.\n',
    )
    expect(output).not.toContain('bundle spawn failed:')
  })

  it('reports a bare spawn-failed message when both streams are empty', () => {
    // #given a spawn error with no captured stdout/stderr
    const error = new Error('ENOENT: spawn bunx')

    // #when formatting the failure output
    const output = formatBundleFailureOutput(error, '', '')

    // #then the existing bare message is preserved
    expect(output).toBe('[build-action-dist] bundle spawn failed: ENOENT: spawn bunx\n')
  })

  it('surfaces both streams, clearly labelled, in stderr-then-stdout order, when both have content', () => {
    // #given both stdout and stderr are non-empty
    const error = new Error('Command failed')
    const stdout = 'stdout diagnostic\n'
    const stderr = 'stderr diagnostic\n'

    // #when formatting the failure output
    const output = formatBundleFailureOutput(error, stdout, stderr)

    // #then the command context is prefixed, and stderr is fully rendered before stdout
    expect(output).toBe(
      '[build-action-dist] bundle command failed: Command failed\n' +
        '[build-action-dist] bundle stderr:\n' +
        'stderr diagnostic\n' +
        '[build-action-dist] bundle stdout:\n' +
        'stdout diagnostic\n',
    )
  })

  it('never glues a label onto an unterminated stream (no trailing newline on either stream)', () => {
    // #given neither stream ends in a newline — the direct regression case for a child
    // whose output was truncated (e.g. by maxBuffer) without a final line break
    const error = new Error('Command failed')
    const stdout = 'a'
    const stderr = 'b'

    // #when formatting the failure output
    const output = formatBundleFailureOutput(error, stdout, stderr)

    // #then each stream is newline-terminated before the next label, so no label is
    // glued onto the previous stream's last line
    expect(output).toBe(
      '[build-action-dist] bundle command failed: Command failed\n' +
        '[build-action-dist] bundle stderr:\n' +
        'b\n' +
        '[build-action-dist] bundle stdout:\n' +
        'a\n',
    )
  })

  it('prefixes stderr-only output with command context', () => {
    // #given only stderr is populated
    const error = new Error('Command failed')
    const stderr = 'raw stderr content\n'

    // #when formatting the failure output
    const output = formatBundleFailureOutput(error, '', stderr)

    // #then stderr is passed through, with the failing command identified ahead of it
    expect(output).toBe('[build-action-dist] bundle command failed: Command failed\nraw stderr content\n')
  })
})
