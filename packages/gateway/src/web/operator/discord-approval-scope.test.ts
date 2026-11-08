/**
 * Discord-run approvals through the real operator routes (#2115).
 *
 * A Discord run registers its approvals under the THREAD id (that is what the button handler verifies), while the
 * web routes address a run by its RUN id. The registry entry therefore carries the run that raised it, and:
 *   - `GET /operator/runs/:runId/approvals` lists the run's open approvals whatever scope they were registered under,
 *   - `POST .../decision` settles one only when the request belongs to the URL's run (another run's id answers
 *     exactly like an unknown request), and
 *   - the status overlay still keys on `scopeIdFor(run)`, so `waiting_for_approval` is unchanged.
 * Repo authorization (binding + denylist) is untouched: it runs before either route reaches the registry.
 */

import type {RunState} from '@fro-bot/runtime'
import type {PermissionRequest} from '../../approvals/coordinator.js'
import type {RepoBinding} from '../../bindings/types.js'
import type {RunSummary} from '../../operator-contract/index.js'

import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {createApprovalRegistry} from '../../approvals/registry.js'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildDecisionRoute} from './decision-route.js'
import {buildPendingApprovalsRoute} from './pending-approvals-route.js'
import {buildRunsRoute} from './runs-route.js'

const BINDING: RepoBinding = {
  owner: 'acme',
  repo: 'widget',
  channelId: 'ch-1',
  channelName: 'widget-dev',
  workspacePath: '/workspace/acme/widget',
  createdAt: '2026-01-01T00:00:00Z',
  createdByDiscordId: 'discord-1',
  databaseId: 42,
  nodeId: 'R_node_42',
}
const THREAD_ID = 'thread-99'

function makeRun(surface: 'discord' | 'web', runId: string): RunState {
  return {
    run_id: runId,
    surface,
    thread_id: surface === 'discord' ? THREAD_ID : '',
    entity_ref: 'acme/widget',
    phase: 'EXECUTING',
    started_at: '2026-01-01T00:00:00.000Z',
    last_heartbeat: '',
    holder_id: 'gateway',
    details: {},
  }
}

function makeApproval(requestID: string): PermissionRequest {
  return {requestID, sessionID: 'sess-1', permission: 'bash', patterns: [], title: 'Run command: ls'}
}

const OTHER_BINDING: RepoBinding = {...BINDING, repo: 'gadget', channelId: 'ch-2', databaseId: 43, nodeId: 'R_node_43'}

interface AppOptions {
  readonly bindings?: readonly RepoBinding[]
  /** run id → repo, for runs outside acme/widget. */
  readonly repoByRun?: Readonly<Record<string, string>>
}

function buildApp(runs: readonly RunState[], options: AppOptions = {}) {
  const registry = createApprovalRegistry({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}})
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const bindings = options.bindings ?? [BINDING]
  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true as const, githubUserId: 1001, sessionId: 'sess-abc'}))
  const runIndex = {
    lookup: async (runId: string) => ({
      repo: options.repoByRun?.[runId] ?? 'acme/widget',
      surface: runs.find(r => r.run_id === runId)?.surface ?? 'web',
    }),
  }
  const denylistCache = {getDenylistState: async () => undefined, isRepoDenied: () => false}
  const bindingsLookup = {
    getBindingByRepo: async (owner: string, repo: string) => ({
      success: true as const,
      data: bindings.find(b => b.owner === owner && b.repo === repo) ?? null,
    }),
  }
  buildPendingApprovalsRoute(app, {runIndex, denylistCache, bindingsLookup, registry, logger, now: () => 0})
  buildDecisionRoute(app, {
    runIndex,
    denylistCache,
    bindingsLookup,
    registry,
    sessionStore: {get: () => ({githubUserId: 1001, login: 'alice', issuedAt: 0})},
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    logger,
  })
  buildRunsRoute(app, {
    listBindings: async () => ({success: true as const, data: [...bindings]}),
    isRepoDenied: () => false,
    isPolicyAvailable: () => true,
    logger,
    now: () => 0,
    listRunsForRepo: async () => runs,
    approvalRegistry: registry,
    questionRegistry: {hasPendingForScope: () => false},
  })
  return {app, registry}
}

function registerApproval(
  registry: ReturnType<typeof createApprovalRegistry>,
  scopeId: string,
  runId: string,
  requestID = 'req-1',
) {
  const postReply = vi.fn(async () => ({ok: true}))
  registry.register({
    requestID,
    sessionID: 'sess-1',
    approvalScopeId: scopeId,
    runId,
    directory: '/workspace/acme/widget',
    request: makeApproval(requestID),
    effects: {postReply},
    deadlineMs: undefined,
  })
  return postReply
}

async function pendingFor(app: Hono, runId: string): Promise<unknown[]> {
  const res = await app.fetch(new Request(`http://localhost/operator/runs/${runId}/approvals`))
  expect(res.status).toBe(200)
  return ((await res.json()) as {approvals: unknown[]}).approvals
}

async function decide(app: Hono, runId: string, requestId: string, decision = 'once') {
  const res = await app.fetch(
    new Request(`http://localhost/operator/runs/${runId}/approvals/${requestId}/decision`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({decision}),
    }),
  )
  return {status: res.status, body: (await res.json()) as {state?: string; error?: string}}
}

async function statusOf(app: Hono, runId: string): Promise<string | undefined> {
  const res = await app.fetch(new Request('http://localhost/operator/runs'))
  return ((await res.json()) as {runs: RunSummary[]}).runs.find(run => run.runId === runId)?.status
}

describe('GET /operator/runs/:runId/approvals — Discord vs web', () => {
  it('lists a Discord-run approval registered under the thread id, and the card shows waiting_for_approval', async () => {
    // #given a Discord run whose approval is registered under the thread id, as the Discord transport does
    const {app, registry} = buildApp([makeRun('discord', 'run-discord')])
    registerApproval(registry, THREAD_ID, 'run-discord')

    // #when / #then the dashboard sees it, and the overlay agrees
    expect(await pendingFor(app, 'run-discord')).toEqual([{requestID: 'req-1', permission: 'bash'}])
    expect(await statusOf(app, 'run-discord')).toBe('waiting_for_approval')
  })

  it('still lists a web-run approval registered under the run id', async () => {
    // #given a web run whose approval is registered under the run id, as the web transport does
    const {app, registry} = buildApp([makeRun('web', 'run-web')])
    registerApproval(registry, 'run-web', 'run-web')

    // #when / #then
    expect(await pendingFor(app, 'run-web')).toHaveLength(1)
    expect(await statusOf(app, 'run-web')).toBe('waiting_for_approval')
  })

  it("does not list another run's approval, even in the same repo", async () => {
    // #given two Discord runs in one repo, one approval
    const {app, registry} = buildApp([makeRun('discord', 'run-a'), makeRun('discord', 'run-b')])
    registerApproval(registry, THREAD_ID, 'run-a')

    // #when / #then
    expect(await pendingFor(app, 'run-a')).toHaveLength(1)
    expect(await pendingFor(app, 'run-b')).toEqual([])
  })
})

describe('POST /operator/runs/:runId/approvals/:requestId/decision — Discord-run approvals', () => {
  it('settles a Discord-run approval for the matching run', async () => {
    // #given
    const {app, registry} = buildApp([makeRun('discord', 'run-discord')])
    const postReply = registerApproval(registry, THREAD_ID, 'run-discord')

    // #when the dashboard approves it
    const result = await decide(app, 'run-discord', 'req-1')

    // #then it is claimed and the reply went upstream once
    expect(result).toEqual({status: 200, body: {state: 'claimed'}})
    expect(postReply).toHaveBeenCalledExactlyOnceWith('req-1', '/workspace/acme/widget', 'once')
  })

  it("answers another run's request id exactly like an unknown one, even when the operator can see both repos", async () => {
    // #given run-a (acme/widget) holds the approval; run-b is a Discord run in acme/gadget, which is also bound
    const {app, registry} = buildApp([makeRun('discord', 'run-a'), makeRun('discord', 'run-b')], {
      bindings: [BINDING, OTHER_BINDING],
      repoByRun: {'run-b': 'acme/gadget'},
    })
    const postReply = registerApproval(registry, THREAD_ID, 'run-a')

    // #when run-b's URL names run-a's request, and a request that does not exist
    const crossRun = await decide(app, 'run-b', 'req-1')
    const unknown = await decide(app, 'run-b', 'req-nope')

    // #then the two answers are identical, and nothing was claimed or sent
    expect(crossRun).toEqual(unknown)
    expect(crossRun).toEqual({status: 200, body: {state: 'unavailable'}})
    expect(postReply).not.toHaveBeenCalled()
    expect(await pendingFor(app, 'run-a')).toHaveLength(1)
  })

  it('refuses a run in a repo the operator cannot access, as it does today', async () => {
    // #given a Discord run in acme/gadget, which is not bound
    const {app, registry} = buildApp([makeRun('discord', 'run-hidden')], {repoByRun: {'run-hidden': 'acme/gadget'}})
    const postReply = registerApproval(registry, THREAD_ID, 'run-hidden')

    // #when / #then the repo gate denies before the registry is reached
    expect(await decide(app, 'run-hidden', 'req-1')).toEqual({status: 404, body: {error: 'not-found'}})
    expect(postReply).not.toHaveBeenCalled()
  })
})
