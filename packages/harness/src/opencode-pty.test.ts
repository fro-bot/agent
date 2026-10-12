import {spawn, spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest'

import {
  cleanEnv,
  compileFixtureBinary,
  fileExists,
  makeTempDir,
  reapPidFile,
  removeDir,
  stageHarnessPackage,
  withTimeout,
  type StagedPackage,
} from './shim-test-kit.js'

// Drives the `opencode` shim under a real controlling terminal. A pty gives us what a pipe cannot: a terminal-generated
// Ctrl-C goes to the whole foreground process group (shim AND child), so the child may see the signal twice — the
// accepted, documented duplicate delivery. Python's stdlib `pty` is the driver; no npm dependency.
const PYTHON_DRIVER = String.raw`
import json, os, pty, select, signal, sys, time

cfg = json.loads(sys.argv[1])
pid, master = pty.fork()
if pid == 0:
    os.execvpe(cfg["argv"][0], cfg["argv"], os.environ.copy())

def drain(timeout):
    # Keep the pty readable so the shim/child never block on a full terminal buffer.
    ready, _, _ = select.select([master], [], [], timeout)
    if ready:
        try:
            os.read(master, 65536)
        except OSError:
            pass

def finish(result):
    with open(cfg["result"], "w") as handle:
        json.dump(result, handle)
    sys.exit(0)

deadline = time.time() + 10
while not os.path.exists(cfg["ready"]):
    drain(0.02)
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        finish({"error": "fixture never became ready"})

if cfg["mode"] == "ctrl-c":
    os.write(master, b"\x03")
else:
    os.kill(pid, signal.SIGINT)

deadline = time.time() + 10
while True:
    drain(0.02)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done != 0:
        if os.WIFEXITED(status):
            finish({"exit": os.WEXITSTATUS(status), "signal": None})
        finish({"exit": None, "signal": os.WTERMSIG(status)})
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        finish({"error": "shim did not exit after SIGINT"})
`

interface PtyResult {
  readonly exit?: number | null
  readonly signal?: number | null
  readonly error?: string
}

const pythonAvailable = spawnSync('python3', ['--version']).status === 0
const skipReason =
  process.platform === 'win32' ? 'win32 has no pty' : pythonAvailable ? undefined : 'python3 is not on PATH'
if (skipReason !== undefined) {
  console.warn(`[opencode-pty.test] skipping PTY tests: ${skipReason}`)
}

let root: string
let staged: StagedPackage
let fixture: string
const pidFiles: string[] = []

beforeAll(() => {
  root = makeTempDir('harness-pty-')
  staged = stageHarnessPackage(root)
  fixture = compileFixtureBinary(root)
  writeFileSync(path.join(root, 'pty-driver.py'), PYTHON_DRIVER)
}, 120_000)

afterEach(() => {
  for (const file of pidFiles.splice(0)) reapPidFile(file)
})

afterAll(() => {
  removeDir(root)
})

async function runUnderPty(
  mode: 'ctrl-c' | 'pid-sigint',
  name: string,
): Promise<{result: PtyResult; receipts: string[]}> {
  const files = {
    ready: path.join(root, `${name}.ready`),
    pid: path.join(root, `${name}.pid`),
    receipts: path.join(root, `${name}.receipts`),
    result: path.join(root, `${name}.result.json`),
  }
  pidFiles.push(files.pid)
  const env = cleanEnv({
    OPENCODE_PATH: fixture,
    FIXTURE_READY: files.ready,
    FIXTURE_PID: files.pid,
    FIXTURE_RECEIPTS: files.receipts,
    FIXTURE_RECORD_SIGNALS: '1',
  })
  const config = {
    argv: [process.execPath, staged.opencodeEntry, 'serve'],
    mode,
    ready: files.ready,
    result: files.result,
  }
  const driver = spawn('python3', [path.join(root, 'pty-driver.py'), JSON.stringify(config)], {env, stdio: 'ignore'})
  const closed = new Promise<void>((resolve, reject) => {
    driver.once('error', reject)
    driver.once('close', () => resolve())
  })
  try {
    await withTimeout('pty driver', closed, 30_000)
  } finally {
    driver.kill('SIGKILL')
  }
  const result = JSON.parse(readFileSync(files.result, 'utf8')) as PtyResult
  const receipts = fileExists(files.receipts) ? readFileSync(files.receipts, 'utf8').split('\n').filter(Boolean) : []
  return {result, receipts}
}

describe.skipIf(skipReason !== undefined)('opencode shim under a controlling terminal', () => {
  it('delivers a terminal Ctrl-C to the child at least once and at most twice', async () => {
    // #given the shim running a signal-recording serve fixture as the pty's foreground job
    // #when the terminal sends Ctrl-C (SIGINT to the whole foreground group: shim and child)
    const {result, receipts} = await runUnderPty('ctrl-c', 'ctrl-c')

    // #then the child saw SIGINT once (kernel only, or forward only) or twice (kernel + forward), and exited cleanly
    expect(result.error).toBeUndefined()
    expect(receipts.length).toBeGreaterThanOrEqual(1)
    expect(receipts.length).toBeLessThanOrEqual(2)
    expect(new Set(receipts)).toEqual(new Set(['SIGINT']))
    expect(result).toEqual({exit: 0, signal: null})
  })

  it('delivers a PID-directed SIGINT to the child while the pty is still attached', async () => {
    // #given the same job under the pty
    // #when SIGINT is sent to the shim's pid only (the terminal is not involved)
    const {result, receipts} = await runUnderPty('pid-sigint', 'pid-sigint')

    // #then the shim forwarded it to the child
    expect(result.error).toBeUndefined()
    expect(receipts).toEqual(['SIGINT'])
    expect(result).toEqual({exit: 0, signal: null})
  })
})
