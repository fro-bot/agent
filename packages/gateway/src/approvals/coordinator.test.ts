/**
 * Tests for the permission approval coordinator.
 *
 * Convention: `as unknown as <Type>` for test doubles is permitted per gateway
 * test pattern. No real SDK client or Discord client is constructed here.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionReply, PermissionRequest, SettlementReason} from './coordinator.js'

import {describe, expect, it, vi} from 'vitest'

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

// ---------------------------------------------------------------------------
// parsePermissionRequest — command/filepath fields (Unit 1)
// ---------------------------------------------------------------------------

describe('parsePermissionRequest — command/filepath fields', () => {
  it('populates command for a bash permission.asked with metadata.command', () => {
    // #given a bash gate with metadata.command
    const payload = {
      id: 'per_bash_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: [],
      metadata: {command: 'git status'},
    }
    // #when parsed
    const result = parsePermissionRequest(payload)
    // #then command is populated and filepath is absent
    expect(result).not.toBeNull()
    expect(result?.command).toBe('git status')
    expect(result?.filepath).toBeUndefined()
  })

  it('populates filepath for an external_directory permission.asked with metadata.filepath', () => {
    // #given an external_directory gate with metadata.filepath
    const payload = {
      id: 'per_dir_1',
      sessionID: 'ses_1',
      permission: 'external_directory',
      patterns: ['/tmp/*'],
      metadata: {filepath: '/tmp/secret.txt', parentDir: '/tmp'},
    }
    // #when parsed
    const result = parsePermissionRequest(payload)
    // #then filepath is populated and command is absent
    expect(result).not.toBeNull()
    expect(result?.filepath).toBe('/tmp/secret.txt')
    expect(result?.command).toBeUndefined()
  })

  it('populates filepath for an edit gate with metadata.filepath', () => {
    // #given an edit gate (not bash, not external_directory) with metadata.filepath
    const payload = {
      id: 'per_edit_1',
      sessionID: 'ses_1',
      permission: 'edit',
      patterns: [],
      metadata: {filepath: '/workspace/src/main.ts'},
    }
    const result = parsePermissionRequest(payload)
    expect(result?.filepath).toBe('/workspace/src/main.ts')
    expect(result?.command).toBeUndefined()
  })

  it('leaves both fields undefined when metadata is absent', () => {
    // #given a payload with no metadata at all
    const payload = {id: 'per_1', sessionID: 'ses_1', permission: 'bash'}
    const result = parsePermissionRequest(payload)
    expect(result).not.toBeNull()
    expect(result?.command).toBeUndefined()
    expect(result?.filepath).toBeUndefined()
  })

  it('leaves both fields undefined when metadata has no command or filepath', () => {
    // #given metadata that exists but lacks the relevant keys
    const payload = {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      metadata: {someOtherKey: 'value'},
    }
    const result = parsePermissionRequest(payload)
    expect(result?.command).toBeUndefined()
    expect(result?.filepath).toBeUndefined()
  })

  it('does NOT read command from the prototype chain (prototype-pollution guard)', () => {
    // #given an object whose prototype has a `command` property
    const proto = {command: 'injected-command'}
    const metadata = Object.create(proto) as Record<string, unknown>
    // metadata itself has no own `command` property — only the prototype does
    const payload = {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      metadata,
    }
    // #when parsed
    const result = parsePermissionRequest(payload)
    // #then the prototype-inherited value is NOT read
    expect(result?.command).toBeUndefined()
  })

  it('does NOT read filepath from the prototype chain (prototype-pollution guard)', () => {
    // #given an object whose prototype has a `filepath` property
    const proto = {filepath: '/injected/path'}
    const metadata = Object.create(proto) as Record<string, unknown>
    const payload = {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'external_directory',
      metadata,
    }
    const result = parsePermissionRequest(payload)
    expect(result?.filepath).toBeUndefined()
  })

  it('populates both command and filepath when metadata has both', () => {
    // #given metadata with both keys (unusual but valid)
    const payload = {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      metadata: {command: 'cat /etc/passwd', filepath: '/etc/passwd'},
    }
    const result = parsePermissionRequest(payload)
    expect(result?.command).toBe('cat /etc/passwd')
    expect(result?.filepath).toBe('/etc/passwd')
  })

  it('ignores non-string command values in metadata', () => {
    // #given metadata.command is a number (not a string)
    const payload = {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      metadata: {command: 42},
    }
    const result = parsePermissionRequest(payload)
    // #then the non-string value is not surfaced
    expect(result?.command).toBeUndefined()
  })

  it('ignores non-string filepath values in metadata', () => {
    // #given metadata.filepath is an object
    const payload = {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'external_directory',
      metadata: {filepath: {nested: true}},
    }
    const result = parsePermissionRequest(payload)
    expect(result?.filepath).toBeUndefined()
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

  it('coordinator does NOT cascade siblings — cascade is owned by the registry', async () => {
    // #given two open requests in the same session
    const coordinator = createPermissionCoordinator({logger: makeLogger()})
    const a = coordinator.onPermissionAsked(makeRequest({requestID: 'per_a', sessionID: 'ses_1'}))
    // eslint-disable-next-line no-void
    void coordinator.onPermissionAsked(makeRequest({requestID: 'per_b', sessionID: 'ses_1'}))
    // #when one is rejected
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_a', reply: 'reject'})
    await expect(a).resolves.toBe('reject')
    // #then the sibling remains open in the coordinator's local map (registry owns cascade)
    expect(coordinator.pending()).toEqual(['per_b'])
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

  it('invokes onReplied (new API) when a request is replied', async () => {
    const onReplied = vi.fn()
    const coordinator = createPermissionCoordinator({logger: makeLogger(), onReplied})
    const promise = coordinator.onPermissionAsked(makeRequest())
    coordinator.onPermissionReplied({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
    await promise
    expect(onReplied).toHaveBeenCalledExactlyOnceWith({sessionID: 'ses_1', requestID: 'per_1', reply: 'once'})
  })

  it('invokes onDispose with the collected sessionIDs when dispose is called', () => {
    // #given a coordinator that has seen requests from two sessions
    const onDispose = vi.fn()
    const coordinator = createPermissionCoordinator({logger: makeLogger(), onDispose})
    // eslint-disable-next-line no-void
    void coordinator.onPermissionAsked(makeRequest({requestID: 'per_a', sessionID: 'ses_A'}))
    // eslint-disable-next-line no-void
    void coordinator.onPermissionAsked(makeRequest({requestID: 'per_b', sessionID: 'ses_B'}))
    // #when disposed
    coordinator.dispose('run ended')
    // #then onDispose is called with the set of sessionIDs seen (NOT the reason string)
    expect(onDispose).toHaveBeenCalledOnce()
    const [sessionIDs] = onDispose.mock.calls[0] as [readonly string[]]
    expect(sessionIDs).toHaveLength(2)
    expect(sessionIDs).toContain('ses_A')
    expect(sessionIDs).toContain('ses_B')
  })

  it('onDispose receives empty array when no requests were ever seen', () => {
    // #given a coordinator that never saw any requests
    const onDispose = vi.fn()
    const coordinator = createPermissionCoordinator({logger: makeLogger(), onDispose})
    // #when disposed with no prior requests
    coordinator.dispose('run ended')
    // #then onDispose is called with an empty array
    expect(onDispose).toHaveBeenCalledExactlyOnceWith([])
  })

  it('concurrent-run isolation: disposing run A via coordinator+registry does NOT touch run B entries', async () => {
    // #given a shared registry (program-scoped) with entries for two runs
    const {createApprovalRegistry} = await import('./registry.js')

    const logger = makeLogger()
    const sharedRegistry = createApprovalRegistry({logger})

    // Register run A's entry
    const reqA: PermissionRequest = makeRequest({requestID: 'per_A', sessionID: 'ses_A'})
    sharedRegistry.register({
      requestID: 'per_A',
      sessionID: 'ses_A',
      approvalScopeId: 'chan_1',
      directory: '/ws/a',
      request: reqA,
      effects: {postReply: vi.fn().mockResolvedValue({ok: true})},
    })
    // Register run B's entry (different sessionID, same shared registry)
    const reqB: PermissionRequest = makeRequest({requestID: 'per_B', sessionID: 'ses_B'})
    sharedRegistry.register({
      requestID: 'per_B',
      sessionID: 'ses_B',
      approvalScopeId: 'chan_2',
      directory: '/ws/b',
      request: reqB,
      effects: {postReply: vi.fn().mockResolvedValue({ok: true})},
    })

    expect(sharedRegistry.has('per_A')).toBe(true)
    expect(sharedRegistry.has('per_B')).toBe(true)

    // Build run A's coordinator wired to call disposeRun (the correct fix)
    const coordinatorA = createPermissionCoordinator({
      logger,
      onDispose: sessionIDs => {
        // eslint-disable-next-line no-void
        void Promise.all(sessionIDs.map(async sid => sharedRegistry.disposeRun(sid, 'run ended')))
      },
    })
    // eslint-disable-next-line no-void
    void coordinatorA.onPermissionAsked(reqA) // coordinator sees ses_A

    // #when run A ends and its coordinator disposes
    coordinatorA.dispose('run ended')

    // Allow the async disposeRun to complete
    await new Promise(r => setTimeout(r, 0))

    // #then run A's entry is settled and removed
    expect(sharedRegistry.has('per_A')).toBe(false)
    // #then run B's entry is NOT touched — isolation holds
    expect(sharedRegistry.has('per_B')).toBe(true)

    // Cleanup: disposeAll still settles everything (shutdown semantics)
    await sharedRegistry.disposeAll('gateway shutdown')
    expect(sharedRegistry.has('per_B')).toBe(false)
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
})
