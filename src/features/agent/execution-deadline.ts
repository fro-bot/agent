/**
 * The run's execution deadline, shared by the V1 and V2 Action loops. A leaf module (it needs only the logger type), so
 * the poller and the attempt loop can both take it without importing each other.
 */
import type {Logger} from '../../shared/logger.js'

export function createDeadlineExceededError(label: string): Error {
  const error = new Error(`${label} exceeded the execution deadline`)
  error.name = 'DeadlineExceededError'
  return error
}

export interface ExecutionDeadline {
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly isExpired: () => boolean
  readonly isTimedOut: () => boolean
  readonly remainingMs: () => number
  readonly run: <T>(operation: () => Promise<T>, label: string) => Promise<T>
  readonly dispose: () => void
}

export function createExecutionDeadline(timeoutMs: number, logger: Logger): ExecutionDeadline {
  const controller = new AbortController()
  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  const latchTimeout = (): void => {
    if (timedOut) return
    timedOut = true
    logger.warning('Execution timeout reached', {timeoutMs})
    controller.abort()
  }

  const isExpired = (): boolean => {
    if (timedOut) return true
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      latchTimeout()
      return true
    }
    return false
  }

  const remainingMs = (): number => {
    if (deadlineAt == null) return Number.POSITIVE_INFINITY
    const remaining = Math.max(0, deadlineAt - Date.now())
    if (remaining === 0) latchTimeout()
    return remaining
  }

  // Races the operation against the deadline with an explicitly tagged outcome, and preserves
  // whichever actually won -- never reinterprets the winner by rereading the clock afterwards.
  // `isExpired()`/`isTimedOut()` remain valid only for admission (before starting work) and for
  // completion-admission decisions made by callers; they are never consulted here to explain a
  // race that has already settled. See createExecutionDeadline's docs for the invariant this
  // upholds: selecting an error never proves quiescence, and observing quiescence never erases
  // an error.
  type RunRaceResult<T> =
    | {readonly source: 'operation'; readonly success: true; readonly value: T}
    | {readonly source: 'operation'; readonly success: false; readonly error: unknown}
    | {readonly source: 'deadline'}

  const run = async <T>(operation: () => Promise<T>, label: string): Promise<T> => {
    // Admission decision: valid to consult the clock here, before any work has started.
    if (isExpired()) throw createDeadlineExceededError(label)
    if (deadlineAt == null) return operation()

    let onAbort: (() => void) | null = null
    const deadlineOutcome = new Promise<RunRaceResult<T>>(resolve => {
      onAbort = (): void => resolve({source: 'deadline'})
      controller.signal.addEventListener('abort', onAbort, {once: true})
    })

    const operationOutcome: Promise<RunRaceResult<T>> = Promise.resolve()
      .then(operation)
      .then(
        (value): RunRaceResult<T> => ({source: 'operation', success: true, value}),
        (error: unknown): RunRaceResult<T> => ({source: 'operation', success: false, error}),
      )

    try {
      // Whichever settles first genuinely won -- no post-race clock recheck, no rewriting the
      // operation's own outcome based on state that changed after the race was already decided.
      const winner = await Promise.race([operationOutcome, deadlineOutcome])
      if (winner.source === 'deadline') throw createDeadlineExceededError(label)
      if (winner.success) return winner.value
      throw winner.error
    } finally {
      if (onAbort != null) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  if (deadlineAt != null) timeoutId = setTimeout(latchTimeout, timeoutMs)

  return {
    timeoutMs,
    signal: controller.signal,
    isExpired,
    isTimedOut: () => timedOut,
    remainingMs,
    run,
    dispose: () => {
      if (timeoutId != null) clearTimeout(timeoutId)
    },
  }
}
