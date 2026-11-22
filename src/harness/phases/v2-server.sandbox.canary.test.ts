import {Buffer} from 'node:buffer'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  bodyStrings,
  canaryForms,
  canaryShapedValue,
  plantScanControls,
  SCAN_PROGRAM,
  scanCommand,
  scanConfig,
  sha256Hex,
  type ScanSpec,
} from './v2-server.sandbox.canary.js'

const spec: ScanSpec = {
  canary: canaryShapedValue('sk-trace-canary-', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2'),
  liveControl: canaryShapedValue('sk-trace-live-', '0123456789abcdef0123456789abcdef0123'),
  xdgTextControl: canaryShapedValue('sk-trace-xdgt-', 'fedcba9876543210fedcba9876543210fedc'),
  xdgBinaryControl: canaryShapedValue('sk-trace-xdgb-', '1357924680acebdf1357924680acebdf1357'),
  runnerTemp: '/nonexistent-runner-temp',
  checkout: [],
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true})
})
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-scan-'))
  roots.push(dir)
  return dir
}
const python = spawnSync('python3', ['--version']).status === 0

/** Runs the scanner as the sandbox would: the config and a scratch directory, with the XDG roots of the given directory. */
function runScan(overrides: Partial<ScanSpec>, xdgRoot: string, extraDir: string): Map<string, string> {
  const result = spawnSync('python3', ['-c', SCAN_PROGRAM, scanConfig({...spec, ...overrides}), extraDir], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: path.join(xdgRoot, 'home'),
      XDG_DATA_HOME: path.join(xdgRoot, 'data'),
      XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
      XDG_CACHE_HOME: path.join(xdgRoot, 'cache'),
      XDG_STATE_HOME: path.join(xdgRoot, 'state'),
    },
  })
  expect(result.status).toBe(0)
  const line = result.stdout.split('\n').find(text => text.startsWith('RESULT canary_scan '))
  expect(line).toBeDefined()
  return new Map(
    (line ?? '')
      .split(' ')
      .filter(part => part.includes('='))
      .map(part => part.split('=') as [string, string]),
  )
}

/** The agent's layout: each XDG root holds an `opencode` link to the runner's directory. */
function layout(): {xdgRoot: string; runner: string; extra: string} {
  const base = tempDir()
  const runner = path.join(base, 'runner-xdg')
  const agent = path.join(base, 'agent')
  for (const kind of ['data', 'config', 'cache', 'state']) {
    fs.mkdirSync(path.join(runner, kind, 'opencode'), {recursive: true})
    fs.mkdirSync(path.join(agent, kind), {recursive: true})
    fs.symlinkSync(path.join(runner, kind, 'opencode'), path.join(agent, kind, 'opencode'))
  }
  fs.mkdirSync(path.join(agent, 'home'))
  const extra = path.join(base, 'extra')
  fs.mkdirSync(extra)
  return {xdgRoot: agent, runner, extra}
}

describe('the sandbox scan command', () => {
  it('holds a fingerprint of the canary and no part of it', () => {
    // #given the command the sandbox is given
    const command = scanCommand(spec)

    // #then its hash is in it, and neither the canary nor any run of 8 characters of its random part is (the shape prefix is
    // shared with the control values on purpose)
    expect(command).toContain(sha256Hex(spec.canary))
    expect(command).not.toContain(spec.canary)
    for (let index = 'sk-trace-canary-'.length; index + 8 <= spec.canary.length; index += 1) {
      expect(command).not.toContain(spec.canary.slice(index, index + 8))
    }
    // #and the runner's planted controls are not in it either, only their hashes
    expect(command).not.toContain(spec.xdgTextControl)
    expect(command).not.toContain(spec.xdgBinaryControl)
  })
})

describe.skipIf(!python)('the scanner', () => {
  it('finds a control in a text file and in a binary file behind nested opencode links', () => {
    // #given the runner's controls planted in the directories the agent's links point at
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)

    // #when the scanner runs with the agent's XDG roots
    const counts = runScan({}, xdgRoot, extra)

    // #then it found both controls through the links, and read at least those two files
    expect(counts.get('ctl.xdgtext.xdg')).toBe('1')
    expect(counts.get('ctl.xdgbin.xdg')).toBe('1')
    expect(Number(counts.get('read.xdg'))).toBeGreaterThanOrEqual(2)
    // #and the canary was not anywhere
    expect(counts.get('canary.xdg')).toBe('0')
  })

  it('finds the canary in a binary file and in a text file behind the links, and reports counts only', () => {
    // #given the canary in a database-like file and in a log
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    fs.writeFileSync(
      path.join(runner, 'data', 'opencode', 'opencode.db'),
      Buffer.concat([Buffer.from([0, 0, 0xfa]), Buffer.from(spec.canary), Buffer.from([0, 0xfb])]),
    )
    fs.writeFileSync(path.join(runner, 'state', 'opencode', 'x.log'), `Authorization: Bearer ${spec.canary}\n`)

    // #when
    const counts = runScan({}, xdgRoot, extra)

    // #then both files are counted, and nothing but counts is printed
    expect(counts.get('canary.xdg')).toBe('2')
  })

  it('does not follow a link met inside a walk, so the links must be named', () => {
    // #given the canary behind a nested link in the checkout
    const {xdgRoot, extra} = layout()
    const checkout = path.join(tempDir(), 'checkout')
    const hidden = path.join(tempDir(), 'hidden')
    fs.mkdirSync(checkout)
    fs.mkdirSync(hidden)
    fs.writeFileSync(path.join(hidden, 'f.txt'), spec.canary)
    fs.symlinkSync(hidden, path.join(checkout, 'nested'))

    // #then a walk of the checkout does not reach it
    expect(runScan({checkout: [checkout]}, xdgRoot, extra).get('canary.checkout')).toBe('0')
    // #but naming the link target as a root does
    expect(runScan({checkout: [hidden]}, xdgRoot, extra).get('canary.checkout')).toBe('1')
  })

  it('finds the canary inside a longer token, and the live control in the scratch directory', () => {
    // #given the canary glued to other token characters, and the live control written into the scratch directory
    const {xdgRoot, extra} = layout()
    const checkout = tempDir()
    fs.writeFileSync(path.join(checkout, 'a.txt'), `prefix_${spec.canary}_suffix`)
    fs.writeFileSync(path.join(extra, 'notes.txt'), spec.liveControl)

    // #when
    const counts = runScan({checkout: [checkout]}, xdgRoot, extra)

    // #then both are found
    expect(counts.get('canary.checkout')).toBe('1')
    expect(counts.get('ctl.live.file')).toBe('1')
  })

  it('fails when a detector control is not seen, naming it', () => {
    // #given nothing planted
    const {xdgRoot, extra} = layout()

    // #when
    const result = spawnSync('python3', ['-c', SCAN_PROGRAM, scanConfig(spec), extra], {
      encoding: 'utf8',
      env: {PATH: process.env.PATH ?? '', XDG_DATA_HOME: path.join(xdgRoot, 'data')},
    })

    // #then the verdict is FAILED, so an empty result is never read as a pass
    expect(result.stdout).toMatch(/^RESULT canary_scan FAILED a detector control was not seen: .*xdgtext\.xdg/)
  })
})

describe('canaryForms', () => {
  const canary = spec.canary
  const body = (value: string): Buffer => Buffer.from(JSON.stringify({attributes: [{value: {stringValue: value}}]}))

  it('finds nothing in a body that does not hold the canary', () => {
    expect(canaryForms(body('an ordinary tool result with a sha 3b9a'), canary)).toEqual([])
  })

  it('finds the canary as written, in a JSON string', () => {
    expect(canaryForms(body(`Authorization: Bearer ${canary}`), canary)).toContain('contiguous')
  })

  it('finds it when every character is a unicode escape', () => {
    const escaped = [...canary].map(char => String.raw`\u` + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')
    const raw = Buffer.from(`{"a":"${escaped}"}`)
    expect(canaryForms(raw, canary)).toContain('escaped')
    expect(canaryForms(raw, canary)).toContain('contiguous')
  })

  it('finds both halves of it in one body, even when they are apart', () => {
    const half = Math.floor(canary.length / 2)
    expect(canaryForms(body(`${canary.slice(0, half)} then ${canary.slice(half)}`), canary)).toEqual(['halves'])
  })

  it('finds one half and nothing else as clean', () => {
    expect(canaryForms(body(canary.slice(0, 10)), canary)).toEqual([])
  })

  it.each([0, 1, 2])('finds it base64-encoded at alignment %i, standard and URL-safe', offset => {
    const message = Buffer.from(`${'y'.repeat(offset)}${canary}-and-more-text`)
    expect(canaryForms(body(message.toString('base64')), canary)).toContain('base64')
    expect(canaryForms(body(message.toString('base64url')), canary)).toContain('base64url')
  })

  it('finds it as hex', () => {
    expect(canaryForms(body(Buffer.from(canary).toString('hex')), canary)).toEqual(['hex'])
  })

  it('reads the strings of a body, keys included, and none of one that is not JSON', () => {
    expect(bodyStrings(Buffer.from('{"k":["v",{"n":"w"}]}'))).toEqual(['k', 'v', 'n', 'w'])
    expect(bodyStrings(Buffer.from('not json'))).toEqual([])
  })
})
