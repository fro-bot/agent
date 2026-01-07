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
 * This dual-condition approach ensures we:
 * 1. Keep recent active sessions regardless of total count (time-based)
 * 2. Always keep minimum history even during low activity (count-based)
 * 3. Prevent cache explosion during high-frequency periods (both limits)
 *
 * Cache size is a critical concern: sessions accumulate 1-10MB each, and without
 * pruning, cache restore/save becomes the workflow bottleneck.
 */
export async function pruneSessions(directory: string, config: PruningConfig, logger: Logger): Promise<PruneResult> {
  const {maxSessions, maxAgeDays} = config

  logger.info('Starting session pruning', {directory, maxSessions, maxAgeDays})

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

  const allSessions = await listSessionsForProject(project.id, logger)

  const mainSessions = allSessions.filter(s => s.parentID == null)

  if (mainSessions.length === 0) {
    return {
      prunedCount: 0,
      prunedSessionIds: [],
      remainingCount: 0,
      freedBytes: 0,
    }
  }

  const sortedSessions = [...mainSessions].sort((a, b) => b.time.updated - a.time.updated)

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)
  const cutoffTime = cutoffDate.getTime()

  const sessionsToKeep = new Set<string>()

  for (const session of sortedSessions) {
    if (session.time.updated >= cutoffTime) {
      sessionsToKeep.add(session.id)
    }
  }

  for (let i = 0; i < Math.min(maxSessions, sortedSessions.length); i++) {
    const session = sortedSessions[i]
    if (session != null) {
      sessionsToKeep.add(session.id)
    }
  }

  const mainSessionsToPrune = sortedSessions.filter(s => !sessionsToKeep.has(s.id))

  const allSessionsToPrune = new Set<string>()
  for (const session of mainSessionsToPrune) {
    allSessionsToPrune.add(session.id)
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
