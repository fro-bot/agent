export const OPENCODE_SQLITE_VERSION = '1.1.53'

export function isSqliteBackend(version: string | null): boolean {
  if (version == null) return false
  return compareVersions(version, OPENCODE_SQLITE_VERSION) >= 0
}

export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
