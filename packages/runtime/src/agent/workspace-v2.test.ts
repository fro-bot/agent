import {describe, expect, it} from 'vitest'

import {DEFAULT_SYSTEMATIC_VERSION} from '../shared/constants.js'
import * as workspaceV2 from './workspace-v2.js'

describe('workspace V2 entry', () => {
  it('exposes the spawn, config and gate pieces the workspace agent needs', () => {
    // #then the subpath carries each runtime piece by name, so a consumer never imports the full barrel
    expect(typeof workspaceV2.startOpenCodeV2Server).toBe('function')
    expect(typeof workspaceV2.buildWorkspaceConfigV2).toBe('function')
    expect(typeof workspaceV2.verifyPermissionRules).toBe('function')
    expect(workspaceV2.DEFAULT_OPENCODE_V2_TIMEOUTS.pollIntervalMs).toBeGreaterThan(0)
  })

  it('pins Systematic for V2 at exactly 3.27.0, the first release that loads there', () => {
    // #then the V2 pin is exact, with no range, and names the plugin id the V2 build registers
    expect(workspaceV2.SYSTEMATIC_V2_VERSION).toBe('3.27.0')
    expect(workspaceV2.SYSTEMATIC_V2_PLUGIN_ID).toBe('systematic')
    expect(workspaceV2.SYSTEMATIC_PACKAGE).toBe('@fro.bot/systematic')
  })

  it('leaves the V1 Systematic default untouched', () => {
    // #then the V1 default is the version V1 images and Action runs install
    expect(DEFAULT_SYSTEMATIC_VERSION).toBe('3.26.4')
  })

  it('pins the fro-bot plugin at an exact version', () => {
    expect(workspaceV2.FRO_BOT_PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(workspaceV2.FRO_BOT_PLUGIN_PACKAGE).toBe('@fro.bot/opencode-plugin')
    expect(workspaceV2.FRO_BOT_PLUGIN_ID).toBe('fro-bot.opencode-plugin')
  })
})
