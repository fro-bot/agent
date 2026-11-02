import {describe, expect, it} from 'vitest'

import {synthesizeApprovalMetadata} from './permission-detail-v2.js'

describe('synthesizeApprovalMetadata', () => {
  it('reads a shell ask’s resource as the command', () => {
    // #given — the resource of the captured 2.2.5 shell ask
    // #then
    expect(synthesizeApprovalMetadata('shell', ['echo hi'])).toEqual({command: 'echo hi'})
  })

  it('lists every command of a multi-command shell ask, so none is approved unseen', () => {
    // #given — `cd src && rg todo | head`: upstream raises one resource per parsed command (shell.ts:133-134)
    // #then — a visible separator: the frame builder strips newlines, which would fuse the commands
    expect(synthesizeApprovalMetadata('shell', ['cd src', 'rg todo', 'head'])).toEqual({
      command: 'cd src; rg todo; head',
    })
  })

  it.each(['external_directory', 'read', 'edit'])('reads a %s ask’s resource as the file path', action => {
    // #then
    expect(synthesizeApprovalMetadata(action, ['/etc/hosts'])).toEqual({filepath: '/etc/hosts'})
  })

  it('lists every file of a multi-file edit ask the way upstream joins a patch’s filepath', () => {
    // #given — an `apply_patch` over two files: one `edit` ask with both targets (patch.ts:220-221)
    // #then
    expect(synthesizeApprovalMetadata('edit', ['src/a.ts', 'src/b.ts'])).toEqual({filepath: 'src/a.ts, src/b.ts'})
  })

  it.each([
    ['grep', ['TODO|FIXME']],
    ['glob', ['**/*.ts']],
    ['webfetch', ['https://example.com']],
    ['skill', ['brainstorm']],
    ['subagent', ['general']],
    ['todo', ['*']],
    ['some_mcp_tool', ['*']],
  ])('synthesizes nothing for %s: its resources are not a path or command', (action, resources) => {
    // #then — `patterns` stays the detail; calling a regex or URL a `filepath` would mislabel it
    expect(synthesizeApprovalMetadata(action, resources)).toBeUndefined()
  })

  it('synthesizes nothing when the ask names no resource', () => {
    // #then
    expect(synthesizeApprovalMetadata('shell', [])).toBeUndefined()
    expect(synthesizeApprovalMetadata('edit', [''])).toBeUndefined()
  })
})
