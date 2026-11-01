import type {OwnershipLedger, TokenUsage} from '@fro-bot/runtime'
import {isShellLedgerKey} from '@fro-bot/runtime'

/**
 * Token, cost and model of a run on OpenCode V2.
 *
 * The V2 event mapper maps no usage event (`session.step.ended` carries `cost` and `tokens` per step, and
 * `session.usage.updated` is ephemeral, but neither is mapped), so the stream cannot fill the Action's usage fields.
 * `GET /api/session/:id` can: the session record carries cumulative `cost`, `tokens` and the `model` it runs. They are
 * cumulative for the session's whole life, so a continued session is read once before the first prompt (the baseline)
 * and the run reports the difference. A background child is its own session, started by this run, and is added to the
 * root's figures.
 *
 * Best-effort: a session that cannot be read leaves the figure out, and a run with nothing readable keeps the nulls it
 * has always reported when usage is unknown.
 */

type FetchRoute = (path: string, init?: RequestInit) => Promise<Response>

const READ_TIMEOUT_MS = 5_000

export interface SessionUsageV2 {
  readonly tokens: TokenUsage
  readonly cost: number
  /** `<providerID>/<modelID>` of the session's model, when it has one. */
  readonly model: string | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The usage a session record carries, or `null` when the record has none in a shape this can read. */
export function parseSessionUsageV2(payload: unknown): SessionUsageV2 | null {
  const info = record(record(payload)?.data)
  const tokens = record(info?.tokens)
  const cache = record(tokens?.cache)
  const input = finite(tokens?.input)
  const output = finite(tokens?.output)
  const reasoning = finite(tokens?.reasoning)
  const cacheRead = finite(cache?.read)
  const cacheWrite = finite(cache?.write)
  const cost = finite(info?.cost)
  if (
    info === null ||
    input === null ||
    output === null ||
    reasoning === null ||
    cacheRead === null ||
    cacheWrite === null ||
    cost === null
  ) {
    return null
  }
  const model = record(info.model)
  const providerId = typeof model?.providerID === 'string' ? model.providerID : null
  const modelId = typeof model?.id === 'string' ? model.id : null
  return {
    tokens: {input, output, reasoning, cache: {read: cacheRead, write: cacheWrite}},
    cost,
    model: providerId !== null && modelId !== null ? `${providerId}/${modelId}` : null,
  }
}

/** One session's usage, or `null` on any failure. Never throws. */
export async function readSessionUsageV2(
  fetchRoute: FetchRoute,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionUsageV2 | null> {
  try {
    const timeout = AbortSignal.timeout(READ_TIMEOUT_MS)
    const response = await fetchRoute(`/api/session/${encodeURIComponent(sessionId)}`, {
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    return parseSessionUsageV2(await response.json())
  } catch {
    return null
  }
}

function subtract(total: SessionUsageV2, baseline: SessionUsageV2 | null): SessionUsageV2 {
  if (baseline === null) return total
  return {
    model: total.model,
    cost: Math.max(0, total.cost - baseline.cost),
    tokens: {
      input: Math.max(0, total.tokens.input - baseline.tokens.input),
      output: Math.max(0, total.tokens.output - baseline.tokens.output),
      reasoning: Math.max(0, total.tokens.reasoning - baseline.tokens.reasoning),
      cache: {
        read: Math.max(0, total.tokens.cache.read - baseline.tokens.cache.read),
        write: Math.max(0, total.tokens.cache.write - baseline.tokens.cache.write),
      },
    },
  }
}

export interface RunUsageV2 {
  readonly tokens: TokenUsage | null
  readonly cost: number | null
  readonly model: string | null
}

/**
 * The usage of this run: the root's growth since `baseline` plus every background child the ledger tracked. `null`
 * figures when the root cannot be read: a child's usage without the root's would be a misleading partial.
 */
export async function collectRunUsageV2(options: {
  readonly fetchRoute: FetchRoute
  readonly rootSessionId: string
  readonly baseline: SessionUsageV2 | null
  readonly ledger?: OwnershipLedger
}): Promise<RunUsageV2> {
  const {fetchRoute, rootSessionId, baseline, ledger} = options
  const root = await readSessionUsageV2(fetchRoute, rootSessionId)
  if (root === null) return {tokens: null, cost: null, model: null}

  const childIds = [
    ...new Set(
      (ledger?.snapshot() ?? []).flatMap(entry => (isShellLedgerKey(entry.sessionId) ? [] : [entry.sessionId])),
    ),
  ].filter(id => id !== rootSessionId)
  const children = await Promise.all(childIds.map(async id => readSessionUsageV2(fetchRoute, id)))

  let {tokens, cost} = subtract(root, baseline)
  for (const child of children) {
    if (child === null) continue
    tokens = {
      input: tokens.input + child.tokens.input,
      output: tokens.output + child.tokens.output,
      reasoning: tokens.reasoning + child.tokens.reasoning,
      cache: {read: tokens.cache.read + child.tokens.cache.read, write: tokens.cache.write + child.tokens.cache.write},
    }
    cost += child.cost
  }
  return {tokens, cost, model: root.model}
}
