import * as path from 'node:path'

export function normalizeWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath)
  if (resolved.endsWith(path.sep) && resolved.length > 1) {
    return resolved.slice(0, -1)
  }
  return resolved
}
