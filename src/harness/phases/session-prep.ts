import type {LogicalSessionKey, SessionSearchResult, SessionSummary} from '@fro-bot/runtime'
import type {AttachmentResult} from '../../features/attachments/index.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import {buildLogicalKey, buildSessionTitle} from '@fro-bot/runtime'
import {
  buildAttachmentResult,
  downloadAttachments,
  parseAttachmentUrls,
  validateAttachments,
} from '../../features/attachments/index.js'
import {getGitHubWorkspace, getInvocationIdentity} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLogger} from '../../shared/logger.js'
import {normalizeWorkspacePath} from '../../shared/paths.js'
import {createSessionReaderV2, prepareSessionContextV2, resolveSessionForLogicalKeyV2} from './session-v2.js'

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

interface SessionPrepContext {
  readonly recentSessions: readonly SessionSummary[]
  readonly priorWorkContext: readonly SessionSearchResult[]
}

export function buildSessionSearchQuery(
  logicalKey: LogicalSessionKey | null,
  issueTitle: string | null,
  repo: string,
): string {
  return logicalKey?.key ?? issueTitle ?? repo
}

export async function runSessionPrep(
  bootstrap: BootstrapPhaseResult,
  routing: RoutingPhaseResult,
  cacheRestore: CacheRestorePhaseResult,
  metrics: MetricsCollector,
): Promise<SessionPrepPhaseResult> {
  const sessionLogger = createLogger({phase: 'session'})
  const normalizedWorkspace = normalizeWorkspacePath(getGitHubWorkspace())

  const logicalKey = buildLogicalKey(routing.triggerResult.context, getInvocationIdentity())
  const sessionTitle = logicalKey == null ? null : buildSessionTitle(logicalKey)
  let continueSessionId: string | null = null
  let isContinuation = false

  // Session reads go over the server's own routes.
  if (logicalKey != null) {
    const resolution = await resolveSessionForLogicalKeyV2(
      createSessionReaderV2(cacheRestore.serverHandle.fetch),
      normalizedWorkspace,
      logicalKey,
      sessionLogger,
    )

    if (resolution.status === 'found') {
      continueSessionId = resolution.sessionId
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

  const searchQuery = buildSessionSearchQuery(logicalKey, routing.agentContext.issueTitle, routing.agentContext.repo)
  let preparedContext: SessionPrepContext = {recentSessions: [], priorWorkContext: []}
  try {
    preparedContext = await prepareSessionContextV2({
      reader: createSessionReaderV2(cacheRestore.serverHandle.fetch),
      workspacePath: normalizedWorkspace,
      searchQuery,
      logger: sessionLogger,
    })
  } catch (error: unknown) {
    sessionLogger.warning('Session presearch strategy failed; proceeding with empty context', {
      error: toErrorMessage(error),
    })
  }

  const {recentSessions, priorWorkContext} = preparedContext
  sessionLogger.debug('Prepared session context', {
    recentSessionCount: recentSessions.length,
    priorWorkResultCount: priorWorkContext.length,
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
