/**
 * V2 session model entry point, published as the `@fro-bot/runtime/session-v2` subpath.
 *
 * A separate entry (not the package barrel) so a consumer that bundles it, namely `@fro.bot/opencode-plugin`, pulls in
 * only the V2 session code and not the whole runtime with its SDK, Octokit and zod dependencies. Sits beside the V1
 * `index.ts`; nothing here imports `@opencode-ai/sdk`.
 */

export type {SessionClientV2, SessionListQueryV2} from './backend-v2.js'

export {getSessionInfoV2, listSessionsV2, SEARCH_MAX_SESSIONS, searchSessionsV2} from './search-v2.js'

export type {SessionDetailsV2} from './search-v2.js'

export {
  getSessionMessagesV2,
  getSessionTodosV2,
  getSessionV2,
  listSessionsForDirectoryV2,
  SESSION_LIST_MAX_PAGES,
} from './storage-v2.js'

export type {MessageV2, PartV2, SessionInfoV2, TodoItemV2} from './types-v2.js'
