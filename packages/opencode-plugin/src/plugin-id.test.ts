import {readFileSync} from 'node:fs'
import {FRO_BOT_PLUGIN_PACKAGE, FRO_BOT_PLUGIN_ID as RUNTIME_PLUGIN_ID} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'

import {FRO_BOT_PLUGIN_ID} from './plugin-id.js'

describe('plugin identity', () => {
  it('matches the id the surfaces gate on', () => {
    // #given the id this package registers and the id runtime's plugin gate looks for
    // #when / #then they must be the same string, or a loaded plugin would read as missing
    expect(FRO_BOT_PLUGIN_ID).toBe(RUNTIME_PLUGIN_ID)
  })

  it('matches the published package name runtime installs', () => {
    // #given
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {name: string}

    // #when / #then
    expect(manifest.name).toBe(FRO_BOT_PLUGIN_PACKAGE)
  })
})
