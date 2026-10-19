import {getBooleanProperty, getObjectProperty, getStringProperty} from './payload-accessors.js'

/**
 * Whether any tool part of an assistant message still blocks completion: the model has not received the result and
 * will produce another turn. A `parts` value that is not an array does not block.
 *
 * Exempt: a provider-executed tool (the model never needs the result back; read from `part.metadata`) and an
 * orphaned interrupted tool (`state.status === 'error'` with `state.metadata.interrupted === true`; cleanup marks
 * abandoned tool_use blocks this way after retries/aborts). The orphan branch is the permissive one, so it reads
 * strictly: a missing or malformed `state` / `metadata`, or `interrupted` that is not exactly `true`, is not an
 * orphan. A completed, non-provider-executed tool still blocks.
 */
export function hasBlockingToolPart(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false

  return parts.some((part: unknown) => {
    if (getStringProperty(part, 'type') !== 'tool') return false
    if (getBooleanProperty(getObjectProperty(part, 'metadata'), 'providerExecuted') === true) return false
    const state = getObjectProperty(part, 'state')
    const interrupted = getBooleanProperty(getObjectProperty(state, 'metadata'), 'interrupted')
    return !(getStringProperty(state, 'status') === 'error' && interrupted === true)
  })
}
