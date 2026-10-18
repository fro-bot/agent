import type {PermissionRequest} from '../approvals/coordinator.js'
import type {PushRelayResult} from '../web/operator-push/push-sender.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  makeApprovalRegistry,
  makeBinding,
  makeDeps,
  makeInMemoryRequest,
  makeMessage,
  mockCreatePermissionCoordinator,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import {createWebApprovalOnPending} from '../web/operator/web-approval.js'
import {createDedupeCache} from '../web/operator-push/dedupe-cache.js'
import {createPushDispatcher} from '../web/operator-push/dispatcher.js'
import {shouldNotify} from '../web/operator-push/trigger-policy.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Approval push deep link (contract 1.12.0): the REAL push dispatcher driven by the REAL
// `onPending` closure `run.ts` hands to the permission coordinator. Only the relay sender and the
// subscription store are fakes, so a missing `runId` at the call site shows up on the wire.
// ---------------------------------------------------------------------------

const SECRET_COMMAND = 'rm -rf /srv/SENTINEL-COMMAND'

function makeRequest(requestID: string): PermissionRequest {
  return {
    requestID,
    sessionID: 'sess-push',
    permission: 'bash',
    patterns: ['/srv/SENTINEL-PATTERN/*'],
    title: `Run command: ${SECRET_COMMAND}`,
    command: SECRET_COMMAND,
  }
}

function makeRealDispatcher() {
  const accepted: PushRelayResult = {outcome: 'accepted', statusCode: 201}
  const sendNotification = vi.fn(async () => accepted)
  const auditInfo = vi.fn()
  const dispatcher = createPushDispatcher({
    store: {
      listAllActiveRecords: vi.fn(async () => ({
        success: true as const,
        data: [
          {
            endpointHash: 'h1',
            endpoint: 'https://push.example.com/1',
            p256dh: 'p256dh',
            auth: 'auth',
            operatorId: 'operator-a',
            active: true,
            keyVersion: '1',
            ownershipGeneration: 1,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      })),
      markDead: vi.fn(async () => ({success: true as const, data: undefined})),
    },
    sender: {sendNotification},
    dedupeCache: createDedupeCache({windowMs: 60_000}),
    triggerPolicy: {shouldNotify},
    vapidConfig: {subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv', keyVersion: '1'},
    logger: {debug: vi.fn(), warn: vi.fn()},
    auditLogger: {info: auditInfo, warn: vi.fn()},
  })
  const sent = (): {data: Record<string, unknown>}[] =>
    (sendNotification.mock.calls as unknown as unknown[][]).map(call => JSON.parse(String(call[1])) as never)
  return {dispatcher, sent, auditInfo}
}

/** Captures the coordinator's `onPending` and fires the given requests from inside the (mocked) run. */
function fireApprovals(requests: readonly PermissionRequest[]): void {
  let onPending: ((req: PermissionRequest) => void) | undefined
  mockCreatePermissionCoordinator.mockImplementation(coordinatorDeps => {
    onPending = coordinatorDeps.onPending
    return {
      onPermissionAsked: vi.fn(),
      onPermissionReplied: vi.fn(),
      pending: vi.fn().mockReturnValue([]),
      dispose: vi.fn(),
      addOwnedSession: vi.fn(),
      isOwned: vi.fn().mockReturnValue(true),
    }
  })
  mockRunOpenCodeCore.mockImplementation(async () => {
    for (const request of requests) onPending?.(request)
  })
}

function createdRunId(): string {
  const call = mockRuntime.createRun.mock.calls[0] as unknown[] | undefined
  return String((call?.[3] as {run_id: string}).run_id)
}

/** Lets the fire-and-forget dispatch (a floating promise in run.ts) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('approval push — real dispatcher + real onPending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a Discord run: the push deep-links to the run that is waiting', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {dispatcher, sent} = makeRealDispatcher()
    fireApprovals([makeRequest('req-1')])

    // #when
    await runMention(
      makeMessage(),
      makeBinding(),
      makeDeps({operatorPushDispatcher: dispatcher, approvalRegistry: makeApprovalRegistry()}),
    )
    await settle()

    // #then — route and runId are the run that was created, not the approval or request id
    const runId = createdRunId()
    expect(sent()).toHaveLength(1)
    expect(sent()[0]?.data).toEqual({type: 'approval', route: `/operator#${runId}`, runId})
  })

  it('a web run: the push deep-links to the run, and the web transport still registers the approval', async () => {
    // #given — the real web approval transport next to the real dispatcher
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const approvalRegistry = makeApprovalRegistry()
    const {dispatcher, sent} = makeRealDispatcher()
    fireApprovals([makeRequest('req-1')])
    const request = {
      ...makeInMemoryRequest(),
      surface: 'web' as const,
      createApprovalOnPending: createWebApprovalOnPending({
        observeApproval: vi.fn(),
        logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
      }),
    }

    // #when
    await awaitLaunchWorkRun(launchWork, request, makeDeps({operatorPushDispatcher: dispatcher, approvalRegistry}))
    await settle()

    // #then
    const runId = createdRunId()
    expect(sent()[0]?.data).toEqual({type: 'approval', route: `/operator#${runId}`, runId})
    expect(approvalRegistry.register).toHaveBeenCalledWith(expect.objectContaining({approvalScopeId: runId}))
  })

  it('the same approvalId asked twice is one send; two approvals on one run are two sends', async () => {
    // #given — req-1 twice, then req-2, all on the same run
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {dispatcher, sent} = makeRealDispatcher()
    fireApprovals([makeRequest('req-1'), makeRequest('req-1'), makeRequest('req-2')])

    // #when
    await runMention(
      makeMessage(),
      makeBinding(),
      makeDeps({operatorPushDispatcher: dispatcher, approvalRegistry: makeApprovalRegistry()}),
    )
    await settle()

    // #then
    const runId = createdRunId()
    expect(sent()).toHaveLength(2)
    expect(sent().map(payload => payload.data.runId)).toEqual([runId, runId])
  })

  it('the wire payload and the audit event never carry the tool name, command, patterns, repo or prompt', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {dispatcher, sent, auditInfo} = makeRealDispatcher()
    fireApprovals([makeRequest('req-1')])

    // #when
    await runMention(
      makeMessage(),
      makeBinding(),
      makeDeps({operatorPushDispatcher: dispatcher, approvalRegistry: makeApprovalRegistry()}),
    )
    await settle()

    // #then — exactly the fixed copy plus the deep link
    const wire = JSON.stringify(sent())
    for (const leaked of ['bash', 'SENTINEL', 'rm -rf', 'acme', 'widget', 'do the thing', 'req-1', 'sess-push']) {
      expect(wire).not.toContain(leaked)
    }
    expect(Object.keys(sent()[0]?.data ?? {}).sort()).toEqual(['route', 'runId', 'type'])
    expect(JSON.stringify(auditInfo.mock.calls)).not.toContain(createdRunId())
  })
})
