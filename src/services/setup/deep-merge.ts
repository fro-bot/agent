const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Deep-merge two plain objects.
 *
 * Source values win over target values on conflict.
 * Arrays are replaced (not merged element-by-element).
 * Primitive source values always overwrite target.
 *
 * Neither the target nor the source is mutated.
 *
 * @param target - Base object (lower priority)
 * @param source - Override object (higher priority)
 * @returns New merged object
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>

  for (const [key, targetValue] of Object.entries(target)) {
    if (UNSAFE_MERGE_KEYS.has(key)) {
      continue
    }

    result[key] = targetValue
  }

  for (const [key, sourceValue] of Object.entries(source)) {
    if (UNSAFE_MERGE_KEYS.has(key)) {
      continue
    }

    const targetValue = result[key]

    if (isMergeableObject(sourceValue) && isMergeableObject(targetValue)) {
      result[key] = deepMerge(targetValue, sourceValue)
    } else {
      result[key] = sourceValue
    }
  }

  return result
}
