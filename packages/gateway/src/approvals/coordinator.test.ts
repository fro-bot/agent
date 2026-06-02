/**
 * Tests for the permission approval coordinator.
 *
 * Convention: `as unknown as <Type>` for test doubles is permitted per gateway
 * test pattern. No real SDK client or Discord client is constructed here.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionReply, PermissionRequest, SettlementReason} from './coordinator.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createPermissionCoordinator, parsePermissionReply, parsePermissionRequest} from './coordinator.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestID: 'per_1',
    sessionID: 'ses_1',
    permission: 'external_directory',
    patterns: ['/tmp/x/*'],
    title: 'Access outside workspace: /tmp/x/secret.txt',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parsePermissionRequest', () => {
  it('parses a well-formed permission.asked payload', () => {
    // #given a real-shaped properties payload (probe 4367)
    const payload = {
      id: 'per_e871',
      sessionID: 'ses_178e',
      permission: 'external_directory',
      patterns: ['/tmp/oc-iso-outside/*'],
      metadata: {filepath: '/tmp/oc-iso-outside/secret.txt', parentDir: '/tmp/oc-iso-outside'},
    }
    // #when parsed
    const result = parsePermissionRequest(payload)
    // #then all fields map and the title is redaction-safe + descriptive
    expect(result).not.toBeNull()
    expect(result?.requestID).toBe('per_e871')
    expect(result?.sessionID).toBe('ses_178e')
    expect(result?.permission).toBe('external_directory')
    expect(result?.patterns).toEqual(['/tmp/oc-iso-outside/*'])
    expect(result?.title).toContain('/tmp/oc-iso-outside/secret.txt')
  })

  it('returns null when requestID (id) is missing', () => {
    const result = parsePermissionRequest({sessionID: 'ses_1', permission: 'bash'})
    expect(result).toBeNull()
  })

  it('returns null when sessionID is missing', () => {
    const result = parsePermissionRequest({id: 'per_1', permission: 'bash'})
    expect(result).toBeNull()
  })

  it('falls back to a safe title when metadata/patterns are absent', () => {
    // #given a request with an unknown gate and no metadata
    const result = parsePermissionRequest({id: 'per_1', sessionID: 'ses_1', permission: 'webfetch'})
    // #then it does not throw and yields a bare-category title
    expect(result?.permission).toBe('webfetch')
    expect(result?.patterns).toEqual([])
    expect(result?.title).toBe('webfetch')
  })

  it('defaults permission to "unknown" when the field is absent', () => {
    const result = parsePermissionRequest({id: 'per_1', sessionID: 'ses_1'})
    expect(result?.permission).toBe('unknown')
  })

  it('builds a command title for the bash gate', () => {
    const result = parsePermissionRequest({
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      metadata: {command: 'rm -rf /tmp/x'},
    })
    expect(result?.title).toBe('Run command: rm -rf /tmp/x')
  })
})

describe('parsePermissionReply', () => {
  it('parses a well-formed permission.replied payload', () => {
    const result = parsePermissionReply({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
    expect(result).toEqual({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
  })

  it.each(['once', 'always', 'reject'] as const)('accepts the "%s" reply verb', verb => {
    const result = parsePermissionReply({sessionID: 'ses_1', requestID: 'per_1', reply: verb})
    expect(result?.reply).toBe(verb)
  })

  it('returns null for an out-of-allowlist reply verb', () => {
    // #given a hostile/invalid verb (the action enum, not OpenCode's)
    const result = parsePermissionReply({sessionID: 'ses_1', requestID: 'per_1', reply: 'allow'})
    // #then it is rejected — only once|always|reject are valid
    expect(result).toBeNull()
  })

  it('returns null when requestID is missing', () => {
    const result = parsePermissionReply({sessionID: 'ses_1', reply: 'once'})
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Coordinator — settlement
// ---------------------------------------------------------------------------

describe('createPermissionCoordinator', () => {
  it('settles a pending request with "once" on permission.replied', async () => {
    // #given a registered request
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const request = makeRequest()
    const promise = coordinator.onPermissionAsked(request)
    expect(coordinator.pending()).toEqual(['per_1'])
    // #when an authoritative reply arrives
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
    // #then the promise resolves with the reply and the entry is no longer pending
    await expect(promise).resolves.toBe('once')
    expect(coordinator.pending()).toEqual([])
  })

  it('settles with "reject" on a reject reply', async () => {
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const promise = coordinator.onPermissionAsked(makeRequest())
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'reject'})
    await expect(promise).resolves.toBe('reject')
  })

  it('cascade-rejects sibling open requests in the same session on reject', async () => {
    // #given two open requests in the same session and one in another
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const a = coordinator.onPermissionAsked(makeRequest({requestID: 'per_a', sessionID: 'ses_1'}))
    const b = coordinator.onPermissionAsked(makeRequest({requestID: 'per_b', sessionID: 'ses_1'}))
    const other = coordinator.onPermissionAsked(makeRequest({requestID: 'per_c', sessionID: 'ses_2'}))
    // #when one of the same-session requests is rejected
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_a', reply: 'reject'})
    // #then both same-session requests settle reject; the other session is untouched
    await expect(a).resolves.toBe('reject')
    await expect(b).resolves.toBe('reject')
    expect(coordinator.pending()).toEqual(['per_c'])
    coordinator.onPermissionReplied({sessionID: 'ses_2', requestID: 'per_c', reply: 'once'})
    await expect(other).resolves.toBe('once')
  })

  it('does NOT cascade siblings on an "once" reply', async () => {
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const a = coordinator.onPermissionAsked(makeRequest({requestID: 'per_a', sessionID: 'ses_1'}))
    // eslint-disable-next-line no-void
    void coordinator.onPermissionAsked(makeRequest({requestID: 'per_b', sessionID: 'ses_1'}))
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_a', reply: 'once'})
    await expect(a).resolves.toBe('once')
    // #then the sibling remains open
    expect(coordinator.pending()).toEqual(['per_b'])
  })

  it('is a no-op for a reply to an unknown requestID', () => {
    const logger = makeLogger()
    const coordinator = createPermissionCoordinator({logger})
    // #when replying to something never registered
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'ghost', reply: 'once'})
    // #then nothing throws and nothing is pending
    expect(coordinator.pending()).toEqual([])
  })

  it('is a no-op for a duplicate reply to an already-settled request', async () => {
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const promise = coordinator.onPermissionAsked(makeRequest())
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
    await expect(promise).resolves.toBe('once')
    // #when a second reply arrives for the same id — must not throw or double-settle
    expect(() =>
      coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'reject'}),
    ).not.toThrow()
  })

  it('tracks N concurrent independent requests', async () => {
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const a = coordinator.onPermissionAsked(makeRequest({requestID: 'per_a', sessionID: 'ses_1'}))
    const b = coordinator.onPermissionAsked(makeRequest({requestID: 'per_b', sessionID: 'ses_2'}))
    expect(coordinator.pending()).toEqual(['per_a', 'per_b'])
    coordinator.onPermissionReplied({sessionID: 'ses_2', requestID: 'per_b', reply: 'once'})
    await expect(b).resolves.toBe('once')
    expect(coordinator.pending()).toEqual(['per_a'])
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_a', reply: 'reject'})
    await expect(a).resolves.toBe('reject')
  })

  it('reuses the pending promise for a duplicate permission.asked', async () => {
    // #given the same requestID asked twice while open
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const first = coordinator.onPermissionAsked(makeRequest())
    const second = coordinator.onPermissionAsked(makeRequest())
    // #then only one entry is pending
    expect(coordinator.pending()).toEqual(['per_1'])
    // #when settled, BOTH awaiters resolve
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
    await expect(first).resolves.toBe('once')
    await expect(second).resolves.toBe('once')
  })

  // ── callbacks ──────────────────────────────────────────────────────────────

  it('invokes onPending when a request registers and onSettled when it settles', async () => {
    const onPending = vi.fn()
    const settled: [string, PermissionReply, SettlementReason][] = []
    const coordinator = createPermissionCoordinator({
      logger: makeLogger(),
      onPending,
      onSettled: (id, reply, reason) => settled.push([id, reply, reason]),
    })
    const promise = coordinator.onPermissionAsked(makeRequest())
    expect(onPending).toHaveBeenCalledOnce()
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
    await promise
    expect(settled).toEqual([['per_1', 'once', 'replied']])
  })

  it('reports "cascade" reason for siblings settled by a reject', async () => {
    const settled: [string, PermissionReply, SettlementReason][] = []
    const coordinator = createPermissionCoordinator({
      logger: makeLogger(),
      onSettled: (id, reply, reason) => settled.push([id, reply, reason]),
    })
    // eslint-disable-next-line no-void
    void coordinator.onPermissionAsked(makeRequest({requestID: 'per_a', sessionID: 'ses_1'}))
    // eslint-disable-next-line no-void
    void coordinator.onPermissionAsked(makeRequest({requestID: 'per_b', sessionID: 'ses_1'}))
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_a', reply: 'reject'})
    await Promise.resolve()
    expect(settled).toContainEqual(['per_a', 'reject', 'replied'])
    expect(settled).toContainEqual(['per_b', 'reject', 'cascade'])
  })

  it('does not let a throwing onPending callback break registration', () => {
    const logger = makeLogger()
    const coordinator = createPermissionCoordinator({
      logger,
      onPending: () => {
        throw new Error('render failed')
      },
    })
    expect(async () => coordinator.onPermissionAsked(makeRequest())).not.toThrow()
    expect(coordinator.pending()).toEqual(['per_1'])
    expect(logger.error).toHaveBeenCalled()
  })

  // ── dispose ──────────────────────────────────────────────────────────────

  it('fail-closes all open requests on dispose', async () => {
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const a = coordinator.onPermissionAsked(makeRequest({requestID: 'per_a', sessionID: 'ses_1'}))
    const b = coordinator.onPermissionAsked(makeRequest({requestID: 'per_b', sessionID: 'ses_2'}))
    coordinator.dispose('run teardown')
    await expect(a).resolves.toBe('reject')
    await expect(b).resolves.toBe('reject')
    expect(coordinator.pending()).toEqual([])
  })

  // ── deadline (fake timers) ───────────────────────────────────────────────

  describe('with a per-request deadline', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('fail-closes to reject when the deadline expires', async () => {
      const coordinator = createPermissionCoordinator({logger: makeLogger(), deadlineMs: 60_000})
      const promise = coordinator.onPermissionAsked(makeRequest())
      // #when the deadline elapses with no reply
      await vi.advanceTimersByTimeAsync(60_000)
      // #then the entry fail-closes to reject
      await expect(promise).resolves.toBe('reject')
      expect(coordinator.pending()).toEqual([])
    })

    it('a reply before the deadline wins and clears the timer', async () => {
      const onSettled = vi.fn()
      const coordinator = createPermissionCoordinator({logger: makeLogger(), deadlineMs: 60_000, onSettled})
      const promise = coordinator.onPermissionAsked(makeRequest())
      coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
      await expect(promise).resolves.toBe('once')
      // #when the deadline would have fired — no second settlement occurs
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onSettled).toHaveBeenCalledTimes(1)
    })
  })
})
