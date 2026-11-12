import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {describeReconstruction, readSessionIds, safeEnvPath, safeEnvToken} from './v2-server.sandbox.harness.js'

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

describe('readSessionIds', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-ids-')))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  function database(statements: string): string {
    const file = path.join(dir, 'opencode-v2.db')
    const db = new DatabaseSync(file)
    db.exec(statements)
    db.close()
    return file
  }

  it('reads ids from session_v2, the table OpenCode 2.2.x keeps sessions in', () => {
    // #given a database shaped like the real one (columns abbreviated)
    const file = database(
      "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, time_suspended INTEGER); INSERT INTO session_v2 (id, project_id) VALUES ('ses_b', 'p'), ('ses_a', 'p')",
    )

    // #when / #then
    expect(readSessionIds(file)).toEqual(['ses_a', 'ses_b'])
  })

  it('names the tables that exist when session_v2 is missing, instead of an opaque SQL error', () => {
    // #given the V1 shape
    const file = database('CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT)')

    // #when / #then
    expect(() => readSessionIds(file)).toThrow(/no session_v2 table; tables: message, session/)
  })
})

describe('describeReconstruction', () => {
  it('names the refusal reason, and reports the other outcomes', () => {
    // #given each outcome
    // #then a failure carries its message, so a CI assertion shows why
    expect(describeReconstruction(undefined)).toBe('reconstruction did not run')
    expect(
      describeReconstruction({
        success: false,
        error: new Error('.gitattributes: only regular files may be reconstructed'),
      }),
    ).toBe('reconstruction failed: .gitattributes: only regular files may be reconstructed')
    expect(describeReconstruction({success: true, data: {kind: 'nothing-to-deliver'}})).toBe(
      'reconstruction returned kind nothing-to-deliver',
    )
    expect(describeReconstruction({success: true, data: {kind: 'changes'}})).toBe('ok')
  })
})
