/**
 * Tests for the web auto-deny approval transport.
 *
 * Verifies that:
 * - The web createApprovalOnPending auto-denies with 'reject' immediately.
 * - It does NOT use the Discord approval transport.
 * - It does NOT hold (fire-and-forget, no await on the reply POST).
 */

import type {PermissionRequest} from '../../approvals/coordinator.js'
import type {ApprovalRegistry} from '../../approvals/registry.js'
import type {ApprovalTransportContext} from '../../execute/launch-types.js'
import {describe, expect, it, vi} from 'vitest'
import {createWebAutoDenyApproval} from './web-approval.js'

function makePermissionRequest(overrides?: Partial<PermissionRequest>): PermissionRequest {
  return {
    requestID: 'req-123',
    sessionID: 'sess-abc',
    permission: 'bash',
    patterns: ['rm -rf /'],
    title: 'Run bash command',
    ...overrides,
  }
}

function makeApprovalRegistry(): ApprovalRegistry {
  return {
    register: vi.fn(),
    attachMessage: vi.fn(),
    markMessagePostFailed: vi.fn(),
    has: vi.fn(() => false),
    pending: vi.fn(() => []),
    hasPendingForScope: vi.fn(() => false),
    handleDecision: vi.fn(async () => 'ok' as const),
    confirmReply: vi.fn(),
    applySettlement: vi.fn(async () => undefined),
    disposeRun: vi.fn(async () => undefined),
    disposeAll: vi.fn(async () => undefined),
  }
}

function makeApprovalTransportContext(overrides?: Partial<ApprovalTransportContext>): ApprovalTransportContext {
  const postReply = vi.fn(async () => ({ok: true as const}))
  const postReplyFactory = vi.fn((_sessionID: string) => postReply)

  return {
    approvalRegistry: makeApprovalRegistry(),
    directory: '/workspace/owner/repo',
    approvalDeadlineMs: 60_000,
    runId: 'run-uuid-1234',
    repo: 'owner/repo',
    replySink: {
      append: vi.fn(),
      flush: vi.fn(async () => undefined),
      buffered: vi.fn(() => ''),
      hasVisibleOutput: vi.fn(() => false),
      markVisibleOutputSent: vi.fn(),
      markVisibleOutputPending: vi.fn(() => vi.fn()),
      send: vi.fn(async () => undefined),
    },
    postReplyFactory,
    ...overrides,
  }
}

describe('createWebAutoDenyApproval', () => {
  describe('auto-deny behavior', () => {
    it('calls postReplyFactory with the request sessionID', async () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const req = makePermissionRequest({sessionID: 'sess-xyz'})
      const factory = createWebAutoDenyApproval()
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // Allow the fire-and-forget to settle
      await new Promise(resolve => setTimeout(resolve, 0))

      // #then — postReplyFactory called with the request's sessionID
      expect(ctx.postReplyFactory).toHaveBeenCalledWith('sess-xyz')
    })

    it('posts reject (deny) for the permission request', async () => {
      // #given
      const postReply = vi.fn(async () => ({ok: true as const}))
      const postReplyFactory = vi.fn((_sessionID: string) => postReply)
      const ctx = makeApprovalTransportContext({postReplyFactory})
      const req = makePermissionRequest({requestID: 'req-abc', sessionID: 'sess-1'})
      const factory = createWebAutoDenyApproval()
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // Allow the fire-and-forget to settle
      await new Promise(resolve => setTimeout(resolve, 0))

      // #then — postReply called with requestID, directory, and 'reject'
      expect(postReply).toHaveBeenCalledWith('req-abc', '/workspace/owner/repo', 'reject')
    })

    it('does NOT register in the approval registry (no Discord transport behavior)', () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const req = makePermissionRequest()
      const factory = createWebAutoDenyApproval()
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — registry.register is NOT called (no Discord transport)
      expect(ctx.approvalRegistry.register).not.toHaveBeenCalled()
    })

    it('does NOT throw when the reply POST fails (fire-and-forget, best-effort)', async () => {
      // #given — postReply rejects
      const postReply = vi.fn(async () => {
        throw new Error('network error')
      })
      const postReplyFactory = vi.fn((_sessionID: string) => postReply)
      const ctx = makeApprovalTransportContext({postReplyFactory})
      const req = makePermissionRequest()
      const factory = createWebAutoDenyApproval()
      const onPending = factory(ctx)

      // #when / #then — no throw, even when the reply POST fails
      expect(() => onPending(req)).not.toThrow()

      // Allow the fire-and-forget to settle (and swallow the error)
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    it('handles multiple permission requests independently', async () => {
      // #given
      const postReply = vi.fn(async () => ({ok: true as const}))
      const postReplyFactory = vi.fn((_sessionID: string) => postReply)
      const ctx = makeApprovalTransportContext({postReplyFactory})
      const factory = createWebAutoDenyApproval()
      const onPending = factory(ctx)

      // #when — two permission requests
      onPending(makePermissionRequest({requestID: 'req-1', sessionID: 'sess-1'}))
      onPending(makePermissionRequest({requestID: 'req-2', sessionID: 'sess-2'}))

      await new Promise(resolve => setTimeout(resolve, 0))

      // #then — both are denied
      expect(postReplyFactory).toHaveBeenCalledTimes(2)
      expect(postReply).toHaveBeenCalledTimes(2)
      expect(postReply).toHaveBeenCalledWith('req-1', ctx.directory, 'reject')
      expect(postReply).toHaveBeenCalledWith('req-2', ctx.directory, 'reject')
    })
  })

  describe('factory shape', () => {
    it('returns a function (createApprovalOnPending) that returns a callback (onPending)', () => {
      // #given
      const factory = createWebAutoDenyApproval()

      // #when
      const ctx = makeApprovalTransportContext()
      const onPending = factory(ctx)

      // #then — both are functions
      expect(typeof factory).toBe('function')
      expect(typeof onPending).toBe('function')
    })
  })
})
