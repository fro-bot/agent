import {describe, expect, it} from 'vitest'

import * as workspaceV2 from './workspace-v2.js'

describe('workspace V2 entry', () => {
  it('exposes the spawn, config and gate pieces the workspace agent needs', () => {
    // #then the subpath carries each runtime piece by name, so a consumer never imports the full barrel
    expect(typeof workspaceV2.startOpenCodeV2Server).toBe('function')
    expect(typeof workspaceV2.buildWorkspaceConfigV2).toBe('function')
    expect(typeof workspaceV2.verifyPermissionRules).toBe('function')
    expect(workspaceV2.DEFAULT_OPENCODE_V2_TIMEOUTS.pollIntervalMs).toBeGreaterThan(0)
  })

  it('installs Systematic for V2 at the shared default, an exact version with no range', () => {
    // #then V1 and V2 share one Systematic pin, and the V2 build registers the plugin under the expected id
    expect(workspaceV2.DEFAULT_SYSTEMATIC_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(workspaceV2).not.toHaveProperty('SYSTEMATIC_V2_VERSION')
    expect(workspaceV2.SYSTEMATIC_V2_PLUGIN_ID).toBe('systematic')
    expect(workspaceV2.SYSTEMATIC_PACKAGE).toBe('@fro.bot/systematic')
  })

  it('pins the fro-bot plugin at an exact version', () => {
    expect(workspaceV2.FRO_BOT_PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(workspaceV2.FRO_BOT_PLUGIN_PACKAGE).toBe('@fro.bot/opencode-plugin')
    expect(workspaceV2.FRO_BOT_PLUGIN_ID).toBe('fro-bot.opencode-plugin')
  })
})
