/**
 * Sleep for specified milliseconds.
[] * @param ms - Milliseconds to wait (must be a non-negative finite number)
 * @throws {Error} If ms is negative or not a finite number
 */
export async function sleep(ms: number): Promise<void> {
  if (ms < 0 || !Number.isFinite(ms)) {
    throw new Error(`Invalid sleep duration: ${ms}`)
  }
  return new Promise(resolve => setTimeout(resolve, ms))
}
