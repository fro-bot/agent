import type {SessionClient} from './backend.js'
import type {Logger} from './types.js'

export async function deleteSession(client: SessionClient, sessionID: string, logger: Logger): Promise<number> {
  const sessionClient = client.session as unknown as {
    delete: (args: {path: {id: string}}) => Promise<{data?: unknown; error?: unknown}>
  }
  const response = await sessionClient.delete({path: {id: sessionID}})
  if (response.error != null) {
    logger.warning('SDK session delete failed', {sessionID, error: String(response.error)})
    return 0
  }

  logger.debug('Deleted session via SDK', {sessionID})
  return 0
}
