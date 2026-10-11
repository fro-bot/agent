import type {TriggerContext} from '../agent/types.js'
import type {Logger} from '../shared/logger.js'
import type {SessionClient} from './backend.js'
import type {SessionInfo} from './types.js'
import {createHash} from 'node:crypto'
import * as path from 'node:path'
import {listSessionsForProject} from './storage.js'

export interface LogicalSessionKey {
  readonly key: string
  readonly entityType: 'discussion' | 'dispatch' | 'issue' | 'pr' | 'schedule'
  readonly entityId: string
}

export type SessionResolution =
  | {readonly status: 'found'; readonly session: SessionInfo}
  | {readonly status: 'not-found'}
  | {readonly status: 'error'; readonly error: string}

function buildEntityKey(entityType: LogicalSessionKey['entityType'], entityId: string): LogicalSessionKey {
  return {
    key: `${entityType}-${entityId}`,
    entityType,
    entityId,
  }
}

function buildScheduleHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function withIdentity(entityId: string, invocationIdentity: string | null): string {
  return invocationIdentity == null ? entityId : `${entityId}-${invocationIdentity}`
}

/**
 * Builds the logical session key for a trigger.
 *
 * Entity-bound keys (issue, PR, discussion) name a GitHub object and are intentionally shared
 * across runs AND across jobs: two jobs working the same issue/PR continue one thread.
 *
 * Run-scoped keys (schedule, workflow_dispatch) name the *run*, so the job that is executing
 * is part of the entity: two jobs of one run (e.g. a `needs:`-chained "Remediate" then
 * "Observe") are different tasks, and without `invocationIdentity` the second would continue
 * the first's root session. These keys are `...-{runId}-{invocationIdentity}`. The key is
 * deliberately NOT attempt-scoped: re-running the same job (new `GITHUB_RUN_ATTEMPT`, same
 * run ID and job) resolves to the same key and continues the same session. `invocationIdentity`
 * is `getInvocationIdentity()`; `null` (outside a runner) omits the segment.
 */
export function buildLogicalKey(context: TriggerContext, invocationIdentity: string | null): LogicalSessionKey | null {
  if (context.eventType === 'unsupported') {
    return null
  }

  if (context.eventType === 'schedule') {
    const rawEvent =
      typeof context.raw === 'object' && context.raw != null && 'event' in context.raw ? context.raw.event : undefined
    const scheduleExpression =
      typeof rawEvent === 'object' &&
      rawEvent != null &&
      'type' in rawEvent &&
      rawEvent.type === 'schedule' &&
      'schedule' in rawEvent
        ? typeof rawEvent.schedule === 'string'
          ? rawEvent.schedule
          : undefined
        : undefined
    const hashSeed =
      scheduleExpression != null && scheduleExpression.trim().length > 0 ? scheduleExpression : context.action
    const hash = buildScheduleHash(hashSeed ?? 'default')
    return buildEntityKey('schedule', withIdentity(`${hash}-${context.runId}`, invocationIdentity))
  }

  if (context.eventType === 'workflow_dispatch') {
    const runId = String(context.runId)
    return buildEntityKey('dispatch', withIdentity(runId, invocationIdentity))
  }

  if (context.target == null) {
    return null
  }

  if (context.eventType === 'issue_comment') {
    if (context.target.kind === 'issue') {
      return buildEntityKey('issue', String(context.target.number))
    }

    if (context.target.kind === 'pr') {
      return buildEntityKey('pr', String(context.target.number))
    }

    return null
  }

  if (context.eventType === 'discussion_comment') {
    if (context.target.kind !== 'discussion') {
      return null
    }

    return buildEntityKey('discussion', String(context.target.number))
  }

  if (context.eventType === 'issues') {
    if (context.target.kind !== 'issue') {
      return null
    }

    return buildEntityKey('issue', String(context.target.number))
  }

  if (context.eventType === 'pull_request' || context.eventType === 'pull_request_review_comment') {
    if (context.target.kind !== 'pr') {
      return null
    }

    return buildEntityKey('pr', String(context.target.number))
  }

  return null
}

export function buildSessionTitle(key: LogicalSessionKey): string {
  return `fro-bot: ${key.key}`
}

export function findSessionByTitle(sessions: readonly SessionInfo[], title: string): SessionInfo | null {
  const matchingSessions = sessions.filter(session => session.title === title)
  if (matchingSessions.length === 0) {
    return null
  }

  return matchingSessions.reduce((latest, current) => (current.time.updated > latest.time.updated ? current : latest))
}

function normalizeWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath)
  if (resolved.endsWith(path.sep) && resolved.length > 1) {
    return resolved.slice(0, -1)
  }
  return resolved
}

export async function resolveSessionForLogicalKey(
  client: SessionClient,
  workspacePath: string,
  key: LogicalSessionKey,
  logger: Logger,
): Promise<SessionResolution> {
  try {
    const sessions = await listSessionsForProject(client, workspacePath, logger)
    const title = buildSessionTitle(key)
    const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath)
    const matchingWorkspaceSessions = sessions.filter(
      session => normalizeWorkspacePath(session.directory) === normalizedWorkspacePath,
    )
    const eligibleWorkspaceSessions = matchingWorkspaceSessions.filter(
      session => session.time.archived == null && session.time.compacting == null,
    )
    const matchedSession = findSessionByTitle(eligibleWorkspaceSessions, title)

    if (matchedSession == null) {
      const eligibleSessions = sessions.filter(
        session => session.time.archived == null && session.time.compacting == null,
      )
      const staleDirectoryMatch = findSessionByTitle(eligibleSessions, title)
      if (staleDirectoryMatch != null) {
        logger.warning('Session continuity: matching session has different workspace directory, ignoring', {
          sessionId: staleDirectoryMatch.id,
          sessionDirectory: staleDirectoryMatch.directory,
          workspacePath,
        })
      }
      return {status: 'not-found'}
    }

    return {status: 'found', session: matchedSession}
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {status: 'error', error: message}
  }
}
