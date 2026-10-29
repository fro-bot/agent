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
 *
 * Background shells are part of the answer. A shell is a server job, not a session, so `session.active` never lists it,
 * and it outlives the run that started it, writing the checkout after the lock expires (bgshell probes p20, p21). The
 * repo is therefore not clear while ANY shell is running in its directory, whoever owns it. That is deliberately wider
 * than "a shell of this repo's sessions": the lease check runs after a holder died, when its session ids are not
 * recoverable (the lease carries none, and a session that moved is listed under its destination), and a shell nobody
 * tagged (`POST /api/shell`) writes the checkout just the same. Two runs never share a checkout, so a running shell in
 * the directory is a writer the next run must wait out. A status the client does not know counts as running, and a list
 * that cannot be read is `unknown`.
 */

import type {Result} from '@bfra.me/es/result'
import type {RemoteOpenCodeV2Client, V2SessionApi} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {RepoQuiescence} from '../runtime-effect.js'
import type {RepoQuiescenceChecker} from './repo-quiescence.js'

import {err, listBusyV2SessionIdsInDirectory, ok, toErrorMessage} from '@fro-bot/runtime'
import {attachOpencodeV2} from './opencode-attach-v2.js'
import {REPO_QUIESCENCE_TIMEOUT_MS} from './recovery-budget.js'
import {resolveRepoDirectory} from './repo-quiescence.js'

const SOURCE = 'opencode-session-status'
const MAX_LOGGED_SESSION_IDS = 32

/** The one client surface this check needs; the real V2 client satisfies it. */
export interface ActiveSessionsClient {
  readonly session: V2SessionApi
  readonly listShells: RemoteOpenCodeV2Client['listShells']
}

export interface RepoQuiescenceCheckerV2Options {
  readonly workspaceOpencodeUrl: string
  readonly workspaceOpencodeToken: string
  readonly logger: GatewayLogger
  /** Test seam; defaults to the bearer-authenticated workspace attach client. */
  readonly createClient?: (url: string, token: string) => ActiveSessionsClient
  readonly now?: () => Date
}

/** Ids of the shells running in `directory`. A failed or unreadable list is an error: it must not read as "none". */
async function listRunningShellIds(
  client: ActiveSessionsClient,
  directory: string,
  signal: AbortSignal,
): Promise<Result<readonly string[], Error>> {
  try {
    const listed = await client.listShells({directory, signal})
    if (!listed.success) return err(new Error(`shell.list failed: ${listed.error.kind}`))
    return ok(
      listed.data.filter(shell => shell.status === 'running' || shell.status === 'unknown').map(shell => shell.id),
    )
  } catch (error) {
    return err(new Error(toErrorMessage(error)))
  }
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
        Promise.all([
          listBusyV2SessionIdsInDirectory(
            client.session,
            directory,
            {realpath: async path => path},
            {signal: controller.signal},
          ),
          listRunningShellIds(client, directory, controller.signal),
        ]),
        aborted,
      ])

      if (outcome === 'aborted') return unknown(timedOut ? 'status-request-timeout' : 'status-request-aborted')
      const [sessions, shells] = outcome
      if (!sessions.success) {
        return unknown(controller.signal.aborted ? 'status-request-aborted' : 'status-request-failed', {
          errorName: sessions.error.name,
        })
      }
      if (!shells.success) {
        return unknown(controller.signal.aborted ? 'status-request-aborted' : 'status-request-failed', {
          errorName: shells.error.name,
        })
      }

      const busyIds = [...sessions.data, ...shells.data]
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
