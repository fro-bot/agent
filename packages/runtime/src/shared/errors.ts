/**
 * Extract error message from unknown error.
 * @param error - Unknown value from catch block
 */
export function toErrorMessage(error: unknown): string {
  // A payload-owned coercion path (non-callable `toString`, a null prototype, or a throwing
  // getter) can make extraction itself throw; never let that escape an error-reporting helper.
  try {
    if (error instanceof Error) {
      return error.message
    }
    return String(error)
  } catch {
    return '[unprintable error]'
  }
}

/**
 * Wrap unknown error as Error instance.
 * @param error - Unknown value from catch block
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(toErrorMessage(error))
}
