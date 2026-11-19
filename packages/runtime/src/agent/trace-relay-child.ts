import type {Readable} from 'node:stream'
import type {Result} from '../shared/types.js'
import type {TraceRelayChildErrorCode} from './trace-relay-wire.js'
import type {StartTraceRelayOptions, TraceRelayServer} from './trace-relay.js'
import {Buffer} from 'node:buffer'
import {
  parseTraceRelayConfig,
  readTraceRelayFrameLength,
  TRACE_RELAY_EXIT_INTERNAL,
  TRACE_RELAY_EXIT_INVALID_CONFIG,
  TRACE_RELAY_EXIT_START_FAILED,
} from './trace-relay-wire.js'
import {startTraceRelay} from './trace-relay.js'

/**
 * The trace-relay child's main loop, with its process streams injected so tests can run it in-process.
 *
 * It reads one framed config from stdin, starts the relay, prints one ready line and then waits: stdin closing, a
 * shutdown request, or an internal failure ends it. On a stop it prints one report line with the batch counts. Its output
 * is exactly those lines: it never prints a stack, a quoted input, a URL, a header or a body, and nothing else on stdout.
 */

export interface TraceRelayChildIo {
  readonly stdin: Readable
  readonly stdout: {readonly write: (chunk: string) => unknown}
  /** Ends the process. Called at most once. */
  readonly exit: (code: number) => void
  /** Longest to wait for the whole frame. Default 10 s. */
  readonly frameTimeoutMs?: number
}

export interface TraceRelayChildDeps {
  /** Starts the relay. Defaults to {@link startTraceRelay}; tests inject a failing one. */
  readonly startRelay?: (options: StartTraceRelayOptions) => Promise<Result<TraceRelayServer, string>>
}

export interface TraceRelayChild {
  /** Stops the relay, prints the report line and exits 0. */
  readonly requestShutdown: () => void
  /** Prints the fixed error line for `code` and exits non-zero. */
  readonly fail: (code: TraceRelayChildErrorCode) => void
}

const DEFAULT_FRAME_TIMEOUT_MS = 10_000

const EXIT_CODES: Readonly<Record<TraceRelayChildErrorCode, number>> = {
  'invalid-config': TRACE_RELAY_EXIT_INVALID_CONFIG,
  'start-failed': TRACE_RELAY_EXIT_START_FAILED,
  internal: TRACE_RELAY_EXIT_INTERNAL,
}

export function runTraceRelayChild(io: TraceRelayChildIo, deps: TraceRelayChildDeps = {}): TraceRelayChild {
  const startRelay = deps.startRelay ?? startTraceRelay
  let finished = false
  let relay: TraceRelayServer | undefined
  let frameTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (code: number, line?: string): void => {
    if (finished) return
    finished = true
    if (frameTimer !== undefined) clearTimeout(frameTimer)
    if (line !== undefined) io.stdout.write(`${line}\n`)
    io.exit(code)
  }

  const fail = (code: TraceRelayChildErrorCode): void => {
    // The error line goes out first; the exit does not wait for a stuck close.
    relay?.close().catch(() => undefined)
    finish(EXIT_CODES[code], JSON.stringify({error: code}))
  }

  let shuttingDown = false
  const requestShutdown = (): void => {
    // Stdin ending and then closing, a signal, and a caller's request all land here: the first one runs the shutdown.
    if (finished || shuttingDown) return
    shuttingDown = true
    const stopping = relay
    const closing = stopping?.close() ?? Promise.resolve(undefined)
    closing.then(
      counts => {
        // Only integers reach the line: the batch counts, and the plugin's totals as the wire module validated them.
        const plugin = stopping?.pluginCounts()
        finish(
          0,
          counts === undefined ? undefined : JSON.stringify({report: {...counts, ...(plugin == null ? {} : {plugin})}}),
        )
      },
      () => finish(0),
    )
  }

  const chunks: Buffer[] = []
  let configured = false

  const onConfigFrame = async (payload: Buffer): Promise<void> => {
    let decoded: unknown
    try {
      decoded = JSON.parse(payload.toString('utf8'))
    } catch {
      fail('invalid-config')
      return
    }
    const config = parseTraceRelayConfig(decoded)
    if (!config.success) {
      fail('invalid-config')
      return
    }
    const started = await startRelay({
      url: config.data.url,
      headers: config.data.headers,
      ...(config.data.limits === undefined ? {} : {limits: config.data.limits}),
    })
    if (!started.success) {
      fail('start-failed')
      return
    }
    relay = started.data
    if (finished) {
      // A shutdown or a failure won the race while the relay was starting.
      relay.close().catch(() => undefined)
      return
    }
    io.stdout.write(`${JSON.stringify({ready: true, port: started.data.port})}\n`)
  }

  const onData = (chunk: Buffer): void => {
    if (finished || configured) return
    chunks.push(chunk)
    const buffered = Buffer.concat(chunks)
    if (buffered.length < 4) return
    const length = readTraceRelayFrameLength(buffered)
    if (length === null) {
      fail('invalid-config')
      return
    }
    if (buffered.length < 4 + length) return
    configured = true
    if (frameTimer !== undefined) clearTimeout(frameTimer)
    onConfigFrame(buffered.subarray(4, 4 + length)).catch(() => fail('internal'))
  }

  const onClosed = (): void => {
    if (finished) return
    if (configured) {
      requestShutdown()
    } else {
      fail('invalid-config')
    }
  }

  frameTimer = setTimeout(() => {
    if (!configured) fail('invalid-config')
  }, io.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS)

  io.stdin.on('data', onData)
  io.stdin.once('end', onClosed)
  io.stdin.once('close', onClosed)
  io.stdin.on('error', onClosed)

  return {requestShutdown, fail}
}
