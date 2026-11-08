import {homedir} from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

/**
 * The global OpenCode config dir the server reads: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
 *
 * Upstream derives it from `xdg-basedir` (`packages/core/src/global.ts:13`) and `config/config.ts:413` merges
 * `<that dir>/opencode.json` into every server's config. `OPENCODE_CONFIG_DIR` does NOT move this layer
 * (`Global.Path.config` is the plain XDG path, `global.ts:21`); it only adds another directory. `filterAgentEnv`
 * lets `XDG_*` through to the server child, so a runner that sets `XDG_CONFIG_HOME` reads from there and a
 * hard-coded `~/.config` would put everything setup writes (`opencode.json`, Systematic config, session tools)
 * where the server never looks. The guard plugin file lives here too, but it is loaded by explicit path.
 */
export function defaultOpenCodeConfigDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() ?? ''
  return xdgConfigHome.length > 0 ? path.join(xdgConfigHome, 'opencode') : path.join(homedir(), '.config', 'opencode')
}
