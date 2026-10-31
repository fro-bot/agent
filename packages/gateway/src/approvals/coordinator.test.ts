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
import {createRunGrants, scopeAlwaysToRun} from './run-grants.js'

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
    alwaysPatterns: [],
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

  it('reads the patterns an always reply would save: `always` on the wire (V1, and V2 mapped to the same shape)', () => {
    const result = parsePermissionRequest({
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['rm /tmp/a'],
      always: ['rm *', 7],
    })
    expect(result?.alwaysPatterns).toEqual(['rm *'])
  })

  it('leaves alwaysPatterns empty when the ask carried none', () => {
    expect(parsePermissionRequest({id: 'per_1', sessionID: 'ses_1', permission: 'bash'})?.alwaysPatterns).toEqual([])
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
// parsePermissionRequest — command/filepath fields
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

// ---------------------------------------------------------------------------
// Run-local grants
// ---------------------------------------------------------------------------

/* eslint-disable no-void */
const RM_ASK = {
  permission: 'bash',
  patterns: ['rm /tmp/a'],
  alwaysPatterns: ['rm *'],
  title: 'Run command: rm /tmp/a',
  command: 'rm /tmp/a',
} as const

function makeRun(runId = 'run_b', replyResult: {ok: boolean} = {ok: true}) {
  const logger = makeLogger()
  const grants = createRunGrants({logger, runId})
  const upstream = vi.fn(async (_requestID: string, _directory: string, _decision: PermissionReply) => replyResult)
  const onPending = vi.fn()
  const answer = vi.fn(async (request: PermissionRequest, decision: 'once' | 'reject') =>
    upstream(request.requestID, '/d', decision),
  )
  const coordinator = createPermissionCoordinator({logger, onPending, runGrants: {grants, runId, answer}})
  coordinator.addOwnedSession('ses_root')
  // The operator surface posts through the scoped factory, as run.ts wires it.
  const operatorPost = scopeAlwaysToRun(
    () => async (requestID, directory, decision) => upstream(requestID, directory, decision),
    grants,
  )('ses_root')
  return {logger, grants, upstream, onPending, answer, coordinator, operatorPost}
}

async function operatorAlways(run: ReturnType<typeof makeRun>, requestID = 'per_1'): Promise<void> {
  void run.coordinator.onPermissionAsked(makeRequest({requestID, sessionID: 'ses_root', ...RM_ASK}))
  await run.operatorPost(requestID, '/d', 'always')
  run.upstream.mockClear()
  run.onPending.mockClear()
}

describe('createPermissionCoordinator — run-local grants', () => {
  it('auto-answers a later matching ask once, with no approval UI, and logs no command text', async () => {
    // #given the operator picked Always on `rm /tmp/a`
    const run = makeRun()
    await operatorAlways(run)

    // #when a later rm asks in the same run
    const result = await run.coordinator.onPermissionAsked(
      makeRequest({
        requestID: 'per_2',
        sessionID: 'ses_root',
        ...RM_ASK,
        patterns: ['rm -rf /tmp/b'],
        command: 'rm -rf /tmp/b',
      }),
    )

    // #then it is answered once upstream, shows nothing, and the log carries the run id, action and marker only
    expect(result).toBe('once')
    expect(run.upstream).toHaveBeenCalledTimes(1)
    expect(run.upstream).toHaveBeenCalledWith('per_2', '/d', 'once')
    expect(run.onPending).not.toHaveBeenCalled()
    expect(run.logger.info).toHaveBeenCalledWith(
      {runId: 'run_b', permission: 'bash', auto: 'run-grant'},
      expect.any(String),
    )
    expect(JSON.stringify(vi.mocked(run.logger.info).mock.calls)).not.toContain('rm -rf /tmp/b')
  })

  it('covers a session the run owns through adoption (an owned child)', async () => {
    const run = makeRun()
    await operatorAlways(run)
    run.coordinator.addOwnedSession('ses_child')

    const result = await run.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_2', sessionID: 'ses_child', ...RM_ASK, patterns: ['rm /tmp/c']}),
    )

    expect(result).toBe('once')
    expect(run.onPending).not.toHaveBeenCalled()
  })

  it('does not cover a session the run does not own', async () => {
    const run = makeRun()
    await operatorAlways(run)

    void run.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_2', sessionID: 'ses_stranger', ...RM_ASK, patterns: ['rm /tmp/c']}),
    )

    expect(run.upstream).not.toHaveBeenCalled()
    expect(run.onPending).toHaveBeenCalledTimes(1)
  })

  it('still asks when only part of the request matches a grant', async () => {
    const run = makeRun()
    await operatorAlways(run)

    void run.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_2', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/c', 'curl http://x']}),
    )

    expect(run.upstream).not.toHaveBeenCalled()
    expect(run.onPending).toHaveBeenCalledTimes(1)
  })

  it.each(['dispose', 'drop'] as const)('stops auto-answering once the run has started ending (%s)', async how => {
    // #given a grant in force
    const run = makeRun()
    await operatorAlways(run)

    // #when the run starts ending
    if (how === 'dispose') run.coordinator.dispose('run ended')
    else run.grants.drop()

    // #then a late ask follows the operator path (dispose rejects it later) and nothing is auto-answered
    void run.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_late', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/z']}),
    )
    expect(run.upstream).not.toHaveBeenCalled()
    expect(run.onPending).toHaveBeenCalledTimes(1)
  })

  it('drops the grants on dispose', async () => {
    const run = makeRun()
    await operatorAlways(run)

    run.coordinator.dispose('run ended')

    expect(run.grants.isDropped()).toBe(true)
  })

  it('does not apply one run’s grant to another run', async () => {
    // #given an Always in run B, and a second run C
    const runB = makeRun('run_b')
    const runC = makeRun('run_c')
    await operatorAlways(runB)

    // #when run C asks for the same thing
    void runC.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_c', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/a']}),
    )

    // #then it goes to its own operator
    expect(runC.upstream).not.toHaveBeenCalled()
    expect(runC.onPending).toHaveBeenCalledTimes(1)
  })

  it('does not answer an ask that arrives during the operator’s in-flight Always, and answers each ask exactly once', async () => {
    // #given an Always reply that has not landed yet
    const logger = makeLogger()
    const grants = createRunGrants({logger, runId: 'run_b'})
    const replies = new Map<string, string[]>()
    const record = (requestID: string, decision: string) => {
      replies.set(requestID, [...(replies.get(requestID) ?? []), decision])
    }
    let landOperatorReply: () => void = () => {}
    const onPending = vi.fn()
    const coordinator = createPermissionCoordinator({
      logger,
      onPending,
      runGrants: {
        grants,
        runId: 'run_b',
        answer: async (request, decision) => {
          record(request.requestID, decision)
          return {ok: true}
        },
      },
    })
    coordinator.addOwnedSession('ses_root')
    const operatorPost = scopeAlwaysToRun(
      () => async (requestID, _directory, decision) =>
        new Promise<{ok: boolean}>(resolve => {
          landOperatorReply = () => {
            record(requestID, decision === 'always' ? 'once' : decision)
            resolve({ok: true})
          }
        }),
      grants,
    )('ses_root')
    void coordinator.onPermissionAsked(makeRequest({requestID: 'per_1', sessionID: 'ses_root', ...RM_ASK}))
    const inFlight = operatorPost('per_1', '/d', 'always')

    // #when a matching ask arrives before it lands
    void coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_2', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/b']}),
    )

    // #then it is not auto-answered: it waits for the operator like any ask
    expect(replies.has('per_2')).toBe(false)
    expect(onPending).toHaveBeenCalledTimes(2)

    // #when the reply lands, a third ask is covered and answered once
    landOperatorReply()
    await inFlight
    await coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_3', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/c']}),
    )

    // #then no request got more than one reply
    expect(replies.get('per_1')).toEqual(['once'])
    expect(replies.get('per_3')).toEqual(['once'])
    expect([...replies.values()].every(decisions => decisions.length === 1)).toBe(true)
  })

  it('sends one reply for a duplicate ask that arrives while its auto-answer is in flight', async () => {
    // #given an auto-answer whose reply call is slow
    const run = makeRun()
    await operatorAlways(run)
    let land: () => void = () => {}
    run.answer.mockImplementationOnce(
      async () =>
        new Promise<{ok: boolean}>(resolve => {
          land = () => resolve({ok: true})
        }),
    )
    const ask = makeRequest({requestID: 'per_2', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/b']})

    // #when the same ask is delivered twice
    const first = run.coordinator.onPermissionAsked(ask)
    const second = run.coordinator.onPermissionAsked(ask)
    land()

    // #then it was replied to once
    await expect(first).resolves.toBe('once')
    await expect(second).resolves.toBe('once')
    expect(run.answer).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to the operator when the permission.replied echo beat the reply call', async () => {
    const run = makeRun()
    await operatorAlways(run)
    run.answer.mockImplementationOnce(async () => {
      run.coordinator.onPermissionReplied({requestID: 'per_2', sessionID: 'ses_root', reply: 'once'})
      return {ok: false}
    })

    const result = await run.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_2', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/b']}),
    )

    expect(result).toBe('once')
    expect(run.onPending).not.toHaveBeenCalled()
  })

  it('falls back to the operator when the auto-answer cannot be delivered', async () => {
    const run = makeRun()
    await operatorAlways(run)
    run.answer.mockResolvedValueOnce({ok: false})

    void run.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_2', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/b']}),
    )
    await vi.waitFor(() => expect(run.onPending).toHaveBeenCalledTimes(1))

    expect(run.coordinator.pending()).toContain('per_2')
  })

  it('rejects instead when the auto-answer cannot be delivered and the run is ending', async () => {
    const run = makeRun()
    await operatorAlways(run)
    let fail: () => void = () => {}
    run.answer.mockImplementationOnce(
      async () =>
        new Promise<{ok: boolean}>(resolve => {
          fail = () => resolve({ok: false})
        }),
    )
    const result = run.coordinator.onPermissionAsked(
      makeRequest({requestID: 'per_2', sessionID: 'ses_root', ...RM_ASK, patterns: ['rm /tmp/b']}),
    )

    // #when the run ends while the auto-answer is in flight, and then it fails
    run.coordinator.dispose('run ended')
    fail()

    // #then the operator path is not reopened; the ask is rejected
    await expect(result).resolves.toBe('reject')
    expect(run.answer).toHaveBeenLastCalledWith(expect.objectContaining({requestID: 'per_2'}), 'reject')
    expect(run.onPending).not.toHaveBeenCalled()
  })

  it('asks the operator as before when no run grants are wired', () => {
    const onPending = vi.fn()
    const coordinator = createPermissionCoordinator({logger: makeLogger(), onPending})
    coordinator.addOwnedSession('ses_root')

    void coordinator.onPermissionAsked(makeRequest({sessionID: 'ses_root', ...RM_ASK}))

    expect(onPending).toHaveBeenCalledTimes(1)
  })
})
/* eslint-enable no-void */
