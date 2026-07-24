import type {Logger} from '../shared/logger.js'
import type {SessionClient} from './backend.js'

export interface SessionTitleDeadline {
  readonly signal: AbortSignal
  readonly isExpired: () => boolean
  readonly remainingMs: () => number
}

export async function reassertSessionTitle(
  client: SessionClient,
  sessionId: string,
  title: string | undefined,
  logger: Logger,
  deadline?: SessionTitleDeadline,
): Promise<void> {
  if (title == null) {
    return
  }

  if (deadline?.isExpired() === true || deadline?.remainingMs() === 0) return

  try {
    let onAbort: (() => void) | undefined
    const abortPromise =
      deadline == null
        ? null
        : new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('Session title re-assertion aborted'))
            deadline.signal.addEventListener('abort', onAbort, {once: true})
          })
    try {
      const update = client.session.update({
        path: {id: sessionId},
        body: {title},
        ...(deadline == null ? {} : {signal: deadline.signal}),
      })
      const response = await Promise.race([update, ...(abortPromise == null ? [] : [abortPromise])])
      if (deadline?.isExpired() === true) return

      if (response.error != null) {
        logger.warning('Best-effort session title re-assertion failed', {
          sessionId,
          sessionTitle: title,
          error: String(response.error),
        })
      }
    } finally {
      if (deadline != null && onAbort != null) deadline.signal.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    if (deadline?.isExpired() === true) return
    logger.warning('Best-effort session title re-assertion failed', {
      sessionId,
      sessionTitle: title,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
