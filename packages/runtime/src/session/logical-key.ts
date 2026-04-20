import type {TriggerContext} from '../../../../src/features/triggers/types.js'
import type {Logger} from '../../../../src/shared/logger.js'
import type {SessionClient} from './backend.js'
import type {SessionInfo} from './types.js'
import {createHash} from 'node:crypto'
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

export function buildLogicalKey(context: TriggerContext): LogicalSessionKey | null {
  if (context.eventType === 'unsupported') {
    return null
  }

  if (context.eventType === 'schedule') {
    const scheduleExpression = context.raw.event.type === 'schedule' ? context.raw.event.schedule : undefined
    const hashSeed =
      scheduleExpression != null && scheduleExpression.trim().length > 0 ? scheduleExpression : context.action
    const hash = buildScheduleHash(hashSeed ?? 'default')
    return buildEntityKey('schedule', hash)
  }

  if (context.eventType === 'workflow_dispatch') {
    const runId = String(context.runId)
    return buildEntityKey('dispatch', runId)
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

export async function resolveSessionForLogicalKey(
  client: SessionClient,
  workspacePath: string,
  key: LogicalSessionKey,
  logger: Logger,
): Promise<SessionResolution> {
  try {
    const sessions = await listSessionsForProject(client, workspacePath, logger)
    const title = buildSessionTitle(key)
    const matchedSession = findSessionByTitle(sessions, title)

    if (matchedSession == null) {
      return {status: 'not-found'}
    }

    if (matchedSession.time.archived != null || matchedSession.time.compacting != null) {
      return {status: 'not-found'}
    }

    return {status: 'found', session: matchedSession}
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {status: 'error', error: message}
  }
}
