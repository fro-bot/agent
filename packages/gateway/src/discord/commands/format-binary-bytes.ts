/**
 * Format a byte count for the Discord recovery replies (`12 B`, `1.5 KiB`).
 *
 * Distinct from runtime `formatBytes` (`12B`, `KB`), which has different operator-visible output and throws on bad
 * input; this one never throws.
 */
export function formatBinaryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}
