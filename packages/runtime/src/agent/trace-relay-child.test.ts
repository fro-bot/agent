import type {TraceRelayWireConfig} from './trace-relay-wire.js'
import {Buffer} from 'node:buffer'
import {PassThrough} from 'node:stream'
import {afterEach, describe, expect, it} from 'vitest'

import {err} from '../shared/types.js'
import {runTraceRelayChild} from './trace-relay-child.js'
import {postBatch, startHttpUpstream} from './trace-relay-test-kit.js'
import {encodeTraceRelayConfig, TRACE_RELAY_MAX_CONFIG_BYTES} from './trace-relay-wire.js'

const CREDENTIAL = 'Basic Y2hpbGQtY2FuYXJ5LTAwMDc6c2VjcmV0'
const BODY_CANARY = 'BATCH-BODY-CANARY-0007'
const COLLECTOR_HOST_CANARY = 'collector-canary.example.com'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Run {
  readonly stdin: PassThrough
  readonly output: () => string
  readonly exits: () => number[]
  readonly child: ReturnType<typeof runTraceRelayChild>
  readonly waitForLines: (count: number) => Promise<string>
  readonly waitForExit: () => Promise<number>
}

function run(options: {frameTimeoutMs?: number; deps?: Parameters<typeof runTraceRelayChild>[1]} = {}): Run {
  const stdin = new PassThrough()
  let output = ''
  const exitCodes: number[] = []
  const lineWaiters: (() => void)[] = []
  const exitWaiters: ((code: number) => void)[] = []
  const lineCount = (): number => output.split('\n').length - 1
  const child = runTraceRelayChild(
    {
      stdin,
      stdout: {
        write: chunk => {
          output += chunk
          for (const waiter of lineWaiters.splice(0)) waiter()
          return true
        },
      },
      exit: code => {
        exitCodes.push(code)
        for (const waiter of exitWaiters.splice(0)) waiter(code)
      },
      ...(options.frameTimeoutMs === undefined ? {} : {frameTimeoutMs: options.frameTimeoutMs}),
    },
    options.deps,
  )
  return {
    stdin,
    child,
    output: () => output,
    exits: () => exitCodes,
    waitForLines: async count =>
      new Promise<string>(resolve => {
        const check = (): void => {
          if (lineCount() >= count) resolve(output)
          else lineWaiters.push(check)
        }
        check()
      }),
    waitForExit: async () =>
      new Promise<number>(resolve => {
        const first = exitCodes[0]
        if (first === undefined) exitWaiters.push(resolve)
        else resolve(first)
      }),
  }
}

function configFor(origin: string): TraceRelayWireConfig {
  return {
    version: 1,
    url: `${origin}/api/public/otel/v1/traces`,
    headers: [{name: 'Authorization', value: CREDENTIAL}],
  }
}

function frameOf(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}

describe('runTraceRelayChild', () => {
  it('starts from a framed config, prints one ready line, forwards, and on stdin close prints one report line and exits', async () => {
    // #given an upstream that delivers, then one that is refused, and a framed config written in pieces
    const statuses = [200, 503]
    let next = 0
    const upstream = await startHttpUpstream((_request, res) => {
      res.writeHead(statuses[next++] ?? 200, {'content-length': 0})
      res.end()
    })
    cleanups.push(upstream.close)
    const r = run()
    const frame = encodeTraceRelayConfig(configFor(upstream.origin))

    // #when the frame arrives in pieces
    r.stdin.write(frame.subarray(0, 2))
    r.stdin.write(frame.subarray(2, 40))
    r.stdin.write(frame.subarray(40))
    const readyOutput = await r.waitForLines(1)

    // #then it prints exactly one ready line with a port, and the relay forwards with the credential
    const ready = JSON.parse(readyOutput) as {ready: boolean; port: number}
    expect(readyOutput).toBe(`{"ready":true,"port":${ready.port}}\n`)
    expect((await postBatch(ready.port, {body: Buffer.from(BODY_CANARY)})).status).toBe(200)
    expect((await postBatch(ready.port, {body: Buffer.from(BODY_CANARY)})).status).toBe(503)
    expect(upstream.requests[0]?.headers.authorization).toBe(CREDENTIAL)
    expect(r.exits()).toEqual([])

    // #when stdin closes
    r.stdin.end()

    // #then the child exits cleanly after one report line, and the port stops answering
    expect(await r.waitForExit()).toBe(0)
    expect(r.output()).toBe(`{"ready":true,"port":${ready.port}}\n{"report":{"delivered":1,"retry":1,"dropped":0}}\n`)
    await expect(postBatch(ready.port)).rejects.toThrow()
  })

  it('prints nothing that names the collector, a header value or a body, from start to stop', async () => {
    // #given a collector whose host canary is in its URL, and a sender whose body carries a canary
    const upstream = await startHttpUpstream((_request, res) => res.end())
    cleanups.push(upstream.close)
    const r = run()
    r.stdin.write(
      encodeTraceRelayConfig({
        version: 1,
        url: `${upstream.origin}/${COLLECTOR_HOST_CANARY}/v1/traces`,
        headers: [{name: 'Authorization', value: CREDENTIAL}],
      }),
    )
    const ready = JSON.parse(await r.waitForLines(1)) as {port: number}
    await postBatch(ready.port, {body: Buffer.from(BODY_CANARY)})
    await postBatch(ready.port, {path: '/elsewhere', body: Buffer.from(BODY_CANARY)})

    // #when it stops
    r.stdin.end()
    await r.waitForExit()

    // #then none of it is in the output
    for (const canary of [CREDENTIAL, BODY_CANARY, COLLECTOR_HOST_CANARY, upstream.origin, 'Basic']) {
      expect(r.output()).not.toContain(canary)
    }
    expect(
      r
        .output()
        .split('\n')
        .filter(line => line !== ''),
    ).toHaveLength(2)
  })

  it('ignores bytes after the frame and keeps serving', async () => {
    const upstream = await startHttpUpstream((_request, res) => res.end())
    cleanups.push(upstream.close)
    const r = run()
    r.stdin.write(Buffer.concat([encodeTraceRelayConfig(configFor(upstream.origin)), Buffer.from('trailing garbage')]))
    const ready = JSON.parse(await r.waitForLines(1)) as {port: number}
    expect((await postBatch(ready.port)).status).toBe(200)
    expect(r.exits()).toEqual([])
    r.stdin.end()
    await r.waitForExit()
  })

  it('exits 64 with a fixed line, and no fragment of the input, for a truncated frame', async () => {
    const r = run()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(500)

    r.stdin.write(Buffer.concat([header, Buffer.from(`{"version":1,"k":"${CREDENTIAL}"`)]))
    r.stdin.end()

    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 64 for a frame over the size bound without reading it', async () => {
    const r = run()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(TRACE_RELAY_MAX_CONFIG_BYTES + 1)
    r.stdin.write(Buffer.concat([header, Buffer.from(CREDENTIAL)]))
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 64 for a frame that is not JSON, without quoting it', async () => {
    const r = run()
    const payload = Buffer.from(`not json ${CREDENTIAL}`)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    r.stdin.write(Buffer.concat([header, payload]))
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 64 when stdin closes before any frame arrives', async () => {
    const r = run()
    r.stdin.end()
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 64 when no frame arrives in time', async () => {
    const r = run({frameTimeoutMs: 100})
    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it.each([
    ['an http URL to a public host', {url: `http://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: []}],
    ['http://localhost', {url: 'http://localhost:4318/v1/traces', headers: []}],
    ['a URL with userinfo', {url: `https://user:${CREDENTIAL}@${COLLECTOR_HOST_CANARY}/v1/traces`, headers: []}],
    [
      'a header the relay owns',
      {url: `https://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: [{name: 'host', value: 'x'}]},
    ],
    ['an unknown field', {url: `https://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: [], extra: CREDENTIAL}],
    ['a version it does not know', {version: 2, url: `https://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: []}],
  ])('exits 64 with only the fixed line for %s', async (_name, body) => {
    const r = run()

    r.stdin.write(frameOf({version: 1, ...body}))

    expect(await r.waitForExit()).toBe(64)
    expect(r.output()).toBe('{"error":"invalid-config"}\n')
  })

  it('exits 65 with a fixed line when the relay refuses to start', async () => {
    const r = run({deps: {startRelay: async () => err(`the secret reason ${CREDENTIAL}`)}})
    r.stdin.write(frameOf({version: 1, url: `https://${COLLECTOR_HOST_CANARY}/v1/traces`, headers: []}))

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

  it('stops on a shutdown request after it is ready, and reports', async () => {
    const upstream = await startHttpUpstream((_request, res) => res.end())
    cleanups.push(upstream.close)
    const r = run()
    r.stdin.write(encodeTraceRelayConfig(configFor(upstream.origin)))
    const ready = JSON.parse(await r.waitForLines(1)) as {port: number}
    await postBatch(ready.port)

    r.child.requestShutdown()

    expect(await r.waitForExit()).toBe(0)
    expect(r.output().endsWith('{"report":{"delivered":1,"retry":0,"dropped":0}}\n')).toBe(true)
  })
})
