/**
 * Test support for the OTLP exporter and its callers: a loopback OTLP/HTTP collector, and an HTTPS one with a certificate
 * nothing trusts. Shared by the runtime's exporter suite, the plugin's tracing suites and the Action's real-binary tests (the
 * plugin's `integration.fixture.ts` re-exports it).
 */

import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {createServer} from 'node:http'
import {createServer as createHttpsServer} from 'node:https'
import {tmpdir} from 'node:os'
import path from 'node:path'

export interface SinkRequest {
  readonly method: string
  readonly path: string
  readonly contentType: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: unknown
  /** The raw request body, for walking every string that was sent. */
  readonly text: string
  /** The status this request was answered with. */
  readonly status: number
}

export interface SinkResponse {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: string
  /** Wait this long before answering. */
  readonly delayMs?: number
  /** Never answer: the connection stays open until the sink stops, which destroys it. No timer is left running. */
  readonly hold?: boolean
}

export interface OtlpSink {
  /** The full traces URL, for example `http://127.0.0.1:4318/v1/traces`. */
  readonly url: string
  /** Every request, in arrival order, whatever it was answered with. */
  readonly requests: SinkRequest[]
  /** Requests answered with a status below 300. */
  readonly accepted: () => SinkRequest[]
  /** Requests received in full, whatever they were or will be answered with (a held one is counted when it arrives). */
  readonly received: () => number
  /** Most requests that were in flight at once. */
  readonly peakConcurrent: () => number
  readonly stop: () => Promise<void>
}

export interface OtlpSinkOptions {
  /** Decides the answer to request number `n` (from 1). Default: 200 with an empty JSON body. */
  readonly respond?: (n: number, request: Omit<SinkRequest, 'status'>) => SinkResponse
}

/** A loopback OTLP/HTTP collector that records every request and answers as scripted. */
export async function startOtlpSink(options: OtlpSinkOptions = {}): Promise<OtlpSink> {
  const requests: SinkRequest[] = []
  let inFlight = 0
  let peak = 0
  let count = 0
  let received = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    inFlight += 1
    peak = Math.max(peak, inFlight)
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // Keep the text.
      }
      count += 1
      received += 1
      const seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        contentType: req.headers['content-type'] ?? '',
        headers: {...req.headers},
        body,
        text,
      }
      const answer = options.respond?.(count, seen) ?? {status: 200, body: '{}'}
      // Held: no answer and no timer; `stop` destroys the connection.
      if (answer.hold === true) return
      const finish = (): void => {
        requests.push({...seen, status: answer.status})
        res.writeHead(answer.status, {'content-type': 'application/json', ...answer.headers})
        res.end(answer.body ?? '{}')
        inFlight -= 1
      }
      if (answer.delayMs === undefined) finish()
      else setTimeout(finish, answer.delayMs)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('OTLP sink did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/v1/traces`,
    requests,
    accepted: () => requests.filter(request => request.status < 300),
    received: () => received,
    peakConcurrent: () => peak,
    stop: async () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface TlsSink {
  /** The full traces URL over https, for example `https://127.0.0.1:4318/v1/traces`. */
  readonly url: string
  /**
   * The self-signed certificate file, for a client that is meant to trust it (`NODE_EXTRA_CA_CERTS` of a child process).
   * Removed by `stop`.
   */
  readonly certFile: string
  /** HTTP requests that got through TLS. A client that refuses the certificate never produces one. */
  readonly requests: SinkRequest[]
  /** TCP connections accepted, and TLS handshakes that completed or were refused by the client. */
  readonly connections: () => number
  readonly handshakes: () => number
  readonly tlsErrors: () => number
  readonly stop: () => Promise<void>
}

/** Whether `openssl` can be run: the one thing that makes the TLS tests skip, by name. Anything else going wrong fails them. */
export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], {stdio: 'ignore'})
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * A loopback HTTPS collector with a self-signed certificate nothing trusts, made with `openssl` at run time (no key is
 * committed). A client that validates certificates refuses it. Throws when the certificate cannot be made: callers skip
 * only when `opensslAvailable()` is false.
 */
export async function startTlsSink(options: OtlpSinkOptions = {}): Promise<TlsSink> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tls-sink-'))
  const keyFile = path.join(dir, 'key.pem')
  const certFile = path.join(dir, 'cert.pem')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      {stdio: 'ignore'},
    )
  } catch (error) {
    rmSync(dir, {recursive: true, force: true})
    throw error
  }
  const requests: SinkRequest[] = []
  let connections = 0
  let handshakes = 0
  let tlsErrors = 0
  let count = 0
  const server = createHttpsServer({key: readFileSync(keyFile), cert: readFileSync(certFile)}, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      count += 1
      const seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        contentType: req.headers['content-type'] ?? '',
        headers: {...req.headers},
        body: text,
        text,
      }
      const answer = options.respond?.(count, seen) ?? {status: 200, body: '{}'}
      requests.push({...seen, status: answer.status})
      res.writeHead(answer.status, {'content-type': 'application/json'})
      res.end(answer.body ?? '{}')
    })
  })
  server.on('connection', () => {
    connections += 1
  })
  server.on('secureConnection', () => {
    handshakes += 1
  })
  server.on('tlsClientError', () => {
    tlsErrors += 1
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('TLS sink did not bind a TCP port')
  return {
    url: `https://127.0.0.1:${address.port}/v1/traces`,
    certFile,
    requests,
    connections: () => connections,
    handshakes: () => handshakes,
    tlsErrors: () => tlsErrors,
    stop: async () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => {
          rmSync(dir, {recursive: true, force: true})
          resolve()
        })
      }),
  }
}
