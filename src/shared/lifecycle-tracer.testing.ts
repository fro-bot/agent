import type {SpanExporter} from '@fro-bot/runtime/tracing/exporter'
import type {ScrubbedSpan} from '@fro-bot/runtime/tracing/scrub'
import type {LifecycleTracer} from './lifecycle-tracer.js'
import type {SecretRegistry} from './secret-registry.js'
import {createLifecycleTracer} from './lifecycle-tracer.js'
import {createSecretRegistry} from './secret-registry.js'

/**
 * Test support: a real lifecycle tracer, secret registry and scrub, whose exporter keeps the spans it is handed instead of
 * sending them. A test records, flushes, then reads `exported` for exactly the spans a run would have sent.
 */
export interface RecordingTracer {
  readonly tracer: LifecycleTracer
  readonly registry: SecretRegistry
  /** The scrubbed spans, in export order. Filled by `tracer.flush()`. */
  readonly exported: ScrubbedSpan[]
  /** The values the registry's masker was called with (`core.setSecret` in a run). */
  readonly masked: string[]
}

export function createRecordingTracer(): RecordingTracer {
  const exported: ScrubbedSpan[] = []
  const masked: string[] = []
  const exporter: SpanExporter = {
    export: span => {
      exported.push(span)
    },
    counts: () => ({exported: exported.length, dropped: 0}),
    drop: () => undefined,
    close: async () => ({exported: exported.length, dropped: 0}),
  }
  const registry = createSecretRegistry(value => {
    masked.push(value)
  })
  const tracer = createLifecycleTracer({
    inputs: {enabled: true, url: 'http://127.0.0.1:9/v1/traces', headers: []},
    logger: {debug: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined},
    registry,
    env: {},
    createExporter: () => exporter,
  })
  return {tracer, registry, exported, masked}
}

/** The exported span named `name`, or a thrown error so a test never reads through an optional. */
export function spanNamed(exported: readonly ScrubbedSpan[], name: string): ScrubbedSpan {
  const found = exported.find(span => span.name === name)
  if (found === undefined) throw new Error(`no exported span named ${name}`)
  return found
}
