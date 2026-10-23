import type {
  ExecuteRecoveryFailureReason,
  ExecuteRecoveryResult,
  JournalInProgressPhase,
  PreviewRecoveryResult,
} from '../workspace-api/types.js'
import type {AutoRecoverRequest, CheckoutRecoveryOutcome} from './checkout-recovery.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {totalRecoveryCeilingMs} from '../workspace-api/client.js'
import {totalRecoveryBudgetMs, tryAutoRecoverDirtyCheckout} from './checkout-recovery.js'
import {REPO_QUIESCENCE_TIMEOUT_MS} from './repo-quiescence.js'
import {
  DEFAULT_BACKUP_ID,
  DEFAULT_PREVIEW_FINGERPRINT,
  makeQuiescenceFn,
  makeRecoveryPreviewData,
} from './test-helpers.js'

const REQUEST: AutoRecoverRequest = {
  owner: 'acme',
  repo: 'widget',
  repoSlug: 'acme/widget',
  runId: 'run-1',
  remainingBudgetMs: 600_000,
  requiredBudgetMs: totalRecoveryBudgetMs(),
}

const USAGE = {generationCount: 5, hasUnknownSize: false, totalBytes: 1000, maxGenerations: 5, maxBytes: 4096}

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function recoverOk(): ExecuteRecoveryResult {
  return {kind: 'ok', recoveryId: DEFAULT_BACKUP_ID, sha: 'b'.repeat(40), branch: 'main'}
}

function makeDeps(
  overrides: {
    readonly quiescence?: ReturnType<typeof makeQuiescenceFn>
    readonly preview?: ReturnType<typeof vi.fn>
    readonly recover?: ReturnType<typeof vi.fn>
    readonly listBackups?: ReturnType<typeof vi.fn>
  } = {},
) {
  const checkRepoQuiescence = overrides.quiescence ?? makeQuiescenceFn('clear')
  const previewRecovery = overrides.preview ?? vi.fn().mockResolvedValue(ok(makeRecoveryPreviewData()))
  const recover = overrides.recover ?? vi.fn().mockResolvedValue(ok(recoverOk()))
  const listBackups = overrides.listBackups ?? vi.fn().mockResolvedValue(ok({kind: 'ok', backups: [], totalBytes: 0}))
  const logger = makeLogger()
  return {
    deps: {
      checkRepoQuiescence: checkRepoQuiescence as never,
      previewRecovery: previewRecovery as never,
      recover: recover as never,
      listBackups: listBackups as never,
      logger,
    },
    checkRepoQuiescence,
    previewRecovery,
    recover,
    listBackups,
    logger,
  }
}

async function run(
  overrides: Parameters<typeof makeDeps>[0] = {},
  request: AutoRecoverRequest = REQUEST,
): Promise<{
  readonly outcome: CheckoutRecoveryOutcome
  readonly h: ReturnType<typeof makeDeps>
}> {
  const h = makeDeps(overrides)
  const outcome = await tryAutoRecoverDirtyCheckout(h.deps, request)
  return {outcome, h}
}

describe('tryAutoRecoverDirtyCheckout: the happy sequence', () => {
  it('checks quiescence, previews, then recovers with the preview fingerprint and the run id', async () => {
    // #given / #when
    const {outcome, h} = await run()

    // #then
    expect(outcome).toEqual({kind: 'recovered', backupId: DEFAULT_BACKUP_ID})
    expect(h.checkRepoQuiescence).toHaveBeenCalledOnce()
    expect(h.checkRepoQuiescence.mock.calls[0]?.[0]).toMatchObject({repo: 'acme/widget'})
    expect(h.previewRecovery).toHaveBeenCalledWith('acme', 'widget')
    expect(h.recover).toHaveBeenCalledExactlyOnceWith('acme', 'widget', {
      fingerprint: DEFAULT_PREVIEW_FINGERPRINT,
      runId: 'run-1',
    })
    const order = [
      h.checkRepoQuiescence.mock.invocationCallOrder[0],
      h.previewRecovery.mock.invocationCallOrder[0],
      h.recover.mock.invocationCallOrder[0],
    ]
    expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)))
  })

  it('proceeds on an opaque (not safely inspectable) preview, as the manual flow does', async () => {
    // #given
    const opaque = {
      kind: 'ok' as const,
      preview: {
        inspectionSafe: false as const,
        estimatedSizeBytes: 10,
        entryCount: 2,
        sizeMeasurementComplete: true,
        retention: USAGE,
        fingerprint: 'fp-opaque',
      },
    }

    // #when
    const {outcome, h} = await run({preview: vi.fn().mockResolvedValue(ok(opaque))})

    // #then
    expect(outcome.kind).toBe('recovered')
    expect(h.recover).toHaveBeenCalledWith('acme', 'widget', {fingerprint: 'fp-opaque', runId: 'run-1'})
  })
})

describe('tryAutoRecoverDirtyCheckout: budget gate', () => {
  it('declines, calling nothing, when the remaining budget is one below the required sum', async () => {
    // #given
    const required = totalRecoveryBudgetMs()

    // #when
    const {outcome, h} = await run({}, {...REQUEST, requiredBudgetMs: required, remainingBudgetMs: required - 1})

    // #then
    expect(outcome).toEqual({kind: 'declined', reason: 'budget-insufficient'})
    expect(h.checkRepoQuiescence).not.toHaveBeenCalled()
    expect(h.previewRecovery).not.toHaveBeenCalled()
    expect(h.recover).not.toHaveBeenCalled()
    expect(h.listBackups).not.toHaveBeenCalled()
  })

  it('starts when the remaining budget exactly equals the required sum', async () => {
    // #given
    const required = totalRecoveryBudgetMs()

    // #when
    const {outcome} = await run({}, {...REQUEST, requiredBudgetMs: required, remainingBudgetMs: required})

    // #then
    expect(outcome.kind).toBe('recovered')
  })
})

describe('totalRecoveryBudgetMs', () => {
  it('is the quiescence check plus every workspace call the recovery makes (default sum 514s)', () => {
    // #given the default ceilings: 4s quiescence + 45s preview + 300s recover + 5s dispose + 60s lookup + 100s update
    // #when / #then
    expect(totalRecoveryBudgetMs()).toBe(4_000 + 45_000 + 300_000 + 5_000 + 60_000 + 100_000)
    expect(totalRecoveryBudgetMs()).toBe(514_000)
  })

  it("derives the quiescence term from the checker's own exported timeout, not a literal", () => {
    expect(totalRecoveryBudgetMs()).toBe(REPO_QUIESCENCE_TIMEOUT_MS + totalRecoveryCeilingMs())
  })

  it('follows the ceilings the client was configured with', () => {
    // #given
    const options = {
      previewRecoveryTimeoutMs: 1_000,
      recoverTimeoutMs: 2_000,
      updateTimeoutMs: 3_000,
      listBackupsTimeoutMs: 4_000,
    }

    // #when / #then
    expect(totalRecoveryBudgetMs(options)).toBe(REPO_QUIESCENCE_TIMEOUT_MS + 10_000 + 5_000)
  })
})

describe('tryAutoRecoverDirtyCheckout: quiescence gate', () => {
  it.each([
    ['busy', 'workspace-busy'],
    ['unknown', 'workspace-unknown'],
  ] as const)('%s quiescence declines as %s and never previews or recovers', async (kind, reason) => {
    // #given / #when
    const {outcome, h} = await run({quiescence: makeQuiescenceFn(kind)})

    // #then
    expect(outcome).toEqual({kind: 'declined', reason})
    expect(h.previewRecovery).not.toHaveBeenCalled()
    expect(h.recover).not.toHaveBeenCalled()
  })

  it('a throwing quiescence check declines as unknown (fail closed)', async () => {
    // #given
    const quiescence = vi.fn().mockRejectedValue(new Error('opencode unreachable'))

    // #when
    const {outcome, h} = await run({quiescence: quiescence as never})

    // #then
    expect(outcome).toEqual({kind: 'declined', reason: 'workspace-unknown'})
    expect(h.previewRecovery).not.toHaveBeenCalled()
  })
})

const PREVIEW_DECLINES: readonly (readonly [string, unknown, string])[] = [
  ['no-checkout', ok<PreviewRecoveryResult>({kind: 'no-checkout'}), 'preview-not-ok'],
  [
    'refused checkout-substituted',
    ok<PreviewRecoveryResult>({kind: 'refused', reason: 'checkout-substituted'}),
    'preview-not-ok',
  ],
  [
    'refused maintenance-hold',
    ok<PreviewRecoveryResult>({kind: 'refused', reason: 'maintenance-hold'}),
    'preview-not-ok',
  ],
  [
    'refused journal-in-progress',
    ok<PreviewRecoveryResult>({kind: 'refused', reason: 'journal-in-progress', phase: 'building'}),
    'preview-not-ok',
  ],
  [
    'failed inspection-failed',
    ok<PreviewRecoveryResult>({kind: 'failed', reason: 'inspection-failed'}),
    'preview-not-ok',
  ],
  [
    'failed termination-unconfirmed',
    ok<PreviewRecoveryResult>({kind: 'failed', reason: 'termination-unconfirmed'}),
    'preview-not-ok',
  ],
  [
    'recoverable-update',
    ok<PreviewRecoveryResult>({
      kind: 'recoverable-update',
      update: {
        phase: 'applying',
        fromSha: 'a'.repeat(40),
        toSha: 'b'.repeat(40),
        startedAt: '2026-01-01T00:00:00.000Z',
        estimatedSizeBytes: 1,
        entryCount: 1,
        sizeMeasurementComplete: true,
        fingerprint: 'fp-ru',
      },
    }),
    'preview-not-ok',
  ],
  [
    'ok but size measurement incomplete',
    ok(makeRecoveryPreviewData({sizeMeasurementComplete: false})),
    'size-incomplete',
  ],
  ['transport timeout', err({kind: 'timeout'}), 'preview-unavailable'],
  ['transport network-error', err({kind: 'network-error'}), 'preview-unavailable'],
  ['transport http-error', err({kind: 'http-error', status: 401}), 'preview-unavailable'],
  ['transport parse-error', err({kind: 'parse-error'}), 'preview-unavailable'],
]

describe('tryAutoRecoverDirtyCheckout: preview outcomes', () => {
  it.each(PREVIEW_DECLINES)('preview %s declines (%#), nothing is recovered', async (_label, result, reason) => {
    // #given / #when
    const {outcome, h} = await run({preview: vi.fn().mockResolvedValue(result)})

    // #then — a preview is read-only, so nothing could have moved
    expect(outcome).toEqual({kind: 'declined', reason})
    expect(h.recover).not.toHaveBeenCalled()
  })

  it('a throwing preview declines as unavailable', async () => {
    // #given / #when
    const {outcome, h} = await run({preview: vi.fn().mockRejectedValue(new Error('boom'))})

    // #then
    expect(outcome).toEqual({kind: 'declined', reason: 'preview-unavailable'})
    expect(h.recover).not.toHaveBeenCalled()
  })
})

// Every variant of ExecuteRecoveryResult, classified. `satisfies` over the failure-reason keys and the
// exhaustive switch in the module make a new union member a type error in both places.
const RECOVER_FAILURE_CLASS = {
  'inspection-failed': 'declined',
  'fetch-failed': 'declined',
  'build-failed': 'declined',
  'rollback-failed': 'ambiguous',
  'quarantine-failed': 'ambiguous',
  'install-failed': 'ambiguous',
  'verification-failed': 'ambiguous',
  'termination-unconfirmed': 'ambiguous',
} as const satisfies Record<ExecuteRecoveryFailureReason, 'declined' | 'ambiguous'>

const JOURNAL_PHASE: JournalInProgressPhase = 'quarantining'

describe('tryAutoRecoverDirtyCheckout: recover outcomes that moved nothing (declined)', () => {
  it.each([
    ['refused maintenance-hold', {kind: 'refused', reason: 'maintenance-hold'}, 'maintenance-hold'],
    [
      'refused journal-in-progress',
      {kind: 'refused', reason: 'journal-in-progress', phase: JOURNAL_PHASE},
      'journal-in-progress',
    ],
    ['refused checkout-changed', {kind: 'refused', reason: 'checkout-changed'}, 'checkout-changed'],
    [
      'refused insufficient-disk-space',
      {kind: 'refused', reason: 'insufficient-disk-space'},
      'insufficient-disk-space',
    ],
    ['failed inspection-failed', {kind: 'failed', reason: 'inspection-failed'}, 'inspection-failed'],
    ['failed fetch-failed (before any journal or staging)', {kind: 'failed', reason: 'fetch-failed'}, 'fetch-failed'],
    ['failed build-failed (staging rolled back)', {kind: 'failed', reason: 'build-failed'}, 'build-failed'],
  ] as const)('%s', async (_label, result, reason) => {
    // #given / #when
    const {outcome, h} = await run({recover: vi.fn().mockResolvedValue(ok(result))})

    // #then
    expect(outcome).toEqual({kind: 'declined', reason})
    expect(h.recover).toHaveBeenCalledOnce()
  })

  it('refused quota-exceeded declines and carries the usage the reply names', async () => {
    // #given / #when
    const {outcome} = await run({
      recover: vi.fn().mockResolvedValue(ok({kind: 'refused', reason: 'quota-exceeded', usage: USAGE})),
    })

    // #then
    expect(outcome).toEqual({kind: 'declined', reason: 'quota-exceeded', usage: USAGE})
  })
})

describe('tryAutoRecoverDirtyCheckout: recover outcomes where something may have moved (ambiguous)', () => {
  it.each([
    ['no-checkout (unexpected from /recover)', ok({kind: 'no-checkout'}), 'unexpected-result'],
    ['failed rollback-failed', ok({kind: 'failed', reason: 'rollback-failed'}), 'rollback-failed'],
    ['failed quarantine-failed', ok({kind: 'failed', reason: 'quarantine-failed'}), 'quarantine-failed'],
    ['failed install-failed', ok({kind: 'failed', reason: 'install-failed'}), 'install-failed'],
    ['failed verification-failed', ok({kind: 'failed', reason: 'verification-failed'}), 'verification-failed'],
    [
      'failed termination-unconfirmed',
      ok({kind: 'failed', reason: 'termination-unconfirmed'}),
      'termination-unconfirmed',
    ],
    ['transport timeout', err({kind: 'timeout'}), 'timeout'],
    ['transport network-error', err({kind: 'network-error'}), 'transport-error'],
    ['transport http-error', err({kind: 'http-error', status: 500}), 'transport-error'],
    ['transport parse-error', err({kind: 'parse-error'}), 'transport-error'],
  ] as const)('%s', async (_label, result, reason) => {
    // #given / #when
    const {outcome, h} = await run({recover: vi.fn().mockResolvedValue(result)})

    // #then
    expect(outcome).toEqual({kind: 'ambiguous', reason, backup: {kind: 'not-found'}})
    expect(h.recover).toHaveBeenCalledOnce()
  })

  it('a throwing recover is ambiguous: the request may have reached the workspace', async () => {
    // #given / #when
    const {outcome} = await run({recover: vi.fn().mockRejectedValue(new Error('socket hang up'))})

    // #then
    expect(outcome).toEqual({kind: 'ambiguous', reason: 'transport-error', backup: {kind: 'not-found'}})
  })

  it('classifies every ExecuteRecoveryFailureReason exactly as the table says', async () => {
    // #given every real failure reason
    for (const [reason, expected] of Object.entries(RECOVER_FAILURE_CLASS)) {
      const {outcome} = await run({
        recover: vi.fn().mockResolvedValue(ok({kind: 'failed', reason: reason as ExecuteRecoveryFailureReason})),
      })
      // #then
      expect({reason, kind: outcome.kind}).toEqual({reason, kind: expected})
    }
  })
})

describe('tryAutoRecoverDirtyCheckout: logging', () => {
  it('logs a recovered outcome at warn with run id, repo, outcome and backup id', async () => {
    // #given / #when
    const {h} = await run()

    // #then
    expect(h.logger.warn).toHaveBeenCalledOnce()
    expect(h.logger.warn.mock.calls[0]?.[0]).toEqual({
      repo: 'acme/widget',
      runId: 'run-1',
      outcome: 'recovered',
      backupId: DEFAULT_BACKUP_ID,
    })
  })

  it.each([
    ['declined', {quiescence: makeQuiescenceFn('busy')}, 'workspace-busy'],
    ['ambiguous', {recover: vi.fn().mockResolvedValue(err({kind: 'timeout'}))}, 'timeout'],
  ] as const)(
    'logs a %s outcome at warn with the reason and nothing path-like',
    async (outcomeKind, overrides, reason) => {
      // #given / #when
      const {h} = await run(overrides)

      // #then
      expect(h.logger.warn).toHaveBeenCalledOnce()
      expect(h.logger.warn.mock.calls[0]?.[0]).toEqual({
        repo: 'acme/widget',
        runId: 'run-1',
        outcome: outcomeKind,
        reason,
        ...(outcomeKind === 'ambiguous' ? {lookup: 'not-found'} : {}),
      })
    },
  )
})

// After an ambiguous outcome the recovery may or may not have completed, so the run looks its own backup
// up by run id: a found id is named like a `recovered` one, anything else falls back to the attempted note.
describe('tryAutoRecoverDirtyCheckout: backup lookup after an ambiguous outcome', () => {
  const TIMEOUT = {recover: vi.fn().mockResolvedValue(err({kind: 'timeout'}))}

  function backup(id: string, runId: string | undefined, createdAt = '2026-01-01T00:00:00.000Z') {
    return {
      id,
      metadataOk: true,
      createdAt,
      sizeBytes: 1,
      sizeComplete: true,
      originalHeadSha: undefined,
      originalBranch: undefined,
      ...(runId === undefined ? {} : {runId}),
    }
  }

  function listing(...backups: ReturnType<typeof backup>[]) {
    return vi.fn().mockResolvedValue(ok({kind: 'ok', backups, totalBytes: 1}))
  }

  it('names the backup whose runId is this run, and asks for the canonical owner and repo', async () => {
    // #given
    const listBackups = listing(
      backup('gen-other', 'run-2'),
      backup('gen-mine', 'run-1'),
      backup('gen-manual', undefined),
    )

    // #when
    const {outcome, h} = await run({...TIMEOUT, listBackups})

    // #then
    expect(outcome).toEqual({kind: 'ambiguous', reason: 'timeout', backup: {kind: 'found', backupId: 'gen-mine'}})
    expect(h.listBackups).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
  })

  it('picks the newest when more than one backup carries this run id', async () => {
    // #given
    const listBackups = listing(
      backup('gen-old', 'run-1', '2026-01-01T00:00:00.000Z'),
      backup('gen-new', 'run-1', '2026-01-02T00:00:00.000Z'),
    )

    // #when
    const {outcome} = await run({...TIMEOUT, listBackups})

    // #then
    expect(outcome).toMatchObject({backup: {kind: 'found', backupId: 'gen-new'}})
  })

  it.each([
    ['no backups at all', listing()],
    ['only backups of other runs and manual ones', listing(backup('a', 'run-2'), backup('b', undefined))],
  ])('%s is not-found', async (_label, listBackups) => {
    const {outcome} = await run({...TIMEOUT, listBackups})
    expect(outcome).toMatchObject({kind: 'ambiguous', backup: {kind: 'not-found'}})
  })

  it.each([
    ['a workspace-side failure', vi.fn().mockResolvedValue(ok({kind: 'failed'}))],
    ['a timeout', vi.fn().mockResolvedValue(err({kind: 'timeout'}))],
    ['a network error', vi.fn().mockResolvedValue(err({kind: 'network-error'}))],
    ['a parse error', vi.fn().mockResolvedValue(err({kind: 'parse-error'}))],
    ['a throw', vi.fn().mockRejectedValue(new Error('boom'))],
  ])('%s is a failed lookup, never an error', async (_label, listBackups) => {
    const {outcome} = await run({...TIMEOUT, listBackups})
    expect(outcome).toMatchObject({kind: 'ambiguous', backup: {kind: 'failed'}})
  })

  it.each([
    ['recovered', {}],
    ['declined', {quiescence: makeQuiescenceFn('busy')}],
  ])('a %s outcome never looks anything up', async (_label, overrides) => {
    const {h} = await run(overrides)
    expect(h.listBackups).not.toHaveBeenCalled()
  })

  it.each([
    ['found', listing(backup('gen-mine', 'run-1')), {lookup: 'found', backupId: 'gen-mine'}],
    ['not-found', listing(), {lookup: 'not-found'}],
    ['failed', vi.fn().mockResolvedValue(err({kind: 'timeout'})), {lookup: 'failed'}],
  ])('logs the %s lookup in the one ambiguous warning, with no path', async (_label, listBackups, fields) => {
    // #given / #when
    const {h} = await run({...TIMEOUT, listBackups})

    // #then
    expect(h.logger.warn).toHaveBeenCalledOnce()
    expect(h.logger.warn.mock.calls[0]?.[0]).toEqual({
      repo: 'acme/widget',
      runId: 'run-1',
      outcome: 'ambiguous',
      reason: 'timeout',
      ...fields,
    })
  })
})
