import type {LogicalSessionKey, SessionSearchResult, SessionSummary} from '@fro-bot/runtime'
import type {AttachmentResult} from '../../features/attachments/index.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import {
  buildLogicalKey,
  buildSessionTitle,
  listSessions,
  resolveSessionForLogicalKey,
  searchSessions,
} from '@fro-bot/runtime'
import {
  buildAttachmentResult,
  downloadAttachments,
  parseAttachmentUrls,
  validateAttachments,
} from '../../features/attachments/index.js'
import {getGitHubWorkspace} from '../../shared/env.js'
import {createLogger} from '../../shared/logger.js'
import {normalizeWorkspacePath} from '../../shared/paths.js'

export interface SessionPrepPhaseResult {
  readonly recentSessions: readonly SessionSummary[]
  readonly priorWorkContext: readonly SessionSearchResult[]
  readonly attachmentResult: AttachmentResult | null
  readonly normalizedWorkspace: string
  readonly logicalKey: LogicalSessionKey | null
  readonly continueSessionId: string | null
  readonly isContinuation: boolean
  readonly sessionTitle: string | null
}

export async function runSessionPrep(
  bootstrap: BootstrapPhaseResult,
  routing: RoutingPhaseResult,
  cacheRestore: CacheRestorePhaseResult,
  metrics: MetricsCollector,
): Promise<SessionPrepPhaseResult> {
  const sessionLogger = createLogger({phase: 'session'})
  const normalizedWorkspace = normalizeWorkspacePath(getGitHubWorkspace())

  const recentSessions = await listSessions(
    cacheRestore.serverHandle.client,
    normalizedWorkspace,
    {limit: 10},
    sessionLogger,
  )
  sessionLogger.debug('Listed recent sessions', {count: recentSessions.length})

  const logicalKey = buildLogicalKey(routing.triggerResult.context)
  const sessionTitle = logicalKey == null ? null : buildSessionTitle(logicalKey)
  let continueSessionId: string | null = null
  let isContinuation = false

  if (logicalKey != null) {
    const resolution = await resolveSessionForLogicalKey(
      cacheRestore.serverHandle.client,
      normalizedWorkspace,
      logicalKey,
      sessionLogger,
    )

    if (resolution.status === 'found') {
      continueSessionId = resolution.session.id
      isContinuation = true
      sessionLogger.info('Session continuity: found existing session', {
        logicalKey: logicalKey.key,
        sessionId: continueSessionId,
      })
    } else if (resolution.status === 'error') {
      sessionLogger.warning('Session continuity: lookup error, will create new', {
        logicalKey: logicalKey.key,
        error: resolution.error,
      })
    } else {
      sessionLogger.info('Session continuity: no existing session found', {
        logicalKey: logicalKey.key,
      })
    }
  }

  const searchQuery = logicalKey?.key ?? routing.agentContext.issueTitle ?? routing.agentContext.repo
  const priorWorkContext = await searchSessions(
    searchQuery,
    cacheRestore.serverHandle.client,
    normalizedWorkspace,
    {limit: 5},
    sessionLogger,
  )
  sessionLogger.debug('Searched prior sessions', {
    query: searchQuery,
    resultCount: priorWorkContext.length,
  })

  for (const session of priorWorkContext) {
    metrics.addSessionUsed(session.sessionId)
  }

  const attachmentLogger = createLogger({phase: 'attachments'})
  const commentBody = routing.agentContext.commentBody ?? ''
  const parsedUrls = parseAttachmentUrls(commentBody)

  let attachmentResult: AttachmentResult | null = null
  if (parsedUrls.length > 0) {
    attachmentLogger.info('Processing attachments', {count: parsedUrls.length})
    const downloaded = await downloadAttachments(parsedUrls, bootstrap.inputs.githubToken, undefined, attachmentLogger)
    const {validated, skipped} = validateAttachments(downloaded, undefined, attachmentLogger)

    if (validated.length > 0 || skipped.length > 0) {
      attachmentResult = buildAttachmentResult(commentBody, parsedUrls, validated, skipped)
      attachmentLogger.info('Attachments processed', {
        processed: validated.length,
        skipped: skipped.length,
      })
    }
  }

  return {
    recentSessions,
    priorWorkContext,
    attachmentResult,
    normalizedWorkspace,
    logicalKey,
    continueSessionId,
    isContinuation,
    sessionTitle,
  }
}
