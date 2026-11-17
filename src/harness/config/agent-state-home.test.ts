import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {resolveAgentStateHome} from './agent-state-home.js'

describe('resolveAgentStateHome', () => {
  let root: string
  let workspace: string
  let outside: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-state-home-')))
    workspace = path.join(root, 'work', 'repo')
    outside = path.join(root, 'elsewhere')
    fs.mkdirSync(workspace, {recursive: true})
    fs.mkdirSync(outside, {recursive: true})
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('accepts a directory under the checkout, existing or not, and returns it untouched', () => {
    // #given an existing directory and one whose parents do not exist yet
    const existing = path.join(workspace, 'connect', 'state')
    fs.mkdirSync(existing, {recursive: true})
    const missing = path.join(workspace, 'not', 'yet', 'there')

    // #when resolved
    const first = resolveAgentStateHome(existing, workspace)
    const second = resolveAgentStateHome(missing, workspace)

    // #then both resolve, and nothing is created by the resolver
    expect(first).toEqual({success: true, data: existing})
    expect(second).toEqual({success: true, data: missing})
    expect(fs.existsSync(path.join(workspace, 'not'))).toBe(false)
  })

  it('normalizes a trailing slash and dot segments to one spelling', () => {
    // #given a path with a trailing slash and a `.` segment
    const result = resolveAgentStateHome(`${workspace}/connect/./state/`, workspace)

    // #then
    expect(result).toEqual({success: true, data: path.join(workspace, 'connect', 'state')})
  })

  it('refuses a relative path', () => {
    // #when
    const result = resolveAgentStateHome('connect/state', workspace)

    // #then
    expect(!result.success && result.error.message).toContain('absolute')
  })

  it.each([
    ['a sibling of the checkout', (): string => path.join(root, 'work', 'other')],
    ['a sibling that shares the checkout name as a prefix', (): string => `${workspace}-evil`],
    ['the checkout parent', (): string => path.dirname(workspace)],
    ['a `..` escape', (): string => `${workspace}/connect/../../escape`],
    ['the filesystem root', (): string => path.parse(workspace).root],
  ])('refuses %s', (_label, build) => {
    // #when
    const result = resolveAgentStateHome(build(), workspace)

    // #then
    expect(!result.success && result.error.message).toContain('inside the checkout')
  })

  it('refuses the checkout itself', () => {
    // #when
    const result = resolveAgentStateHome(workspace, workspace)

    // #then
    expect(!result.success && result.error.message).toContain('inside the checkout')
  })

  it('refuses a final component that is a symlink, even to a directory inside the checkout', () => {
    // #given a link whose target is inside the checkout, and one that points out of it
    fs.mkdirSync(path.join(workspace, 'real'))
    fs.symlinkSync(path.join(workspace, 'real'), path.join(workspace, 'inside-link'))
    fs.symlinkSync(outside, path.join(workspace, 'out-link'))

    // #when
    const inside = resolveAgentStateHome(path.join(workspace, 'inside-link'), workspace)
    const out = resolveAgentStateHome(path.join(workspace, 'out-link'), workspace)

    // #then both are refused as symlinks
    expect(!inside.success && inside.error.message).toContain('symlink')
    expect(!out.success && out.error.message).toContain('symlink')
  })

  it('refuses a parent that is a symlink out of the checkout, whether or not the leaf exists', () => {
    // #given a link in the checkout that points at a directory outside it
    fs.symlinkSync(outside, path.join(workspace, 'link'))
    fs.mkdirSync(path.join(outside, 'state'))

    // #when the leaf exists behind the link, and when it does not
    const existing = resolveAgentStateHome(path.join(workspace, 'link', 'state'), workspace)
    const missing = resolveAgentStateHome(path.join(workspace, 'link', 'new'), workspace)

    // #then
    expect(!existing.success && existing.error.message).toContain('symlink')
    expect(!missing.success && missing.error.message).toContain('symlink')
  })

  it('refuses an existing path that is not a directory', () => {
    // #given a regular file
    const file = path.join(workspace, 'state-file')
    fs.writeFileSync(file, 'x')

    // #when
    const result = resolveAgentStateHome(file, workspace)

    // #then
    expect(!result.success && result.error.message).toContain('not a directory')
  })

  it('refuses a path under .git, which the take-back restores from a snapshot', () => {
    // #when
    const result = resolveAgentStateHome(path.join(workspace, '.git', 'state'), workspace)

    // #then
    expect(!result.success && result.error.message).toContain('.git')
  })

  it.each([undefined, '', '  '])('refuses when the checkout is unknown (%j)', unset => {
    // #when
    const result = resolveAgentStateHome(path.join(workspace, 'state'), unset)

    // #then
    expect(!result.success && result.error.message).toContain('GITHUB_WORKSPACE')
  })
})
