import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {defaultOpenCodeConfigDir} from './opencode-config-dir.js'

describe('defaultOpenCodeConfigDir', () => {
  it('defaults the config dir to ~/.config/opencode', () => {
    // #given/#when/#then
    expect(defaultOpenCodeConfigDir({})).toBe(path.join(os.homedir(), '.config', 'opencode'))
  })

  it('follows XDG_CONFIG_HOME, the directory the server reads its global config from', () => {
    // #given a runner that relocates XDG_CONFIG_HOME (filterAgentEnv forwards XDG_* to the server)
    // #when/#then the guard is registered where the server looks, not under a hard-coded ~/.config
    expect(defaultOpenCodeConfigDir({XDG_CONFIG_HOME: '/srv/xdg'})).toBe('/srv/xdg/opencode')
  })

  it('ignores an empty XDG_CONFIG_HOME (GitHub Actions materializes unset env as an empty string)', () => {
    // #given/#when/#then
    expect(defaultOpenCodeConfigDir({XDG_CONFIG_HOME: '  '})).toBe(path.join(os.homedir(), '.config', 'opencode'))
  })
})
