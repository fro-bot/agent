/** Test support for the turn model: deterministic ids, replay of a fixture, and a readable outline of the span trees. */

import type {IdSource, Observation, SpanRecord, TurnModel, TurnModelLimits} from './turn-model.js'

import {createTurnModel} from './turn-model.js'

export function sequentialIds(): IdSource {
  let trace = 0
  let span = 0
  return {
    trace: () => {
      trace += 1
      return `trace-${trace}`
    },
    span: () => {
      span += 1
      return `span-${span}`
    },
  }
}

export interface Replay {
  readonly records: readonly SpanRecord[]
  readonly model: TurnModel
}

/** Feeds `observations` to a fresh model in order, then flushes at the last time, and returns every record. */
export function replay(
  observations: readonly Observation[],
  options: {
    readonly limits?: Partial<TurnModelLimits>
    readonly flush?: boolean
    /** Called after each observation with the records it finished. */
    readonly afterEach?: (model: TurnModel, finished: readonly SpanRecord[], observation: Observation) => void
  } = {},
): Replay {
  const model = createTurnModel({
    ids: sequentialIds(),
    ...(options.limits === undefined ? {} : {limits: options.limits}),
  })
  const records: SpanRecord[] = []
  let last = 0
  for (const observation of observations) {
    last = Math.max(last, observation.at)
    const finished = model.observe(observation)
    records.push(...finished)
    options.afterEach?.(model, finished, observation)
  }
  if (options.flush !== false) records.push(...model.flush(last))
  return {records, model}
}

function describe(record: SpanRecord, label: (traceId: string) => string): string {
  const flags = [...record.marks, ...record.gaps.map(gap => `no:${gap}`)]
  const tail = flags.length === 0 ? '' : ` {${flags.join(',')}}`
  if (record.kind === 'invoke_agent') {
    const extra = [
      record.standalone === undefined ? undefined : `standalone=${record.standalone}`,
      record.continuationOf === undefined ? undefined : `continues=${label(record.continuationOf)}`,
      record.reportDeliveredInTrace === undefined ? undefined : `report-in=${label(record.reportDeliveredInTrace)}`,
      record.prompts.length === 0
        ? undefined
        : `prompts=${record.prompts.map(p => (p.midTurn ? 'mid' : 'first')).join('+')}`,
    ].filter(part => part !== undefined)
    return `invoke_agent ${record.agent ?? '?'} [${record.role} ${record.sessionId}] ${record.status}${extra.length === 0 ? '' : ` ${extra.join(' ')}`}${tail}`
  }
  if (record.kind === 'chat') {
    const parts = [
      record.requestKind,
      record.requestKind === 'primary' ? `attempt=${record.attempt}` : undefined,
      record.status,
      record.finishReason === undefined ? undefined : `finish=${record.finishReason}`,
      record.followOnOf.length === 0 ? undefined : `follow-on-of=${record.followOnOf.map(label).join('+')}`,
      record.texts.length === 0 ? undefined : `texts=${record.texts.length}`,
    ].filter(part => part !== undefined)
    return `chat ${parts.join(' ')} [${record.sessionId}]${tail}`
  }
  const parts = [
    record.tool,
    record.outcome,
    record.errorType === undefined ? undefined : `error=${record.errorType}`,
  ].filter(part => part !== undefined)
  return `execute_tool ${parts.join(' ')} [${record.sessionId}]${tail}`
}

/**
 * An indented outline of every trace: `T1` is the trace whose root started first. Siblings are ordered by start time, or
 * by their text when `order` is `text` (for comparing two runs whose timings differ).
 */
export function renderTrees(records: readonly SpanRecord[], order: 'time' | 'text' = 'time'): string {
  const roots = records
    .filter(record => record.kind === 'invoke_agent' && record.parentSpanId === undefined)
    .toSorted((a, b) => a.start - b.start || a.spanId.localeCompare(b.spanId, 'en', {numeric: true}))
  const labels = new Map(roots.map((root, index) => [root.traceId, `T${index + 1}`]))
  const label = (traceId: string): string => labels.get(traceId) ?? `?${traceId}`
  const children = new Map<string | undefined, SpanRecord[]>()
  for (const record of records) {
    const list = children.get(record.parentSpanId) ?? []
    list.push(record)
    children.set(record.parentSpanId, list)
  }
  const lines: string[] = []
  const visit = (record: SpanRecord, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${describe(record, label)}`)
    const kids = (children.get(record.spanId) ?? []).map(kid => ({kid, text: describe(kid, label)}))
    kids.sort((a, b) =>
      order === 'text'
        ? a.text.localeCompare(b.text, 'en')
        : a.kid.start - b.kid.start || a.text.localeCompare(b.text, 'en'),
    )
    for (const {kid} of kids) visit(kid, depth + 1)
  }
  for (const root of roots) {
    lines.push(`${label(root.traceId)}:`)
    visit(root, 1)
  }
  const orphans = records.filter(
    record => record.parentSpanId !== undefined && !records.some(other => other.spanId === record.parentSpanId),
  )
  for (const orphan of orphans) lines.push(`ORPHAN ${describe(orphan, label)}`)
  return lines.join('\n')
}
