/**
 * Tests for the web approval transport.
 *
 * Verifies that:
 * - `onPending(req)` registers the entry in the approval registry with
 *   `approvalScopeId = ctx.runId` (register-before-fan-out).
 * - `onPending(req)` calls `observeApproval` with the bounded frame data.
 * - `observeApproval` throwing is fail-soft: registration still happened,
 *   no throw escapes `onPending`, a warn is logged.
 * - Oversized command/filepath values are bounded before the frame is built.
 * - The transport does NOT call any visible-output tracking methods.
 */

import type {PermissionRequest} from '../../approvals/coordinator.js'
import type {ApprovalRegistry} from '../../approvals/registry.js'
import type {ApprovalTransportContext} from '../../execute/launch-types.js'
import type {ApprovalFrameData} from '../../operator-contract/approval-frame.js'
import type {WebApprovalTransportDeps} from './web-approval.js'
import {describe, expect, it, vi} from 'vitest'
import {APPROVAL_DETAIL_MAX_LENGTH} from '../../approvals/approval-detail.js'
import {createWebApprovalOnPending} from './web-approval.js'

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

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
    describePendingForScope: vi.fn(() => []),
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

function makeDeps(overrides?: Partial<WebApprovalTransportDeps>): WebApprovalTransportDeps {
  return {
    observeApproval: vi.fn(),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path: register + observe
// ---------------------------------------------------------------------------

describe('createWebApprovalOnPending', () => {
  describe('happy path: register-before-fan-out', () => {
    it('registers the entry in the approval registry with approvalScopeId = ctx.runId', () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest({requestID: 'req-abc', sessionID: 'sess-xyz'})
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — registry.register called with approvalScopeId = ctx.runId
      expect(ctx.approvalRegistry.register).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requestID: 'req-abc',
          sessionID: 'sess-xyz',
          approvalScopeId: 'run-uuid-1234',
          directory: '/workspace/owner/repo',
        }),
      )
    })

    it('calls observeApproval with the bounded frame data (settled: false)', () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest({
        requestID: 'req-abc',
        permission: 'bash',
        command: 'echo hello',
      })
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — observeApproval called with the correct frame data
      expect(deps.observeApproval).toHaveBeenCalledExactlyOnceWith('run-uuid-1234', {
        requestID: 'req-abc',
        permission: 'bash',
        command: 'echo hello',
        settled: false,
      })
    })

    it('register is called BEFORE observeApproval (register-before-fan-out order)', () => {
      // #given
      const callOrder: string[] = []
      const registry = makeApprovalRegistry()
      ;(registry.register as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('register')
      })
      const ctx = makeApprovalTransportContext({approvalRegistry: registry})
      const deps = makeDeps({
        observeApproval: vi.fn(() => {
          callOrder.push('observeApproval')
        }),
      })
      const req = makePermissionRequest()
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — register precedes observeApproval
      expect(callOrder).toStrictEqual(['register', 'observeApproval'])
    })

    it('passes the postReplyFactory-derived postReply to the registry effects', () => {
      // #given
      const postReply = vi.fn(async () => ({ok: true as const}))
      const postReplyFactory = vi.fn((_sessionID: string) => postReply)
      const ctx = makeApprovalTransportContext({postReplyFactory})
      const deps = makeDeps()
      const req = makePermissionRequest({sessionID: 'sess-xyz'})
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — postReplyFactory called with the request's sessionID
      expect(postReplyFactory).toHaveBeenCalledWith('sess-xyz')
      // registry.register received the effects with the postReply closure
      const registerCall = (ctx.approvalRegistry.register as ReturnType<typeof vi.fn>).mock.calls[0]
      const registeredEffects = (registerCall as [{effects: {postReply: unknown}}])[0].effects
      expect(registeredEffects.postReply).toBe(postReply)
    })

    it('includes filepath in the frame when the request has a filepath', () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest({
        permission: 'external_directory',
        filepath: '/some/path/file.ts',
      })
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — filepath present in the frame (open frame, settled: false)
      expect(deps.observeApproval).toHaveBeenCalledWith(
        'run-uuid-1234',
        expect.objectContaining({settled: false, filepath: '/some/path/file.ts'}),
      )
    })

    it('omits command and filepath from the frame when the request has neither', () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest({permission: 'bash'})
      // no command or filepath
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — neither command nor filepath in the frame (open frame, settled: false)
      expect(deps.observeApproval).toHaveBeenCalledWith('run-uuid-1234', expect.objectContaining({settled: false}))
      const capturedFrame = vi.mocked(deps.observeApproval).mock.calls.at(0)?.[1]
      expect(capturedFrame).toBeDefined()
      expect((capturedFrame as Extract<ApprovalFrameData, {settled: false}>).command).toBeUndefined()
      expect((capturedFrame as Extract<ApprovalFrameData, {settled: false}>).filepath).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Edge: fail-soft observeApproval
  // ---------------------------------------------------------------------------

  describe('edge: observeApproval fail-soft', () => {
    it('does NOT throw when observeApproval throws synchronously', () => {
      // #given — observeApproval throws
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps({
        observeApproval: vi.fn(() => {
          throw new Error('SSE fan-out failed')
        }),
      })
      const req = makePermissionRequest()
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when / #then — no throw escapes onPending
      expect(() => onPending(req)).not.toThrow()
    })

    it('still registers in the registry even when observeApproval throws', () => {
      // #given — observeApproval throws
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps({
        observeApproval: vi.fn(() => {
          throw new Error('SSE fan-out failed')
        }),
      })
      const req = makePermissionRequest({requestID: 'req-fail'})
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — registry.register was still called (registration happened before fan-out)
      expect(ctx.approvalRegistry.register).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({requestID: 'req-fail'}),
      )
    })

    it('logs a warn when observeApproval throws', () => {
      // #given — observeApproval throws
      const ctx = makeApprovalTransportContext()
      const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
      const deps = makeDeps({
        observeApproval: vi.fn(() => {
          throw new Error('SSE fan-out failed')
        }),
        logger,
      })
      const req = makePermissionRequest()
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — warn logged
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({runId: 'run-uuid-1234', requestID: 'req-123'}),
        expect.stringContaining('observeApproval threw'),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // Edge: bounding applied to command/filepath
  // ---------------------------------------------------------------------------

  describe('edge: bounding applied to command and filepath', () => {
    it('truncates an oversized command to APPROVAL_DETAIL_MAX_LENGTH in the frame', () => {
      // #given — command exceeds the cap
      const oversizedCommand = 'x'.repeat(APPROVAL_DETAIL_MAX_LENGTH + 100)
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest({command: oversizedCommand})
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — command in the frame is capped (open frame, settled: false)
      expect(deps.observeApproval).toHaveBeenCalledOnce()
      const capturedFrame1 = vi.mocked(deps.observeApproval).mock.calls.at(0)?.[1] as Extract<
        ApprovalFrameData,
        {settled: false}
      >
      expect(capturedFrame1.settled).toBe(false)
      expect(capturedFrame1.command).toBeDefined()
      expect(capturedFrame1.command?.length).toBe(APPROVAL_DETAIL_MAX_LENGTH)
    })

    it('strips control characters from command in the frame', () => {
      // #given — command with embedded control chars
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest({command: 'echo\u0000hello\u001Fworld'})
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — control chars stripped in the frame (open frame, settled: false)
      expect(deps.observeApproval).toHaveBeenCalledWith(
        'run-uuid-1234',
        expect.objectContaining({settled: false, command: 'echohelloworld'}),
      )
    })

    it('omits command from the frame when the bounded result is empty', () => {
      // #given — command is only control chars (strips to empty)
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest({command: '\u0000\u0001\u0002'})
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — command omitted from the frame (empty after bounding, open frame)
      expect(deps.observeApproval).toHaveBeenCalledOnce()
      const capturedFrame2 = vi.mocked(deps.observeApproval).mock.calls.at(0)?.[1] as Extract<
        ApprovalFrameData,
        {settled: false}
      >
      expect(capturedFrame2.settled).toBe(false)
      expect(capturedFrame2.command).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // No visible-output tracking
  // ---------------------------------------------------------------------------

  describe('no visible-output tracking', () => {
    it('does NOT call markVisibleOutputPending or markVisibleOutputSent', () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const req = makePermissionRequest()
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when
      onPending(req)

      // #then — no visible-output tracking calls
      expect(ctx.replySink.markVisibleOutputPending).not.toHaveBeenCalled()
      expect(ctx.replySink.markVisibleOutputSent).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Factory shape
  // ---------------------------------------------------------------------------

  describe('factory shape', () => {
    it('returns a function (createApprovalOnPending) that returns a callback (onPending)', () => {
      // #given
      const deps = makeDeps()
      const factory = createWebApprovalOnPending(deps)

      // #when
      const ctx = makeApprovalTransportContext()
      const onPending = factory(ctx)

      // #then — both are functions
      expect(typeof factory).toBe('function')
      expect(typeof onPending).toBe('function')
    })

    it('handles multiple permission requests independently', () => {
      // #given
      const ctx = makeApprovalTransportContext()
      const deps = makeDeps()
      const factory = createWebApprovalOnPending(deps)
      const onPending = factory(ctx)

      // #when — two permission requests
      onPending(makePermissionRequest({requestID: 'req-1', sessionID: 'sess-1', command: 'echo 1'}))
      onPending(makePermissionRequest({requestID: 'req-2', sessionID: 'sess-2', command: 'echo 2'}))

      // #then — both registered and observed
      expect(ctx.approvalRegistry.register).toHaveBeenCalledTimes(2)
      expect(deps.observeApproval).toHaveBeenCalledTimes(2)
      expect(deps.observeApproval).toHaveBeenNthCalledWith(
        1,
        'run-uuid-1234',
        expect.objectContaining({requestID: 'req-1', command: 'echo 1'}),
      )
      expect(deps.observeApproval).toHaveBeenNthCalledWith(
        2,
        'run-uuid-1234',
        expect.objectContaining({requestID: 'req-2', command: 'echo 2'}),
      )
    })
  })
})
