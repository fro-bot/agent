import type {Logger} from '../shared/logger.js'

// The v1 session client can read time.archived, but its typed session.update body only exposes {title?}.
// Archiving writes time.archived, so this helper must use the v2 session.update endpoint.
import {createOpencodeClient} from '@opencode-ai/sdk/v2/client'
import {formatSdkError, toErrorMessage} from '../shared/errors.js'

export async function archiveSession(baseUrl: string, sessionId: string, logger: Logger): Promise<boolean> {
  try {
    const client = createOpencodeClient({baseUrl})
    const response = await client.session.update({
      sessionID: sessionId,
      time: {archived: Date.now()},
    })

    if (response.error != null) {
      logger.warning('SDK session archive failed', {sessionId, error: formatSdkError(response.error)})
      return false
    }

    logger.debug('Archived session via SDK', {sessionId})
    return true
  } catch (error: unknown) {
    logger.warning('SDK session archive failed', {
      sessionId,
      error: toErrorMessage(error),
    })
    return false
  }
}
