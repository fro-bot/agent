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

export async function listProjectsViaSDK(client: SessionClient, logger: Logger): Promise<readonly ProjectInfo[]> {
  const response = await client.project.list()
  if (response.error != null || response.data == null) {
    logger.warning('SDK project list failed', {error: String(response.error)})
    return []
  }
  if (!Array.isArray(response.data)) return []

  const projects: ProjectInfo[] = []
  for (const project of response.data as unknown[]) {
    if (!isRecord(project)) continue
    const id = readString(project.id)
    const worktree = readString(project.worktree)
    const projectPath = readString(project.path)
    if (id == null || worktree == null || projectPath == null) continue
    projects.push({id, worktree, path: projectPath, vcs: 'git', time: {created: 0, updated: 0}})
  }
  return projects
}

export async function findProjectByWorkspace(
  client: SessionClient,
  workspacePath: string,
  logger: Logger,
): Promise<ProjectInfo | null> {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath)
  const projects = await listProjectsViaSDK(client, logger)

  for (const project of projects) {
    if (normalizeWorkspacePath(project.worktree) === normalizedWorkspace) return project
    const projectPath = readString(project.path)
    if (projectPath != null && normalizeWorkspacePath(projectPath) === normalizedWorkspace) return project
  }

  return null
}
