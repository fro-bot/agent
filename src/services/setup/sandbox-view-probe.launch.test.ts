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

  it('does not call an on-time exit a timeout when a descendant keeps stderr open past the deadline', async () => {
    // #given a launcher that exits well before a 300 ms deadline, while a background child holds stderr for a second and
    // writes to it just before letting go
    const started = Date.now()
    const result = await launchWithDeadline(SH, ['-c', '(sleep 1; echo "descendant words" >&2) & sleep 0.1; exit 0'], {
      timeoutMs: 300,
      onSpawn: () => undefined,
    })

    // #then the exit was on time: code 0, not timed out, back within the drain bound (not after the second)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(900)
  })

  it('keeps stderr that arrives inside the drain window after an on-time exit', async () => {
    // #given the same shape, with the descendant's text arriving 0.2 s after the exit, inside the drain window, and a
    // deadline that falls between the exit and the end of the drain
    const result = await launchWithDeadline(SH, ['-c', '(sleep 0.3; echo "inside the window" >&2) & exit 0'], {
      timeoutMs: 200,
      onSpawn: () => undefined,
    })

    // #then the late text is kept and the exit still counts as on time
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toContain('inside the window')
  })

  it('keeps the timeout behaviour: a child that never exits is reported timed out', async () => {
    // #given a child that outlives a short deadline
    const result = await launchWithDeadline(SH, ['-c', 'exec sleep 30'], {timeoutMs: 300, onSpawn: () => undefined})

    // #then a launcher still running at the deadline is a timeout, with no exit code
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('keeps a timeout recorded before the exit when a descendant outside the killed group still holds stderr', async () => {
    // #given a launcher that outlives a short deadline, and a descendant in its own process group (job control) that the
    // group kill does not reach, so `close` does not come and the result is settled from `exit`
    const result = await launchWithDeadline(SH, ['-c', 'set -m; (sleep 2) & exec sleep 30'], {
      timeoutMs: 300,
      onSpawn: () => undefined,
    })

    // #then it is still a timeout
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('reports a launcher that cannot be started with no pid', async () => {
    // #given a command that does not exist
    const result = await launchWithDeadline('/nonexistent/launcher', [], {timeoutMs: 1000, onSpawn: () => undefined})

    // #then
    expect(result.pid).toBeNull()
  })
})
