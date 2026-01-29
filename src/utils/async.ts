/**
 * Sleep for specified milliseconds.
 * @param ms - Milliseconds to wait
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
