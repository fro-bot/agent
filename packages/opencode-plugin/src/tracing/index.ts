/**
 * Lazy tracing entry. `setup.ts` reaches this module through one dynamic `import()` so the bundler emits it, and the
 * OpenTelemetry SDK it pulls in, as a separate chunk that is evaluated only when tracing is on.
 *
 * Everything is constructed explicitly: no detectors, no global tracer provider, and nothing the SDK would otherwise
 * take from an `OTEL_*` variable. The exporter is built from `createOtlpHttpExportDelegate` rather than the
 * `OTLPTraceExporter` class: that class merges `OTEL_EXPORTER_OTLP_HEADERS` into the headers it is given.
 */

import {OTLPExporterBase} from '@opentelemetry/otlp-exporter-base'
import {createOtlpHttpExportDelegate, httpAgentFactoryFromOptions} from '@opentelemetry/otlp-exporter-base/node-http'
import {JsonTraceSerializer} from '@opentelemetry/otlp-transformer'
import {resourceFromAttributes} from '@opentelemetry/resources'
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'

export interface StubExportOptions {
  /** Full OTLP traces URL, for example `http://127.0.0.1:4318/v1/traces`. */
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

const EXPORT_TIMEOUT_MS = 5_000

/** Builds a tracer, records one span with explicit times, and flushes. Feasibility stub: replaced by the real exporter. */
export async function exportStubSpan(options: StubExportOptions): Promise<void> {
  const headers = {'Content-Type': 'application/json', ...options.headers}
  const exporter = new OTLPExporterBase<ReadableSpan[]>(
    createOtlpHttpExportDelegate(
      {
        url: options.url,
        headers: async () => headers,
        timeoutMillis: EXPORT_TIMEOUT_MS,
        concurrencyLimit: 4,
        compression: 'none',
        agentFactory: httpAgentFactoryFromOptions({keepAlive: true}),
      },
      JsonTraceSerializer,
    ),
  )
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({'service.name': 'fro-bot-opencode-plugin'}),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 64,
        maxExportBatchSize: 32,
        scheduledDelayMillis: 1_000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  })
  try {
    const start = Date.now()
    const span = provider.getTracer('fro-bot-opencode-plugin').startSpan('feasibility stub', {startTime: start})
    span.end(start + 1)
    await provider.forceFlush()
  } finally {
    await provider.shutdown()
  }
}
