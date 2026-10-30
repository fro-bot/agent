/** `@fro.bot/opencode-plugin`: the session tools and the subagent session-reuse guard. */

import {Plugin} from '@opencode/plugin'
import {FRO_BOT_PLUGIN_ID} from './plugin-id.js'
import {setupFroBotPlugin} from './setup.js'

export {FRO_BOT_PLUGIN_ID} from './plugin-id.js'

export default Plugin.define({
  id: FRO_BOT_PLUGIN_ID,
  setup: async ctx => setupFroBotPlugin(ctx),
})
