import type {ExecAdapter, ToolCacheAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import process from 'node:process'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'

function forwardOutput(listener: ((data: Buffer) => void) | undefined, data: unknown): void {
  if (listener == null) return
  if (data instanceof Uint8Array) {
    listener(Buffer.from(data))
    return
  }
  listener(Buffer.from(String(data)))
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

  return new Promise<number | 'timed-out'>((resolve, reject) => {
    const child = spawn(commandLine, args ?? [], {
      cwd: options?.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let killId: ReturnType<typeof setTimeout> | undefined
    let finished = false

    const finish = (result: number | 'timed-out'): void => {
      if (finished) return
      finished = true
      if (timeoutId != null) clearTimeout(timeoutId)
      if (killId != null) clearTimeout(killId)
      resolve(result)
    }

    child.on('error', error => {
      if (finished) return
      finished = true
      if (timeoutId != null) clearTimeout(timeoutId)
      if (killId != null) clearTimeout(killId)
      reject(error)
    })
    child.on('close', code => {
      if (killId != null) {
        clearTimeout(killId)
        killId = undefined
      }
      finish(code ?? 1)
    })
    child.stdout.on('data', data => forwardOutput(options?.listeners?.stdout, data))
    child.stderr.on('data', data => forwardOutput(options?.listeners?.stderr, data))

    if (options?.input != null) {
      child.stdin.write(options.input)
    }
    child.stdin.end()

    timeoutId = setTimeout(() => {
      if (finished) return
      child.kill('SIGTERM')
      killId = setTimeout(() => child.kill('SIGKILL'), 5_000)
      finished = true
      clearTimeout(timeoutId)
      resolve('timed-out')
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
