/**
 * Fixtures for the trace relay tests: a recording loopback HTTP upstream, a batch poster and a raw-socket exchange.
 *
 * Not shipped: imported by tests only. The HTTPS upstream comes from `key-proxy-test-kit.ts`.
 */

import type {IncomingHttpHeaders, IncomingMessage, Server, ServerResponse} from 'node:http'
import type {RecordedRequest, UpstreamHandler} from './key-proxy-test-kit.js'
import {Buffer} from 'node:buffer'
import http from 'node:http'
import net from 'node:net'

export type {RecordedRequest, UpstreamHandler} from './key-proxy-test-kit.js'

export interface HttpUpstream {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string
  readonly port: number
  readonly requests: RecordedRequest[]
  readonly close: () => Promise<void>
}

/** An HTTP server on an ephemeral loopback port that records every request before it calls `handler`. */
export async function startHttpUpstream(handler: UpstreamHandler): Promise<HttpUpstream> {
  const requests: RecordedRequest[] = []
  const server: Server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      requests.push(recorded)
      handler(recorded, res, req)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: async () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface PostedBatch {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

export interface PostOptions {
  readonly path?: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: Buffer | string
}

/** One request to the relay at `127.0.0.1:<port>`. A protobuf content type and the fixed path unless told otherwise. */
export async function postBatch(port: number, options: PostOptions = {}): Promise<PostedBatch> {
  return new Promise<PostedBatch>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/v1/traces',
        method: options.method ?? 'POST',
        headers: {'content-type': 'application/x-protobuf', ...options.headers},
        agent: false,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(options.body ?? Buffer.from([0x0a, 0x00, 0xff]))
  })
}

export interface RawExchange {
  /** The status code of the first response line, or null when nothing parseable came back. */
  readonly status: number | null
  readonly text: string
  /** The server closed the connection before `waitMs` ran out. */
  readonly closed: boolean
}

/**
 * Writes `bytes` on a plain socket and reads what comes back for up to `waitMs`. For requests `http.request` will not
 * build: CONNECT, an absolute-form target, a lying content length, a stall.
 */
export async function rawExchange(
  port: number,
  bytes: string | Buffer,
  options: {readonly waitMs?: number; readonly endAfterWrite?: boolean} = {},
): Promise<RawExchange> {
  return new Promise<RawExchange>(resolve => {
    const socket = net.connect({host: '127.0.0.1', port})
    let text = ''
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      clearTimeout(timer)
      socket.destroy()
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(text)
      resolve({status: match === null ? null : Number(match[1]), text, closed})
    }
    timer = setTimeout(finish, options.waitMs ?? 500)
    socket.on('data', chunk => {
      text += chunk.toString('latin1')
    })
    socket.on('error', () => {
      closed = true
      finish()
    })
    socket.on('close', () => {
      closed = true
      finish()
    })
    socket.on('connect', () => {
      socket.write(bytes)
      if (options.endAfterWrite === true) socket.end()
    })
  })
}
