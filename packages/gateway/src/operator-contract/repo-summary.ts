/**
 * Operator-safe repo summary projection.
 *
 * Exposes only display-safe fields from a RepoBinding.
 * Internal coordination fields (channelId, workspacePath, createdByDiscordId,
 * createdAt, databaseId, nodeId) are excluded by construction — they do not
 * appear in this type and cannot appear in the projection output.
 *
 * Security: the builder copies only the declared safe fields; it does NOT spread
 * the binding. Any future internal field added to RepoBinding will not leak here.
 */

import type {RepoBinding} from '../bindings/types.js'

/**
 * Operator-safe projection of a bound repository.
 *
 * Carries only the fields safe to expose to an operator web client.
 * Internal coordination fields (channelId, workspacePath, createdByDiscordId,
 * createdAt, databaseId, nodeId) are excluded by construction.
 *
 * channelName is optional and display-only — it may be absent when the binding
 * was created without a channel name or the name is empty.
 */
export interface RepoSummary {
  readonly owner: string
  readonly repo: string
  readonly channelName?: string
}

/**
 * Pure builder: project a RepoBinding to a RepoSummary.
 *
 * Copies only the declared safe fields. Does NOT spread the binding.
 * channelName is included only when non-empty (empty string is treated as absent).
 *
 * @param binding - The binding to project.
 * @returns An operator-safe RepoSummary with no internal fields.
 */
export function toRepoSummary(binding: RepoBinding): RepoSummary {
  const summary: RepoSummary = {
    owner: binding.owner,
    repo: binding.repo,
    ...(binding.channelName === '' ? {} : {channelName: binding.channelName}),
  }
  return summary
}
