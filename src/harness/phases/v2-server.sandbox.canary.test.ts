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
  exportedSpans,
  plantScanControls,
  SCAN_PROGRAM,
  scanCommand,
  scanConfig,
  sha256Hex,
  toolSpanHoldsArgument,
  type ScanSpec,
} from './v2-server.sandbox.canary.js'

const spec: ScanSpec = {
  canary: canaryShapedValue('sk-trace-canary-', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2'),
  liveControl: canaryShapedValue('sk-trace-live-', '0123456789abcdef0123456789abcdef0123'),
  xdgTextControl: canaryShapedValue('sk-trace-xdgt-', 'fedcba9876543210fedcba9876543210fedc'),
  xdgBinaryControl: canaryShapedValue('sk-trace-xdgb-', '1357924680acebdf1357924680acebdf1357'),
  longControl: canaryShapedValue('sk-trace-long-', '2468013579bdface2468013579bdface2468'),
  boundaryControl: canaryShapedValue('sk-trace-edge-', '9876543210fedcba9876543210fedcba9876'),
  chunkBytes: 4096,
  // The verdict tests run where there is no /proc too; the container run requires the process controls.
  requireProcControls: false,
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
function runScan(overrides: Partial<ScanSpec>, xdgRoot: string, extraDir: string, preamble = ''): Map<string, string> {
  const result = spawnSync(
    'python3',
    ['-c', `${preamble}\n${SCAN_PROGRAM}`, scanConfig({...spec, ...overrides}), extraDir],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: path.join(xdgRoot, 'home'),
        XDG_DATA_HOME: path.join(xdgRoot, 'data'),
        XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
        XDG_CACHE_HOME: path.join(xdgRoot, 'cache'),
        XDG_STATE_HOME: path.join(xdgRoot, 'state'),
      },
    },
  )
  expect(result.status).toBe(0)
  const line = result.stdout.split('\n').find(text => text.startsWith('RESULT canary_scan '))
  expect(line).toBeDefined()
  return new Map([
    ['status', (line ?? '').split(' ')[2] ?? ''],
    ...(line ?? '')
      .split(' ')
      .filter(part => part.includes('='))
      .map(part => part.split('=') as [string, string]),
  ])
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
  // What the command's own `mktemp` directory holds for the scanner to find.
  fs.writeFileSync(path.join(extra, 'notes.txt'), spec.liveControl)
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

describe.skipIf(!python)('the scanner on large files and long runs', () => {
  const canary = spec.canary
  const scanCheckout = (files: Record<string, Buffer>, overrides: Partial<ScanSpec> = {}): Map<string, string> => {
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, {...spec, ...overrides})
    const checkout = tempDir()
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(checkout, name), content)
    return runScan({...overrides, checkout: [checkout]}, xdgRoot, extra)
  }

  it('finds the canary inside a token run longer than 4,096 bytes', () => {
    // #given the canary in the middle of a 12,000-character run of token characters
    const run = Buffer.from(`${'a'.repeat(6000)}${canary}${'b'.repeat(6000)}`)

    // #then it is found, not skipped for its length
    const counts = scanCheckout({'run.txt': run})
    expect(counts.get('canary.checkout')).toBe('1')
    expect(counts.get('skip.checkout')).toBe('0')
  })

  it('finds the canary across a chunk boundary, wherever the boundary falls inside it', () => {
    // #given a file per offset, with the canary straddling the 4,096-byte chunk boundary at every position but the ends
    const files: Record<string, Buffer> = {}
    const first = 4096 - canary.length + 1
    for (let offset = first; offset < 4096; offset += 1) {
      files[`edge-${offset}.bin`] = Buffer.concat([Buffer.alloc(offset), Buffer.from(canary), Buffer.alloc(9000, 1)])
    }

    // #then every file's canary is found
    expect(scanCheckout(files).get('canary.checkout')).toBe(String(Object.keys(files).length))
  })

  it('finds the canary in the last chunk of a file many chunks long, and a run that crosses several', () => {
    // #given a 40,000-byte binary file with the canary near its end, and a 20,000-character run with it in the second half
    const counts = scanCheckout({
      'big.bin': Buffer.concat([Buffer.alloc(39_000), Buffer.from(canary), Buffer.alloc(900, 2)]),
      'long.txt': Buffer.from(`${'q'.repeat(12_000)}${canary}${'r'.repeat(8000)}`),
    })

    // #then both are found
    expect(counts.get('canary.checkout')).toBe('2')
  })

  it('finds the long-run control and the chunk-boundary control the runner plants', () => {
    // #given the controls planted behind the links
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)

    // #when
    const counts = runScan({}, xdgRoot, extra)

    // #then both are found, and the planted boundary file is larger than a chunk
    expect(counts.get('ctl.long.xdg')).toBe('1')
    expect(counts.get('ctl.boundary.xdg')).toBe('1')
    expect(fs.statSync(path.join(runner, 'cache', 'opencode', 'it-control-boundary.bin')).size).toBeGreaterThan(4096)
  })

  it('reports INCOMPLETE, with a count, when a file in the checkout cannot be read', () => {
    // #given a file the scanner may not open
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    const checkout = tempDir()
    fs.writeFileSync(path.join(checkout, 'sealed.txt'), 'nothing here')
    fs.chmodSync(path.join(checkout, 'sealed.txt'), 0o000)

    // #when
    const counts = runScan({checkout: [checkout]}, xdgRoot, extra)

    // #then the verdict is not BLOCKED
    expect(counts.get('skip.checkout')).toBe('1')
    expect(counts.get('status')).toBe('INCOMPLETE')
  })

  it('reports INCOMPLETE when a file is over the size bound, and when the time budget is spent', () => {
    // #given a file over a bound that the planted controls are under
    const big = {'big.bin': Buffer.alloc(30_000)}
    const bounded = scanCheckout(big, {maxFileBytes: 25_000})
    expect(bounded.get('skip.checkout')).toBe('1')
    expect(bounded.get('status')).toBe('INCOMPLETE')

    // #and a budget of zero seconds, which leaves every file unread: counted, and never a pass
    const spent = scanCheckout(big, {budgetSeconds: 0})
    expect(Number(spent.get('skip.checkout'))).toBeGreaterThanOrEqual(1)
    expect(Number(spent.get('skip.xdg'))).toBeGreaterThanOrEqual(1)
    expect(spent.get('status')).not.toBe('BLOCKED')
  })

  it('does not call the scan incomplete for a skipped file in the runner temp, which the sandbox is not meant to read', () => {
    // #given an unreadable file in the temp root and nothing skipped elsewhere
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    const temp = tempDir()
    fs.writeFileSync(path.join(temp, 'step.txt'), 'private')
    fs.chmodSync(path.join(temp, 'step.txt'), 0o000)

    // #when
    const counts = runScan({runnerTemp: temp}, xdgRoot, extra)

    // #then it is counted and the verdict stands
    expect(counts.get('skip.temp')).toBe('1')
    expect(counts.get('status')).toBe('BLOCKED')
  })

  it('reports OPEN, not INCOMPLETE, when the canary was found and something else was skipped', () => {
    // #given a hit and an unreadable file
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    const checkout = tempDir()
    fs.writeFileSync(path.join(checkout, 'hit.txt'), canary)
    fs.writeFileSync(path.join(checkout, 'sealed.txt'), 'x')
    fs.chmodSync(path.join(checkout, 'sealed.txt'), 0o000)

    // #then
    expect(runScan({checkout: [checkout]}, xdgRoot, extra).get('status')).toBe('OPEN')
  })
})

/**
 * Python run before the scanner, so a clock and a read error can be injected without a hook in the scanner: `open` is wrapped,
 * and what the wrapper does is decided by the file's name.
 */
const FAULTS = `import builtins, time
_open = builtins.open
_late = [False]
_reads = {}


class _File:
    def __init__(self, f, name):
        self.f, self.name = f, name

    def read(self, n=-1):
        _reads[self.name] = _reads.get(self.name, 0) + 1
        if self.name.endswith('fails.txt') and _reads[self.name] == 2:
            raise OSError(5, 'injected read error')
        data = self.f.read(n)
        if self.name.endswith('late.txt') and data:
            _late[0] = True
        return data

    def __enter__(self):
        self.f.__enter__()
        return self

    def __exit__(self, *args):
        return self.f.__exit__(*args)


builtins.open = lambda p, *a, **k: _File(_open(p, *a, **k), str(p))
_mono = time.monotonic
time.monotonic = lambda: 1e9 if _late[0] else _mono()
`

describe.skipIf(!python)('a hit is never dropped by an early exit', () => {
  const canary = spec.canary
  /** A temp root with one multi-chunk file that starts with the canary, then runs on. */
  const tempWith = (name: string, size = 20_000): string => {
    const temp = tempDir()
    fs.writeFileSync(path.join(temp, name), Buffer.concat([Buffer.from(canary), Buffer.alloc(size, 1)]))
    return temp
  }
  const scanTemp = (temp: string, overrides: Partial<ScanSpec> = {}, preamble = ''): Map<string, string> => {
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, {...spec, ...overrides})
    return runScan({...overrides, runnerTemp: temp}, xdgRoot, extra, preamble)
  }

  it('keeps the hit when the deadline passes after it in the same runner-temp file', () => {
    // #given the canary in the first chunk of a file, and a clock that runs out as soon as that file has been read once
    const counts = scanTemp(tempWith('late.txt'), {}, FAULTS)

    // #then the hit is counted and the verdict is OPEN, with the file recorded as skipped
    expect(counts.get('canary.temp')).toBe('1')
    expect(counts.get('skip.temp')).toBe('1')
    expect(counts.get('status')).toBe('OPEN')
  })

  it('keeps the hit when a read fails after it in the same file', () => {
    // #given the canary in the first chunk, and an I/O error on the second read of the file
    const counts = scanTemp(tempWith('fails.txt'), {}, FAULTS)

    // #then
    expect(counts.get('canary.temp')).toBe('1')
    expect(counts.get('skip.temp')).toBe('1')
    expect(counts.get('status')).toBe('OPEN')
  })

  it('keeps the hit in the part of a file under the size bound, and records the file as skipped', () => {
    // #given a file over the bound with the canary at its start (the bound is above every planted control)
    const counts = scanTemp(tempWith('over.bin', 30_000), {maxFileBytes: 25_000})

    // #then the part that was read is examined
    expect(counts.get('canary.temp')).toBe('1')
    expect(counts.get('skip.temp')).toBe('1')
    expect(counts.get('status')).toBe('OPEN')
  })

  it('keeps a hit in the checkout and in OpenCode storage the same way', () => {
    // #given the canary at the start of a file with a failing read in the checkout
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    const checkout = tempDir()
    fs.writeFileSync(path.join(checkout, 'fails.txt'), Buffer.concat([Buffer.from(canary), Buffer.alloc(20_000, 1)]))

    // #then
    const counts = runScan({checkout: [checkout]}, xdgRoot, extra, FAULTS)
    expect(counts.get('canary.checkout')).toBe('1')
    expect(counts.get('skip.checkout')).toBe('1')
    expect(counts.get('status')).toBe('OPEN')
  })

  it('keeps a control hit when the stream that held it ended early, so a missing control means it was not seen', () => {
    // #given the live control in a file whose second read fails
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    fs.rmSync(path.join(extra, 'notes.txt'))
    fs.writeFileSync(
      path.join(extra, 'fails.txt'),
      Buffer.concat([Buffer.from(spec.liveControl), Buffer.alloc(20_000, 1)]),
    )

    // #then the control still counts: the verdict is not FAILED for it
    const counts = runScan({}, xdgRoot, extra, FAULTS)
    expect(counts.get('ctl.live.file')).toBe('1')
    expect(counts.get('status')).not.toBe('FAILED')
  })
})

describe.skipIf(!python)('the known credential-bearing paths', () => {
  it('opens a known file in a directory that cannot be listed, which a walk cannot reach', () => {
    // #given the canary in a child of a directory with search permission only (no listing)
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    const temp = tempDir()
    const step = path.join(temp, 'step')
    fs.mkdirSync(step)
    fs.writeFileSync(path.join(step, 'file_commands.txt'), `INPUT_TRACE-HEADERS=Authorization: Bearer ${spec.canary}\n`)
    fs.chmodSync(step, 0o100)

    try {
      // #when the walk alone runs, it cannot list the directory, and finds nothing
      const walked = runScan({runnerTemp: temp}, xdgRoot, extra)
      expect(walked.get('canary.temp')).toBe('0')
      expect(walked.get('skip.temp')).toBe('1')

      // #and the known path is opened directly
      const direct = runScan({runnerTemp: temp, knownPaths: [path.join(step, 'file_commands.txt')]}, xdgRoot, extra)

      // #then the hit counts and the verdict is OPEN
      expect(direct.get('canary.known')).toBe('1')
      expect(direct.get('read.known')).toBe('1')
      expect(direct.get('status')).toBe('OPEN')
    } finally {
      fs.chmodSync(step, 0o700)
    }
  })

  it('counts a permission error as a refusal, not a skip, and any other error as a skip', () => {
    // #given a known file that cannot be read, and one that does not exist
    const {xdgRoot, runner, extra} = layout()
    plantScanControls(runner, spec)
    const dir = tempDir()
    const sealed = path.join(dir, 'sealed.txt')
    fs.writeFileSync(sealed, spec.canary)
    fs.chmodSync(sealed, 0o000)

    // #then a refusal is counted and the verdict stands
    const refused = runScan({knownPaths: [sealed]}, xdgRoot, extra)
    expect(refused.get('denied.known')).toBe('1')
    expect(refused.get('skip.known')).toBe('0')
    expect(refused.get('status')).toBe('BLOCKED')

    // #but a path that is not there is an incomplete scan
    const missing = runScan({knownPaths: [path.join(dir, 'gone.txt')]}, xdgRoot, extra)
    expect(missing.get('skip.known')).toBe('1')
    expect(missing.get('status')).toBe('INCOMPLETE')
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

describe('the exported tool span', () => {
  const attribute = (key: string, value: string) => ({key, value: {stringValue: value}})
  const span = (name: string, attributes: Record<string, string>) => ({
    name,
    attributes: Object.entries(attributes).map(([key, value]) => attribute(key, value)),
  })
  const body = (...spans: ReturnType<typeof span>[]): Buffer =>
    Buffer.from(JSON.stringify({resourceSpans: [{scopeSpans: [{spans}]}]}))
  const marker = 'toolarg-marker-0123abcd'

  it('decodes the name and the string attributes of every span in every body', () => {
    // #given two bodies
    const spans = exportedSpans([body(span('invoke_agent x', {a: '1'})), body(span('execute_tool bash', {b: '2'}))])

    // #then
    expect(spans).toEqual([
      {name: 'invoke_agent x', attributes: {a: '1'}},
      {name: 'execute_tool bash', attributes: {b: '2'}},
    ])
  })

  it('finds the marker in the tool span arguments', () => {
    const spans = exportedSpans([
      body(span('execute_tool bash', {'gen_ai.tool.call.arguments': `{"command":": ${marker}; true"}`})),
    ])
    expect(toolSpanHoldsArgument(spans, marker)).toBe(true)
  })

  it('does not count the marker found elsewhere: in the result, in a model request, or in another attribute of the tool span', () => {
    // #given the marker in the tool's result, in a chat span's input and in the tool span's description, never in its arguments
    const spans = exportedSpans([
      body(
        span('execute_tool bash', {
          'gen_ai.tool.call.arguments': '{"command":"true"}',
          'gen_ai.tool.call.result': `saw ${marker}`,
          description: marker,
        }),
        span('chat fixture-model', {'gen_ai.input.messages': `[{"tool_call":"${marker}"}]`}),
      ),
    ])

    // #then it is not proof that the tool's arguments arrived
    expect(toolSpanHoldsArgument(spans, marker)).toBe(false)
  })

  it('is false when no tool span arrived', () => {
    expect(toolSpanHoldsArgument(exportedSpans([body(span('invoke_agent x', {}))]), marker)).toBe(false)
    expect(toolSpanHoldsArgument([], marker)).toBe(false)
  })

  it('ignores a body that is not OTLP JSON', () => {
    expect(exportedSpans([Buffer.from('nope'), Buffer.from('{"resourceSpans":null}')])).toEqual([])
  })
})
