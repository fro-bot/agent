/**
 * A usable tracing fallback for the real-runner "tracing off" row (`v2-server.sandbox.integration.test.ts`, suite 14), and the
 * sink it points at. Nothing here is product code.
 *
 * The plugin turns tracing on from a user-scope settings file only when no launcher variable is set and the server is not
 * headless (`resolveTracingSettings`). The file is accepted when it is a regular file the plugin's user owns, mode 0600, under
 * 16 KiB, outside the project directory, version 1, with a collector URL that is `https` or loopback `http`, and `hosts`
 * naming the machine. Planted for the sandbox user with the Action's "off" launcher, it is a path a wrongly-on plugin would
 * export through; a sink that hears nothing then shows the launcher won.
 */
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {USER_SETTINGS_RELATIVE_PATH} from '../../../packages/opencode-plugin/src/tracing/settings.js'

/** The machine's name as the plugin matches it: lower case, without a trailing dot. */
export function fallbackHosts(hostname: string): string[] {
  return [hostname.toLowerCase().replace(/\.$/, '')]
}

/** True for an address the plugin accepts as a plain-`http` collector: a loopback IPv4 literal or `[::1]`. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export interface TracingFallback {
  readonly endpoint: string
  readonly hosts: readonly string[]
}

/**
 * The file's text. Refuses an endpoint the plugin would refuse, so a fallback that could never turn tracing on is not planted
 * and then mistaken for a proof. The header is a marker only, never a credential.
 */
export function tracingFallbackDocument(fallback: TracingFallback): string {
  const url = new URL(fallback.endpoint)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('the plugin accepts only an https collector, or plain http on a loopback address')
  }
  return JSON.stringify({
    version: 1,
    endpoint: fallback.endpoint,
    headers: {'x-fallback-marker': 'sink'},
    hosts: fallback.hosts,
  })
}

/** Where the plugin reads the file for a given `$XDG_CONFIG_HOME`. */
export const fallbackFilePath = (configHome: string): string => path.join(configHome, USER_SETTINGS_RELATIVE_PATH)

/** Writes the file for the current user, mode 0600, under `configHome`. */
export function writeTracingFallbackFile(configHome: string, fallback: TracingFallback): string {
  const file = fallbackFilePath(configHome)
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700})
  fs.writeFileSync(file, tracingFallbackDocument(fallback), {mode: 0o600})
  fs.chmodSync(file, 0o600)
  return file
}

export interface RecordingHttpSink {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string
  /** `127.0.0.1:<port>`. */
  readonly address: string
  /** One `METHOD path` per request received. */
  readonly requests: string[]
  readonly close: () => Promise<void>
}

/**
 * A plain-`http` loopback server that records and accepts every request. It is `http` because the plugin sends to an `https`
 * collector only if it trusts its certificate, and a wrongly-on plugin must be able to reach this one.
 */
export async function startRecordingHttpSink(): Promise<RecordingHttpSink> {
  const requests: string[] = []
  const server = http.createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`)
    request.resume()
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(Buffer.from('{}'))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    address: `127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
