import {execFile} from 'node:child_process'
import {mkdir, readdir, readFile, realpath} from 'node:fs/promises'
import process from 'node:process'
import {runSandboxViewChild} from '../../../packages/runtime/src/agent/sandbox-view-child.js'

// The view builder: `dist/sandbox-view.js`. It runs as root inside the launch's private mount namespace, before the agent
// starts. The policy is its one argument. It builds the read-only view, verifies the kernel's mount table, prints nothing
// on success and one fixed JSON line on failure. A deep import keeps the bundle to the builder, not the whole runtime.
//
// The tools run with an empty environment: the launch carries secrets in its environment, and `mount` needs none of them.
async function runTool(argv: readonly string[], timeoutMs: number): Promise<'failed' | 'ok' | 'timeout'> {
  const [tool, ...args] = argv
  return new Promise(resolve => {
    if (tool === undefined) {
      resolve('failed')
      return
    }
    execFile(tool, args, {timeout: timeoutMs, killSignal: 'SIGKILL', env: {LC_ALL: 'C'}}, error => {
      if (error === null) resolve('ok')
      else resolve((error as {killed?: boolean}).killed === true ? 'timeout' : 'failed')
    })
  })
}

runSandboxViewChild({
  policyText: process.argv[2],
  readMountInfo: async () => readFile('/proc/self/mountinfo', 'utf8'),
  run: runTool,
  mkdir: async directory => {
    await mkdir(directory, {recursive: true, mode: 0o755})
  },
  realpath,
  isEmptyDirectory: async target => (await readdir(target)).length === 0,
  stdout: process.stdout,
}).then(
  code => {
    process.exitCode = code
  },
  () => {
    process.stdout.write(`${JSON.stringify({view: 'failed', stage: 'seal'})}\n`)
    process.exitCode = 78
  },
)
