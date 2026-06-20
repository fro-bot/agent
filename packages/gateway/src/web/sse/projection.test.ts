/**
 * projection.test.ts — Tests for the run-status projection.
 *
 * Covers:
 * - Happy path: each RunPhase maps to the expected base OperatorWebStatus.
 * - Overlay: waiting_for_approval overrides 'running' when hasPendingForScope → true.
 * - Edge: denied/keyless repo (projectRunStatus → null) yields null.
 * - Safety: the closed DTO contains ONLY the contract fields — no details passthrough.
 * - Scope: scopeIdFor returns thread_id for discord, run_id for non-discord.
 *
 * Test seam: projectRunStatus is injected via the deps object so tests can drive
 * it without needing a real binding store or denylist. This avoids the async I/O
 * of the real bridge while still testing the projection logic in full.
 *
 * BDD comments: #given / #when / #then.
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorRunStatus, OperatorWebStatus} from '../../operator-contract/index.js'
import type {ProjectRunObservationDeps} from './projection.js'

import {describe, expect, it} from 'vitest'

import {projectRunObservation, scopeIdFor} from './projection.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_NOW_MS = 2_000_000
const STALE_THRESHOLD_MS = 60_000

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-001',
    surface: 'github',
    thread_id: 'thread-001',
    entity_ref: 'acme/widget#1',
    phase: 'EXECUTING',
    started_at: '2024-01-01T00:00:00.000Z',
    last_heartbeat: new Date(BASE_NOW_MS - 1000).toISOString(),
    holder_id: 'holder-001',
    details: {},
    ...overrides,
  }
}

function makeBaseStatus(overrides: Partial<OperatorRunStatus> = {}): OperatorRunStatus {
  return {
    runId: 'run-001',
    entityRef: 'acme/widget#1',
    surface: 'github',
    phase: 'EXECUTING',
    status: 'running',
    startedAt: '2024-01-01T00:00:00.000Z',
    stale: false,
    ...overrides,
  }
}

/**
 * Build a deps object with a stubbed projectRunStatus that returns the given value.
 * hasPendingForScope defaults to always-false (no pending approval).
 */
function makeDeps(
  baseStatus: OperatorRunStatus | null,
  hasPendingForScope: (scopeId: string) => boolean = () => false,
): ProjectRunObservationDeps {
  return {
    nowMs: BASE_NOW_MS,
    staleThresholdMs: STALE_THRESHOLD_MS,
    bindingsLookup: {getBindingByRepo: async () => ({success: true, data: null})},
    isRepoDenied: () => false,
    hasPendingForScope,
    // Inject a stub so tests don't need a real binding store
    _projectRunStatus: async () => baseStatus,
  }
}

// ---------------------------------------------------------------------------
// scopeIdFor
// ---------------------------------------------------------------------------

describe('scopeIdFor', () => {
  it('returns thread_id for a discord run', () => {
    // #given a discord run with a thread_id
    const runState = makeRunState({surface: 'discord', thread_id: 'thread-discord-42'})

    // #when computing the scope id
    const scopeId = scopeIdFor(runState)

    // #then thread_id is returned
    expect(scopeId).toBe('thread-discord-42')
  })

  it('returns run_id for a github run', () => {
    // #given a github run
    const runState = makeRunState({surface: 'github', run_id: 'run-github-99'})

    // #when computing the scope id
    const scopeId = scopeIdFor(runState)

    // #then run_id is returned
    expect(scopeId).toBe('run-github-99')
  })

  it('returns run_id for a web run (forward-compat for non-discord surfaces)', () => {
    // #given a web run
    const runState = makeRunState({surface: 'web', run_id: 'run-web-77'})

    // #when computing the scope id
    const scopeId = scopeIdFor(runState)

    // #then run_id is returned (web runs use runId scope)
    expect(scopeId).toBe('run-web-77')
  })
})

// ---------------------------------------------------------------------------
// Happy path: RunPhase → base OperatorWebStatus
// ---------------------------------------------------------------------------

describe('projectRunObservation — phase → base status mapping', () => {
  const phases: {phase: RunState['phase']; expectedStatus: OperatorWebStatus}[] = [
    {phase: 'PENDING', expectedStatus: 'queued'},
    {phase: 'ACKNOWLEDGED', expectedStatus: 'running'},
    {phase: 'EXECUTING', expectedStatus: 'running'},
    {phase: 'COMPLETED', expectedStatus: 'succeeded'},
    {phase: 'FAILED', expectedStatus: 'failed'},
    {phase: 'CANCELLED', expectedStatus: 'cancelled'},
  ]

  for (const {phase, expectedStatus} of phases) {
    it(`maps ${phase} → ${expectedStatus}`, async () => {
      // #given a run in the given phase and a base status from the bridge
      const runState = makeRunState({phase})
      const baseStatus = makeBaseStatus({phase, status: expectedStatus})
      const deps = makeDeps(baseStatus)

      // #when projecting
      const result = await projectRunObservation(runState, deps)

      // #then the status matches the expected base
      expect(result).not.toBeNull()
      expect(result?.status).toBe(expectedStatus)
    })
  }
})

// ---------------------------------------------------------------------------
// Overlay: waiting_for_approval
// ---------------------------------------------------------------------------

describe('projectRunObservation — waiting_for_approval overlay', () => {
  it('overrides running → waiting_for_approval when hasPendingForScope is true', async () => {
    // #given a running run whose scope has a pending approval
    const runState = makeRunState({phase: 'EXECUTING', surface: 'github', run_id: 'run-001'})
    const baseStatus = makeBaseStatus({phase: 'EXECUTING', status: 'running'})
    const deps = makeDeps(baseStatus, scopeId => scopeId === 'run-001')

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then status is overridden to waiting_for_approval
    expect(result).not.toBeNull()
    expect(result?.status).toBe('waiting_for_approval')
  })

  it('uses thread_id as scope for discord runs when checking pending approval', async () => {
    // #given a discord run whose thread_id scope has a pending approval
    const runState = makeRunState({surface: 'discord', thread_id: 'thread-discord-42', run_id: 'run-001'})
    const baseStatus = makeBaseStatus({surface: 'discord', status: 'running'})
    // Only the thread_id scope triggers the overlay
    const deps = makeDeps(baseStatus, scopeId => scopeId === 'thread-discord-42')

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then status is overridden to waiting_for_approval (via thread_id scope)
    expect(result).not.toBeNull()
    expect(result?.status).toBe('waiting_for_approval')
  })

  it('does NOT override when hasPendingForScope is false', async () => {
    // #given a running run with no pending approval
    const runState = makeRunState({phase: 'EXECUTING'})
    const baseStatus = makeBaseStatus({phase: 'EXECUTING', status: 'running'})
    const deps = makeDeps(baseStatus, () => false)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then status remains running (no overlay)
    expect(result?.status).toBe('running')
  })

  it('does NOT produce blocked — no source exists in v1', async () => {
    // #given any run state
    const runState = makeRunState()
    const baseStatus = makeBaseStatus()
    const deps = makeDeps(baseStatus, () => false)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then blocked is never produced
    expect(result?.status).not.toBe('blocked')
  })

  it('does NOT override a terminal succeeded status even when hasPendingForScope is true', async () => {
    // #given a run that has already completed (base status = succeeded) but a stale
    // approval entry still reports pending for the scope
    const runState = makeRunState({phase: 'COMPLETED', surface: 'github', run_id: 'run-terminal-1'})
    const baseStatus = makeBaseStatus({phase: 'COMPLETED', status: 'succeeded'})
    // hasPendingForScope returns true — simulates a stale approval entry
    const deps = makeDeps(baseStatus, () => true)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then the terminal status is preserved — overlay does NOT apply
    expect(result).not.toBeNull()
    expect(result?.status).toBe('succeeded')
    expect(result?.status).not.toBe('waiting_for_approval')
  })

  it('does NOT override a terminal failed status even when hasPendingForScope is true', async () => {
    // #given a run that has failed (base status = failed) but a stale approval entry lingers
    const runState = makeRunState({phase: 'FAILED', surface: 'github', run_id: 'run-terminal-2'})
    const baseStatus = makeBaseStatus({phase: 'FAILED', status: 'failed'})
    const deps = makeDeps(baseStatus, () => true)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then the terminal status is preserved
    expect(result).not.toBeNull()
    expect(result?.status).toBe('failed')
    expect(result?.status).not.toBe('waiting_for_approval')
  })

  it('does NOT override a queued status (waiting_for_approval only applies to running)', async () => {
    // #given a run in PENDING phase (queued) with a pending approval scope
    const runState = makeRunState({phase: 'PENDING', surface: 'github', run_id: 'run-queued-1'})
    const baseStatus = makeBaseStatus({phase: 'PENDING', status: 'queued'})
    const deps = makeDeps(baseStatus, () => true)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then queued status is preserved — overlay only applies to running
    expect(result).not.toBeNull()
    expect(result?.status).toBe('queued')
    expect(result?.status).not.toBe('waiting_for_approval')
  })
})

// ---------------------------------------------------------------------------
// Edge: denied / keyless repo → null
// ---------------------------------------------------------------------------

describe('projectRunObservation — denied/keyless repo', () => {
  it('returns null when the bridge returns null (denied repo)', async () => {
    // #given a run whose repo is on the denylist (bridge returns null)
    const runState = makeRunState()
    const deps = makeDeps(null)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then null is returned (contract omission — no record)
    expect(result).toBeNull()
  })

  it('does not call hasPendingForScope when the bridge returns null', async () => {
    // #given a denied run
    const runState = makeRunState()
    let pendingCalled = false
    const deps = makeDeps(null, () => {
      pendingCalled = true
      return true
    })

    // #when projecting
    await projectRunObservation(runState, deps)

    // #then hasPendingForScope was never called (short-circuit on null)
    expect(pendingCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Safety: closed DTO — no details passthrough
// ---------------------------------------------------------------------------

describe('projectRunObservation — closed DTO safety', () => {
  it('output contains ONLY the contract fields — no details passthrough', async () => {
    // #given a run whose details carry sensitive internal data
    const runState = makeRunState({
      details: {
        rawOutput: 'secret tool output',
        workspacePath: '/home/runner/workspace/acme/widget',
        toolArgs: ['--token', 'ghp_supersecret'],
        internalUrl: 'http://internal.corp/api',
        holder_id: 'should-not-leak',
      },
    })
    const baseStatus = makeBaseStatus()
    const deps = makeDeps(baseStatus)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then the result is non-null
    expect(result).not.toBeNull()

    // #then the serialized DTO contains NONE of the sensitive values
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('rawOutput')
    expect(serialized).not.toContain('secret tool output')
    expect(serialized).not.toContain('workspacePath')
    expect(serialized).not.toContain('/home/runner/workspace')
    expect(serialized).not.toContain('toolArgs')
    expect(serialized).not.toContain('ghp_supersecret')
    expect(serialized).not.toContain('internalUrl')
    expect(serialized).not.toContain('http://internal.corp')
    expect(serialized).not.toContain('details')

    // #then the result has EXACTLY the contract fields (structural allowlist proof)
    const contractFields = new Set(['runId', 'entityRef', 'surface', 'phase', 'status', 'startedAt', 'stale'])
    const resultKeys = new Set(Object.keys(result as object))
    expect(resultKeys).toEqual(contractFields)
  })

  it('does not spread runState — holder_id and thread_id are absent from output', async () => {
    // #given a run with holder_id and thread_id
    const runState = makeRunState({holder_id: 'holder-secret', thread_id: 'thread-secret'})
    const baseStatus = makeBaseStatus()
    const deps = makeDeps(baseStatus)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then holder_id and thread_id are not in the output
    expect(result).not.toBeNull()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('holder_id')
    expect(serialized).not.toContain('holder-secret')
    expect(serialized).not.toContain('thread_id')
    expect(serialized).not.toContain('thread-secret')
  })

  it('copies only the explicit OperatorRunStatus fields from the bridge result', async () => {
    // #given a base status with all contract fields populated
    const baseStatus: OperatorRunStatus = {
      runId: 'run-closed-dto',
      entityRef: 'org/repo#5',
      surface: 'github',
      phase: 'COMPLETED',
      status: 'succeeded',
      startedAt: '2024-06-01T12:00:00.000Z',
      stale: false,
    }
    const runState = makeRunState({run_id: 'run-closed-dto', phase: 'COMPLETED'})
    const deps = makeDeps(baseStatus)

    // #when projecting
    const result = await projectRunObservation(runState, deps)

    // #then each contract field is copied exactly
    expect(result?.runId).toBe('run-closed-dto')
    expect(result?.entityRef).toBe('org/repo#5')
    expect(result?.surface).toBe('github')
    expect(result?.phase).toBe('COMPLETED')
    expect(result?.status).toBe('succeeded')
    expect(result?.startedAt).toBe('2024-06-01T12:00:00.000Z')
    expect(result?.stale).toBe(false)
  })
})
