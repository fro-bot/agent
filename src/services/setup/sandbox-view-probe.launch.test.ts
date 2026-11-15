import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {launchWithDeadline} from './sandbox-view-probe.js'

const SH = '/bin/sh'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The process group of a live process, read back from `ps` (the same flags work on Linux and macOS). */
function processGroupOf(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {encoding: 'utf8'}).trim())
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3000
  while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
}

describe('launchWithDeadline, with real child processes', () => {
  // The detached descendant outlives the launcher on purpose, so it is killed here whatever the test did, and its absence
  // is asserted: a failed test must not leave a `sleep` behind.
  let descendantPid: number | null = null
  const scratchDirs: string[] = []
  afterEach(async () => {
    const pid = descendantPid
    descendantPid = null
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      await waitUntilGone(pid)
    }
    for (const dir of scratchDirs.splice(0)) rmSync(dir, {recursive: true, force: true})
    if (pid !== null && isAlive(pid)) throw new Error(`The detached descendant ${pid} is still running after cleanup`)
  })

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
    // #given a launcher that outlives a 1.5 s deadline, and a descendant that is really detached: node spawns `sleep` with
    // `detached: true` (its own session and process group, portable to macOS, which has no `setsid`), stderr inherited, and
    // records its pid. The launcher's group kill cannot reach it, so `close` never comes and the result is settled from `exit`.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'launch-detached-'))
    scratchDirs.push(dir)
    const pidFile = path.join(dir, 'descendant.pid')
    const spawnDetached = [
      "const {spawn} = require('node:child_process')",
      "const child = spawn('sleep', ['30'], {detached: true, stdio: ['ignore', 'ignore', 'inherit']})",
      "require('node:fs').writeFileSync(process.argv[1], String(child.pid))",
      'child.unref()',
    ].join(';')
    // #when run
    const started = Date.now()
    const result = await launchWithDeadline(
      SH,
      ['-c', '"$1" -e "$2" "$3"; exec sleep 30', 'sh', process.execPath, spawnDetached, pidFile],
      {timeoutMs: 1500, onSpawn: () => undefined},
    )
    const elapsed = Date.now() - started
    descendantPid = Number(readFileSync(pidFile, 'utf8'))

    // #then the fixture did what it says: the descendant exists, is alive, and is in another process group than the
    // launcher (a detached child leads its own session, so its group is its own pid)
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true)
    expect(isAlive(descendantPid)).toBe(true)
    const descendantGroup = processGroupOf(descendantPid)
    expect(result.pid).not.toBeNull()
    expect(descendantGroup).not.toBe(result.pid)
    expect(descendantGroup).toBe(descendantPid)

    // #and the timeout recorded before the exit survived the drain window
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()

    // #and the result did not wait for the descendant: deadline, plus the drain bound, plus slack, well under the 2 s
    // fallback that applies when no exit arrives
    expect(elapsed).toBeLessThan(1500 + 500 + 700)
  })

  it('reports a launcher that cannot be started with no pid', async () => {
    // #given a command that does not exist
    const result = await launchWithDeadline('/nonexistent/launcher', [], {timeoutMs: 1000, onSpawn: () => undefined})

    // #then
    expect(result.pid).toBeNull()
  })
})
