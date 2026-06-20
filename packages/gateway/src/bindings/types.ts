export interface RepoBinding {
  readonly owner: string
  readonly repo: string
  readonly channelId: string
  readonly channelName: string
  readonly workspacePath: string
  readonly createdAt: string
  readonly createdByDiscordId: string
  /**
   * GitHub numeric repository id (database_id). Captured at ingest via GET /repos/{owner}/{repo}.
   * Used as the primary deny key for the metadata/repos.yaml redaction gate.
   * Absent on legacy bindings — absence means "no usable deny key" (fails closed at the gate).
   * INTERNAL: must NOT appear on any operator-facing projection (e.g. OperatorRunStatus).
   */
  readonly databaseId?: number
  /**
   * GitHub node_id string for the repository. Captured at ingest via GET /repos/{owner}/{repo}.
   * Used as the secondary deny key for the metadata/repos.yaml redaction gate.
   * Absent on legacy bindings — absence means "no usable deny key" (fails closed at the gate).
   * INTERNAL: must NOT appear on any operator-facing projection (e.g. OperatorRunStatus).
   */
  readonly nodeId?: string
}

export interface ChannelIndex {
  readonly owner: string
  readonly repo: string
}

export interface BindingExistsError extends Error {
  readonly code: 'BINDING_EXISTS_ERROR'
  readonly owner: string
  readonly repo: string
}

export interface StoreError extends Error {
  readonly code: 'BINDING_STORE_ERROR'
}

export interface ValidationError extends Error {
  readonly code: 'BINDING_VALIDATION_ERROR'
}

export interface PartialWriteError extends Error {
  readonly code: 'BINDING_PARTIAL_WRITE_ERROR'
  readonly primaryKey: string
  readonly indexKey: string
}

export function createBindingExistsError(owner: string, repo: string): BindingExistsError {
  return Object.assign(new Error(`Binding already exists for ${owner}/${repo}`), {
    code: 'BINDING_EXISTS_ERROR' as const,
    owner,
    repo,
  })
}

export function createStoreError(message: string): StoreError {
  return Object.assign(new Error(message), {code: 'BINDING_STORE_ERROR' as const})
}

export function createValidationError(message: string): ValidationError {
  return Object.assign(new Error(message), {code: 'BINDING_VALIDATION_ERROR' as const})
}

export function createPartialWriteError(primaryKey: string, indexKey: string): PartialWriteError {
  return Object.assign(
    new Error(
      `Partial write: primary record written at ${primaryKey} but index write failed and rollback also failed. Manual cleanup required for key: ${primaryKey}`,
    ),
    {
      code: 'BINDING_PARTIAL_WRITE_ERROR' as const,
      primaryKey,
      indexKey,
    },
  )
}

export function hasValidRepoBindingShape(value: unknown): value is RepoBinding {
  if (typeof value !== 'object' || value == null) {
    return false
  }

  const candidate = value as Partial<RepoBinding>
  if (
    typeof candidate.owner !== 'string' ||
    typeof candidate.repo !== 'string' ||
    typeof candidate.channelId !== 'string' ||
    typeof candidate.channelName !== 'string' ||
    typeof candidate.workspacePath !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.createdByDiscordId !== 'string'
  ) {
    return false
  }

  // Optional deny-key fields: when present, must be the correct type.
  // Absent (undefined) is valid — legacy bindings have no deny keys.
  if (candidate.databaseId !== undefined && typeof candidate.databaseId !== 'number') {
    return false
  }

  if (candidate.nodeId !== undefined && typeof candidate.nodeId !== 'string') {
    return false
  }

  return true
}

export function hasValidChannelIndexShape(value: unknown): value is ChannelIndex {
  if (typeof value !== 'object' || value == null) {
    return false
  }

  const candidate = value as Partial<ChannelIndex>
  return typeof candidate.owner === 'string' && typeof candidate.repo === 'string'
}
