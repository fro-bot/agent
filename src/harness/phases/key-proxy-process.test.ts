import type {KeyProxyLauncher, KeyProxyProcess} from './key-proxy-process.js'
import {Buffer} from 'node:buffer'
import {execFileSync, spawn} from 'node:child_process'
import * as fs from 'node:fs/promises'
import http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {startTlsUpstream} from '../../../packages/runtime/src/agent/key-proxy-test-kit.js'
import {createMockLogger, serializeLoggerCalls, unwrapErr} from '../../shared/test-helpers.js'
import {startKeyProxyProcess} from './key-proxy-process.js'

const REAL_KEY = 'sk-SUPERVISOR-REAL-CANARY-0042'

function findBun(): string | null {
  try {
    return execFileSync('which', ['bun'], {encoding: 'utf8'}).trim() || null
  } catch {
    return null
  }
}

const BUN = findBun()
const SOURCE_ENTRY = fileURLToPath(new URL('../../../apps/action/src/key-proxy.ts', import.meta.url))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readProc(pid: number): Promise<{cmdline: string; environ: string}> {
  return {
    cmdline: await fs.readFile(`/proc/${pid}/cmdline`, 'utf8'),
    environ: await fs.readFile(`/proc/${pid}/environ`, 'utf8'),
  }
}

const OPENAI = {providerId: 'openai', key: REAL_KEY, baseUrl: null, protocols: ['openai-chat'] as const}

describe('key-proxy-process', () => {
  let dir: string
  const cleanups: (() => Promise<void>)[] = []
  const trackedPids: number[] = []

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'key-proxy-process-'))
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    for (const pid of trackedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    await fs.rm(dir, {recursive: true, force: true})
  })

  async function fakeChild(source: string): Promise<KeyProxyLauncher> {
    const file = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`)
    await fs.writeFile(file, source)
    return {command: process.execPath, args: [file]}
  }

  const realLauncher = (): KeyProxyLauncher => {
    if (BUN === null) throw new Error('bun is required for the real-child tests')
    return {command: BUN, args: [SOURCE_ENTRY]}
  }

  async function startWith(
    launcher: KeyProxyLauncher,
    extra: Partial<Parameters<typeof startKeyProxyProcess>[0]> = {},
  ) {
    const logger = createMockLogger()
    const started = await startKeyProxyProcess({
      launcher,
      providers: [OPENAI],
      logger,
      timeouts: {readyMs: 5000, exitGraceMs: 1500, killConfirmMs: 1500},
      ...extra,
    })
    if (started.success) {
      cleanups.push(async () => {
        await started.data.stop()
      })
    }
    return {started, logger}
  }

  describe.skipIf(BUN === null)('with the real child', () => {
    it('returns a port, serves with the real key, and stops with confirmation when stdin closes', async () => {
      // #given an HTTPS upstream and the real child on the source entry
      const upstream = await startTlsUpstream((_request, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end('{}')
      })
      cleanups.push(upstream.close)
      const {started} = await startWith(realLauncher(), {
        providers: [{...OPENAI, baseUrl: `${upstream.origin}/v1`}],
        testing: {upstreamCa: upstream.ca},
      })
      if (!started.success) throw new Error(started.error.message)
      const proxy: KeyProxyProcess = started.data

      // #when a request carries the placeholder
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: proxy.port,
            path: '/openai/chat/completions',
            method: 'POST',
            headers: {authorization: `Bearer ${proxy.placeholder}`},
          },
          res => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.end('{}')
      })

      // #then the upstream saw the real key from stdin and the base URL names the loopback prefix
      expect(status).toBe(200)
      expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
      expect(proxy.baseUrl('openai')).toBe(`http://127.0.0.1:${proxy.port}/openai`)
      expect(proxy.placeholder.length).toBeGreaterThanOrEqual(32)
      expect(proxy.placeholder).not.toContain(REAL_KEY)

      // #when it is stopped
      const stopped = await proxy.stop()

      // #then the exit is confirmed, and an intentional stop is not a crash
      expect(stopped.outcome).toBe('stopped')
      expect(stopped.crashed).toBe(false)
      expect(proxy.died.aborted).toBe(false)
    })

    it('keeps the key out of the child argv and environment, which is empty', async () => {
      // #given a parent environment that holds a canary
      process.env.KEY_PROXY_PARENT_CANARY = 'parent-canary-value'
      cleanups.push(async () => {
        delete process.env.KEY_PROXY_PARENT_CANARY
      })
      const {started} = await startWith(realLauncher())
      if (!started.success) throw new Error(started.error.message)
      const pid = started.data.pid
      trackedPids.push(pid)

      // #when the child's own command line and environment are read from the runner side (Linux only)
      const proc = process.platform === 'linux' ? await readProc(pid) : {cmdline: '', environ: ''}

      // #then neither holds the key, the placeholder or anything of the parent's environment
      expect(proc.cmdline).not.toContain(REAL_KEY)
      expect(proc.cmdline).not.toContain(started.data.placeholder)
      expect(proc.environ).not.toContain(REAL_KEY)
      expect(proc.environ).not.toContain('parent-canary-value')
      expect(proc.environ).toBe('')
      const stopped = await started.data.stop()
      expect(stopped.outcome).toBe('stopped')
    })

    it('exits 64 with the fixed line for a truncated config, printing no fragment of it', async () => {
      // #given the real child fed a truncated frame
      const child = spawn(BUN as string, [SOURCE_ENTRY], {env: {}, stdio: ['pipe', 'pipe', 'ignore']})
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(900)
      child.stdin.write(Buffer.concat([header, Buffer.from(`{"placeholder":"x","key":"${REAL_KEY}"`)]))
      child.stdin.end()

      // #then it exits 64 with the fixed line only
      expect(await exited).toBe(64)
      expect(out).toBe('{"error":"invalid-config"}\n')
      expect(out).not.toContain(REAL_KEY)
    })

    it('notices when the child dies after ready, and later requests fail', async () => {
      // #given a running proxy
      const {started} = await startWith(realLauncher())
      if (!started.success) throw new Error(started.error.message)
      const proxy = started.data
      const pid = proxy.pid
      const died = new Promise<void>(resolve => proxy.died.addEventListener('abort', () => resolve(), {once: true}))

      // #when the child is killed from outside
      process.kill(pid, 'SIGKILL')
      await died

      // #then the crash is latched, the owned signal fired, and a request is refused
      expect(proxy.crashed()).toBe(true)
      await expect(
        new Promise<void>((resolve, reject) => {
          const req = http.request({host: '127.0.0.1', port: proxy.port, path: '/openai/models', method: 'GET'}, () =>
            resolve(),
          )
          req.on('error', reject)
          req.end()
        }),
      ).rejects.toThrow()
      const stopped = await proxy.stop()
      expect(stopped.crashed).toBe(true)
      expect(stopped.outcome).toBe('already-exited')
    })

    it('does not report a crash when stop races the exit', async () => {
      // #given a running proxy
      const {started} = await startWith(realLauncher())
      if (!started.success) throw new Error(started.error.message)

      // #when stop is called and the exit lands while it is pending
      const stopping = started.data.stop()
      const again = started.data.stop()
      const [first, second] = await Promise.all([stopping, again])

      // #then there is no false crash and both calls agree
      expect(first).toEqual(second)
      expect(first.crashed).toBe(false)
      expect(started.data.died.aborted).toBe(false)
    })
  })

  describe('with a fake child', () => {
    it('fails the start, and reaps the child, when it exits before ready', async () => {
      const launcher = await fakeChild('process.exit(3)')
      const {started} = await startWith(launcher)
      expect(started.success).toBe(false)
      expect(unwrapErr(started).kind).toBe('exited-early')
    })

    it('fails the start when the child prints garbage, and kills it', async () => {
      const launcher = await fakeChild(
        String.raw`process.stdout.write('this is not json\n'); setInterval(() => {}, 1000); process.stdin.resume()`,
      )
      const {started} = await startWith(launcher)
      expect(started.success).toBe(false)
      const error = unwrapErr(started)
      expect(error.kind).toBe('bad-ready')
      expect(error.message).not.toContain('not json')
    })

    it('fails the start with the fixed code when the child reports an error line', async () => {
      const launcher = await fakeChild(
        String.raw`process.stdout.write('{"error":"invalid-config"}\n'); process.exit(64)`,
      )
      const {started} = await startWith(launcher)
      expect(started.success).toBe(false)
      expect(unwrapErr(started).kind).toBe('child-error')
    })

    it('fails the start, and reaps the child, when it never answers within the bound', async () => {
      // #given a child that reads stdin forever and prints nothing
      const pidFile = path.join(dir, 'pid')
      const launcher = await fakeChild(
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )

      // #when the start is bounded at 300 ms
      const {started} = await startWith(launcher, {timeouts: {readyMs: 3000, exitGraceMs: 500, killConfirmMs: 1000}})

      // #then it fails with a timeout and the child is gone
      expect(started.success).toBe(false)
      expect(unwrapErr(started).kind).toBe('ready-timeout')
      const pid = Number(await fs.readFile(pidFile, 'utf8'))
      trackedPids.push(pid)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(alive(pid)).toBe(false)
    })

    it('fails the start when the caller aborts, and reaps the child', async () => {
      const pidFile = path.join(dir, 'pid')
      const launcher = await fakeChild(
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )
      const controller = new AbortController()
      // Abort once the child has started (it writes its pid first), so a slow runtime start cannot beat the abort.
      const watcher = setInterval(() => {
        fs.access(pidFile).then(
          () => {
            clearInterval(watcher)
            controller.abort()
          },
          () => undefined,
        )
      }, 25)
      const {started} = await startWith(launcher, {signal: controller.signal})
      expect(started.success).toBe(false)
      expect(unwrapErr(started).kind).toBe('aborted')
      const pid = Number(await fs.readFile(pidFile, 'utf8'))
      trackedPids.push(pid)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(alive(pid)).toBe(false)
    })

    it('kills a child that ignores stdin EOF', async () => {
      // #given a child that is ready and then ignores the closed pipe
      const launcher = await fakeChild(
        String.raw`process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000)`,
      )
      const {started} = await startWith(launcher, {timeouts: {readyMs: 3000, exitGraceMs: 200, killConfirmMs: 2000}})
      if (!started.success) throw new Error(started.error.message)

      // #when it is stopped
      const stopped = await started.data.stop()

      // #then it was killed and the exit is confirmed
      expect(stopped.outcome).toBe('killed')
      expect(stopped.crashed).toBe(false)
    })

    it('reports unconfirmed when a child survives the kill', async () => {
      // #given a child that ignores EOF and a kill that does nothing
      const pidFile = path.join(dir, 'pid')
      const launcher = await fakeChild(
        String.raw`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )
      const {started} = await startWith(launcher, {
        timeouts: {readyMs: 3000, exitGraceMs: 150, killConfirmMs: 150},
        deps: {killGroup: () => undefined},
      })
      if (!started.success) throw new Error(started.error.message)
      trackedPids.push(Number(await fs.readFile(pidFile, 'utf8')))

      // #when it is stopped
      const stopped = await started.data.stop()

      // #then the outcome is unconfirmed, never "stopped"
      expect(stopped.outcome).toBe('unconfirmed')
    })

    it('does not leak the key into the child argv', async () => {
      // #given a child that records its own argv
      const argvFile = path.join(dir, 'argv.json')
      const launcher = await fakeChild(
        String.raw`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify([process.argv, Object.keys(process.env)])); process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )
      process.env.KEY_PROXY_PARENT_CANARY = 'parent-canary-value'
      cleanups.push(async () => {
        delete process.env.KEY_PROXY_PARENT_CANARY
      })

      // #when it starts
      const {started} = await startWith(launcher)
      if (!started.success) throw new Error(started.error.message)

      // #then argv has no key, and the environment holds none of the parent's variables
      const [argv, envKeys] = JSON.parse(await fs.readFile(argvFile, 'utf8')) as [string[], string[]]
      expect(argv.join(' ')).not.toContain(REAL_KEY)
      expect(argv.join(' ')).not.toContain(started.data.placeholder)
      expect(envKeys).not.toContain('KEY_PROXY_PARENT_CANARY')
      expect(envKeys).not.toContain('PATH')
      expect(envKeys).not.toContain('HOME')
      await started.data.stop()
    })

    it('never logs the key or the placeholder', async () => {
      const launcher = await fakeChild(
        String.raw`process.stdout.write('{"ready":true,"port":4321}\n'); process.stdin.resume(); setInterval(() => {}, 1000)`,
      )
      const {started, logger} = await startWith(launcher)
      if (!started.success) throw new Error(started.error.message)
      await started.data.stop()
      const serialized = serializeLoggerCalls(logger)
      expect(serialized).not.toContain(REAL_KEY)
      expect(serialized).not.toContain(started.data.placeholder)
    })

    it('refuses a provider list the proxy cannot serve, before spawning anything', async () => {
      const launcher = await fakeChild('process.exit(0)')
      const {started} = await startWith(launcher, {
        providers: [{providerId: 'groq', key: REAL_KEY, baseUrl: null, protocols: ['openai-chat']}],
      })
      expect(started.success).toBe(false)
      const error = unwrapErr(started)
      expect(error.kind).toBe('invalid-providers')
      expect(error.message).not.toContain(REAL_KEY)
    })

    it('reports a launcher that cannot be spawned', async () => {
      const {started} = await startWith({command: path.join(dir, 'does-not-exist'), args: []})
      expect(started.success).toBe(false)
      expect(unwrapErr(started).kind).toBe('spawn-failed')
    })
  })
})
