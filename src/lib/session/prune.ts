import type {Logger, PruneResult, PruningConfig} from './types.js'

import {deleteSession, findProjectByDirectory, listSessionsForProject} from './storage.js'

/**
 * Default pruning configuration.
 */
export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  maxSessions: 50,
  maxAgeDays: 30,
}

/**
 * Prune old sessions based on retention policy.
 *
 * Retention logic: keep sessions that satisfy EITHER condition:
 * - Within maxAgeDays of the current date
 * - Within the most recent maxSessions (by updatedAt)
 *
 * This ensures we always keep at least maxSessions, even if they're older than maxAgeDays.
 */
export async function pruneSessions(directory: string, config: PruningConfig, logger: Logger): Promise<PruneResult> {
  const {maxSessions, maxAgeDays} = config

  logger.info('Starting session pruning', {directory, maxSessions, maxAgeDays})

  // Find project
  const project = await findProjectByDirectory(directory, logger)
  if (project == null) {
    logger.debug('No project found for pruning', {directory})
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: 0,
      freedBytes: 0,
    }
  }

  // Get all sessions (including child sessions for cleanup)
  const allSessions = await listSessionsForProject(project.id, logger)

  // Filter to main sessions only for retention calculation
  const mainSessions = allSessions.filter(s => s.parentID == null)

  if (mainSessions.length === 0) {
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: 0,
      freedBytes: 0,
    }
  }

  // Sort by updatedAt descending (most recent first)
  const sortedSessions = [...mainSessions].sort((a, b) => b.time.updated - a.time.updated)

  // Calculate cutoff date
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)
  const cutoffTime = cutoffDate.getTime()

  // Determine which sessions to keep
  const sessionsToKeep = new Set<string>()

  // Keep sessions within age limit
  for (const session of sortedSessions) {
    if (session.time.updated >= cutoffTime) {
      sessionsToKeep.add(session.id)
    }
  }

  // Ensure we keep at least maxSessions (most recent)
  for (let i = 0; i < Math.min(maxSessions, sortedSessions.length); i++) {
    const session = sortedSessions[i]
    if (session != null) {
      sessionsToKeep.add(session.id)
    }
  }

  // Determine sessions to prune (main sessions not in keep set)
  const mainSessionsToPrune = sortedSessions.filter(s => !sessionsToKeep.has(s.id))

  // Also find child sessions of sessions being pruned
  const allSessionsToPrune = new Set<string>()
  for (const session of mainSessionsToPrune) {
    allSessionsToPrune.add(session.id)
    // Add child sessions
    for (const child of allSessions) {
      if (child.parentID === session.id) {
        allSessionsToPrune.add(child.id)
      }
    }
  }

  if (allSessionsToPrune.size === 0) {
    logger.info('No sessions to prune')
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: mainSessions.length,
      freedBytes: 0,
    }
  }

  // Prune sessions
  let freedBytes = 0
  const prunedIds: string[] = []

  for (const sessionId of allSessionsToPrune) {
    try {
      const bytes = await deleteSession(project.id, sessionId, logger)
      freedBytes += bytes
      prunedIds.push(sessionId)
      logger.debug('Pruned session', {sessionId, bytes})
    } catch (error) {
      logger.warning('Failed to prune session', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const remainingCount = mainSessions.length - mainSessionsToPrune.length

  logger.info('Session pruning complete', {
    prunedCount: prunedIds.length,
    remainingCount,
    freedBytes,
  })

  return {
    prunedCount: prunedIds.length,
    prunedSessionIds: prunedIds,
    remainingCount,
    freedBytes,
  }
}
