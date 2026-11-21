/**
 * Support for the real-binary tracing tests: decoding what a loopback OTLP sink received, drawing the span tree, walking
 * every string of a payload, and driving sessions through the real HTTP API.
 */

import type {RunningServer, SinkRequest} from '../integration.fixture.js'

export const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Polls until `done`. On timeout the error carries `diagnose()`: what the test saw, so a failure explains itself. */
export async function waitUntil(
  label: string,
  done: () => boolean,
  timeoutMs = 40_000,
  diagnose?: () => string,
): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (done()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}${diagnose === undefined ? '' : `\n${diagnose()}`}`)
}

export interface DecodedSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly kind: number
  readonly startMs: number
  readonly endMs: number
  readonly status: {readonly code: number; readonly message?: string}
  readonly attrs: Readonly<Record<string, unknown>>
  readonly events: readonly {readonly name: string}[]
  readonly resource: Readonly<Record<string, unknown>>
  readonly request: number
}

interface RawValue {
  stringValue?: string
  intValue?: string | number
  boolValue?: boolean
  doubleValue?: number
  arrayValue?: {values?: RawValue[]}
}

function decodeValue(value: RawValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.boolValue !== undefined) return value.boolValue
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(item => decodeValue(item))
  return undefined
}

const decodeAttributes = (list: {key: string; value: RawValue}[] | undefined): Record<string, unknown> =>
  Object.fromEntries((list ?? []).map(item => [item.key, decodeValue(item.value)]))

interface RawSpan {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes?: {key: string; value: RawValue}[]
  status?: {code?: number; message?: string}
  events?: {name: string}[]
}

/** Every span in the accepted requests, decoded from the exporter's OTLP JSON, in arrival order. */
export function decodeSpans(requests: readonly SinkRequest[]): DecodedSpan[] {
  return requests.flatMap((request, index) => {
    const body = request.body as {
      resourceSpans?: {resource?: {attributes?: {key: string; value: RawValue}[]}; scopeSpans?: {spans?: RawSpan[]}[]}[]
    }
    return (body.resourceSpans ?? []).flatMap(resource =>
      (resource.scopeSpans ?? []).flatMap(scope =>
        (scope.spans ?? []).map(span => ({
          name: span.name,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId === undefined || span.parentSpanId === '' ? undefined : span.parentSpanId,
          kind: span.kind,
          startMs: Number(BigInt(span.startTimeUnixNano) / 1_000_000n),
          endMs: Number(BigInt(span.endTimeUnixNano) / 1_000_000n),
          status: {
            code: span.status?.code ?? 0,
            ...(span.status?.message === undefined ? {} : {message: span.status.message}),
          },
          attrs: decodeAttributes(span.attributes),
          events: span.events ?? [],
          resource: decodeAttributes(resource.resource?.attributes),
          request: index,
        })),
      ),
    )
  })
}

/** The tree as names, kinds and attribute keys: no content. Children are indented under their parent, oldest first. */
export function outline(spans: readonly DecodedSpan[]): string {
  const byParent = new Map<string | undefined, DecodedSpan[]>()
  const ids = new Set(spans.map(span => span.spanId))
  for (const span of spans) {
    const parent = span.parentSpanId !== undefined && ids.has(span.parentSpanId) ? span.parentSpanId : undefined
    byParent.set(parent, [...(byParent.get(parent) ?? []), span])
  }
  const kinds = ['internal', 'internal', 'internal', 'client']
  const lines: string[] = []
  const walk = (parent: string | undefined, depth: number): void => {
    const children = (byParent.get(parent) ?? []).toSorted((a, b) => a.startMs - b.startMs)
    for (const span of children) {
      const keys = Object.keys(span.attrs)
        .filter(key => !key.startsWith('gen_ai.usage') && key !== 'session.id' && key !== 'gen_ai.conversation.id')
        .toSorted((a, b) => a.localeCompare(b))
      const flags = [
        span.status.code === 2 ? 'ERROR' : '',
        typeof span.attrs['fro_bot.outcome'] === 'string' ? String(span.attrs['fro_bot.outcome']) : '',
      ]
        .filter(flag => flag !== '')
        .join(' ')
      lines.push(
        `${'  '.repeat(depth)}${span.name} [${kinds[span.kind] ?? span.kind}${flags === '' ? '' : ` ${flags}`}] {${keys.join(', ')}}`,
      )
      walk(span.spanId, depth + 1)
    }
  }
  walk(undefined, 0)
  return lines.join('\n')
}

/** Every string anywhere in a JSON value, keys included. */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out)
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      allStrings(item, out)
    }
  }
  return out
}

/** Secret shapes assembled at run time, and the part of each that must never appear in a payload. */
const join = (...parts: string[]): string => parts.join('')
export const FIXTURE_SECRETS = {
  github: {value: join('ghp_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'), needle: 'aB3dE5fG7hJ9'},
  openai: {value: join('sk-', 'Q9x8W7e6R5t4Y3u2I1o0P9a8S7d6'), needle: 'Q9x8W7e6R5'},
  aws: {value: join('AKIA', 'IOSFODNN7EXAMPLE'), needle: 'IOSFODNN7EXAMPLE'},
  pem: {
    value: join('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END RSA PRIVATE', ' KEY-----'),
    needle: 'MIIEowIBAAKCAQEA',
  },
  pair: {value: 'database_password=hunter2xyz99', needle: 'hunter2xyz99'},
  connection: {value: join('postgres://', 'app:pw98765@db.internal:5432/prod'), needle: 'pw98765'},
} as const

export const secretNeedles = (): string[] => Object.values(FIXTURE_SECRETS).map(secret => secret.needle)

/** The fixture secrets, one per line: for a file the model reads and for a prompt. */
export const secretLines = (): string =>
  Object.values(FIXTURE_SECRETS)
    .map(secret => secret.value)
    .join('\n')

type Api = RunningServer['api']

export async function createSession(api: Api, directory: string): Promise<string> {
  const created = await api('POST', '/api/session', {body: {location: {directory}}})
  const data = (created.data as {data?: {id?: unknown}}).data
  if (typeof data?.id !== 'string') throw new Error(`session create failed: ${created.status}`)
  return data.id
}

export async function prompt(
  api: Api,
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sent = await api('POST', `/api/session/${sessionId}/prompt`, {body: {text, ...extra}})
  if (sent.status !== 200) throw new Error(`prompt failed: ${sent.status}`)
}

/** Messages of a session, to know when a turn finished. */
export async function idleMessages(api: Api, sessionId: string): Promise<unknown[]> {
  const response = await api('GET', `/api/session/${sessionId}/message`)
  const data = (response.data as {data?: unknown[]}).data
  return Array.isArray(data) ? data : []
}
