import type {Logger} from '../shared/logger.js'

import {createOpencodeClient} from '@opencode-ai/sdk/v2/client'

export async function archiveSession(baseUrl: string, sessionId: string, logger: Logger): Promise<boolean> {
  try {
    const client = createOpencodeClient({baseUrl})
    const response = await client.session.update({
      sessionID: sessionId,
      time: {archived: Date.now()},
    })

    if (response.error != null) {
      logger.warning('SDK session archive failed', {sessionId, error: String(response.error)})
      return false
    }

    logger.debug('Archived session via SDK', {sessionId})
    return true
  } catch (error: unknown) {
    logger.warning('SDK session archive failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
