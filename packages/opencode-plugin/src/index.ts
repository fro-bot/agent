/**
 * `@fro.bot/opencode-plugin`: Fro Bot's OpenCode V2 plugin.
 *
 * - the session tools (`session_list`, `session_read`, `session_search`, `session_info`), and
 * - the subagent session-reuse guard (`execute.before` on `subagent` + `sessionID`).
 *
 * `effect` and `@opencode/plugin` are provided by the host at load time and must stay external in the bundle
 * (`tsdown.config.ts`). The public surface is the default export and the id; everything else is internal.
 */

import {Plugin} from '@opencode/plugin'
import {FRO_BOT_PLUGIN_ID} from './plugin-id.js'
import {setupFroBotPlugin} from './setup.js'

export {FRO_BOT_PLUGIN_ID} from './plugin-id.js'

export default Plugin.define({
  id: FRO_BOT_PLUGIN_ID,
  setup: async ctx => setupFroBotPlugin(ctx),
})
