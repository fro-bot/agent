/**
 * The hook-time snapshot: an immutable, bounded copy of exactly the named fields the content module reads, taken before
 * the hook returns.
 *
 * Why: a hook's input is a live object. OpenCode, or a plugin that runs after this one, may edit it once the hook has
 * returned, and a span must say what the model request carried when the hook fired, not what a later edit made of it. So
 * the handler copies the named fields (system text, message text, tool definitions, tool arguments and results) into
 * frozen values and keeps nothing of the input. Strings are immutable, so a string is shared, not copied: the cost is the
 * walk over the structure, not the bytes. Scrubbing, bounding and serialization still happen later, off the host's path.
 *
 * What a snapshot is NOT: it is not scrubbed. It holds the raw named content until the one scrub pass at export.
 *
 * Bounds. Each snapshot has a size ceiling of its own, and every held snapshot counts against a ledger (count and
 * characters) that is separate from the exporter's queue. Past a bound, a field is replaced by an `OmittedContent` marker,
 * which the attribute mapping turns into a marker on the span, so a span keeps its structure and says what is missing.
 * For a request over its ceiling the oldest history messages go first and the snapshot says how many.
 *
 * Each snapshot is raw-shaped (the same field names the host uses, pruned to the named fields), so the extractors in
 * `content.ts` read a snapshot exactly as they would read the host's input.
 *
 * Plain functions: no SDK, no I/O, no clock. Nothing here throws; anything unreadable becomes `OmittedContent`.
 */

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export interface SnapshotLimits {
  /** Characters of one request snapshot: system, tool definitions and the newest history that fits. */
  readonly requestChars: number
  readonly systemChars: number
  readonly toolDefinitionChars: number
  /** One prompt, one tool call's arguments, one tool result. At the scrubber's input ceiling: over it the value would be omitted anyway. */
  readonly valueChars: number
  /**
   * A JSON-string argument longer than this is carried as the text it is (`{value: text}`), not parsed: parsing is the one
   * step whose cost is not a walk we count.
   */
  readonly argumentParseChars: number
  /** Depth of a copied value. Past it (a cycle included) the value is omitted. */
  readonly maxDepth: number
  /**
   * Everything visited in one snapshot: objects, arrays, strings, and every entry looked at and skipped (a part left as a
   * placeholder, an entry that is not a message). One budget for the whole request, so a huge array of cheap things is stopped.
   */
  readonly maxNodes: number
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  requestChars: 4 * 1024 * 1024,
  systemChars: 512 * 1024,
  toolDefinitionChars: 512 * 1024,
  valueChars: 8 * 1024 * 1024,
  argumentParseChars: 256 * 1024,
  maxDepth: 24,
  maxNodes: 200_000,
}

export interface PendingLimits {
  /** Snapshots held at once: taken in a hook and not yet exported or dropped. */
  readonly maxPending: number
  /** Characters held at once, across all pending snapshots. */
  readonly maxPendingChars: number
}

export const DEFAULT_PENDING_LIMITS: PendingLimits = {maxPending: 256, maxPendingChars: 32 * 1024 * 1024}

export type OmissionReason = 'snapshot-bound' | 'pending-bound' | 'unreadable'

/** In place of a field that was not captured. A value, not an error: the attribute mapping reads it into a span marker. */
export interface OmittedContent {
  readonly kind: 'snapshot-omitted'
  readonly reason: OmissionReason
}

/** Stands for a message part that is not copied (media, files, anything unknown); the count of these is the parts left out. */
const PLACEHOLDER: Json = Object.freeze({type: 'omitted'})

const OMITTED: Readonly<Record<OmissionReason, OmittedContent>> = {
  'snapshot-bound': Object.freeze({kind: 'snapshot-omitted', reason: 'snapshot-bound'}),
  'pending-bound': Object.freeze({kind: 'snapshot-omitted', reason: 'pending-bound'}),
  unreadable: Object.freeze({kind: 'snapshot-omitted', reason: 'unreadable'}),
}

export const omittedContent = (reason: OmissionReason): OmittedContent => OMITTED[reason]

/** The reason a field was omitted, or undefined when `value` is real content. */
export function omittedReason(value: unknown): OmissionReason | undefined {
  if (!isRecord(value) || value.kind !== 'snapshot-omitted') return undefined
  const reason = value.reason
  return reason === 'snapshot-bound' || reason === 'pending-bound' || reason === 'unreadable' ? reason : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// The ledger of pending snapshots
// ---------------------------------------------------------------------------------------------------------------------

export interface LedgerStats {
  readonly pending: number
  readonly pendingChars: number
  /** Snapshots refused because the ledger was full. */
  readonly refused: number
}

export interface SnapshotLedger {
  /** Characters a new snapshot may take, or undefined when the ledger is full by count or by characters. */
  readonly room: () => number | undefined
  /** Records a snapshot as pending. Idempotent per snapshot. */
  readonly hold: (snapshot: object, chars: number) => void
  /** Gives a held snapshot one more owner: it is freed when every owner has released it. Ignored if not held. */
  readonly retain: (snapshot: unknown) => void
  /** One owner lets go; the last frees it. Safe on anything: a value the ledger does not hold is ignored. */
  readonly release: (snapshot: unknown) => void
  /** Notes a snapshot refused for lack of room. */
  readonly refuse: () => void
  readonly stats: () => LedgerStats
}

/**
 * Counts what is pending. Freed explicitly when the span the snapshot belongs to is exported or dropped. A snapshot that
 * leaves the pipeline by some other route (a discarded observation, a model failure) is freed when it is garbage
 * collected, so a leak on a rare path costs delay, never a permanent hole in the budget.
 */
export function createSnapshotLedger(options: Partial<PendingLimits> = {}): SnapshotLedger {
  const limits: PendingLimits = {...DEFAULT_PENDING_LIMITS, ...options}
  /** Characters and the number of owners that have not released it yet. */
  const held = new WeakMap<object, {readonly chars: number; owners: number}>()
  let pending = 0
  let pendingChars = 0
  let refused = 0
  const free = (chars: number): void => {
    pending = Math.max(0, pending - 1)
    pendingChars = Math.max(0, pendingChars - chars)
  }
  const backstop = new FinalizationRegistry<number>(free)
  return {
    room: () => {
      if (pending >= limits.maxPending) return undefined
      const remaining = limits.maxPendingChars - pendingChars
      return remaining > 0 ? remaining : undefined
    },
    hold: (snapshot, chars) => {
      if (held.has(snapshot)) return
      held.set(snapshot, {chars, owners: 1})
      pending += 1
      pendingChars += chars
      backstop.register(snapshot, chars, snapshot)
    },
    retain: snapshot => {
      if (typeof snapshot !== 'object' || snapshot === null) return
      const entry = held.get(snapshot)
      if (entry !== undefined) entry.owners += 1
    },
    release: snapshot => {
      if (typeof snapshot !== 'object' || snapshot === null) return
      const entry = held.get(snapshot)
      if (entry === undefined) return
      entry.owners -= 1
      if (entry.owners > 0) return
      held.delete(snapshot)
      backstop.unregister(snapshot)
      free(entry.chars)
    },
    refuse: () => {
      refused += 1
    },
    stats: () => ({pending, pendingChars, refused}),
  }
}

export interface SnapshotContext {
  readonly ledger?: SnapshotLedger | undefined
  readonly limits?: Partial<SnapshotLimits> | undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Bounded, frozen copy
// ---------------------------------------------------------------------------------------------------------------------

/** Nodes visited so far, shared by every meter of one snapshot so the budget is request-wide. */
interface NodeCount {
  nodes: number
}

interface Meter {
  readonly limit: number
  readonly maxDepth: number
  readonly maxNodes: number
  readonly shared: NodeCount
  chars: number
  over: boolean
}

const meterFor = (limit: number, limits: SnapshotLimits, shared: NodeCount = {nodes: 0}): Meter => ({
  limit,
  maxDepth: limits.maxDepth,
  maxNodes: limits.maxNodes,
  shared,
  chars: 0,
  over: false,
})

function spend(meter: Meter, chars: number, nodes: number): boolean {
  meter.chars += chars
  meter.shared.nodes += nodes
  if (meter.chars > meter.limit || meter.shared.nodes > meter.maxNodes) meter.over = true
  return !meter.over
}

function readKey(source: Json, key: string): unknown {
  try {
    return source[key]
  } catch {
    // A getter that throws: the field is not read.
    return undefined
  }
}

/** A frozen deep copy of a JSON-like value. Sets `meter.over` and returns undefined when a bound is crossed. */
function copyValue(value: unknown, meter: Meter, depth: number): unknown {
  if (meter.over) return undefined
  switch (typeof value) {
    case 'string':
      spend(meter, value.length, 1)
      return value
    case 'number':
    case 'boolean':
      spend(meter, 8, 1)
      return value
    case 'bigint':
      spend(meter, 24, 1)
      return value.toString()
    case 'object': {
      if (value === null) return null
      if (depth >= meter.maxDepth) {
        meter.over = true
        return undefined
      }
      if (!spend(meter, 8, 1)) return undefined
      if (Array.isArray(value)) {
        const items: unknown[] = []
        for (const element of value) {
          items.push(copyValue(element, meter, depth + 1) ?? null)
          if (meter.over) return undefined
        }
        return Object.freeze(items)
      }
      const copy: Json = {}
      for (const key of Object.keys(value)) {
        if (key === '__proto__') continue
        const child = copyValue(readKey(value as Json, key), meter, depth + 1)
        if (meter.over) return undefined
        if (child === undefined) continue
        spend(meter, key.length, 0)
        copy[key] = child
      }
      return Object.freeze(copy)
    }
    case 'undefined':
    case 'function':
    case 'symbol':
      // Not content.
      return undefined
  }
}

function copyBounded(
  value: unknown,
  limit: number,
  limits: SnapshotLimits,
): {value: unknown; chars: number} | undefined {
  const meter = meterFor(limit, limits)
  const copy = copyValue(value, meter, 0)
  return meter.over ? undefined : {value: copy, chars: meter.chars}
}

// ---------------------------------------------------------------------------------------------------------------------
// The four snapshots
// ---------------------------------------------------------------------------------------------------------------------

/** A request's content, raw-shaped: `system`, `messages` and `tools` pruned to the named fields. */
export interface RequestSnapshot {
  readonly system?: readonly {readonly text: string}[] | OmittedContent
  readonly messages?: readonly Json[] | OmittedContent
  readonly tools?: Readonly<Record<string, {readonly description?: string; readonly input?: unknown}>> | OmittedContent
  /**
   * Entries of the history not kept (the oldest, left out to fit the snapshot's bounds). Counted by arithmetic on the
   * array's length, so it is an upper bound: it also counts entries that were not messages.
   */
  readonly droppedMessages?: number
  /** Characters this snapshot holds; what the ledger counts. */
  readonly size: number
}

export interface PromptSnapshot {
  readonly text?: string | OmittedContent
  readonly size: number
}

export interface ToolResultSnapshot {
  readonly content?: string | readonly Json[]
  readonly output?: unknown
  readonly metadata?: {readonly truncated: boolean}
  readonly size: number
}

function resolve(context: SnapshotContext): {limits: SnapshotLimits; room: number | undefined} {
  const limits: SnapshotLimits = {...DEFAULT_SNAPSHOT_LIMITS, ...context.limits}
  const room = context.ledger === undefined ? Number.POSITIVE_INFINITY : context.ledger.room()
  if (room === undefined) context.ledger?.refuse()
  return {limits, room}
}

function pruneToolResultValue(value: unknown, type: unknown, meter: Meter): unknown {
  if (type === 'content' && Array.isArray(value)) {
    const items: Json[] = []
    for (const item of value) {
      if (!isRecord(item)) {
        spend(meter, 0, 1)
        if (meter.over) return undefined
        items.push(Object.freeze({type: 'text', text: ''}))
        continue
      }
      if (item.type === 'text') {
        const text = asString(readKey(item, 'text')) ?? ''
        spend(meter, text.length, 1)
        items.push(Object.freeze({type: 'text', text}))
      } else {
        // Files are named, never carried: the name and type are all the span reads.
        const name = asString(readKey(item, 'name'))
        const mime = asString(readKey(item, 'mime'))
        spend(meter, (name?.length ?? 0) + (mime?.length ?? 0), 1)
        items.push(
          Object.freeze({type: 'file', ...(name === undefined ? {} : {name}), ...(mime === undefined ? {} : {mime})}),
        )
      }
      if (meter.over) return undefined
    }
    return Object.freeze(items)
  }
  return copyValue(value, meter, 1)
}

function pruneMessagePart(part: unknown, meter: Meter): Json {
  // Every part visited costs a node, the ones that are only a placeholder included.
  spend(meter, 0, 1)
  if (meter.over || !isRecord(part)) return PLACEHOLDER
  const type = readKey(part, 'type')
  switch (type) {
    case 'text':
    case 'reasoning': {
      const text = asString(readKey(part, 'text'))
      if (text === undefined) return PLACEHOLDER
      spend(meter, text.length, 1)
      return Object.freeze({type, text})
    }
    case 'tool-call': {
      const input = copyValue(readKey(part, 'input'), meter, 2)
      return Object.freeze({
        type,
        ...(asString(readKey(part, 'id')) === undefined ? {} : {id: readKey(part, 'id')}),
        ...(asString(readKey(part, 'name')) === undefined ? {} : {name: readKey(part, 'name')}),
        ...(input === undefined ? {} : {input}),
      })
    }
    case 'tool-result': {
      const result = readKey(part, 'result')
      const resultType = isRecord(result) ? readKey(result, 'type') : undefined
      const value = isRecord(result) ? pruneToolResultValue(readKey(result, 'value'), resultType, meter) : undefined
      return Object.freeze({
        type,
        ...(asString(readKey(part, 'id')) === undefined ? {} : {id: readKey(part, 'id')}),
        result: Object.freeze({type: resultType, ...(value === undefined ? {} : {value})}),
      })
    }
    default:
      // Media, files and anything unknown are not copied; the placeholder keeps the count of parts left out.
      return PLACEHOLDER
  }
}

function pruneMessage(raw: unknown, meter: Meter): Json | undefined {
  if (!isRecord(raw)) return undefined
  const role = asString(readKey(raw, 'role'))
  if (role === undefined) return undefined
  spend(meter, role.length, 1)
  const content = readKey(raw, 'content')
  if (typeof content === 'string') {
    spend(meter, content.length, 1)
    return Object.freeze({role, content})
  }
  const parts: Json[] = []
  if (Array.isArray(content)) {
    for (const part of content) {
      parts.push(pruneMessagePart(part, meter))
      if (meter.over) break
    }
  }
  return Object.freeze({role, content: Object.freeze(parts)})
}

function pruneSystem(
  system: unknown,
  limit: number,
  limits: SnapshotLimits,
  shared: NodeCount,
): {value: RequestSnapshot['system']; chars: number} | undefined {
  if (!Array.isArray(system)) return undefined
  const meter = meterFor(limit, limits, shared)
  const parts: {text: string}[] = []
  for (const part of system) {
    spend(meter, 0, 1)
    if (meter.over) return {value: omittedContent('snapshot-bound'), chars: 0}
    const text = isRecord(part) ? asString(readKey(part, 'text')) : undefined
    if (text === undefined) continue
    spend(meter, text.length, 1)
    parts.push(Object.freeze({text}))
    if (meter.over) return {value: omittedContent('snapshot-bound'), chars: 0}
  }
  return {value: Object.freeze(parts), chars: meter.chars}
}

function pruneTools(
  tools: unknown,
  limit: number,
  limits: SnapshotLimits,
  shared: NodeCount,
): {value: RequestSnapshot['tools']; chars: number} | undefined {
  if (!isRecord(tools)) return undefined
  const meter = meterFor(limit, limits, shared)
  const copy: Record<string, {description?: string; input?: unknown}> = {}
  for (const name of Object.keys(tools)) {
    if (name === '__proto__') continue
    spend(meter, 0, 1)
    if (meter.over) return {value: omittedContent('snapshot-bound'), chars: 0}
    const tool = readKey(tools, name)
    if (!isRecord(tool)) continue
    spend(meter, name.length, 1)
    const description = asString(readKey(tool, 'description'))
    if (description !== undefined) spend(meter, description.length, 0)
    const rawInput = readKey(tool, 'input')
    const input = isRecord(rawInput) ? copyValue(rawInput, meter, 1) : undefined
    if (meter.over) return {value: omittedContent('snapshot-bound'), chars: 0}
    copy[name] = Object.freeze({
      ...(description === undefined ? {} : {description}),
      ...(input === undefined ? {} : {input}),
    })
  }
  return {value: Object.freeze(copy), chars: meter.chars}
}

function omittedRequest(reason: OmissionReason): RequestSnapshot {
  const omitted = omittedContent(reason)
  return Object.freeze({system: omitted, messages: omitted, tools: omitted, size: 0})
}

/**
 * The request a `context`, `compaction`, `generate` or `title` hook carries, as it is now. Takes the system text, each
 * message's role and text/reasoning/tool-call/tool-result parts, and each tool's name, description and input schema.
 * Never takes the request's model or options objects, headers, attachments or binary parts.
 */
export function snapshotRequest(
  input: {readonly system?: unknown; readonly messages?: unknown; readonly tools?: unknown},
  context: SnapshotContext = {},
): RequestSnapshot {
  try {
    const {limits, room} = resolve(context)
    if (room === undefined) return omittedRequest('pending-bound')
    const total = Math.min(limits.requestChars, room)
    // One node budget for the whole request: the system text, the tools and every message draw on it.
    const shared: NodeCount = {nodes: 0}
    const system = pruneSystem(input.system, Math.min(limits.systemChars, total), limits, shared)
    let used = system?.chars ?? 0
    const tools = pruneTools(
      input.tools,
      Math.min(limits.toolDefinitionChars, Math.max(0, total - used)),
      limits,
      shared,
    )
    used += tools?.chars ?? 0

    // The newest history that fits, kept in order. The walk ends at the first message that does not fit or when the node
    // budget is spent, and what is older is counted by its length, not walked: the cost is the budget's, not the history's.
    let messages: RequestSnapshot['messages']
    let droppedMessages = 0
    if (Array.isArray(input.messages)) {
      const kept: Json[] = []
      let remaining = Math.max(0, total - used)
      let index = input.messages.length - 1
      for (; index >= 0; index -= 1) {
        // An entry costs a node whether or not it is a message.
        shared.nodes += 1
        if (shared.nodes > limits.maxNodes) break
        const meter = meterFor(remaining, limits, shared)
        const message = pruneMessage(input.messages[index], meter)
        if (message === undefined) continue
        if (meter.over) break
        remaining -= meter.chars
        used += meter.chars
        kept.push(message)
      }
      // Entries not kept, by length: an upper bound, since it also counts entries that were not messages.
      droppedMessages = index + 1
      kept.reverse()
      messages = Object.freeze(kept)
    }

    const snapshot: RequestSnapshot = Object.freeze({
      ...(system === undefined ? {} : {system: system.value}),
      ...(messages === undefined ? {} : {messages}),
      ...(tools === undefined ? {} : {tools: tools.value}),
      ...(droppedMessages > 0 ? {droppedMessages} : {}),
      size: used,
    })
    context.ledger?.hold(snapshot, used)
    return snapshot
  } catch {
    return omittedRequest('unreadable')
  }
}

/** A user prompt's `text`. Attachments are not read. */
export function snapshotPrompt(prompt: unknown, context: SnapshotContext = {}): PromptSnapshot {
  try {
    const {limits, room} = resolve(context)
    if (room === undefined) return Object.freeze({text: omittedContent('pending-bound'), size: 0})
    const text = isRecord(prompt) ? asString(readKey(prompt, 'text')) : undefined
    if (text === undefined) return Object.freeze({size: 0})
    if (text.length > Math.min(limits.valueChars, room)) {
      return Object.freeze({text: omittedContent('snapshot-bound'), size: 0})
    }
    const snapshot: PromptSnapshot = Object.freeze({text, size: text.length})
    context.ledger?.hold(snapshot, text.length)
    return snapshot
  } catch {
    return Object.freeze({text: omittedContent('unreadable'), size: 0})
  }
}

/** A tool call's arguments: an object, as the span carries it. A JSON string is parsed; any other value is wrapped. */
export function snapshotToolArguments(
  input: unknown,
  context: SnapshotContext = {},
): Json | OmittedContent | undefined {
  try {
    if (input === undefined) return undefined
    const {limits, room} = resolve(context)
    if (room === undefined) return omittedContent('pending-bound')
    let value: unknown = input
    if (typeof input === 'string') {
      // Length first: a string over its bound is omitted unparsed, and one over the parse ceiling is carried as text.
      if (input.length > Math.min(limits.valueChars, room)) return omittedContent('snapshot-bound')
      value = {value: input}
      if (input.length <= limits.argumentParseChars) {
        try {
          const parsed: unknown = JSON.parse(input)
          if (isRecord(parsed)) value = parsed
        } catch {
          // Not JSON: wrapped.
        }
      }
    } else if (!isRecord(input)) {
      value = {value: input}
    }
    const copy = copyBounded(value, Math.min(limits.valueChars, room), limits)
    if (copy === undefined || !isRecord(copy.value)) return omittedContent('snapshot-bound')
    context.ledger?.hold(copy.value, copy.chars)
    return copy.value
  } catch {
    return omittedContent('unreadable')
  }
}

/**
 * A tool result: the content the model saw (text, and files by name and type only), `output` for a tool that returned
 * only structured output, and whether the tool cut its own output. Metadata is not taken.
 */
export function snapshotToolResult(
  result: unknown,
  context: SnapshotContext = {},
): ToolResultSnapshot | OmittedContent | undefined {
  try {
    if (!isRecord(result)) return undefined
    const {limits, room} = resolve(context)
    if (room === undefined) return omittedContent('pending-bound')
    const meter = meterFor(Math.min(limits.valueChars, room), limits)
    const raw = readKey(result, 'content')
    let content: string | readonly Json[] | undefined
    if (typeof raw === 'string') {
      spend(meter, raw.length, 1)
      content = raw
    } else if (Array.isArray(raw)) {
      const parts: Json[] = []
      for (const item of raw) {
        spend(meter, 0, 1)
        if (meter.over) break
        if (!isRecord(item)) continue
        const type = readKey(item, 'type')
        if (type === 'text') {
          const text = asString(readKey(item, 'text')) ?? ''
          spend(meter, text.length, 1)
          parts.push(Object.freeze({type: 'text', text}))
        } else if (type === 'file') {
          const name = asString(readKey(item, 'name'))
          const mime = asString(readKey(item, 'mime'))
          spend(meter, (name?.length ?? 0) + (mime?.length ?? 0), 1)
          parts.push(
            Object.freeze({type: 'file', ...(mime === undefined ? {} : {mime}), ...(name === undefined ? {} : {name})}),
          )
        }
        if (meter.over) break
      }
      content = Object.freeze(parts)
    }
    const output = content === undefined ? copyValue(readKey(result, 'output'), meter, 1) : undefined
    if (meter.over) return omittedContent('snapshot-bound')
    const metadata = readKey(result, 'metadata')
    const truncated = isRecord(metadata) && readKey(metadata, 'truncated') === true
    if (content === undefined && output === undefined) return undefined
    const snapshot: ToolResultSnapshot = Object.freeze({
      ...(content === undefined ? {} : {content}),
      ...(output === undefined ? {} : {output}),
      metadata: Object.freeze({truncated}),
      size: meter.chars,
    })
    context.ledger?.hold(snapshot, meter.chars)
    return snapshot
  } catch {
    return omittedContent('unreadable')
  }
}

/** The size a snapshot reports, for the buffer bound; zero for anything else. */
export function snapshotSize(value: unknown): number {
  return isRecord(value) && typeof value.size === 'number' ? value.size : 0
}
