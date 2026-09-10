import type {SessionClient} from './backend.js'
import type {Logger, ProjectInfo} from './types.js'
import path from 'node:path'

import {isRecord, readString} from './storage-mappers.js'

function normalizeWorkspacePath(workspacePath: string): string {
  // Use path.resolve + path.normalize for correct cross-platform behavior.
  // The URL constructor would mangle Windows drive-letter paths (C:\foo → /C:/foo).
  const resolved = path.resolve(path.normalize(workspacePath))
  return resolved.endsWith(path.sep) && resolved.length > 1 ? resolved.slice(0, -1) : resolved
}

export async function listProjectsViaSDK(
  client: SessionClient,
  workspacePath: string,
  logger: Logger,
): Promise<readonly ProjectInfo[]> {
  // Route to the OpenCode instance for this workspace, matching the sibling pattern in
  // storage.ts's `listSessionsForProject`. Without `directory`, the server falls back to its
  // `x-opencode-directory` header, then `process.cwd()` — not guaranteed to be this workspace —
  // and lists only that one instance's projects, not every project across instances. Sending the
  // raw (unnormalized) path here mirrors storage.ts; normalization is a client-side concern for
  // matching against `worktree` results below, not for what the server expects on this query.
  const response = await client.project.list({query: {directory: workspacePath}})
  if (response.error != null || response.data == null) {
    logger.warning('SDK project list failed', {error: String(response.error)})
    return []
  }
  if (!Array.isArray(response.data)) {
    // Successful response, unexpected shape; do not log the payload itself.
    // Log only intrinsic types; payloads can supply their own constructor.name.
    logger.warning('SDK project list returned a non-array payload', {
      type: typeof response.data,
    })
    return []
  }

  // `id` and `worktree` are the only fields this module (or any consumer) reads, so they're the
  // only fields allowed to gate inclusion. `time` and `vcs` are neither read nor asserted here —
  // requiring an unread field (first `path`, then `time.updated`) is what silently no-opped
  // pruning for six months.
  let skipped = 0
  const projects: ProjectInfo[] = []
  for (const project of response.data) {
    if (!isRecord(project)) {
      skipped += 1
      continue
    }
    const id = readString(project.id)
    const worktree = readString(project.worktree)
    if (id == null || worktree == null) {
      skipped += 1
      continue
    }

    projects.push({id, worktree})
  }

  logger.debug('Discovered projects via SDK', {total: response.data.length, skipped, retained: projects.length})
  return projects
}

export async function findProjectByWorkspace(
  client: SessionClient,
  workspacePath: string,
  logger: Logger,
): Promise<ProjectInfo | null> {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath)
  const projects = await listProjectsViaSDK(client, workspacePath, logger)

  for (const project of projects) {
    if (normalizeWorkspacePath(project.worktree) === normalizedWorkspace) return project
  }

  return null
}
