/**
 * What a request's tool list says, worked out once per snapshot: how many tools it offered, how long their serialized
 * definitions are, and their names (to tell whether a called tool was among them).
 *
 * The list is the hook-time snapshot's `tools` record (`snapshot.ts`), the same one `gen_ai.tool.definitions` is built from. So
 * the count and length describe what this plugin captured of the request, not what the provider billed: the snapshot keeps a
 * tool's name, description and input schema and nothing else.
 *
 * Plain functions: no SDK, no I/O, no clock. Nothing here throws.
 */

import {extractToolDefinitions} from './content.js'
import {omittedReason} from './snapshot.js'

export interface ToolDefinitionStats {
  /** The tools the request offered, by name. */
  readonly names: ReadonlySet<string>
  readonly count: number
  /** Characters of the `gen_ai.tool.definitions` content before any bound or scrub: 0 for a list of no tools. */
  readonly chars: number
}

/** The snapshot's `tools` object is frozen and lives as long as its request, so the stats live exactly as long as it does. */
const computed = new WeakMap<object, ToolDefinitionStats | undefined>()

function compute(tools: Record<string, unknown>): ToolDefinitionStats | undefined {
  try {
    const names = new Set(Object.keys(tools))
    const definitions = extractToolDefinitions(tools)
    return {names, count: names.size, chars: definitions === undefined ? 0 : JSON.stringify(definitions).length}
  } catch {
    // A definition that cannot be serialized: the length is unknown, so nothing is said about this list.
    return undefined
  }
}

/**
 * The stats of a request's `tools`, or `undefined` when the list is not known: absent, not an object, or a field the
 * snapshot could not take (`OmittedContent`). Computed once per `tools` object: the next ask is a lookup.
 */
export function toolDefinitionStats(tools: unknown): ToolDefinitionStats | undefined {
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) return undefined
  if (omittedReason(tools) !== undefined) return undefined
  const known = computed.get(tools)
  if (known !== undefined || computed.has(tools)) return known
  const stats = compute(tools as Record<string, unknown>)
  computed.set(tools, stats)
  return stats
}

/** The offered tool names of a request snapshot (the object a `request` observation carries as its content), if known. */
export function offeredToolNames(request: unknown): ReadonlySet<string> | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined
  return toolDefinitionStats((request as {readonly tools?: unknown}).tools)?.names
}
