/**
 * projection.test.ts — Tests for the waiting-status overlay.
 *
 * Covers:
 * - scopeIdFor: thread_id for discord, run_id for non-discord.
 * - overlayWaitingStatus: precedence (approval over question) and the running-only gate.
 * - Composition: the keyed redaction-bridge base (projectRunStatusWithKey) plus the overlay —
 *   the sequence the SSE manager runs — for each phase, scope and denied repo.
 *
 * The base projection's closed-DTO, key and fail-closed behavior is covered in
 * redaction/surface-gate.test.ts.
 *
 * BDD comments: #given / #when / #then.
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorRunStatus, OperatorWebStatus} from '../../operator-contract/index.js'
import type {WaitingPredicates} from './projection.js'

import {describe, expect, it} from 'vitest'

import {projectRunStatusWithKey} from '../../redaction/surface-gate.js'
import {overlayWaitingStatus, scopeIdFor} from './projection.js'

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

function makePredicates(pendingApprovalScopes: readonly string[], pendingQuestionScopes: readonly string[]) {
  return {
    hasPendingApproval: (scopeId: string) => pendingApprovalScopes.includes(scopeId),
    hasPendingQuestion: (scopeId: string) => pendingQuestionScopes.includes(scopeId),
  } satisfies WaitingPredicates
}

const NONE_PENDING = makePredicates([], [])

/**
 * The production sequence: keyed base through the real redaction bridge (stub binding store), then the
 * overlay under the run's scope. Null when the bridge yields no status.
 */
async function projectAndOverlay(
  runState: RunState,
  predicates: WaitingPredicates,
  options: {readonly denied?: boolean} = {},
): Promise<OperatorRunStatus | null> {
  const projection = await projectRunStatusWithKey(runState, {
    nowMs: BASE_NOW_MS,
    staleThresholdMs: STALE_THRESHOLD_MS,
    bindingsLookup: {getBindingByRepo: async () => ({success: true, data: {databaseId: 1, nodeId: 'R_1'}})},
    isRepoDenied: () => options.denied === true,
  })
  if (projection.kind !== 'projected') {
    return null
  }
  const status = overlayWaitingStatus(projection.status.status, scopeIdFor(runState), predicates)
  return status === projection.status.status ? projection.status : {...projection.status, status}
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
// overlayWaitingStatus — the exported synchronous overlay
// ---------------------------------------------------------------------------

describe('overlayWaitingStatus', () => {
  it('returns waiting_for_approval for running with a pending approval', () => {
    // #given a running status and a pending approval in scope
    const predicates = makePredicates(['scope-1'], [])

    // #when overlaying
    const result = overlayWaitingStatus('running', 'scope-1', predicates)

    // #then approval wins
    expect(result).toBe('waiting_for_approval')
  })

  it('returns waiting_for_question for running with only a pending question', () => {
    // #given a running status and a pending question only
    const predicates = makePredicates([], ['scope-1'])

    // #when overlaying
    const result = overlayWaitingStatus('running', 'scope-1', predicates)

    // #then the question overlay applies
    expect(result).toBe('waiting_for_question')
  })

  it('returns waiting_for_approval when both are pending', () => {
    // #given both families pending
    const predicates = makePredicates(['scope-1'], ['scope-1'])

    // #when overlaying
    const result = overlayWaitingStatus('running', 'scope-1', predicates)

    // #then approval takes precedence
    expect(result).toBe('waiting_for_approval')
  })

  it('returns running when nothing is pending in the scope', () => {
    // #given pending entries only in another scope
    const predicates = makePredicates(['other'], ['other'])

    // #when overlaying
    const result = overlayWaitingStatus('running', 'scope-1', predicates)

    // #then the status is unchanged
    expect(result).toBe('running')
  })

  it.each(['queued', 'blocked', 'succeeded', 'failed', 'cancelled'] as const)(
    'leaves %s unchanged even with pending approval and question',
    status => {
      // #given a non-running status with stale pending entries
      const predicates = makePredicates(['scope-1'], ['scope-1'])

      // #when overlaying
      const result = overlayWaitingStatus(status, 'scope-1', predicates)

      // #then the overlay does not apply
      expect(result).toBe(status)
    },
  )

  it('does not consult the predicates for a non-running status', () => {
    // #given spy predicates
    let calls = 0
    const predicates: WaitingPredicates = {
      hasPendingApproval: () => {
        calls += 1
        return true
      },
      hasPendingQuestion: () => {
        calls += 1
        return true
      },
    }

    // #when overlaying a terminal status
    overlayWaitingStatus('succeeded', 'scope-1', predicates)

    // #then neither registry was read
    expect(calls).toBe(0)
  })

  it('passes the scope id through to both predicates', () => {
    // #given predicates that record the scopes they receive
    const seen: string[] = []
    const predicates: WaitingPredicates = {
      hasPendingApproval: scopeId => {
        seen.push(`a:${scopeId}`)
        return false
      },
      hasPendingQuestion: scopeId => {
        seen.push(`q:${scopeId}`)
        return false
      },
    }

    // #when overlaying a running status
    overlayWaitingStatus('running', 'scope-9', predicates)

    // #then approval is read first, then question, both with the scope
    expect(seen).toEqual(['a:scope-9', 'q:scope-9'])
  })

  it('composes with scopeIdFor: discord keys on thread_id, web on run_id', () => {
    // #given pending entries keyed by thread and by run id
    const predicates = makePredicates(['thread-d'], ['run-w'])
    const discord = makeRunState({surface: 'discord', thread_id: 'thread-d', run_id: 'run-d'})
    const web = makeRunState({surface: 'web', thread_id: 'thread-w', run_id: 'run-w'})

    // #when overlaying each run under its own scope
    const discordStatus = overlayWaitingStatus('running', scopeIdFor(discord), predicates)
    const webStatus = overlayWaitingStatus('running', scopeIdFor(web), predicates)

    // #then each run sees only its own scope's entries
    expect(discordStatus).toBe('waiting_for_approval')
    expect(webStatus).toBe('waiting_for_question')
  })
})

// ---------------------------------------------------------------------------
// Keyed base + overlay composition
// ---------------------------------------------------------------------------

describe('keyed base + overlay — phase → status mapping', () => {
  const phases: {phase: RunState['phase']; expectedStatus: OperatorWebStatus}[] = [
    {phase: 'PENDING', expectedStatus: 'queued'},
    {phase: 'ACKNOWLEDGED', expectedStatus: 'running'},
    {phase: 'EXECUTING', expectedStatus: 'running'},
    {phase: 'COMPLETED', expectedStatus: 'succeeded'},
    {phase: 'FAILED', expectedStatus: 'failed'},
    {phase: 'CANCELLED', expectedStatus: 'cancelled'},
  ]

  for (const {phase, expectedStatus} of phases) {
    it(`maps ${phase} → ${expectedStatus} with nothing pending`, async () => {
      // #when projecting a run in the phase
      const result = await projectAndOverlay(makeRunState({phase}), NONE_PENDING)

      // #then the status is the base status, never blocked
      expect(result?.status).toBe(expectedStatus)
      expect(result?.status).not.toBe('blocked')
    })
  }
})

describe('keyed base + overlay — waiting overlay', () => {
  it('overlays a running web run to waiting_for_approval under its run id', async () => {
    // #when a running github run has a pending approval under its run id
    const result = await projectAndOverlay(makeRunState(), makePredicates(['run-001'], []))

    // #then it waits for approval
    expect(result?.status).toBe('waiting_for_approval')
  })

  it('overlays a running discord run under its thread id, not its run id', async () => {
    // #given a discord run with a pending approval keyed by thread and a pending question keyed by run id
    const runState = makeRunState({surface: 'discord', thread_id: 'thread-d', run_id: 'run-d'})

    // #when projecting
    const result = await projectAndOverlay(runState, makePredicates(['thread-d'], ['run-d']))

    // #then only the thread-keyed approval counts
    expect(result?.status).toBe('waiting_for_approval')
  })

  it('overlays waiting_for_question when only a question is pending', async () => {
    // #when only a question is pending for the scope
    const result = await projectAndOverlay(makeRunState(), makePredicates([], ['run-001']))

    // #then it waits for the question
    expect(result?.status).toBe('waiting_for_question')
  })

  it('shows waiting_for_approval while an approval and a question are both pending', async () => {
    // #when both families are pending
    const result = await projectAndOverlay(makeRunState(), makePredicates(['run-001'], ['run-001']))

    // #then approval takes precedence
    expect(result?.status).toBe('waiting_for_approval')
  })

  it('moves approval → question → running as each pending item settles', async () => {
    // #given mutable pending state for both families
    let approvalPending = true
    let questionPending = true
    const predicates: WaitingPredicates = {
      hasPendingApproval: () => approvalPending,
      hasPendingQuestion: () => questionPending,
    }

    // #when / #then the status follows the precedence as items settle
    expect((await projectAndOverlay(makeRunState(), predicates))?.status).toBe('waiting_for_approval')
    approvalPending = false
    expect((await projectAndOverlay(makeRunState(), predicates))?.status).toBe('waiting_for_question')
    questionPending = false
    expect((await projectAndOverlay(makeRunState(), predicates))?.status).toBe('running')
  })

  it('stays running with nothing pending in the scope', async () => {
    // #when pending entries exist only for another scope
    const result = await projectAndOverlay(makeRunState(), makePredicates(['other'], ['other']))

    // #then the status is unchanged
    expect(result?.status).toBe('running')
  })

  it.each([
    ['succeeded', 'COMPLETED'],
    ['failed', 'FAILED'],
    ['cancelled', 'CANCELLED'],
    ['queued', 'PENDING'],
  ] as const)('does not overlay a %s status even with stale pending entries', async (status, phase) => {
    // #when a non-running run has pending entries in both families
    const result = await projectAndOverlay(makeRunState({phase}), makePredicates(['run-001'], ['run-001']))

    // #then the base status is preserved
    expect(result?.status).toBe(status)
  })

  it('keeps checkout fields through the overlay', async () => {
    // #given a running run with checkout provenance
    const provenance = {
      kind: 'observed',
      observation: {
        head: {kind: 'attached', branch: 'main', sha: 'a'.repeat(40)},
        worktree: {kind: 'clean'},
        operationInProgress: 'none',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      remote: {kind: 'not-checked'},
    }

    // #when a pending approval overlays it
    const result = await projectAndOverlay(
      makeRunState({details: {checkoutProvenance: provenance}}),
      makePredicates(['run-001'], []),
    )

    // #then the status is overlaid and the provenance is preserved
    expect(result?.status).toBe('waiting_for_approval')
    expect(result?.checkoutProvenance).toEqual(provenance)
  })

  it('round-trips waiting_for_question through JSON as a valid OperatorWebStatus', async () => {
    // #given a projected waiting_for_question status
    const result = await projectAndOverlay(makeRunState(), makePredicates([], ['run-001']))

    // #when serialized and parsed as an SSE status frame would be
    const parsed = JSON.parse(JSON.stringify(result)) as OperatorRunStatus
    const allowed: readonly OperatorWebStatus[] = [
      'queued',
      'blocked',
      'running',
      'waiting_for_approval',
      'waiting_for_question',
      'succeeded',
      'failed',
      'cancelled',
    ]

    // #then the status survives and is in the contract set
    expect(parsed.status).toBe('waiting_for_question')
    expect(allowed).toContain(parsed.status)
  })
})

describe('keyed base + overlay — denied repo', () => {
  it('yields nothing and never consults the registries', async () => {
    // #given a denied repository and spy predicates
    let consulted = false
    const predicates: WaitingPredicates = {
      hasPendingApproval: () => {
        consulted = true
        return true
      },
      hasPendingQuestion: () => {
        consulted = true
        return true
      },
    }

    // #when projecting
    const result = await projectAndOverlay(makeRunState(), predicates, {denied: true})

    // #then no status is produced and the registries were not read
    expect(result).toBeNull()
    expect(consulted).toBe(false)
  })
})
