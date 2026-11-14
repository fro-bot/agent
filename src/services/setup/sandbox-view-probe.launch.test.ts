import {describe, expect, it} from 'vitest'
import {launchWithDeadline} from './sandbox-view-probe.js'

const SH = '/bin/sh'

describe('launchWithDeadline, with real child processes', () => {
  it('captures stderr written right before exit', async () => {
    // #given a child that prints to stderr and exits at once
    const result = await launchWithDeadline(SH, ['-c', 'echo "sudo: early failure" >&2; exit 3'], {
      timeoutMs: 5000,
      onSpawn: () => undefined,
    })

    // #then both the exit code and the text arrived
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toContain('sudo: early failure')
  })

  it('captures what an orphaned descendant writes to the same stderr after the launcher has exited', async () => {
    // #given a launcher that exits while a background child still holds stderr and writes shortly after
    const result = await launchWithDeadline(SH, ['-c', '(sleep 0.2; echo "late words" >&2) & exit 4'], {
      timeoutMs: 5000,
      onSpawn: () => undefined,
    })

    // #then the exit code is kept and the late text is not lost
    expect(result.exitCode).toBe(4)
    expect(result.stderr).toContain('late words')
  })

  it('does not wait for a descendant that holds the pipe open for ever: it settles on its own bound with the exit code', async () => {
    // #given a launcher that exits while a background child keeps stderr open for a long time
    const started = Date.now()
    const result = await launchWithDeadline(SH, ['-c', 'echo "first words" >&2; (sleep 3 >/dev/null) & exit 5'], {
      timeoutMs: 20_000,
      onSpawn: () => undefined,
    })

    // #then it returned well before the descendant exits, with what had arrived
    expect(Date.now() - started).toBeLessThan(2500)
    expect(result.exitCode).toBe(5)
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toContain('first words')
  })

  it('keeps the timeout behaviour: a child that never exits is reported timed out', async () => {
    // #given a child that outlives a short deadline
    const result = await launchWithDeadline(SH, ['-c', 'exec sleep 30'], {timeoutMs: 300, onSpawn: () => undefined})

    // #then
    expect(result.timedOut).toBe(true)
  })

  it('reports a launcher that cannot be started with no pid', async () => {
    // #given a command that does not exist
    const result = await launchWithDeadline('/nonexistent/launcher', [], {timeoutMs: 1000, onSpawn: () => undefined})

    // #then
    expect(result.pid).toBeNull()
  })
})
