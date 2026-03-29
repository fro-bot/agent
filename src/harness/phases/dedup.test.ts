import type {TriggerContext, TriggerTarget} from '../../features/triggers/types.js'
import type {DeduplicationMarker} from '../../services/cache/dedup.js'
import type {EventType, GitHubContext} from '../../services/github/types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {restoreDeduplicationMarker, saveDeduplicationMarker} from '../../services/cache/dedup.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {setActionOutputs} from '../config/outputs.js'
import {extractDedupEntity, runDedup, saveDedupMarker} from './dedup.js'

vi.mock('../../services/cache/dedup.js', () => ({
  restoreDeduplicationMarker: vi.fn(),
  saveDeduplicationMarker: vi.fn(),
}))

vi.mock('../config/outputs.js', () => ({
  setActionOutputs: vi.fn(),
}))

function createRawContext(eventType: EventType): GitHubContext {
  return {
    eventName: eventType,
    eventType,
    repo: {owner: 'fro-bot', repo: 'agent'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 123,
    actor: 'mrbrown',
    payload: {},
    event: {type: 'unsupported'},
  }
}

function createTarget(kind: TriggerTarget['kind'], number: number): TriggerTarget {
  return {
    kind,
    number,
    title: 'title',
    body: null,
    locked: false,
  }
}

function createTriggerContext(options?: {
  readonly eventType?: EventType
  readonly target?: TriggerTarget | null
  readonly runId?: number
  readonly action?: string | null
  readonly repo?: {readonly owner: string; readonly repo: string}
}): TriggerContext {
  const eventType = options?.eventType ?? 'pull_request'
  const target = options?.target === undefined ? createTarget('pr', 42) : options.target

  return {
    eventType,
    eventName: eventType,
    repo: options?.repo ?? {owner: 'fro-bot', repo: 'agent'},
    ref: 'refs/heads/main',
    sha: 'sha123',
    runId: options?.runId ?? 1001,
    actor: 'mrbrown',
    action: options?.action ?? 'opened',
    author: null,
    target,
    commentBody: null,
    commentId: null,
    hasMention: false,
    command: null,
    isBotReviewRequested: false,
    raw: createRawContext(eventType),
  }
}

function createMarker(runId: number, timestamp: string): DeduplicationMarker {
  return {
    timestamp,
    runId,
    action: 'opened',
    eventType: 'pull_request',
    entityType: 'pr',
    entityNumber: 42,
  }
}

describe('extractDedupEntity', () => {
  it('returns pr entity for pull_request with pr target', () => {
    // #given pull_request trigger context with pr target
    const context = createTriggerContext({
      eventType: 'pull_request',
      target: createTarget('pr', 42),
    })

    // #when extracting dedup entity
    const result = extractDedupEntity(context)

    // #then pr entity is returned
    expect(result).toEqual({entityType: 'pr', entityNumber: 42})
  })

  it('returns issue entity for issues with issue target', () => {
    // #given issues trigger context with issue target
    const context = createTriggerContext({
      eventType: 'issues',
      target: createTarget('issue', 10),
    })

    // #when extracting dedup entity
    const result = extractDedupEntity(context)

    // #then issue entity is returned
    expect(result).toEqual({entityType: 'issue', entityNumber: 10})
  })

  it('returns null for issue_comment event type', () => {
    // #given issue_comment context
    const context = createTriggerContext({
      eventType: 'issue_comment',
      target: createTarget('issue', 10),
    })

    // #when extracting dedup entity
    const result = extractDedupEntity(context)

    // #then entity is not deduplicable
    expect(result).toBeNull()
  })

  it('returns null when target is null', () => {
    // #given context without target
    const context = createTriggerContext({target: null})

    // #when extracting dedup entity
    const result = extractDedupEntity(context)

    // #then no entity is returned
    expect(result).toBeNull()
  })
})

describe('runDedup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns shouldProceed true when window is disabled', async () => {
    // #given dedup window disabled
    const context = createTriggerContext({
      eventType: 'pull_request',
      target: createTarget('pr', 42),
    })

    // #when running dedup phase
    const result = await runDedup(0, context, 'fro-bot/agent', 1, createMockLogger())

    // #then dedup is bypassed and no restore occurs
    expect(result).toEqual({
      shouldProceed: true,
      entity: {entityType: 'pr', entityNumber: 42},
    })
    expect(vi.mocked(restoreDeduplicationMarker)).not.toHaveBeenCalled()
  })

  it('returns shouldProceed true for non-deduplicable event', async () => {
    // #given non-deduplicable issue_comment event
    const context = createTriggerContext({
      eventType: 'issue_comment',
      target: createTarget('issue', 42),
    })

    // #when running dedup phase
    const result = await runDedup(60_000, context, 'fro-bot/agent', 1, createMockLogger())

    // #then processing proceeds without dedup lookup
    expect(result).toEqual({shouldProceed: true, entity: null})
    expect(vi.mocked(restoreDeduplicationMarker)).not.toHaveBeenCalled()
  })

  it('bypasses dedup for synchronize action', async () => {
    // #given synchronize action on a PR (fires first, needed for required status checks)
    const context = createTriggerContext({
      eventType: 'pull_request',
      action: 'synchronize',
      target: createTarget('pr', 42),
    })

    // #when running dedup phase
    const result = await runDedup(600_000, context, 'fro-bot/agent', 1, createMockLogger())

    // #then dedup is bypassed — no cache lookup occurs
    expect(result).toEqual({shouldProceed: true, entity: {entityType: 'pr', entityNumber: 42}})
    expect(vi.mocked(restoreDeduplicationMarker)).not.toHaveBeenCalled()
  })

  it('bypasses dedup for reopened action', async () => {
    // #given reopened PR (meaningful state change, breaks dedup lock)
    const context = createTriggerContext({
      eventType: 'pull_request',
      action: 'reopened',
      target: createTarget('pr', 42),
    })

    // #when running dedup phase
    const result = await runDedup(600_000, context, 'fro-bot/agent', 1, createMockLogger())

    // #then dedup is bypassed
    expect(result).toEqual({shouldProceed: true, entity: {entityType: 'pr', entityNumber: 42}})
    expect(vi.mocked(restoreDeduplicationMarker)).not.toHaveBeenCalled()
  })

  it('returns shouldProceed true when no sentinel is found', async () => {
    // #given cache miss for dedup marker
    vi.mocked(restoreDeduplicationMarker).mockResolvedValueOnce(null)
    const context = createTriggerContext({
      eventType: 'pull_request',
      target: createTarget('pr', 42),
    })

    // #when running dedup phase
    const result = await runDedup(60_000, context, 'fro-bot/agent', 100, createMockLogger())

    // #then processing proceeds
    expect(result).toEqual({
      shouldProceed: true,
      entity: {entityType: 'pr', entityNumber: 42},
    })
  })

  it('returns shouldProceed true when marker is expired', async () => {
    // #given previous marker older than dedup window
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    vi.mocked(restoreDeduplicationMarker).mockResolvedValueOnce(createMarker(2002, new Date(1_000).toISOString()))
    const context = createTriggerContext({
      eventType: 'pull_request',
      target: createTarget('pr', 42),
      runId: 3003,
    })

    // #when running dedup phase
    const result = await runDedup(10_000, context, 'fro-bot/agent', 10, createMockLogger())

    // #then expired marker allows processing
    expect(result).toEqual({
      shouldProceed: true,
      entity: {entityType: 'pr', entityNumber: 42},
    })
    expect(nowSpy).toHaveBeenCalled()
  })

  it('returns shouldProceed true when marker runId matches current run', async () => {
    // #given marker from same workflow run
    vi.mocked(restoreDeduplicationMarker).mockResolvedValueOnce(createMarker(1001, new Date().toISOString()))
    const context = createTriggerContext({runId: 1001})

    // #when running dedup phase
    const result = await runDedup(60_000, context, 'fro-bot/agent', 10, createMockLogger())

    // #then same-run marker is allowed
    expect(result).toEqual({
      shouldProceed: true,
      entity: {entityType: 'pr', entityNumber: 42},
    })
  })

  it('returns shouldProceed true when marker timestamp is invalid', async () => {
    // #given marker with invalid timestamp
    vi.mocked(restoreDeduplicationMarker).mockResolvedValueOnce(createMarker(999, 'not-a-timestamp'))
    const context = createTriggerContext({runId: 1001})

    // #when running dedup phase
    const result = await runDedup(10_000, context, 'fro-bot/agent', 1, createMockLogger())

    // #then invalid timestamp fails open
    expect(result).toEqual({
      shouldProceed: true,
      entity: {entityType: 'pr', entityNumber: 42},
    })
    expect(vi.mocked(setActionOutputs)).not.toHaveBeenCalled()
  })

  it('returns shouldProceed true when marker timestamp is far in the future', async () => {
    // #given marker with timestamp >60s in the future (beyond clock-skew tolerance)
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    vi.mocked(restoreDeduplicationMarker).mockResolvedValueOnce(
      createMarker(999, new Date(10_000 + 61_000).toISOString()),
    )
    const context = createTriggerContext({runId: 1001})

    // #when running dedup phase
    const result = await runDedup(600_000, context, 'fro-bot/agent', 1, createMockLogger())

    // #then future timestamp beyond tolerance fails open
    expect(result).toEqual({
      shouldProceed: true,
      entity: {entityType: 'pr', entityNumber: 42},
    })
    expect(vi.mocked(setActionOutputs)).not.toHaveBeenCalled()
  })

  it('returns shouldProceed false when marker is slightly in the future (clock skew)', async () => {
    // #given marker with timestamp 30s in the future (within 60s tolerance)
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    vi.mocked(restoreDeduplicationMarker).mockResolvedValueOnce(createMarker(999, new Date(130_000).toISOString()))
    const context = createTriggerContext({runId: 1001})

    // #when running dedup phase with large window
    const result = await runDedup(600_000, context, 'fro-bot/agent', 1, createMockLogger())

    // #then small clock skew is tolerated and dedup applies
    expect(result).toEqual({
      shouldProceed: false,
      entity: {entityType: 'pr', entityNumber: 42},
    })
  })

  it('returns shouldProceed false when recent marker exists within window', async () => {
    // #given recent marker from different run
    vi.spyOn(Date, 'now').mockReturnValue(30_000)
    vi.mocked(restoreDeduplicationMarker).mockResolvedValueOnce(createMarker(999, new Date(25_000).toISOString()))
    const context = createTriggerContext({runId: 1001})

    // #when running dedup phase
    const result = await runDedup(10_000, context, 'fro-bot/agent', 5_000, createMockLogger())

    // #then processing is skipped and outputs are set
    expect(result).toEqual({
      shouldProceed: false,
      entity: {entityType: 'pr', entityNumber: 42},
    })
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith({
      sessionId: null,
      cacheStatus: 'miss',
      duration: 25_000,
    })
  })
})

describe('saveDedupMarker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('calls saveDeduplicationMarker with expected marker shape', async () => {
    // #given dedup entity and trigger context
    vi.useFakeTimers()
    const fixedNow = new Date('2026-03-21T12:34:56.000Z')
    vi.setSystemTime(fixedNow)
    vi.mocked(saveDeduplicationMarker).mockResolvedValueOnce(true)
    const context = createTriggerContext({
      eventType: 'pull_request',
      runId: 1234,
      action: 'synchronize',
      target: createTarget('pr', 42),
    })
    const entity = {entityType: 'pr' as const, entityNumber: 42}

    // #when saving dedup marker
    await saveDedupMarker(context, entity, 'fro-bot/agent', createMockLogger())

    // #then cache save is called with expected marker payload
    expect(vi.mocked(saveDeduplicationMarker)).toHaveBeenCalledWith(
      'fro-bot/agent',
      entity,
      {
        timestamp: fixedNow.toISOString(),
        runId: 1234,
        action: 'synchronize',
        eventType: 'pull_request',
        entityType: 'pr',
        entityNumber: 42,
      },
      expect.anything(),
      undefined,
    )
  })
})
