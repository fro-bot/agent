/**
 * Format bytes to human-readable string (e.g., "1.5MB").
 * @param bytes - Number of bytes (must be a non-negative finite number)
 * @throws {Error} If bytes is negative or not a finite number
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) {
    throw new Error(`Invalid bytes value: ${bytes}`)
  }
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
