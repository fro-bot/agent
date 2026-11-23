/**
 * Lazy tracing entry. `setup.ts` reaches this module through one dynamic `import()` so the bundler emits it, and the
 * OpenTelemetry SDK it pulls in, as a separate chunk that is evaluated only when tracing resolves to on.
 *
 * `startTracing` builds the whole path (scrubber, exporter, pipeline, hook and event observers) and returns a handle whose
 * `stop` closes open spans, flushes within a bound and logs the counts. Nothing here is awaited on the host's request
 * path: handlers only append observations.
 */

import type {TracingSettings} from './settings.js'

import {createSpanExporter} from '@fro-bot/runtime/tracing/exporter'
import {createScrubber, type Scrubber} from './content.js'
import {createTracePipeline} from './pipeline.js'
import {registerObservers, type ObserverHost} from './record-observations.js'
import {createSnapshotLedger, type PendingLimits} from './snapshot.js'

/**
 * How long cleanup may take, all of it: closing spans, the final batch, the transport.
 *
 * The server waits for plugin cleanup with no cap of its own, and the Action SIGKILLs the process 5 s after it closes
 * stdin, starting before this cleanup does (measured: the cleanup begins about 6 ms after stdin closes). Three seconds
 * leaves two for any other plugin's cleanup and the process exit, and is still longer than a healthy loopback relay or a
 * nearby collector needs for one batch. A batch still in flight at the bound is abandoned and counted as dropped.
 */
export const CLEANUP_BOUND_MS = 3_000

/**
 * The most of the cleanup bound the pipeline may spend mapping and scrubbing what is left, so the exporter keeps the
 * rest (about two thirds) to deliver the final batch. What the pipeline has not done by then is dropped and counted.
 */
export const DRAIN_BOUND_MS = 1_000

export type OnSettings = Extract<TracingSettings, {mode: 'on'}>

export interface TracingHandle {
  /** Closes everything, flushes within `CLEANUP_BOUND_MS` and logs the counts. Never throws. */
  readonly stop: () => Promise<void>
}

export interface StartTracingOptions {
  /** The plugin's own environment, read once for secret-named variables. Never exported, never logged. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly log: (line: string) => void
  readonly now?: () => number
  /** Bounds on snapshots pending export. Tests lower them; production uses the defaults. */
  readonly pending?: Partial<PendingLimits>
  /** The most of the cleanup bound the pipeline may spend on what is left. Tests lower it; production uses `DRAIN_BOUND_MS`. */
  readonly drainBoundMs?: number
  /** Replaces the scrubber (tests that force the safety net). Production builds its own from `env`. */
  readonly scrubber?: Scrubber
}

export async function startTracing(
  host: ObserverHost,
  settings: OnSettings,
  options: StartTracingOptions,
): Promise<TracingHandle> {
  const {log} = options
  const local = settings.host === 'local'
  const scrubber =
    options.scrubber ??
    createScrubber({
      env: options.env,
      // The collector credential is a literal secret too: it must not come back in a tool result or an error message.
      extraSecrets: local ? Object.values(settings.headers) : [],
    })
  const exporter = createSpanExporter({
    url: settings.endpoint,
    headers: local ? settings.headers : {},
    // Action mode only: a local collector did not ask for the header.
    reportCounts: !local,
    onStopped: () => {
      log('tracing stopped exporting after repeated failures')
    },
  })
  // Snapshots pending export are counted apart from the exporter's queue; the pipeline frees each as its span leaves.
  const ledger = createSnapshotLedger(options.pending)
  const pipeline = createTracePipeline({
    sink: exporter,
    scrubber,
    ledger,
    ...(settings.host === 'action' ? {identity: settings.identity} : {}),
    ...(options.now === undefined ? {} : {now: options.now}),
  })

  let stopObserving: () => void
  try {
    stopObserving = await registerObservers(
      host,
      observation => {
        pipeline.observe(observation)
      },
      options.now,
      {ledger},
    )
  } catch (error) {
    // Some hooks may already be registered: they only append to a pipeline that is stopped now.
    pipeline.stop()
    await exporter.close(0)
    throw error
  }

  let stopping: Promise<void> | undefined
  return {
    stop: async () => {
      stopping ??= (async () => {
        const started = Date.now()
        try {
          stopObserving()
          pipeline.stop(options.drainBoundMs ?? DRAIN_BOUND_MS)
        } catch {
          // Counted below as whatever the exporter holds.
        }
        let counts = exporter.counts()
        try {
          counts = await exporter.close(Math.max(0, CLEANUP_BOUND_MS - (Date.now() - started)))
        } catch {
          // The line below reports what is known.
        }
        const {observationsDropped} = pipeline.stats()
        const lost = observationsDropped > 0 ? `, ${observationsDropped} observations lost` : ''
        // Normally absent: a number here means a known literal got past the matchers and the safety net withheld the value.
        const withheld = scrubber.survivalCount?.() ?? 0
        const survived = withheld > 0 ? `, ${withheld} values withheld (literal survived)` : ''
        log(`tracing stopped, exported ${counts.exported} spans, dropped ${counts.dropped}${lost}${survived}`)
      })()
      await stopping
    },
  }
}
