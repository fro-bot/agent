import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

export const OPENCODE_SQLITE_VERSION = '1.2.0'

export function getOpenCodeDbPath(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  const basePath = xdgDataHome ?? path.join(os.homedir(), '.local', 'share')
  return path.join(basePath, 'opencode', 'opencode.db')
}

export async function isSqliteBackend(version: string | null): Promise<boolean> {
  if (version != null) {
    return compareVersions(version, OPENCODE_SQLITE_VERSION) >= 0
  }
  try {
    await fs.access(getOpenCodeDbPath())
    return true
  } catch {
    return false
  }
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
