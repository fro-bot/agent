/**
 * Shared async exec helper for the `opencode` shim and the `harness` passthrough.
 *
 * Runs the resolved binary as a direct, non-detached child with inherited stdio, forwards catchable signals to it,
 * and reports HOW the child ended. It never calls `process.exit` and never re-raises a signal: the entry points own
 * that (see `exitStatusFor`).
 *
 * Only the direct child is signalled — descendant cleanup stays the binary's job. A signal delivered to the whole
 * foreground process group (Ctrl-C, terminal hangup) may therefore reach the child twice; that is accepted.
 */

import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process'
import os from 'node:os'
import process from 'node:process'

/** Signals forwarded to the child. Listening on SIGUSR1 also stops Node from opening its inspector. */
export const FORWARDED_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
] as const satisfies readonly NodeJS.Signals[]

export type ExecOutcome =
  | {readonly kind: 'exited'; readonly code: number}
  | {readonly kind: 'signaled'; readonly signal: NodeJS.Signals}
  | {readonly kind: 'spawn-error'; readonly code: string | undefined; readonly message: string}
  | {readonly kind: 'unknown'}

/** What an entry point should do once the child has ended. */
export type ExitStatus =
  {readonly kind: 'exit'; readonly code: number} | {readonly kind: 'reraise'; readonly signal: NodeJS.Signals}

/** The slice of `process` the helper needs; injectable so listener handling is testable without real signals. */
export interface SignalHost {
  readonly on: (signal: NodeJS.Signals, listener: () => void) => unknown
  readonly off: (signal: NodeJS.Signals, listener: () => void) => unknown
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface ExecBinaryOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly signalHost?: SignalHost
  readonly spawnFn?: SpawnFn
}

const RERAISED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

/**
 * Run `binaryPath` with `args`, forwarding signals until it ends.
 *
 * Listeners are installed BEFORE spawning; a signal that arrives while no child exists is held and delivered as soon
 * as the child does. All listeners are removed before the returned promise settles.
 */
export async function execBinary(
  binaryPath: string,
  args: readonly string[],
  options: ExecBinaryOptions = {},
): Promise<ExecOutcome> {
  const host: SignalHost = options.signalHost ?? process
  const spawnFn = options.spawnFn ?? spawn
  const env = options.env ?? process.env

  let child: ChildProcess | undefined
  const held: NodeJS.Signals[] = []

  const listeners = FORWARDED_SIGNALS.map(signal => {
    const listener = (): void => {
      if (child === undefined) {
        held.push(signal)
        return
      }
      child.kill(signal)
    }
    return {signal, listener}
  })

  const removeListeners = (): void => {
    for (const {signal, listener} of listeners) host.off(signal, listener)
  }

  for (const {signal, listener} of listeners) host.on(signal, listener)

  return new Promise<ExecOutcome>(resolve => {
    let settled = false
    let detachErrorHandler = (): void => {}
    const settle = (outcome: ExecOutcome): void => {
      if (settled) return
      settled = true
      detachErrorHandler()
      removeListeners()
      resolve(outcome)
    }

    let spawned: ChildProcess
    try {
      spawned = spawnFn(binaryPath, [...args], {stdio: 'inherit', env})
    } catch (error) {
      settle(toSpawnError(error))
      return
    }
    child = spawned

    // 'error' also fires for a failed kill() (for example EPERM on a forwarded signal) or IPC on a LIVE child. Those
    // must neither end supervision nor go unhandled -- an 'error' with no listener throws -- so the handler stays
    // attached until the outcome settles, and only a child that never started is treated as a spawn failure.
    const onError = (error: Error): void => {
      if (spawned.pid === undefined) settle(toSpawnError(error))
    }
    spawned.on('error', onError)
    detachErrorHandler = () => {
      spawned.off('error', onError)
    }
    spawned.once('exit', (code, signal) => {
      settle(outcomeFromExit(code, signal))
    })

    for (const signal of held.splice(0)) spawned.kill(signal)
  })
}

function outcomeFromExit(code: number | null, signal: NodeJS.Signals | null): ExecOutcome {
  if (code !== null) return {kind: 'exited', code}
  if (signal !== null) return {kind: 'signaled', signal}
  return {kind: 'unknown'}
}

function toSpawnError(error: unknown): ExecOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return {
    kind: 'spawn-error',
    code: typeof code === 'string' ? code : undefined,
    message: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Map how the child ended to what the entry point should do.
 *
 * - exit code → that code
 * - SIGINT/SIGTERM/SIGHUP/SIGQUIT → re-raise on self (after the caller removes its own listeners)
 * - any other signal → `128 + signal number` (re-raising SIGPIPE or SIGUSR1 would not end the process, since Node
 *   ignores SIGPIPE and SIGUSR1 starts the inspector; the remaining signals use the same mapping for one rule)
 * - neither code nor signal → 1
 * - spawn error: ENOENT → 127, EACCES → 126, otherwise 1
 */
export function exitStatusFor(outcome: ExecOutcome): ExitStatus {
  switch (outcome.kind) {
    case 'exited':
      return {kind: 'exit', code: outcome.code}
    case 'signaled':
      if (RERAISED_SIGNALS.includes(outcome.signal)) return {kind: 'reraise', signal: outcome.signal}
      return {kind: 'exit', code: 128 + (os.constants.signals[outcome.signal] ?? 0)}
    case 'spawn-error':
      if (outcome.code === 'ENOENT') return {kind: 'exit', code: 127}
      if (outcome.code === 'EACCES') return {kind: 'exit', code: 126}
      return {kind: 'exit', code: 1}
    case 'unknown':
      return {kind: 'exit', code: 1}
  }
}
