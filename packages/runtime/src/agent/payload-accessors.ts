/**
 * Own-property readers for untyped OpenCode payloads (SSE events, REST message bodies, tool parts).
 *
 * Every reader goes through the property descriptor, so inherited properties miss and getters never run.
 * The typed readers check the value's `typeof` and accept `''`: streamed text depends on an empty string being a
 * real value. The `firstString` helper in `error-format/provider-failure.ts` rejects `''` on purpose, for
 * classification — do not merge the two.
 */

/** Own value of `property`, or `undefined` on a miss (non-object `value`, absent or inherited property). */
export function ownValue(value: unknown, property: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return Object.getOwnPropertyDescriptor(value, property)?.value
}

export function getStringProperty(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null

  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

export function getNumberProperty(value: unknown, property: string): number | null {
  if (value == null || typeof value !== 'object') return null

  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'number' ? descriptor.value : null
}

export function getBooleanProperty(value: unknown, property: string): boolean | null {
  if (value == null || typeof value !== 'object') return null

  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'boolean' ? descriptor.value : null
}

/** Any non-null own value, not narrowed (primitives included). Callers guard with the next typed reader. */
export function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null

  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}
