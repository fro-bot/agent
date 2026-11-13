/**
 * Fixtures for the key proxy tests: a self-signed TLS certificate for `127.0.0.1` and a recording HTTPS upstream.
 *
 * Not shipped: imported by tests only. The certificate comes from the `openssl` binary on the PATH.
 */

import type {IncomingHttpHeaders, IncomingMessage, ServerResponse} from 'node:http'
import type {Server} from 'node:https'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {createServer} from 'node:https'
import os from 'node:os'
import path from 'node:path'

export interface TlsMaterial {
  readonly key: string
  readonly cert: string
}

let cached: TlsMaterial | undefined

/** One certificate per process: `CN=localhost`, valid for `127.0.0.1` and `localhost`. */
export function generateTlsMaterial(): TlsMaterial {
  if (cached !== undefined) return cached
  const dir = mkdtempSync(path.join(os.tmpdir(), 'key-proxy-tls-'))
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
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      {stdio: 'ignore'},
    )
    cached = {
      key: readFileSync(path.join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
    }
    return cached
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

export interface RecordedRequest {
  readonly method: string
  readonly url: string
  /** Lower-cased header names as the upstream received them. */
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

export type UpstreamHandler = (request: RecordedRequest, res: ServerResponse, req: IncomingMessage) => void

export interface TlsUpstream {
  /** `https://127.0.0.1:<port>`. */
  readonly origin: string
  /** The PEM the proxy must trust. */
  readonly ca: string
  readonly requests: RecordedRequest[]
  /** Live request sockets, so a test can see one destroyed. */
  readonly connections: Set<IncomingMessage>
  readonly close: () => Promise<void>
}

/** An HTTPS server on an ephemeral loopback port that records every request before it calls `handler`. */
export async function startTlsUpstream(handler: UpstreamHandler): Promise<TlsUpstream> {
  const tls = generateTlsMaterial()
  const requests: RecordedRequest[] = []
  const connections = new Set<IncomingMessage>()
  const server: Server = createServer({key: tls.key, cert: tls.cert}, (req, res) => {
    const chunks: Buffer[] = []
    connections.add(req)
    req.once('close', () => connections.delete(req))
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
    origin: `https://127.0.0.1:${port}`,
    ca: tls.cert,
    requests,
    connections,
    close: async () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
