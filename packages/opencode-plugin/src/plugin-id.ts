/**
 * The plugin id. Stable and explicit on purpose: a plugin the host cannot load is skipped while the server stays up, and
 * the surfaces confirm a safety plugin loaded by looking this id up in `GET /api/plugin` with status `active` (probe
 * P13). An entry with no `id` is a module that exported no valid definition. Never derive it from the package name or
 * version.
 */
export const FRO_BOT_PLUGIN_ID = 'fro-bot.opencode-plugin'
