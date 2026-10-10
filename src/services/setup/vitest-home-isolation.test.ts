import {realpathSync} from 'node:fs'
import {homedir, tmpdir, userInfo} from 'node:os'
import {isAbsolute, relative} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'

import {defaultOpenCodeConfigDir} from './no-task-reuse-config.js'

// Live evals opt out of isolation (see vitest-home-isolation.setup.ts).
const isolationEnabled = process.env.FRO_BOT_EVAL !== '1'

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel.startsWith('..') === false && isAbsolute(rel) === false
}

const tempRoot = realpathSync(tmpdir())

describe.skipIf(isolationEnabled === false)('vitest home isolation', () => {
  it('points os.homedir() at a temp dir, not the real home', () => {
    // #given the real home recorded by the OS user database (independent of $HOME)
    const realHome = userInfo().homedir

    // #when / #then
    expect(isInside(tempRoot, homedir())).toBe(true)
    expect(homedir()).not.toBe(realHome)
    expect(isInside(realHome, homedir())).toBe(false)
  })

  it.each(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'])(
    'points %s at a temp dir outside the real home',
    name => {
      // #given
      const realHome = userInfo().homedir
      const value = process.env[name]

      // #then
      expect(value).toBeDefined()
      expect(isInside(tempRoot, value ?? '')).toBe(true)
      expect(isInside(realHome, value ?? '')).toBe(false)
    },
  )

  it('resolves the default OpenCode config dir under temp', () => {
    // #when the production default (reads the ambient env)
    const configDir = defaultOpenCodeConfigDir()

    // #then
    expect(isInside(tempRoot, configDir)).toBe(true)
    expect(isInside(userInfo().homedir, configDir)).toBe(false)
  })

  it('resolves the home-based fallback under temp when XDG_CONFIG_HOME is unset', () => {
    // #given XDG_CONFIG_HOME removed so the `homedir()/.config` fallback applies
    const {XDG_CONFIG_HOME: saved} = process.env
    delete process.env.XDG_CONFIG_HOME

    try {
      // #when / #then
      expect(isInside(tempRoot, defaultOpenCodeConfigDir())).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = saved
    }
  })
})
