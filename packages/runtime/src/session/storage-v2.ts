/** V2 sibling of `storage.ts`: reads against a `SessionClientV2`, returning a `Result` so an outage is not "no sessions". */

import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {SessionClientV2} from './backend-v2.js'
import type {MessageV2, SessionInfoV2, TodoItemV2} from './types-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {toError} from '../shared/errors.js'
import {mapSessionInfoV2, mapSessionPageV2} from './storage-mappers-v2.js'
import {latestTodosV2, mapMessagesV2} from './storage-message-mappers-v2.js'

const SESSION_LIST_PAGE_SIZE = 100

/** Upper bound on pages followed per listing: 10 pages of 100 sessions. */
export const SESSION_LIST_MAX_PAGES = 10

/** Lists root, unarchived sessions created in `directory` (exact string match), newest first, up to a page bound. */
export async function listSessionsForDirectoryV2(
  client: SessionClientV2,
  directory: string,
  logger: Logger,
): Promise<Result<readonly SessionInfoV2[], Error>> {
  const sessions: SessionInfoV2[] = []
  let cursor: string | undefined

  for (let page = 0; page < SESSION_LIST_MAX_PAGES; page += 1) {
    let payload: unknown
    try {
      payload = await client.list({
        directory,
        limit: SESSION_LIST_PAGE_SIZE,
        order: 'desc',
        parentID: null,
        archived: false,
        ...(cursor == null ? {} : {cursor}),
      })
    } catch (error) {
      logger.warning('V2 session list failed', {source: 'listSessionsForDirectoryV2', error: toError(error).message})
      return err(toError(error))
    }

    const parsed = mapSessionPageV2(payload)
    if (parsed == null) {
      logger.warning('V2 session list returned a payload that is not a session list', {
        source: 'listSessionsForDirectoryV2',
        type: typeof payload,
      })
      return err(new Error('session list response was not a session list'))
    }

    sessions.push(...parsed.sessions)
    // Stop on an empty page or a cursor that did not advance.
    if (parsed.sessions.length === 0 || parsed.nextCursor == null || parsed.nextCursor === cursor) break
    cursor = parsed.nextCursor
  }

  return ok(sessions)
}

/** Resolves to `ok(null)` when the session does not exist. */
export async function getSessionV2(
  client: SessionClientV2,
  sessionID: string,
  logger: Logger,
): Promise<Result<SessionInfoV2 | null, Error>> {
  let payload: unknown
  try {
    payload = await client.get(sessionID)
  } catch (error) {
    logger.warning('V2 session get failed', {source: 'getSessionV2', error: toError(error).message})
    return err(toError(error))
  }

  if (payload == null) return ok(null)
  const session = mapSessionInfoV2(payload)
  if (session == null) {
    logger.warning('V2 session get returned an unparseable payload', {source: 'getSessionV2', type: typeof payload})
    return err(new Error('session response was not a session'))
  }
  return ok(session)
}

export async function getSessionMessagesV2(
  client: SessionClientV2,
  sessionID: string,
  logger: Logger,
): Promise<Result<readonly MessageV2[], Error>> {
  let payload: unknown
  try {
    payload = await client.messages(sessionID)
  } catch (error) {
    logger.warning('V2 session messages failed', {source: 'getSessionMessagesV2', error: toError(error).message})
    return err(toError(error))
  }

  const messages = mapMessagesV2(payload)
  if (messages == null) {
    logger.warning('V2 session messages returned a non-list payload', {
      source: 'getSessionMessagesV2',
      type: typeof payload,
    })
    return err(new Error('session messages response was not a message list'))
  }
  return ok(messages)
}

/** V2 has no todo endpoint; the list is whatever the last completed `todowrite` call in the readable messages set. */
export async function getSessionTodosV2(
  client: SessionClientV2,
  sessionID: string,
  logger: Logger,
): Promise<Result<readonly TodoItemV2[], Error>> {
  const messages = await getSessionMessagesV2(client, sessionID, logger)
  return messages.success ? ok(latestTodosV2(messages.data)) : messages
}
