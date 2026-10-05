/**
 * Repo workspace quiescence check — a point-in-time read of OpenCode's session status for one repo's
 * workspace directory. Used to corroborate an expired coordination lease before it is replaced or
 * deleted: only `clear` permits it; `busy` and `unknown` both block. Not fencing — it proves nothing
 * about later activity.
 *
 * Fail-closed by construction: every failure mode (transport, non-2xx, empty/missing body, invalid
 * shape, timeout, bad repo) resolves to `unknown`. No retries, no cached clearance.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {RepoQuiescence} from '../runtime-effect.js'

import {canonicalWorkspaceDirectory} from '../workspace-api/client.js'
import {attachOpencode} from './opencode-attach.js'

const SOURCE = 'opencode-session-status'
const STATUS_REQUEST_TIMEOUT_MS = 4_000
const MAX_LOGGED_SESSION_IDS = 32

export interface RepoQuiescenceContext {
  readonly repo: string
  readonly signal: AbortSignal
}

/** Structurally compatible with the lock layer's `ConfirmExpiredHolder`, which passes extra context. */
export type RepoQuiescenceChecker = (context: RepoQuiescenceContext) => Promise<RepoQuiescence>

interface StatusResponseLike {
  readonly ok: boolean
  readonly status: number
  readonly headers: {readonly get: (name: string) => string | null}
}

interface StatusResultLike {
  readonly data?: unknown
  readonly error?: unknown
  readonly response?: StatusResponseLike
}

/** The one SDK call this check needs; the real OpenCode client satisfies it. */
export interface SessionStatusClient {
  readonly session: {
    readonly status: (options: {
      readonly query: {readonly directory: string}
      readonly signal: AbortSignal
    }) => Promise<StatusResultLike>
  }
}

export interface RepoQuiescenceCheckerOptions {
  readonly workspaceOpencodeUrl: string
  readonly workspaceOpencodeToken: string
  readonly logger: GatewayLogger
  /** Test seam; defaults to the bearer-authenticated workspace attach client. */
  readonly createClient?: (url: string, token: string) => SessionStatusClient
  readonly now?: () => Date
}

type ParsedStatuses =
  | {readonly kind: 'valid'; readonly busyIds: readonly string[]}
  | {readonly kind: 'invalid'; readonly busyIds: readonly string[]}

/**
 * Resolves `owner/repo` to the canonical workspace directory (shared with the run's session directory), or
 * `null` for anything not exactly that shape. `session.status` returns `{}` for any directory without
 * sessions, so `clear` is only meaningful because this is the directory the run's sessions are created under.
 */
function resolveRepoDirectory(repo: string): string | null {
  const parts = repo.split('/')
  if (parts.length !== 2) return null
  return canonicalWorkspaceDirectory(parts[0] ?? '', parts[1] ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && Array.isArray(value) === false
}

/** `busy` or `retry` in ANY entry counts as activity; an idle-only map is clear; anything unrecognized is invalid. */
function parseStatuses(data: Record<string, unknown>): ParsedStatuses {
  const busyIds: string[] = []
  let invalid = false
  for (const [sessionId, status] of Object.entries(data)) {
    const type = isRecord(status) ? status.type : undefined
    if (type === 'busy' || type === 'retry') busyIds.push(sessionId)
    else if (type !== 'idle') invalid = true
  }
  return {kind: invalid ? 'invalid' : 'valid', busyIds}
}

/** A 204 / zero-length body is rewritten to `{}` by the SDK; that is absence of evidence, not an empty map. */
function hasUsableBody(response: StatusResponseLike | undefined): boolean {
  if (response === undefined || response.ok === false || response.status !== 200) return false
  if (response.headers.get('Content-Length') === '0') return false
  return response.headers.get('Content-Type')?.toLowerCase().includes('json') === true
}

export function createRepoQuiescenceChecker(options: RepoQuiescenceCheckerOptions): RepoQuiescenceChecker {
  const {logger, now = () => new Date()} = options
  const client: SessionStatusClient =
    options.createClient?.(options.workspaceOpencodeUrl, options.workspaceOpencodeToken) ??
    attachOpencode(options.workspaceOpencodeUrl, options.workspaceOpencodeToken).client

  return async ({repo, signal}) => {
    const directory = resolveRepoDirectory(repo)
    if (directory === null) {
      logger.warn({repo}, 'repo-quiescence: invalid repo; treating as unknown')
      return {kind: 'unknown', source: 'unavailable', directory: null, reason: 'invalid-repo'}
    }

    const unknown = (reason: string, detail: Record<string, unknown> = {}): RepoQuiescence => {
      logger.warn({repo, directory, reason, ...detail}, 'repo-quiescence: workspace status unknown')
      return {kind: 'unknown', source: SOURCE, directory, reason}
    }

    const controller = new AbortController()
    let timedOut = false
    const onAbort = (): void => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, {once: true})
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, STATUS_REQUEST_TIMEOUT_MS)

    // Raced against the abort so a client that ignores the signal still cannot stall the caller.
    const aborted = new Promise<'aborted'>(resolve => {
      if (controller.signal.aborted) resolve('aborted')
      else controller.signal.addEventListener('abort', () => resolve('aborted'), {once: true})
    })

    try {
      const outcome = await Promise.race([
        client.session.status({query: {directory}, signal: controller.signal}).then(
          result => ({result}) as const,
          (error: unknown) => ({error}) as const,
        ),
        aborted,
      ])

      if (outcome === 'aborted') return unknown(timedOut ? 'status-request-timeout' : 'status-request-aborted')
      if ('error' in outcome) {
        const errorName = outcome.error instanceof Error ? outcome.error.name : typeof outcome.error
        return unknown(controller.signal.aborted ? 'status-request-aborted' : 'status-request-failed', {errorName})
      }

      const {result} = outcome
      if (result.error !== undefined || result.response?.ok !== true) {
        return unknown('status-request-rejected', {httpStatus: result.response?.status ?? null})
      }
      if (hasUsableBody(result.response) === false || isRecord(result.data) === false) {
        return unknown('status-response-invalid', {httpStatus: result.response?.status ?? null})
      }

      const parsed = parseStatuses(result.data)
      if (parsed.busyIds.length > 0) {
        logger.info(
          {
            repo,
            directory,
            busyCount: parsed.busyIds.length,
            sessionIds: parsed.busyIds.slice(0, MAX_LOGGED_SESSION_IDS),
          },
          'repo-quiescence: workspace busy',
        )
        return {kind: 'busy', source: SOURCE, directory, checkedAt: now().toISOString(), sessionIds: parsed.busyIds}
      }
      if (parsed.kind === 'invalid') return unknown('status-entry-invalid')

      return {kind: 'clear', source: SOURCE, directory, checkedAt: now().toISOString()}
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
