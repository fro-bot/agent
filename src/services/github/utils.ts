/**
 * Check if an error is an HTTP 404 Not Found error.
 * @param error - Unknown error value
 */
export function isNotFoundError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') {
    return false
  }
  return 'status' in error && (error as Record<string, unknown>).status === 404
}

/**
 * Execute a promise and return null if it throws a 404 error.
 * Rethrows other errors.
 * @param promise - Promise to execute
 */
export async function ignoreNotFound<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}
