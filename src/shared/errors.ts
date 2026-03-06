/**
 * Extract error message from unknown error.
 * @param error - Unknown value from catch block
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/**
 * Wrap unknown error as Error instance.
 * @param error - Unknown value from catch block
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(String(error))
}
