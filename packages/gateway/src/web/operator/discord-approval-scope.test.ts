/**
 * Pins the existing scope split behind the approval push deep link (contract 1.12.0).
 *
 * A Discord run registers its approvals under the THREAD id (that is what the button handler verifies),
 * while the web pending-approvals route reads the registry by RUN id. So for a Discord-scope approval:
 *   - `GET /operator/runs/:runId/approvals` returns `{approvals: []}` — the web cannot decide it, and
 *   - the status overlay still shows `waiting_for_approval`, because it keys on `scopeIdFor(run)`.
 * The approval push deep-links to that run's card all the same, exactly as question pushes do. If this
 * test starts failing, the scope model changed and the push copy / dashboard handoff must be revisited.
 */

import type {RunState} from '@fro-bot/runtime'
import type {PermissionRequest} from '../../approvals/coordinator.js'
import type {RepoBinding} from '../../bindings/types.js'
import type {RunSummary} from '../../operator-contract/index.js'

import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {createApprovalRegistry} from '../../approvals/registry.js'
import {setOperatorRouteGuard} from '../operator-route.js'
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

function buildApp(runs: readonly RunState[]) {
  const registry = createApprovalRegistry({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}})
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true as const, githubUserId: 1001, sessionId: 'sess-abc'}))
  buildPendingApprovalsRoute(app, {
    runIndex: {
      lookup: async runId => ({repo: 'acme/widget', surface: runs.find(r => r.run_id === runId)?.surface ?? 'web'}),
    },
    denylistCache: {getDenylistState: async () => undefined, isRepoDenied: () => false},
    bindingsLookup: {getBindingByRepo: async () => ({success: true as const, data: BINDING})},
    registry,
    logger,
    now: () => 0,
  })
  buildRunsRoute(app, {
    listBindings: async () => ({success: true as const, data: [BINDING]}),
    isRepoDenied: () => false,
    logger,
    now: () => 0,
    listRunsForRepo: async () => runs,
    approvalRegistry: registry,
    questionRegistry: {hasPendingForScope: () => false},
  })
  return {app, registry}
}

function registerApproval(registry: ReturnType<typeof createApprovalRegistry>, scopeId: string): void {
  registry.register({
    requestID: 'req-1',
    sessionID: 'sess-1',
    approvalScopeId: scopeId,
    directory: '/workspace/acme/widget',
    request: makeApproval('req-1'),
    effects: {postReply: async () => ({ok: true})},
    deadlineMs: undefined,
  })
}

async function pendingFor(app: Hono, runId: string): Promise<unknown[]> {
  const res = await app.fetch(new Request(`http://localhost/operator/runs/${runId}/approvals`))
  expect(res.status).toBe(200)
  return ((await res.json()) as {approvals: unknown[]}).approvals
}

async function statusOf(app: Hono, runId: string): Promise<string | undefined> {
  const res = await app.fetch(new Request('http://localhost/operator/runs'))
  return ((await res.json()) as {runs: RunSummary[]}).runs.find(run => run.runId === runId)?.status
}

describe('approval scope split — Discord vs web (pinned)', () => {
  it('a Discord-scope approval is invisible to the web pending route but shows waiting_for_approval', async () => {
    // #given a Discord run whose approval is registered under the thread id, as the Discord transport does
    const {app, registry} = buildApp([makeRun('discord', 'run-discord')])
    registerApproval(registry, THREAD_ID)

    // #when / #then — the web cannot see (or decide) it, yet the card shows the run is waiting
    expect(await pendingFor(app, 'run-discord')).toEqual([])
    expect(await statusOf(app, 'run-discord')).toBe('waiting_for_approval')
  })

  it('a web-scope approval is registered under the run id, so the same card can decide it', async () => {
    // #given a web run whose approval is registered under the run id, as the web transport does
    const {app, registry} = buildApp([makeRun('web', 'run-web')])
    registerApproval(registry, 'run-web')

    // #when / #then
    expect(await pendingFor(app, 'run-web')).toHaveLength(1)
    expect(await statusOf(app, 'run-web')).toBe('waiting_for_approval')
  })
})
