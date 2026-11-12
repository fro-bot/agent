import {describe, expect, it} from 'vitest'
import {safeEnvPath, safeEnvToken} from './v2-server.sandbox.harness.js'

describe('safeEnvPath', () => {
  it.each([
    '/home/runner/work/_temp/_runner_file_commands/set_env_3f2a-1b',
    '/home/runner/work/_temp',
    '/var/lib/x_y+z@1.2/file.txt',
  ])('keeps a plain absolute path: %s', value => {
    // #given an env-derived value that is a plain absolute path
    // #then it is used as is
    expect(safeEnvPath(value, '/fallback')).toBe(value)
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['relative', 'work/_temp'],
    ['a command separator', '/tmp/x; touch /tmp/pwned'],
    ['a command substitution', '/tmp/$(id)'],
    ['a backtick substitution', '/tmp/`id`'],
    ['a single quote', "/tmp/x'y"],
    ['a double quote', '/tmp/x"y'],
    ['a space', '/tmp/x y'],
    ['a newline', '/tmp/x\nid'],
    ['a glob', '/tmp/*'],
    ['a parent segment', '/tmp/../etc/passwd'],
    ['a pipe', '/tmp/x|id'],
  ])('falls back for %s', (_label, value) => {
    // #given a value that could change the meaning of a shell command it is embedded in
    // #then the fallback is used instead
    expect(safeEnvPath(value, '/fallback')).toBe('/fallback')
  })
})

describe('safeEnvToken', () => {
  it('keeps a plain token and falls back for anything with shell meaning', () => {
    // #given
    // #then only word characters, dots and dashes survive
    expect(safeEnvToken('dummy-probe_token.1', 'fb')).toBe('dummy-probe_token.1')
    expect(safeEnvToken('a b', 'fb')).toBe('fb')
    expect(safeEnvToken('a;b', 'fb')).toBe('fb')
    expect(safeEnvToken("a'b", 'fb')).toBe('fb')
    expect(safeEnvToken(undefined, 'fb')).toBe('fb')
  })
})
