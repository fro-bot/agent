import type {ExecOutcome} from './exec-binary.js'

import {spawn, type ChildProcess} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest'

import {execBinary, exitStatusFor, FORWARDED_SIGNALS} from './exec-binary.js'
import {isGone, readPid} from './shim-test-kit.js'

const WAIT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 10

// --- fixtures (written to a temp dir) -------------------------------------------------------------------------------

const EXEC_BINARY_URL = new URL('./exec-binary.ts', import.meta.url).href

// Hosts execBinary in its own process. Config arrives via RUNNER_CONFIG; the outcome is written to a file so the
// child (which inherits this process's stdio) owns stdout/stderr.
const RUNNER_SOURCE = `
import {spawn} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {execBinary} from ${JSON.stringify(EXEC_BINARY_URL)}

const cfg = JSON.parse(process.env.RUNNER_CONFIG)
const options = {}
if (cfg.raiseBeforeSpawn !== undefined) {
  options.spawnFn = (command, args, spawnOptions) => {
    // Delivered to this process while the child does not exist yet.
    process.kill(process.pid, cfg.raiseBeforeSpawn)
    const child = spawn(command, args, spawnOptions)
    writeFileSync(cfg.childPidPath, String(child.pid))
    return child
  }
}
const outcome = await execBinary(cfg.binary, cfg.args, options)
writeFileSync(cfg.outcomePath, JSON.stringify(outcome))
`

// Handles every forwarded signal, records each receipt, and signals readiness only after its handlers exist.
const CHILD_HANDLER_SOURCE = String.raw`
import {appendFileSync, writeFileSync} from 'node:fs'

const [readyPath, receiptsPath, pidPath] = process.argv.slice(2)
writeFileSync(pidPath, String(process.pid))
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']) {
  process.on(sig, () => {
    appendFileSync(receiptsPath, sig + '\n')
    // Linger so a duplicate forward would land (and be recorded) before the child is gone.
    setTimeout(() => process.exit(0), 100)
  })
}
setInterval(() => {}, 1000)
writeFileSync(readyPath, 'ready')
`

// No signal handlers: default dispositions apply.
const CHILD_PLAIN_SOURCE = `
import {writeFileSync} from 'node:fs'

const [readyPath, pidPath] = process.argv.slice(2)
writeFileSync(pidPath, String(process.pid))
setInterval(() => {}, 1000)
writeFileSync(readyPath, 'ready')
`

// Prints a "listening on" line, then echoes stdin once it ends.
const CHILD_SERVE_SOURCE = `
console.log('listening on http://127.0.0.1:4096')
let data = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { data += chunk })
process.stdin.on('end', () => {
  console.log('stdin:' + data.trim())
  process.exit(0)
})
`

// --- helpers ---------------------------------------------------------------------------------------------------------

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (predicate() === false) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${description}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

function readOutcome(outcomePath: string): ExecOutcome {
  return JSON.parse(readFileSync(outcomePath, 'utf8')) as ExecOutcome
}

interface RunnerHandle {
  readonly proc: ChildProcess
  readonly stdout: () => string
  readonly stderr: () => string
  readonly exited: Promise<{readonly code: number | null; readonly signal: NodeJS.Signals | null}>
  readonly hasExited: () => boolean
}

describe.skipIf(process.platform === 'win32')('execBinary', () => {
  let dir: string
  let runnerPath: string
  let childHandlerPath: string
  let childPlainPath: string
  let childServePath: string
  let counter = 0
  const runners: ChildProcess[] = []
  const pidFiles: string[] = []

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'exec-binary-test-'))
    runnerPath = path.join(dir, 'runner.mjs')
    childHandlerPath = path.join(dir, 'child-handler.mjs')
    childPlainPath = path.join(dir, 'child-plain.mjs')
    childServePath = path.join(dir, 'child-serve.mjs')
    writeFileSync(runnerPath, RUNNER_SOURCE)
    writeFileSync(childHandlerPath, CHILD_HANDLER_SOURCE)
    writeFileSync(childPlainPath, CHILD_PLAIN_SOURCE)
    writeFileSync(childServePath, CHILD_SERVE_SOURCE)
  })

  afterEach(() => {
    // Unconditionally reap runners and any fixture child whose pid was recorded.
    for (const proc of runners.splice(0)) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }
    for (const file of pidFiles.splice(0)) {
      const pid = readPid(file)
      if (pid === undefined) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })

  afterAll(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  function tmpFile(name: string): string {
    counter += 1
    const file = path.join(dir, `${counter}-${name}`)
    pidFiles.push(file)
    return file
  }

  function startRunner(config: {
    readonly binary: string
    readonly args: readonly string[]
    readonly outcomePath: string
    readonly raiseBeforeSpawn?: NodeJS.Signals
    readonly childPidPath?: string
  }): RunnerHandle {
    const proc = spawn(process.execPath, [runnerPath], {
      env: {...process.env, RUNNER_CONFIG: JSON.stringify(config)},
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    runners.push(proc)
    let out = ''
    let err = ''
    let done = false
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    proc.stderr?.on('data', (chunk: string) => {
      err += chunk
    })
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`runner did not exit within ${WAIT_TIMEOUT_MS}ms\nstdout: ${out}\nstderr: ${err}`))
      }, WAIT_TIMEOUT_MS)
      proc.once('exit', (code, signal) => {
        clearTimeout(timer)
        done = true
        resolve({code, signal})
      })
    })
    return {proc, stdout: () => out, stderr: () => err, exited, hasExited: () => done}
  }

  // --- outcome reporting ---------------------------------------------------------------------------------------------

  describe('exit codes', () => {
    it.each([0, 3])('reports exit code %i from the child', async code => {
      // #given a child that exits with a known code
      const host = new EventEmitter()

      // #when it is executed
      const outcome = await execBinary(process.execPath, ['-e', `process.exit(${code})`], {signalHost: host})

      // #then the outcome carries that code
      expect(outcome).toEqual({kind: 'exited', code})
    })
  })

  describe('stdio passthrough', () => {
    it('makes child stdout readable before exit and delivers piped stdin to the child', async () => {
      // #given a runner hosting a child that prints a listening line, then waits for stdin to end
      const outcomePath = tmpFile('outcome.json')
      const runner = startRunner({binary: process.execPath, args: [childServePath], outcomePath})

      // #when the listening line arrives
      await waitFor('"listening on" line', () => runner.stdout().includes('listening on'))

      // #then the child is still running (line was not buffered until exit)
      expect(runner.hasExited()).toBe(false)

      // #when stdin is piped to the runner and closed
      runner.proc.stdin?.end('hello\n')
      await runner.exited

      // #then the child received the data and exited 0
      expect(runner.stdout()).toContain('stdin:hello')
      expect(readOutcome(outcomePath)).toEqual({kind: 'exited', code: 0})
    })
  })

  // --- signal forwarding (real processes) ----------------------------------------------------------------------------

  describe('signal forwarding', () => {
    it.each(['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'] as const)(
      'forwards a PID-directed %s to the child exactly once and reports its handled exit',
      async signal => {
        // #given a runner hosting a child whose handlers are installed (readiness ack written)
        const readyPath = tmpFile('ready')
        const receiptsPath = tmpFile('receipts')
        const pidPath = tmpFile('child.pid')
        const outcomePath = tmpFile('outcome.json')
        const runner = startRunner({
          binary: process.execPath,
          args: [childHandlerPath, readyPath, receiptsPath, pidPath],
          outcomePath,
        })
        await waitFor('child readiness ack', () => existsSync(readyPath))

        // #when the signal is sent to the runner only
        runner.proc.kill(signal)
        const result = await runner.exited

        // #then the child recorded exactly one receipt of that signal
        expect(readFileSync(receiptsPath, 'utf8').trim().split('\n')).toEqual([signal])
        // #then the child's handled exit is reported and the runner itself exits cleanly
        expect(readOutcome(outcomePath)).toEqual({kind: 'exited', code: 0})
        expect(result).toEqual({code: 0, signal: null})
        // #then the child is gone (the runner awaited its exit event)
        const childPid = readPid(pidPath)
        expect(childPid).toBeDefined()
        await waitFor('child to be reaped', () => isGone(childPid as number))
      },
    )

    it('reports the terminating signal when the child does not handle a forwarded SIGTERM', async () => {
      // #given a child with default signal dispositions
      const readyPath = tmpFile('ready')
      const pidPath = tmpFile('child.pid')
      const outcomePath = tmpFile('outcome.json')
      const runner = startRunner({binary: process.execPath, args: [childPlainPath, readyPath, pidPath], outcomePath})
      await waitFor('child readiness ack', () => existsSync(readyPath))

      // #when the runner receives SIGTERM (the SDK proc.kill() path)
      runner.proc.kill('SIGTERM')
      await runner.exited

      // #then the child died by SIGTERM and the outcome says so
      expect(readOutcome(outcomePath)).toEqual({kind: 'signaled', signal: 'SIGTERM'})
    })

    it('delivers a signal received before the child exists once it spawns, without orphaning the child', async () => {
      // #given a runner that raises SIGTERM on itself while the spawn is in flight
      const childPidPath = tmpFile('child.pid')
      const outcomePath = tmpFile('outcome.json')
      const runner = startRunner({
        binary: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        outcomePath,
        raiseBeforeSpawn: 'SIGTERM',
        childPidPath,
      })

      // #when the runner finishes
      await runner.exited

      // #then the child received the held SIGTERM (it would otherwise run forever) and is not left behind
      expect(readOutcome(outcomePath)).toEqual({kind: 'signaled', signal: 'SIGTERM'})
      const childPid = readPid(childPidPath)
      expect(childPid).toBeDefined()
      await waitFor('child to be reaped', () => isGone(childPid as number))
    })
  })

  // --- listener lifecycle and hold semantics (injected signal host) --------------------------------------------------

  describe('listener lifecycle', () => {
    it('installs a listener for every forwarded signal before spawning and removes them all afterwards', async () => {
      // #given a signal host and a spawn wrapper that inspects the host at spawn time
      const host = new EventEmitter()
      const installedAtSpawn: number[] = []

      // #when executing a trivial child
      await execBinary(process.execPath, ['-e', ''], {
        signalHost: host,
        spawnFn: (command, args, options) => {
          for (const signal of FORWARDED_SIGNALS) installedAtSpawn.push(host.listenerCount(signal))
          return spawn(command, [...args], options)
        },
      })

      // #then every signal had exactly one listener at spawn time, and none remain
      expect(FORWARDED_SIGNALS).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'])
      expect(installedAtSpawn).toEqual(FORWARDED_SIGNALS.map(() => 1))
      for (const signal of FORWARDED_SIGNALS) expect(host.listenerCount(signal)).toBe(0)
    })

    it('keeps supervising the child when forwarding a signal fails, repeatedly', async () => {
      // #given a child whose kill() fails with EPERM (reported as an 'error' event) for every forwarded signal
      const host = new EventEmitter()
      let realKill: ChildProcess['kill'] | undefined
      let spawnedChild: ChildProcess | undefined
      const outcomePromise = execBinary(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        signalHost: host,
        spawnFn: (command, args, options) => {
          const child = spawn(command, [...args], options)
          spawnedChild = child
          realKill = child.kill.bind(child)
          child.kill = () => {
            child.emit('error', Object.assign(new Error('kill EPERM'), {code: 'EPERM'}))
            return false
          }
          return child
        },
      })
      let settled = false
      const tracked = outcomePromise.then(outcome => {
        settled = true
        return outcome
      })

      try {
        // #when two signals are forwarded and each forward fails (an unhandled 'error' would throw from emit)
        host.emit('SIGTERM')
        host.emit('SIGTERM')
        await new Promise<void>(resolve => setTimeout(resolve, 100))

        // #then supervision continues: the promise is still pending and the listeners are still installed
        expect(settled).toBe(false)
        expect(host.listenerCount('SIGTERM')).toBe(1)
      } finally {
        // The test (not the helper) ends the real child, and the helper reports that real exit.
        realKill?.('SIGKILL')
      }
      const outcome = await tracked
      expect(outcome).toEqual({kind: 'signaled', signal: 'SIGKILL'})
      for (const signal of FORWARDED_SIGNALS) expect(host.listenerCount(signal)).toBe(0)
      expect(spawnedChild?.listenerCount('error')).toBe(0)
    })

    it('holds a signal emitted before the child exists and delivers it after spawn', async () => {
      // #given a host that emits SIGTERM while spawn is in flight
      const host = new EventEmitter()

      // #when executing a child that would otherwise run forever
      const outcome = await execBinary(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        signalHost: host,
        spawnFn: (command, args, options) => {
          host.emit('SIGTERM')
          return spawn(command, [...args], options)
        },
      })

      // #then the held signal reached the child, and listeners were cleaned up
      expect(outcome).toEqual({kind: 'signaled', signal: 'SIGTERM'})
      expect(host.listenerCount('SIGTERM')).toBe(0)
    })
  })

  // --- spawn errors --------------------------------------------------------------------------------------------------

  describe('spawn errors', () => {
    it('reports ENOENT for a nonexistent binary and removes its listeners', async () => {
      // #given a path that does not exist
      const host = new EventEmitter()
      const missing = path.join(dir, 'does-not-exist')

      // #when executing it
      const outcome = await execBinary(missing, [], {signalHost: host})

      // #then the outcome is a spawn error with code ENOENT
      expect(outcome).toMatchObject({kind: 'spawn-error', code: 'ENOENT'})
      for (const signal of FORWARDED_SIGNALS) expect(host.listenerCount(signal)).toBe(0)
    })

    it('reports a synchronous spawn throw as a spawn error and removes its listeners', async () => {
      // #given a spawn function that throws synchronously (for example fd exhaustion)
      const host = new EventEmitter()
      const spawnFn = (): never => {
        throw Object.assign(new Error('spawn EMFILE'), {code: 'EMFILE'})
      }

      // #when executing through it
      const outcome = await execBinary('/irrelevant', [], {signalHost: host, spawnFn})

      // #then the throw became an outcome, and no listener leaked on the injected host
      expect(outcome).toEqual({kind: 'spawn-error', code: 'EMFILE', message: 'spawn EMFILE'})
      for (const signal of FORWARDED_SIGNALS) expect(host.listenerCount(signal)).toBe(0)
    })

    it('reports EACCES for a file without the executable bit', async () => {
      // #given a script with no execute permission
      const script = path.join(dir, 'not-executable.sh')
      writeFileSync(script, '#!/bin/sh\nexit 0\n')
      chmodSync(script, 0o644)

      // #when executing it
      const outcome = await execBinary(script, [], {signalHost: new EventEmitter()})

      // #then the outcome is a spawn error with code EACCES
      expect(outcome).toMatchObject({kind: 'spawn-error', code: 'EACCES'})
    })
  })
})

// --- exitStatusFor (pure) ------------------------------------------------------------------------------------------------

describe('exitStatusFor', () => {
  it('maps an exit code to itself', () => {
    // #given/#when/#then
    expect(exitStatusFor({kind: 'exited', code: 0})).toEqual({kind: 'exit', code: 0})
    expect(exitStatusFor({kind: 'exited', code: 3})).toEqual({kind: 'exit', code: 3})
  })

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const)('asks to re-raise %s on self', signal => {
    // #given a child killed by a re-raisable signal
    // #when mapped
    // #then the entry point is told to re-raise it
    expect(exitStatusFor({kind: 'signaled', signal})).toEqual({kind: 'reraise', signal})
  })

  it.each(['SIGPIPE', 'SIGUSR1', 'SIGKILL', 'SIGSEGV'] as const)(
    'maps %s to 128 + the platform signal number',
    signal => {
      // #given a child killed by a signal Node would not terminate us with
      // #when mapped
      // #then the status is 128 + the platform constant
      expect(exitStatusFor({kind: 'signaled', signal})).toEqual({
        kind: 'exit',
        code: 128 + os.constants.signals[signal],
      })
    },
  )

  it('uses the platform constant for SIGPIPE', () => {
    expect(exitStatusFor({kind: 'signaled', signal: 'SIGPIPE'})).toEqual({
      kind: 'exit',
      code: 128 + os.constants.signals.SIGPIPE,
    })
  })

  it('maps an outcome with neither code nor signal to 1', () => {
    expect(exitStatusFor({kind: 'unknown'})).toEqual({kind: 'exit', code: 1})
  })

  it('maps ENOENT to 127, EACCES to 126, and any other spawn error to 1', () => {
    expect(exitStatusFor({kind: 'spawn-error', code: 'ENOENT', message: 'x'})).toEqual({kind: 'exit', code: 127})
    expect(exitStatusFor({kind: 'spawn-error', code: 'EACCES', message: 'x'})).toEqual({kind: 'exit', code: 126})
    expect(exitStatusFor({kind: 'spawn-error', code: 'EMFILE', message: 'x'})).toEqual({kind: 'exit', code: 1})
    expect(exitStatusFor({kind: 'spawn-error', code: undefined, message: 'x'})).toEqual({kind: 'exit', code: 1})
  })
})
