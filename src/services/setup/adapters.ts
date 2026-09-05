import type {ChildProcess} from 'node:child_process'
import type {ExecAdapter, ToolCacheAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import process from 'node:process'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'

// Bound on waiting for a real reap after escalating to SIGKILL. SIGKILL is unrefusable, but this
// guards against a wedged reap (e.g. a zombie under an unusual init) so callers never hang forever.
const SIGKILL_REAP_GRACE_MS = 2_000

function forwardOutput(listener: ((data: Buffer) => void) | undefined, data: unknown): void {
  if (listener == null) return
  if (data instanceof Uint8Array) {
    listener(Buffer.from(data))
    return
  }
  listener(Buffer.from(String(data)))
}

/**
 * Signal the whole process group, not just the direct child.
 *
 * npm/npx-spawned installers fork descendants (arborist workers, lifecycle scripts) that survive
 * a plain `child.kill()` as orphans. Killing the negative pid targets the process group instead —
 * this only works because the child is spawned with `detached: true`, making it its own group
 * leader. Falls back to a direct kill on Windows (no process groups) or if the group is already
 * gone.
 */
function killChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Group not found / already reaped / no permission — fall back to a direct kill.
    }
  }
  child.kill(signal)
}

async function execWithTimeout(
  commandLine: string,
  args: string[] | undefined,
  timeoutMs: number,
  options: Parameters<ExecAdapter['exec']>[2],
): Promise<number | 'timed-out'> {
  const env =
    options?.env ??
    Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null))

  // Detached (non-Windows only) so the child is its own process group leader, which lets the
  // timeout path signal the whole group via a negative pid instead of leaving arborist/npx
  // descendants running as orphans. Never unref() the child — that would let the event loop exit
  // out from under a still-running install and lose the ability to reap it.
  const detached = process.platform !== 'win32'

  return new Promise<number | 'timed-out'>((resolve, reject) => {
    const child = spawn(commandLine, args ?? [], {
      cwd: options?.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
    })
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let killId: ReturnType<typeof setTimeout> | undefined
    let graceId: ReturnType<typeof setTimeout> | undefined
    let finished = false
    let timedOut = false

    const clearTimers = (): void => {
      if (timeoutId != null) clearTimeout(timeoutId)
      if (killId != null) clearTimeout(killId)
      if (graceId != null) clearTimeout(graceId)
    }

    const finish = (result: number | 'timed-out'): void => {
      if (finished) return
      finished = true
      clearTimers()
      resolve(result)
    }

    child.on('error', error => {
      if (finished) return
      finished = true
      clearTimers()
      reject(error)
    })
    child.on('close', code => {
      // Wait for the real close/exit before resolving the timeout path, so a caller awaiting
      // 'timed-out' can trust the child (and its group) is actually gone — not just signaled.
      finish(timedOut ? 'timed-out' : (code ?? 1))
    })
    child.stdout.on('data', data => forwardOutput(options?.listeners?.stdout, data))
    child.stderr.on('data', data => forwardOutput(options?.listeners?.stderr, data))
    child.stdin.on('error', () => {})

    if (options?.input != null) {
      child.stdin.write(options.input)
    }
    child.stdin.end()

    timeoutId = setTimeout(() => {
      if (finished) return
      timedOut = true
      killChildProcessGroup(child, 'SIGTERM')
      killId = setTimeout(() => {
        killChildProcessGroup(child, 'SIGKILL')
        graceId = setTimeout(() => finish('timed-out'), SIGKILL_REAP_GRACE_MS)
      }, 5_000)
    }, timeoutMs)
  })
}

export function createToolCacheAdapter(): ToolCacheAdapter {
  return {
    find: tc.find,
    downloadTool: tc.downloadTool,
    extractTar: tc.extractTar,
    extractZip: tc.extractZip,
    cacheDir: tc.cacheDir,
  }
}

export function createExecAdapter(): ExecAdapter {
  return {
    exec: exec.exec,
    execWithTimeout,
    getExecOutput: exec.getExecOutput,
  }
}
