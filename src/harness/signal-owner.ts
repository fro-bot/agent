import type {Logger} from '../shared/logger.js'
import process from 'node:process'
import {holdSignalOwnership, killRunningExecChildren} from '../services/setup/adapters.js'
import {markRunCancelled, startCancellationCleanups} from '../shared/cancellation.js'

/**
 * The one SIGINT/SIGTERM handler of a run.
 *
 * GitHub cancels a step with SIGINT, then SIGTERM 7.5 s later, then a kill about 2.5 s after that. Before this module the
 * only handler was the isolate-agent lifecycle's, and only once its sandbox existed; a cancelled run without isolation ended
 * where Node's default ends it, with nothing flushed. The owner is installed at the start of `run()` for every run and takes
 * the exec adapter's signal ownership with it (the adapter's own handler would kill the running command and re-raise at once).
 *
 * On the first signal it, in this order:
 *  1. sets the cancelled flag, synchronously (`shared/cancellation.ts`): every irreversible write checks it at the point of
 *     submission, so nothing is sent after this line;
 *  2. calls `onCancel`, synchronously: the tracer ends the spans still open as `cancelled`;
 *  3. starts the registered teardown (the sandbox's: stop the sandbox user's processes, take its files back, inside its own
 *     10 s budget), or, with none registered, reaps the commands the exec adapter is running;
 *  4. starts the export, with its own deadline, short of the runner's SIGTERM, one turn of the event loop later: its local
 *     preparation (the scrubber, the serialization) is CPU work, and the teardown's first steps go first;
 *  5. when both have settled, removes its handlers and re-raises the signal, so the process ends with the signal's default
 *     action and the runner sees the exit it always saw.
 *
 * The export never shortens the teardown (it runs beside it, and the process stays until the teardown settles) and never
 * extends it past its own deadline. A second signal changes nothing: the first one's handling is already running.
 */

/** The slice of `process` the owner uses; injectable so a test needs no real signals. */
export interface SignalHost {
  readonly pid: number
  readonly on: (signal: SignalName, listener: () => void) => unknown
  readonly off: (signal: SignalName, listener: () => void) => unknown
  readonly kill: (pid: number, signal: SignalName) => unknown
}

export type SignalName = 'SIGINT' | 'SIGTERM'

/** Runs the teardown of something the run owns. Rejections are swallowed: the owner always goes on to re-raise. */
export type SignalTeardown = (signal: SignalName) => Promise<unknown>

/**
 * Longest the export runs once a signal arrives. The runner's SIGTERM comes 7.5 s after its SIGINT, and an isolated run's
 * teardown has up to 10 s, so the export gets half of the first window.
 */
export const SIGNAL_FLUSH_DEADLINE_MS = 5_000

export interface SignalOwnerOptions {
  readonly logger: Logger
  /** Ends the spans still open as cancelled. Synchronous; a throw is ignored. */
  readonly onCancel: (signal: SignalName) => void
  /** Starts the export with the given bound. Shared with normal completion: it must be idempotent. */
  readonly flush: (options: {readonly boundMs: number}) => Promise<unknown>
  readonly flushDeadlineMs?: number
  /** Defaults to the real `process`. */
  readonly host?: SignalHost
  /** Kills the commands the exec adapter is running; returns how many. Defaults to the adapter's own. */
  readonly reapChildren?: () => number
  /** Takes signal ownership from the exec adapter. Defaults to the adapter's own. */
  readonly holdOwnership?: () => () => void
}

export interface SignalOwner {
  /** True from the first signal. */
  readonly cancelled: () => boolean
  /**
   * Registers what must run when a signal arrives, beside the export: the sandbox teardown. Registered after the signal began,
   * it runs at once and the re-raise waits for it. Returns a function that unregisters it (a teardown that already started
   * is not interrupted). With none registered a signal reaps the exec adapter's running commands instead.
   */
  readonly registerTeardown: (teardown: SignalTeardown) => () => void
  /** Resolves once the handling of a signal has finished (immediately when none arrived). The process normally ends before then. */
  readonly drain: () => Promise<void>
  /** Removes the handlers and gives the exec adapter its signal ownership back. Idempotent. */
  readonly dispose: () => void
}

const SIGNALS: readonly SignalName[] = ['SIGINT', 'SIGTERM']

export function createSignalOwner(options: SignalOwnerOptions): SignalOwner {
  const {logger} = options
  const host: SignalHost = options.host ?? process
  const deadlineMs = options.flushDeadlineMs ?? SIGNAL_FLUSH_DEADLINE_MS
  const reapChildren = options.reapChildren ?? (() => killRunningExecChildren('SIGKILL'))
  const teardowns = new Set<SignalTeardown>()
  // Every teardown and the export that this signal started, those registered late included. Never rejects.
  const runs: Promise<void>[] = []
  const listeners: [SignalName, () => void][] = []
  let releaseOwnership: (() => void) | null = (options.holdOwnership ?? holdSignalOwnership)()
  let signalled = false
  let received: SignalName = 'SIGTERM'
  let handling: Promise<void> | undefined

  const runTeardown = async (teardown: SignalTeardown, signal: SignalName): Promise<void> => {
    try {
      await teardown(signal)
    } catch {
      // The teardown decides its own outcome; the owner's job is to end the process once it is done.
    }
  }

  /**
   * The export, bounded: the exporter has its own bound, and this timer is the backstop for one that ignores it. The timer starts
   * with the signal, so the deadline covers the export's own preparation (the scrubber, the serialization) too, and the export
   * starts one turn of the event loop later: the teardown's first steps (the stop signals, the reaping) are already on their way
   * when that work occupies the thread.
   */
  const runFlush = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, deadlineMs)
    })
    try {
      const exported = (async () => {
        await new Promise<void>(resolve => {
          setImmediate(resolve)
        })
        await options.flush({boundMs: deadlineMs})
      })()
      await Promise.race([exported, deadline])
    } catch {
      // An export never changes how a cancelled run ends.
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const settleRuns = async (): Promise<void> => {
    let waited = 0
    while (waited < runs.length) {
      const batch = runs.slice(waited)
      waited += batch.length
      await Promise.all(batch)
    }
  }

  const dispose = (): void => {
    releaseOwnership?.()
    releaseOwnership = null
    for (const [signal, listener] of listeners.splice(0)) host.off(signal, listener)
  }

  const handle = async (signal: SignalName): Promise<void> => {
    // 1 and 2, synchronously and before anything awaits.
    markRunCancelled()
    try {
      options.onCancel(signal)
    } catch {
      // Tracing never changes how a cancelled run stops.
    }
    logger.warning('Received a termination signal; stopping the run', {signal})
    // 3 and 4, side by side: the export and the teardown share the runner's window. The teardown starts first.
    if (teardowns.size === 0) {
      const reaped = reapChildren()
      if (reaped > 0) logger.info('Stopped the commands the run was waiting on', {count: reaped})
    } else {
      for (const teardown of teardowns) runs.push(runTeardown(teardown, signal))
    }
    // What the run holds that a pending read could otherwise strand (a review receipt) is given back at once, beside both.
    runs.push(...startCancellationCleanups())
    runs.push(runFlush())
    await settleRuns()
    // 5. The handlers are gone, so this ends the process with the signal's default action.
    dispose()
    host.kill(host.pid, signal)
  }

  for (const signal of SIGNALS) {
    const listener = (): void => {
      // A second signal: the first one's handling is already running, and it ends the process itself.
      if (signalled) return
      signalled = true
      received = signal
      handling = handle(signal).catch(() => undefined)
    }
    listeners.push([signal, listener])
    host.on(signal, listener)
  }

  return {
    cancelled: () => signalled,
    registerTeardown: teardown => {
      teardowns.add(teardown)
      // A signal that is being handled with no teardown reaped commands instead; this one still runs, and is waited for.
      if (signalled) runs.push(runTeardown(teardown, received))
      return () => {
        teardowns.delete(teardown)
      }
    },
    drain: async () => {
      await handling
    },
    dispose,
  }
}
