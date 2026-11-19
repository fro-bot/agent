import type {TraceRelayLimits} from './trace-relay-wire.js'
import type {TraceRelayServer} from './trace-relay.js'
import {Buffer} from 'node:buffer'
import net from 'node:net'
import os from 'node:os'
import {gzipSync} from 'node:zlib'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {startTlsUpstream} from './key-proxy-test-kit.js'
import {postBatch, rawExchange, startHttpUpstream} from './trace-relay-test-kit.js'
import {TRACE_RELAY_COUNTS_HEADER} from './trace-relay-wire.js'
import {startTraceRelay} from './trace-relay.js'

const CREDENTIAL = 'Basic dHJhY2UtcmVsYXktY2FuYXJ5LTAwMDc6c2VjcmV0'
const BATCH = Buffer.from([0x0a, 0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f])

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function relayFor(
  url: string,
  options: {limits?: Partial<TraceRelayLimits>; ca?: string; headers?: {name: string; value: string}[]} = {},
): Promise<TraceRelayServer> {
  const started = await startTraceRelay({
    url,
    headers: options.headers ?? [
      {name: 'Authorization', value: CREDENTIAL},
      {name: 'x-langfuse-ingestion-version', value: '4'},
    ],
    ...(options.limits === undefined ? {} : {limits: options.limits}),
    ...(options.ca === undefined ? {} : {ca: options.ca}),
  })
  if (!started.success) throw new Error(`fixture: ${started.error}`)
  cleanups.push(async () => {
    await started.data.close()
  })
  return started.data
}

async function upstreamAnswering(status: number, body = '') {
  const upstream = await startHttpUpstream((_request, res) => {
    res.writeHead(status, {'content-length': Buffer.byteLength(body)})
    res.end(body)
  })
  cleanups.push(upstream.close)
  return upstream
}

describe('startTraceRelay: forwarding', () => {
  it('forwards a batch byte for byte with the configured headers and answers delivered with an empty body', async () => {
    // #given a recording upstream and a relay pointed at its traces URL
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const upstream = await upstreamAnswering(200, '{"partialSuccess":{}}')
    const relay = await relayFor(`${upstream.origin}/api/public/otel/v1/traces?project=a`)

    // #when a batch is posted
    const answer = await postBatch(relay.port, {body: BATCH})

    // #then the same bytes arrive at the configured path and query, with the credential and the relay's own framing
    expect(answer.status).toBe(200)
    expect(answer.body.length).toBe(0)
    expect(upstream.requests).toHaveLength(1)
    const seen = upstream.requests[0]
    expect(seen?.method).toBe('POST')
    expect(seen?.url).toBe('/api/public/otel/v1/traces?project=a')
    expect(seen?.body.equals(BATCH)).toBe(true)
    expect(seen?.headers.authorization).toBe(CREDENTIAL)
    expect(seen?.headers['x-langfuse-ingestion-version']).toBe('4')
    expect(seen?.headers['content-type']).toBe('application/x-protobuf')
    expect(seen?.headers['content-length']).toBe(String(BATCH.length))
    expect(seen?.headers.host).toBe(`127.0.0.1:${upstream.port}`)
    expect(Object.keys(seen?.headers ?? {}).sort()).toEqual([
      'authorization',
      'connection',
      'content-length',
      'content-type',
      'host',
      'x-langfuse-ingestion-version',
    ])
    // the relay uses https.request or http.request, never fetch
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(relay.counts()).toEqual({delivered: 1, retry: 0, dropped: 0})
  })

  it('forwards a JSON batch and a gzip batch, and no other content type or encoding', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)
    const json = Buffer.from('{"resourceSpans":[]}')
    const zipped = gzipSync(json)

    const asJson = await postBatch(relay.port, {
      headers: {'content-type': 'application/json; charset=utf-8'},
      body: json,
    })
    const asGzip = await postBatch(relay.port, {
      headers: {'content-type': 'application/json', 'content-encoding': 'gzip'},
      body: zipped,
    })
    const asIdentity = await postBatch(relay.port, {headers: {'content-encoding': 'identity'}, body: BATCH})

    expect([asJson.status, asGzip.status, asIdentity.status]).toEqual([200, 200, 200])
    expect(upstream.requests[0]?.headers['content-type']).toBe('application/json')
    expect(upstream.requests[0]?.headers['content-encoding']).toBeUndefined()
    expect(upstream.requests[1]?.headers['content-encoding']).toBe('gzip')
    expect(upstream.requests[1]?.body.equals(zipped)).toBe(true)
    expect(upstream.requests[2]?.headers['content-encoding']).toBeUndefined()
    expect(upstream.requests[2]?.headers['content-type']).toBe('application/x-protobuf')
  })

  it('forwards a chunked batch as one body with its own content length', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)

    const exchange = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n',
      {waitMs: 300},
    )

    expect(exchange.status).toBe(200)
    expect(upstream.requests[0]?.body.toString()).toBe('abcdef')
    expect(upstream.requests[0]?.headers['content-length']).toBe('6')
    expect(upstream.requests[0]?.headers['transfer-encoding']).toBeUndefined()
  })

  it('forwards only to the configured URL when a request names another host in its path, Host header or body', async () => {
    // #given a decoy that must never be reached
    const decoy = await upstreamAnswering(200)
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)

    // #when the sender names the decoy in its Host header and body, and in an absolute-form target
    const named = await postBatch(relay.port, {
      headers: {host: `127.0.0.1:${decoy.port}`, 'x-forwarded-host': `127.0.0.1:${decoy.port}`},
      body: Buffer.from(`{"url":"${decoy.origin}/v1/traces"}`),
    })
    const absolute = await rawExchange(
      relay.port,
      `POST ${decoy.origin}/v1/traces HTTP/1.1\r\nHost: 127.0.0.1:${decoy.port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
    )

    // #then the batch went only to the configured URL, under the configured host, and the absolute form was refused
    expect(named.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.headers.host).toBe(`127.0.0.1:${upstream.port}`)
    expect(upstream.requests[0]?.headers['x-forwarded-host']).toBeUndefined()
    expect(absolute.status).toBe(404)
    expect(decoy.requests).toHaveLength(0)
  })

  it('does not forward sender headers other than the content type and encoding', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)

    await postBatch(relay.port, {
      headers: {
        authorization: 'Bearer sender-token',
        cookie: 'session=1',
        'x-api-key': 'sender-key',
        'x-forwarded-for': '203.0.113.9',
        'user-agent': 'sender/1.0',
        'x-langfuse-ingestion-version': '1',
        'retry-after': '1',
      },
    })

    const headers = upstream.requests[0]?.headers
    expect(headers?.authorization).toBe(CREDENTIAL)
    expect(headers?.['x-langfuse-ingestion-version']).toBe('4')
    for (const name of ['cookie', 'x-api-key', 'x-forwarded-for', 'user-agent', 'retry-after']) {
      expect(headers?.[name]).toBeUndefined()
    }
  })

  it('forwards over https and refuses a collector whose certificate is not trusted', async () => {
    // #given a TLS upstream
    const upstream = await startTlsUpstream((_request, res) => {
      res.writeHead(200, {'content-length': 0})
      res.end()
    })
    cleanups.push(upstream.close)

    // #when the relay trusts its CA
    const trusting = await relayFor(`${upstream.origin}/v1/traces`, {ca: upstream.ca})
    const delivered = await postBatch(trusting.port)

    // #then the batch is delivered with the credential; without the CA the connection fails and the sender is told to retry
    expect(delivered.status).toBe(200)
    expect(upstream.requests[0]?.headers.authorization).toBe(CREDENTIAL)
    const distrusting = await relayFor(`${upstream.origin}/v1/traces`)
    const refused = await postBatch(distrusting.port)
    expect(refused.status).toBe(503)
    expect(upstream.requests).toHaveLength(1)
  })
})

describe('startTraceRelay: what the sender is told', () => {
  it.each([301, 302, 307, 308])('does not follow an upstream %i and answers dropped', async status => {
    // #given an upstream that redirects to a second server
    const target = await upstreamAnswering(200)
    const upstream = await startHttpUpstream((_request, res) => {
      res.writeHead(status, {location: `${target.origin}/v1/traces`, 'content-length': 0})
      res.end()
    })
    cleanups.push(upstream.close)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)

    // #when a batch is posted
    const answer = await postBatch(relay.port)

    // #then the redirect was not followed, the credential never reached the target, and the sender is told dropped
    expect(answer.status).toBe(422)
    expect(target.requests).toHaveLength(0)
    expect(answer.headers.location).toBeUndefined()
    expect(relay.counts()).toEqual({delivered: 0, retry: 0, dropped: 1})
  })

  it.each([
    [200, 200],
    [202, 200],
    [204, 200],
    [400, 422],
    [401, 422],
    [403, 422],
    [404, 422],
    [413, 422],
    [415, 422],
    [429, 503],
    [500, 503],
    [502, 503],
    [503, 503],
    [504, 503],
  ])('maps an upstream %i to %i and returns none of its body or headers', async (upstreamStatus, expected) => {
    // #given an upstream answering with a body and a retry-after that carry a canary
    const upstream = await startHttpUpstream((_request, res) => {
      res.writeHead(upstreamStatus, {'retry-after': '3600', 'x-canary': 'UPSTREAM-HEADER-CANARY'})
      res.end('UPSTREAM-BODY-CANARY')
    })
    cleanups.push(upstream.close)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)

    // #when a batch is posted
    const answer = await postBatch(relay.port)

    // #then the sender gets the fixed status, an empty body, and no upstream header
    expect(answer.status).toBe(expected)
    expect(answer.body.length).toBe(0)
    expect(answer.headers['retry-after']).toBeUndefined()
    expect(answer.headers['x-canary']).toBeUndefined()
  })

  it('answers retry within the timeout for an upstream that never answers', async () => {
    const upstream = await startHttpUpstream(() => undefined)
    cleanups.push(upstream.close)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {upstreamTimeoutMs: 150}})
    const started = Date.now()

    const answer = await postBatch(relay.port)

    expect(answer.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(relay.counts()).toEqual({delivered: 0, retry: 1, dropped: 0})
  })

  it('answers retry at the connect timeout for a collector that accepts the connection but never completes the handshake', async () => {
    // #given a TCP listener that accepts and says nothing, so a TLS handshake never completes
    const silent = net.createServer(socket => {
      socket.on('error', () => undefined)
    })
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      silent.close()
      silent.unref()
    })
    const address = silent.address()
    const silentPort = typeof address === 'object' && address !== null ? address.port : 0
    const relay = await relayFor(`https://127.0.0.1:${silentPort}/v1/traces`, {
      limits: {connectTimeoutMs: 150, upstreamTimeoutMs: 30_000},
    })
    const started = Date.now()

    const answer = await postBatch(relay.port)

    // #then the sender hears retry at the connect bound, long before the upstream bound
    expect(answer.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('answers retry when the connection to the collector fails', async () => {
    // #given a port nothing listens on
    const closed = await startHttpUpstream(() => undefined)
    const {port} = closed
    await closed.close()
    const relay = await relayFor(`http://127.0.0.1:${port}/v1/traces`)

    const answer = await postBatch(relay.port)

    expect(answer.status).toBe(503)
  })

  it('answers dropped and closes the socket for an upstream that upgrades', async () => {
    const upstream = await startHttpUpstream((_request, res) => {
      res.destroy()
    })
    cleanups.push(upstream.close)
    // a server that answers 101 to anything
    const upgrader = net.createServer(socket => {
      socket.on('error', () => undefined)
      socket.once('data', () => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      })
    })
    await new Promise<void>(resolve => upgrader.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      await new Promise<void>(resolve => {
        upgrader.close(() => resolve())
        upgrader.getConnections(() => undefined)
      })
    })
    const address = upgrader.address()
    const upgraderPort = typeof address === 'object' && address !== null ? address.port : 0
    const relay = await relayFor(`http://127.0.0.1:${upgraderPort}/v1/traces`)

    const answer = await postBatch(relay.port)

    expect(answer.status).toBe(422)
  })

  it('counts every outcome and reports the counts on close', async () => {
    const statuses = [200, 401, 503, 200]
    let next = 0
    const upstream = await startHttpUpstream((_request, res) => {
      res.writeHead(statuses[next++] ?? 200, {'content-length': 0})
      res.end()
    })
    cleanups.push(upstream.close)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)

    await Promise.all(statuses.map(async () => postBatch(relay.port)))

    expect(await relay.close()).toEqual({delivered: 2, retry: 1, dropped: 1})
  })
})

async function arrange() {
  const upstream = await upstreamAnswering(200)
  const relay = await relayFor(`${upstream.origin}/v1/traces`)
  return {upstream, relay}
}

describe('startTraceRelay: what it answers locally', () => {
  it.each([
    ['GET on the route', 'GET', '/v1/traces', 405],
    ['PUT on the route', 'PUT', '/v1/traces', 405],
    ['another path', 'POST', '/v1/metrics', 404],
    ['the root', 'POST', '/', 404],
    ['a trailing slash', 'POST', '/v1/traces/', 404],
    ['a query on the route', 'POST', '/v1/traces?x=1', 404],
    ['a dot segment', 'POST', '/v1/../v1/traces', 404],
    ['an encoded slash', 'POST', '/v1%2Ftraces', 404],
    ['a double slash', 'POST', '//v1/traces', 404],
    ['a semicolon in the path', 'POST', '/v1/traces;x=1', 404],
  ])('answers %s locally and forwards nothing', async (_name, method, path, status) => {
    const {upstream, relay} = await arrange()

    const exchange = await rawExchange(
      relay.port,
      `${method} ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nContent-Length: 2\r\n\r\nab`,
    )

    expect(exchange.status).toBe(status)
    expect(upstream.requests).toHaveLength(0)
    expect(relay.counts()).toEqual({delivered: 0, retry: 0, dropped: 0})
  })

  it('answers an absolute-form target, CONNECT, an upgrade request and Expect locally', async () => {
    const {upstream, relay} = await arrange()

    const absolute = await rawExchange(
      relay.port,
      'POST http://collector.example.com/v1/traces HTTP/1.1\r\nHost: collector.example.com\r\nContent-Length: 0\r\n\r\n',
    )
    const connect = await rawExchange(
      relay.port,
      'CONNECT collector.example.com:443 HTTP/1.1\r\nHost: collector.example.com:443\r\n\r\n',
    )
    const upgrade = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 0\r\n\r\n',
    )
    const bareUpgrade = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
    )
    const expectation = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n',
    )

    expect(absolute.status).toBe(404)
    expect(connect.status).toBe(405)
    expect(upgrade.status).toBe(404)
    expect(bareUpgrade.status).toBe(404)
    expect(expectation.status).toBe(417)
    expect(upstream.requests).toHaveLength(0)
  })

  it.each([
    ['a refused CONNECT', 'CONNECT collector.example.com:443 HTTP/1.1\r\nHost: collector.example.com:443\r\n\r\n'],
    ['a refused upgrade', 'POST /v1/traces HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
    ['a malformed request', 'NOT HTTP AT ALL\r\n\r\n'],
  ])('survives a client reset after %s and keeps serving', async (_name, request) => {
    // #given a client that reads the refusal and then resets the connection while the relay still holds its socket
    const {upstream, relay} = await arrange()
    const socket = net.connect({host: '127.0.0.1', port: relay.port})
    socket.on('error', () => undefined)
    await new Promise<void>(resolve => socket.once('connect', resolve))
    const answered = new Promise<void>(resolve => socket.once('data', () => resolve()))
    socket.write(request)
    await answered
    socket.resetAndDestroy()
    await new Promise(resolve => setTimeout(resolve, 200))

    // #then the relay is still up and serves a batch
    expect((await postBatch(relay.port)).status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
  })

  it.each([
    ['a type that is not protobuf or JSON', {'content-type': 'text/plain'}],
    ['a missing content type', {'content-type': ''}],
    ['a content type that only starts like an accepted one', {'content-type': 'application/jsonx'}],
    ['an unsupported encoding', {'content-encoding': 'br'}],
    ['an encoding that only contains gzip', {'content-encoding': 'gzip, br'}],
    ['deflate', {'content-encoding': 'deflate'}],
  ])('refuses %s locally with a final status and forwards nothing', async (_name, headers) => {
    const {upstream, relay} = await arrange()

    const answer = await postBatch(relay.port, {headers})

    expect(answer.status).toBe(415)
    expect(answer.body.length).toBe(0)
    expect(upstream.requests).toHaveLength(0)
    expect(relay.counts().dropped).toBe(1)
  })
})

describe('startTraceRelay: limits', () => {
  it('refuses a body over the request cap before it is buffered, from the declared length alone', async () => {
    // #given a cap of 1 KiB and a request that declares 5 MiB and sends none of it
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {maxRequestBodyBytes: 1024}})

    const exchange = await rawExchange(
      relay.port,
      `POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nContent-Length: ${5 * 1024 * 1024}\r\n\r\n`,
      {waitMs: 1000},
    )

    // #then the answer comes at once, without waiting for a body, and nothing was forwarded
    expect(exchange.status).toBe(413)
    expect(upstream.requests).toHaveLength(0)
    expect(relay.counts().dropped).toBe(1)
  })

  it('cuts off a chunked body that grows past the cap', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {maxRequestBodyBytes: 1024}})
    const chunk = 'a'.repeat(512)

    const exchange = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nTransfer-Encoding: chunked\r\n\r\n' +
        `200\r\n${chunk}\r\n200\r\n${chunk}\r\n200\r\n${chunk}\r\n0\r\n\r\n`,
      {waitMs: 500},
    )

    expect(exchange.status).toBe(413)
    expect(upstream.requests).toHaveLength(0)
  })

  it('refuses further batches once the run total is reached', async () => {
    // #given a total cap of 100 bytes
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {maxTotalBytes: 100}})
    const body = Buffer.alloc(60, 1)

    // #when three 60-byte batches are posted
    const first = await postBatch(relay.port, {body})
    const second = await postBatch(relay.port, {body})
    const third = await postBatch(relay.port, {body})

    // #then the first fits, and the rest are refused without a forward
    expect(first.status).toBe(200)
    expect(second.status).toBe(413)
    expect(third.status).toBe(413)
    expect(upstream.requests).toHaveLength(1)
    expect(relay.counts()).toEqual({delivered: 1, retry: 0, dropped: 2})
  })

  it('refuses a batch past the run total from its declared length alone, and from a chunked body as it grows', async () => {
    // #given a total cap of 100 bytes with 60 already used
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {maxTotalBytes: 100}})
    expect((await postBatch(relay.port, {body: Buffer.alloc(60, 1)})).status).toBe(200)

    // #when a request declares 60 more and sends none of it, and a chunked body of 60 follows
    const declared = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nContent-Length: 60\r\n\r\n',
      {waitMs: 1000},
    )
    const chunked = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nTransfer-Encoding: chunked\r\n\r\n' +
        `3c\r\n${'b'.repeat(60)}\r\n0\r\n\r\n`,
      {waitMs: 500},
    )

    // #then both are refused, the first without waiting for a body
    expect(declared.status).toBe(413)
    expect(chunked.status).toBe(413)
    expect(upstream.requests).toHaveLength(1)
  })

  it('cuts off a sender that stalls mid-request', async () => {
    // #given a short request timeout and a sender that promises 100 bytes and sends 5
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {requestTimeoutMs: 300}})

    const exchange = await rawExchange(
      relay.port,
      'POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nContent-Length: 100\r\n\r\nabcde',
      {waitMs: 3000},
    )

    // #then the relay ended the exchange itself, and nothing was forwarded
    expect(exchange.closed).toBe(true)
    expect(upstream.requests).toHaveLength(0)
  })

  it('cuts off a sender that never finishes its headers', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {headersTimeoutMs: 300}})

    const exchange = await rawExchange(relay.port, 'POST /v1/traces HTTP/1.1\r\nHost: x\r\n', {waitMs: 3000})

    expect(exchange.closed).toBe(true)
  })

  it('refuses a header block over the header cap with a final status', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {maxHeaderBytes: 1024}})

    const exchange = await rawExchange(
      relay.port,
      `POST /v1/traces HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(4096)}\r\nContent-Length: 0\r\n\r\n`,
    )

    expect(exchange.status).toBe(431)
    expect(upstream.requests).toHaveLength(0)
  })

  it('refuses a connection past the connection cap', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {maxConnections: 2}})
    const held: net.Socket[] = []
    cleanups.push(async () => {
      for (const socket of held) socket.destroy()
    })
    for (let i = 0; i < 2; i++) {
      const socket = net.connect({host: '127.0.0.1', port: relay.port})
      socket.on('error', () => undefined)
      await new Promise<void>(resolve => socket.once('connect', resolve))
      held.push(socket)
    }

    // #when a third connection is made
    const third = await rawExchange(relay.port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n', {waitMs: 500})

    // #then it is dropped without an answer
    expect(third.status).toBeNull()
    expect(third.closed).toBe(true)
  })
})

describe('startTraceRelay: its socket and its start', () => {
  it('listens on 127.0.0.1 only', async () => {
    const upstream = await upstreamAnswering(200)
    const relay = await relayFor(`${upstream.origin}/v1/traces`)

    expect(relay.address).toBe('127.0.0.1')
    expect(relay.port).toBeGreaterThan(0)
    // no other interface answers on the port
    const externals = Object.values(os.networkInterfaces())
      .flat()
      .filter(info => info !== undefined && !info.internal && info.family === 'IPv4')
    for (const info of externals) {
      const reachable = await new Promise<boolean>(resolve => {
        const socket = net.connect({host: info?.address ?? '', port: relay.port, timeout: 500})
        socket.once('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.once('error', () => resolve(false))
        socket.once('timeout', () => {
          socket.destroy()
          resolve(false)
        })
      })
      expect(reachable).toBe(false)
    }
    const v6 = await new Promise<boolean>(resolve => {
      const socket = net.connect({host: '::1', port: relay.port, timeout: 500})
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
    expect(v6).toBe(false)
  })

  it.each([
    ['an http URL to a public host', 'http://collector.example.com/v1/traces'],
    ['http://localhost', 'http://localhost:4318/v1/traces'],
    ['a URL with userinfo', 'https://user:pass@collector.example.com/v1/traces'],
    ['a string that is not a URL', 'not a url'],
  ])('refuses %s at start', async (_name, url) => {
    const started = await startTraceRelay({url, headers: []})
    expect(started.success).toBe(false)
  })

  it('stops answering after close and aborts a forward that is still waiting', async () => {
    const upstream = await startHttpUpstream(() => undefined)
    cleanups.push(upstream.close)
    const relay = await relayFor(`${upstream.origin}/v1/traces`, {limits: {upstreamTimeoutMs: 30_000}})
    const waiting = postBatch(relay.port).then(
      () => 'answered',
      () => 'cut',
    )
    await new Promise(resolve => setTimeout(resolve, 100))

    await relay.close()

    expect(await waiting).toBe('cut')
    await expect(postBatch(relay.port)).rejects.toThrow()
  })
})

async function arrangeCounts() {
  const upstream = await upstreamAnswering(200)
  const relay = await relayFor(`${upstream.origin}/v1/traces`)
  return {upstream, relay}
}

describe('startTraceRelay: the plugin counts header', () => {
  const withCounts = (value: string) => ({headers: {[TRACE_RELAY_COUNTS_HEADER]: value}})

  it('records a valid value, and keeps null when none was ever received', async () => {
    const {relay} = await arrangeCounts()
    expect(relay.pluginCounts()).toBeNull()

    await postBatch(relay.port)
    expect(relay.pluginCounts()).toBeNull()

    await postBatch(relay.port, withCounts('exported=12;dropped=3'))
    expect(relay.pluginCounts()).toEqual({exportedSpans: 12, droppedSpans: 3})
  })

  it('keeps the last valid value, not a sum, and does not require it to grow', async () => {
    const {relay} = await arrangeCounts()

    await postBatch(relay.port, withCounts('exported=100;dropped=10'))
    await postBatch(relay.port, withCounts('exported=7;dropped=1'))

    expect(relay.pluginCounts()).toEqual({exportedSpans: 7, droppedSpans: 1})
  })

  it.each([
    ['malformed', 'exported=lots'],
    ['oversized', `exported=${'9'.repeat(13)};dropped=1`],
    ['negative', 'exported=-1;dropped=2'],
    ['non-numeric', 'exported=a;dropped=b'],
    ['with an extra field', 'exported=1;dropped=2;x=3'],
    ['empty', ' '],
  ])('ignores a %s value without refusing the batch, and keeps the earlier valid one', async (_name, value) => {
    const {upstream, relay} = await arrangeCounts()
    await postBatch(relay.port, withCounts('exported=5;dropped=6'))

    const answer = await postBatch(relay.port, withCounts(value))

    expect(answer.status).toBe(200)
    expect(upstream.requests).toHaveLength(2)
    expect(relay.pluginCounts()).toEqual({exportedSpans: 5, droppedSpans: 6})
    expect(relay.counts()).toEqual({delivered: 2, retry: 0, dropped: 0})
  })

  it('ignores a duplicated header without refusing the batch', async () => {
    const {upstream, relay} = await arrangeCounts()

    const exchange = await rawExchange(
      relay.port,
      `POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-protobuf\r\nContent-Length: 2\r\n${TRACE_RELAY_COUNTS_HEADER}: exported=1;dropped=2\r\n${TRACE_RELAY_COUNTS_HEADER}: exported=3;dropped=4\r\n\r\nab`,
      {waitMs: 400},
    )

    expect(exchange.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(relay.pluginCounts()).toBeNull()
  })

  it('does not forward the header upstream, valid or not', async () => {
    const {upstream, relay} = await arrangeCounts()

    await postBatch(relay.port, withCounts('exported=1;dropped=2'))
    await postBatch(relay.port, withCounts('garbage'))

    expect(upstream.requests).toHaveLength(2)
    for (const request of upstream.requests) {
      expect(request.headers[TRACE_RELAY_COUNTS_HEADER]).toBeUndefined()
      expect(JSON.stringify(request.headers)).not.toContain('exported=')
    }
  })

  it('records the value only from a request on the route', async () => {
    const {relay} = await arrangeCounts()

    await postBatch(relay.port, {path: '/elsewhere', ...withCounts('exported=1;dropped=2')})
    await postBatch(relay.port, {method: 'GET', body: '', ...withCounts('exported=1;dropped=2')})

    expect(relay.pluginCounts()).toBeNull()
  })
})
