/**
 * Repo workspace quiescence for an OpenCode V2 workspace: the V2 sibling of `repo-quiescence.ts`.
 *
 * V1 asked `session.status` for one directory. V2 has no per-directory status, so the busy set is the server's global
 * active list joined with `session.list({directory})` (`listBusyV2SessionIdsInDirectory`, probes P2 and P9). The
 * contract is the same: only `clear` permits replacing or deleting an expired lease, `busy` and `unknown` both block,
 * and every failure (transport, non-2xx, bad shape, timeout, bad repo) resolves to `unknown`. No retries, no cached
 * clearance.
 *
 * The directory match is an exact string against the directory the session was created with, so the join uses the same
 * canonical workspace directory the run creates its sessions under (`canonicalWorkspaceDirectory`). The gateway cannot
 * `realpath` it: the checkout lives in the workspace's filesystem, not this one. That is why the canonicalizer handed to
 * the join is the identity.
 */

import type {V2SessionApi} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {RepoQuiescence} from '../runtime-effect.js'
import type {RepoQuiescenceChecker} from './repo-quiescence.js'

import {listBusyV2SessionIdsInDirectory} from '@fro-bot/runtime'
import {attachOpencodeV2} from './opencode-attach-v2.js'
import {REPO_QUIESCENCE_TIMEOUT_MS} from './recovery-budget.js'
import {resolveRepoDirectory} from './repo-quiescence.js'

const SOURCE = 'opencode-session-status'
const MAX_LOGGED_SESSION_IDS = 32

/** The one client surface this check needs; the real V2 client satisfies it. */
export interface ActiveSessionsClient {
  readonly session: V2SessionApi
}

export interface RepoQuiescenceCheckerV2Options {
  readonly workspaceOpencodeUrl: string
  readonly workspaceOpencodeToken: string
  readonly logger: GatewayLogger
  /** Test seam; defaults to the bearer-authenticated workspace attach client. */
  readonly createClient?: (url: string, token: string) => ActiveSessionsClient
  readonly now?: () => Date
}

export function createRepoQuiescenceCheckerV2(options: RepoQuiescenceCheckerV2Options): RepoQuiescenceChecker {
  const {logger, now = () => new Date()} = options
  const client: ActiveSessionsClient =
    options.createClient?.(options.workspaceOpencodeUrl, options.workspaceOpencodeToken) ??
    attachOpencodeV2(options.workspaceOpencodeUrl, options.workspaceOpencodeToken)

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
    }, REPO_QUIESCENCE_TIMEOUT_MS)

    // Raced against the abort so a client that ignores the signal still cannot stall the caller.
    const aborted = new Promise<'aborted'>(resolve => {
      if (controller.signal.aborted) resolve('aborted')
      else controller.signal.addEventListener('abort', () => resolve('aborted'), {once: true})
    })

    try {
      const outcome = await Promise.race([
        listBusyV2SessionIdsInDirectory(
          client.session,
          directory,
          {realpath: async path => path},
          {signal: controller.signal},
        ),
        aborted,
      ])

      if (outcome === 'aborted') return unknown(timedOut ? 'status-request-timeout' : 'status-request-aborted')
      if (!outcome.success) {
        return unknown(controller.signal.aborted ? 'status-request-aborted' : 'status-request-failed', {
          errorName: outcome.error.name,
        })
      }

      const busyIds = [...outcome.data]
      if (busyIds.length > 0) {
        logger.info(
          {repo, directory, busyCount: busyIds.length, sessionIds: busyIds.slice(0, MAX_LOGGED_SESSION_IDS)},
          'repo-quiescence: workspace busy',
        )
        return {kind: 'busy', source: SOURCE, directory, checkedAt: now().toISOString(), sessionIds: busyIds}
      }
      return {kind: 'clear', source: SOURCE, directory, checkedAt: now().toISOString()}
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
