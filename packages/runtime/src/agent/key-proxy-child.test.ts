import type {KeyProxyWireConfig} from './key-proxy-wire.js'
import {Buffer} from 'node:buffer'
import http from 'node:http'
import {PassThrough} from 'node:stream'
import {afterEach, describe, expect, it} from 'vitest'

import {runKeyProxyChild} from './key-proxy-child.js'
import {buildKeyProxyUpstream} from './key-proxy-routes.js'
import {startTlsUpstream} from './key-proxy-test-kit.js'
import {encodeKeyProxyConfig, KEY_PROXY_MAX_CONFIG_BYTES} from './key-proxy-wire.js'

const PLACEHOLDER = 'placeholder-0123456789abcdefghijklmnopqrstuvwxyz'
const REAL_KEY = 'sk-CHILD-REAL-CANARY-0007'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Run {
  readonly stdin: PassThrough
  readonly output: () => string
  readonly exits: () => number[]
  readonly child: ReturnType<typeof runKeyProxyChild>
  readonly waitForLine: () => Promise<string>
  readonly waitForExit: () => Promise<number>
}

function run(options: {frameTimeoutMs?: number} = {}): Run {
  const stdin = new PassThrough()
  let output = ''
  const exitCodes: number[] = []
  const lineWaiters: ((line: string) => void)[] = []
  const exitWaiters: ((code: number) => void)[] = []
  const child = runKeyProxyChild({
    stdin,
    stdout: {
      write: chunk => {
        output += chunk
        for (const waiter of lineWaiters.splice(0)) waiter(output)
        return true
      },
    },
    exit: code => {
      exitCodes.push(code)
      for (const waiter of exitWaiters.splice(0)) waiter(code)
    },
    ...options,
  })
  return {
    stdin,
    child,
    output: () => output,
    exits: () => exitCodes,
    waitForLine: async () =>
      new Promise<string>(resolve => {
        if (output.includes('\n')) resolve(output)
        else lineWaiters.push(resolve)
      }),
    waitForExit: async () =>
      new Promise<number>(resolve => {
        const first = exitCodes[0]
        if (first === undefined) exitWaiters.push(resolve)
        else resolve(first)
      }),
  }
}

async function configFor(origin: string, ca: string): Promise<KeyProxyWireConfig> {
  const built = buildKeyProxyUpstream({providerId: 'openai', baseUrl: `${origin}/v1`, protocols: ['openai-chat']})
  if (!built.success) throw new Error('fixture')
  return {
    version: 1,
    placeholder: PLACEHOLDER,
    providers: [{id: 'openai', key: REAL_KEY, origin: built.data.origin, routes: built.data.routes}],
    ca,
  }
}

async function post(port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/openai/chat/completions',
        method: 'POST',
        headers: {authorization: `Bearer ${PLACEHOLDER}`},
      },
      res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
}

describe('runKeyProxyChild', () => {
  it('starts from a framed config, prints one ready line, serves, and stops when stdin closes', async () => {
    // #given an upstream and a framed config written in two pieces
    const upstream = await startTlsUpstream((_request, res) => {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end('{}')
    })
    cleanups.push(upstream.close)
    const r = run()
    const frame = encodeKeyProxyConfig(await configFor(upstream.origin, upstream.ca))

    // #when the frame arrives in pieces
    r.stdin.write(frame.subarray(0, 2))
    r.stdin.write(frame.subarray(2, 40))
    r.stdin.write(frame.subarray(40))
    const line = await r.waitForLine()

    // #then it prints exactly one ready line with a port, and the proxy forwards with the real key
    const ready = JSON.parse(line) as {ready: boolean; port: number}
    expect(line.endsWith('\n')).toBe(true)
    expect(ready.ready).toBe(true)
    expect(await post(ready.port)).toBe(200)
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(r.exits()).toEqual([])

    // #when stdin closes
    r.stdin.end()

    // #then the child exits cleanly and the port stops answering
    expect(await r.waitForExit()).toBe(0)
    await expect(post(ready.port)).rejects.toThrow()
    expect(r.output()).not.toContain(REAL_KEY)
    expect(r.output()).not.toContain(PLACEHOLDER)
  })

  it('ignores bytes after the frame and keeps serving', async () => {
    const upstream = await startTlsUpstream((_request, res) => res.end('{}'))
    cleanups.push(upstream.close)
    const r = run()
    r.stdin.write(
      Buffer.concat([
        encodeKeyProxyConfig(await configFor(upstream.origin, upstream.ca)),
        Buffer.from('trailing garbage'),
      ]),
    )
    const ready = JSON.parse(await r.waitForLine()) as {port: number}
    expect(await post(ready.port)).toBe(200)
    expect(r.exits()).toEqual([])
    r.stdin.end()
    await r.waitForExit()
  })

  it('exits 64 with a fixed line, and no fragment of the input, for a truncated frame', async () => {
    // #given a frame that announces more bytes than arrive before stdin closes
    const r = run()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(500)

    // #when stdin ends early
    r.stdin.write(Buffer.concat([header, Buffer.from(`{"placeholder":"${PLACEHOLDER}","k":"${REAL_KEY}"`)]))
    r.stdin.end()

    // #then the child exits 64 with the fixed message
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 64 for a frame over the size bound without reading it', async () => {
    const r = run()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(KEY_PROXY_MAX_CONFIG_BYTES + 1)
    r.stdin.write(Buffer.concat([header, Buffer.from(REAL_KEY)]))
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 64 for a frame that is not JSON, without quoting it', async () => {
    const r = run()
    const payload = Buffer.from(`not json ${REAL_KEY}`)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    r.stdin.write(Buffer.concat([header, payload]))
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 64 for JSON of the wrong shape, without quoting it', async () => {
    const r = run()
    const payload = Buffer.from(
      JSON.stringify({version: 1, placeholder: PLACEHOLDER, providers: 'x', secret: REAL_KEY}),
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    r.stdin.write(Buffer.concat([header, payload]))
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).not.toContain(REAL_KEY)
    expect(r.output()).not.toContain(PLACEHOLDER)
  })

  it('exits 64 when no frame arrives in time', async () => {
    const r = run({frameTimeoutMs: 100})
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 65 with a fixed line when the proxy refuses to start', async () => {
    // #given a config whose upstream is plain http
    const r = run()
    r.stdin.write(
      encodeKeyProxyConfig({
        version: 1,
        placeholder: PLACEHOLDER,
        providers: [{id: 'openai', key: REAL_KEY, origin: 'http://api.example.com', routes: []}],
      }),
    )

    // #then it exits 65 and says nothing about why
    expect(await r.waitForExit()).toBe(65)
    expect(r.output()).toBe('{"error":"start-failed"}\n')
  })

  it('exits once with 70 and a fixed line on an internal failure', async () => {
    const r = run()
    r.child.fail('internal')
    r.child.fail('internal')
    expect(await r.waitForExit()).toBe(70)
    expect(r.exits()).toEqual([70])
    expect(r.output()).toBe('{"error":"internal"}\n')
  })

  it('stops on a shutdown request after it is ready', async () => {
    const upstream = await startTlsUpstream((_request, res) => res.end('{}'))
    cleanups.push(upstream.close)
    const r = run()
    r.stdin.write(encodeKeyProxyConfig(await configFor(upstream.origin, upstream.ca)))
    await r.waitForLine()
    r.child.requestShutdown()
    expect(await r.waitForExit()).toBe(0)
  })
})
