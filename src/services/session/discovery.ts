import type {SessionClient} from './backend.js'
import type {Logger, ProjectInfo} from './types.js'

import {normalizeWorkspacePath} from '../../shared/paths.js'
import {isRecord, readString} from './storage-mappers.js'

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
    projects.push({id, worktree, path: projectPath} as unknown as ProjectInfo)
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
    const projectPath = readString((project as unknown as Record<string, unknown>).path)
    if (projectPath != null && normalizeWorkspacePath(projectPath) === normalizedWorkspace) return project
  }

  return null
}
