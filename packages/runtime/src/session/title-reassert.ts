import type {Logger} from '../shared/logger.js'
import type {SessionClient} from './backend.js'

export async function reassertSessionTitle(
  client: SessionClient,
  sessionId: string,
  title: string | undefined,
  logger: Logger,
): Promise<void> {
  if (title == null) {
    return
  }

  try {
    const response = await client.session.update({
      path: {id: sessionId},
      body: {title} as Record<string, unknown>,
    })

    if (response.error != null) {
      logger.warning('Best-effort session title re-assertion failed', {
        sessionId,
        sessionTitle: title,
        error: String(response.error),
      })
    }
  } catch (error) {
    logger.warning('Best-effort session title re-assertion failed', {
      sessionId,
      sessionTitle: title,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
