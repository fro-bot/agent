import type {ActionOpenCodeV2Client} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {toErrorMessage} from '../../shared/errors.js'
import {waitForAbortableDelay} from './session-poll.js'

/**
 * Was a prompt admitted, when the answer to its POST never arrived?
 *
 * The server admits a prompt durably BEFORE it answers, so a connection that fails after the request was sent can leave
 * the prompt admitted (and its turn running) with the caller none the wiser. Sending it again would run it twice, and
 * two overlapping runs of the same task are worse than one failed run. So a post-send failure is ambiguous, and nothing
 * is resent until this has an answer:
 *
 * - `admitted`: a user message with this prompt's text, created since the POST began, is in the session. Admission is
 *   synchronous, so an admitted prompt is already a message (probed on the pinned binary). Do not resend; observe the
 *   execution it started.
 * - `absent`: the message is not there, the root is not running and its inbox is empty. Nothing of this prompt is in
 *   flight, so a resend is safe.
 * - `unknown`: anything else, including a root that IS running (an admitted prompt queued behind a turn is not a message
 *   yet), or reads that kept failing. The caller fails the attempt without resending.
 *
 * Why the text and not a client message id: the prompt route takes an optional `id`, and a duplicate id is deduplicated,
 * but a duplicate POST still schedules another execution, and a client-chosen id sorts into the transcript by its value,
 * so one minted without the server's clock could place the prompt before the history it follows.
 */

export type AdmissionVerdict = 'absent' | 'admitted' | 'unknown'

/** The whole resolution, including its retries. A lost acknowledgment must not hold the run up for long. */
export const ADMISSION_RESOLVE_TIMEOUT_MS = 6_000
const ADMISSION_READ_ATTEMPTS = 3
const ADMISSION_RETRY_DELAY_MS = 400
/** Client and server share a machine and a clock; this only absorbs the gap between "began sending" and "admitted". */
const ADMISSION_CLOCK_SKEW_MS = 2_000

export interface ResolveAdmissionOptions {
  readonly client: ActionOpenCodeV2Client
  readonly sessionId: string
  readonly promptText: string
  /** Epoch ms taken before the POST began. */
  readonly sentAt: number
  readonly logger: Logger
  /** Ends the resolution early (the run's deadline). An aborted resolution is `unknown`. */
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly retryDelayMs?: number
}

export async function resolveAmbiguousAdmission(options: ResolveAdmissionOptions): Promise<AdmissionVerdict> {
  const {client, sessionId, promptText, sentAt, logger} = options
  const timeout = AbortSignal.timeout(options.timeoutMs ?? ADMISSION_RESOLVE_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const retryDelayMs = options.retryDelayMs ?? ADMISSION_RETRY_DELAY_MS

  for (let attempt = 1; attempt <= ADMISSION_READ_ATTEMPTS && !signal.aborted; attempt++) {
    try {
      const messages = await client.listRecentUserMessages({sessionId, signal})
      if (messages.success) {
        const admitted = messages.data.some(
          message => message.text === promptText && message.createdAt >= sentAt - ADMISSION_CLOCK_SKEW_MS,
        )
        if (admitted) return 'admitted'

        const active = await client.session.active({signal})
        if (Object.keys(active).includes(sessionId)) return 'unknown'
        const inbox = await client.listSessionInbox({sessionId, signal})
        if (inbox.success) return inbox.data.queued > 0 ? 'unknown' : 'absent'
      }
    } catch (error) {
      logger.debug('Admission check read failed', {sessionId, attempt, error: toErrorMessage(error)})
    }
    if (attempt < ADMISSION_READ_ATTEMPTS && !signal.aborted) await waitForAbortableDelay(retryDelayMs, signal)
  }
  return 'unknown'
}
