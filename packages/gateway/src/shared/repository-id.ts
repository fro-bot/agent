/**
 * Return whether a value is usable as a numeric GitHub repository deny key.
 *
 * Repository ids are positive integers and must be exactly representable by
 * JavaScript's number type before they cross a numeric storage or matching
 * boundary.
 */
export function isUsableRepositoryId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
