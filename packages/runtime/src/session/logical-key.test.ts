import type {EventType, TriggerContext, TriggerTarget} from '../agent/types.js'
import type {SessionClient} from './backend.js'
import type {SessionInfo} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {buildLogicalKey, buildSessionTitle, findSessionByTitle, resolveSessionForLogicalKey} from './logical-key.js'

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

/** Minimal raw context matching what TriggerContext.raw expects (typed as unknown). */
function createRawContext(eventType: EventType) {
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
}): TriggerContext {
  const eventType = options?.eventType ?? 'pull_request'
  const target = options?.target === undefined ? createTarget('pr', 42) : options.target

  return {
    eventType,
    eventName: eventType,
    repo: {owner: 'fro-bot', repo: 'agent'},
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

function createSession(options: {
  readonly id: string
  readonly title: string
  readonly updated: number
  readonly archived?: number
  readonly compacting?: number
}): SessionInfo {
  return {
    id: options.id,
    version: '1.1.53',
    projectID: 'proj_1',
    directory: '/workspace',
    title: options.title,
    time: {
      created: options.updated - 100,
      updated: options.updated,
      archived: options.archived,
      compacting: options.compacting,
    },
  }
}

function createMockSdkClient(options?: {
  readonly sessionListResponse?: {readonly data?: unknown; readonly error?: unknown}
}) {
  return {
    session: {
      list: vi.fn().mockResolvedValue(options?.sessionListResponse ?? {data: []}),
    },
  }
}

describe('buildLogicalKey', () => {
  it('builds issue key for issue_comment on issue', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'issue_comment',
      target: createTarget('issue', 12),
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'issue-12', entityType: 'issue', entityId: '12'})
  })

  it('builds pr key for issue_comment on pr', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'issue_comment',
      target: createTarget('pr', 347),
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'pr-347', entityType: 'pr', entityId: '347'})
  })

  it('builds discussion key for discussion_comment', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'discussion_comment',
      target: createTarget('discussion', 5),
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'discussion-5', entityType: 'discussion', entityId: '5'})
  })

  it('builds issue key for issues event', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'issues',
      target: createTarget('issue', 42),
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'issue-42', entityType: 'issue', entityId: '42'})
  })

  it('builds pr key for pull_request event', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'pull_request',
      target: createTarget('pr', 88),
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'pr-88', entityType: 'pr', entityId: '88'})
  })

  it('builds pr key for pull_request_review_comment event', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'pull_request_review_comment',
      target: createTarget('pr', 99),
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'pr-99', entityType: 'pr', entityId: '99'})
  })

  it('builds schedule key from stable hash', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'schedule',
      action: '0 0 * * *',
      target: null,
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'schedule-898cd73a', entityType: 'schedule', entityId: '898cd73a'})
  })

  it('builds workflow dispatch key from runId', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'workflow_dispatch',
      runId: 90210,
      target: null,
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toEqual({key: 'dispatch-90210', entityType: 'dispatch', entityId: '90210'})
  })

  it('returns null for unsupported events', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'unsupported',
      target: null,
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toBeNull()
  })

  it('returns null when target is null for target-required events', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'pull_request',
      target: null,
    })

    // #when
    const result = buildLogicalKey(context)

    // #then
    expect(result).toBeNull()
  })

  it('returns deterministic key for same event context', () => {
    // #given
    const context = createTriggerContext({
      eventType: 'discussion_comment',
      target: createTarget('discussion', 17),
    })

    // #when
    const first = buildLogicalKey(context)
    const second = buildLogicalKey(context)

    // #then
    expect(first).toEqual(second)
  })
})

describe('buildSessionTitle', () => {
  it('prefixes logical key with fro-bot namespace', () => {
    // #given
    const key = {key: 'pr-347', entityType: 'pr' as const, entityId: '347'}

    // #when
    const title = buildSessionTitle(key)

    // #then
    expect(title).toBe('fro-bot: pr-347')
  })
})

describe('findSessionByTitle', () => {
  it('returns exact title match', () => {
    // #given
    const sessions = [createSession({id: 'ses_1', title: 'fro-bot: pr-347', updated: 100})]

    // #when
    const result = findSessionByTitle(sessions, 'fro-bot: pr-347')

    // #then
    expect(result?.id).toBe('ses_1')
  })

  it('returns null when no exact match exists', () => {
    // #given
    const sessions = [createSession({id: 'ses_1', title: 'fro-bot: pr-347', updated: 100})]

    // #when
    const result = findSessionByTitle(sessions, 'fro-bot: issue-347')

    // #then
    expect(result).toBeNull()
  })

  it('does not match prefix collisions', () => {
    // #given
    const sessions = [createSession({id: 'ses_1', title: 'fro-bot: pr-347', updated: 100})]

    // #when
    const result = findSessionByTitle(sessions, 'fro-bot: pr-34')

    // #then
    expect(result).toBeNull()
  })

  it('returns most recently updated session when duplicates exist', () => {
    // #given
    const sessions = [
      createSession({id: 'ses_old', title: 'fro-bot: pr-347', updated: 100}),
      createSession({id: 'ses_new', title: 'fro-bot: pr-347', updated: 200}),
      createSession({id: 'ses_other', title: 'fro-bot: pr-888', updated: 500}),
    ]

    // #when
    const result = findSessionByTitle(sessions, 'fro-bot: pr-347')

    // #then
    expect(result?.id).toBe('ses_new')
  })
})

describe('resolveSessionForLogicalKey', () => {
  it('returns found when matching non-archived session exists', async () => {
    // #given
    const key = {key: 'pr-347', entityType: 'pr' as const, entityId: '347'}
    const session = createSession({id: 'ses_match', title: 'fro-bot: pr-347', updated: 500})
    const client = createMockSdkClient({sessionListResponse: {data: [session]}})

    // #when
    const result = await resolveSessionForLogicalKey(
      client as unknown as SessionClient,
      '/workspace',
      key,
      createMockLogger(),
    )

    // #then
    expect(client.session.list).toHaveBeenCalledWith({query: {directory: '/workspace'}})
    expect(result).toEqual({status: 'found', session})
  })

  it('returns not-found when no matching session exists', async () => {
    // #given
    const key = {key: 'pr-347', entityType: 'pr' as const, entityId: '347'}
    const client = createMockSdkClient({
      sessionListResponse: {data: [createSession({id: 'ses_1', title: 'fro-bot: pr-999', updated: 100})]},
    })

    // #when
    const result = await resolveSessionForLogicalKey(
      client as unknown as SessionClient,
      '/workspace',
      key,
      createMockLogger(),
    )

    // #then
    expect(result).toEqual({status: 'not-found'})
  })

  it('returns error when SDK list call throws', async () => {
    // #given
    const key = {key: 'pr-347', entityType: 'pr' as const, entityId: '347'}
    const client = {
      session: {
        list: vi.fn().mockRejectedValue(new Error('sdk exploded')),
      },
    }

    // #when
    const result = await resolveSessionForLogicalKey(
      client as unknown as SessionClient,
      '/workspace',
      key,
      createMockLogger(),
    )

    // #then
    expect(result).toEqual({status: 'error', error: 'sdk exploded'})
  })

  it('returns not-found when matched session is archived', async () => {
    // #given
    const key = {key: 'pr-347', entityType: 'pr' as const, entityId: '347'}
    const archived = createSession({id: 'ses_archived', title: 'fro-bot: pr-347', updated: 500, archived: 1000})
    const client = createMockSdkClient({sessionListResponse: {data: [archived]}})

    // #when
    const result = await resolveSessionForLogicalKey(
      client as unknown as SessionClient,
      '/workspace',
      key,
      createMockLogger(),
    )

    // #then
    expect(result).toEqual({status: 'not-found'})
  })

  it('returns not-found when matched session is mid-compaction', async () => {
    // #given
    const key = {key: 'pr-347', entityType: 'pr' as const, entityId: '347'}
    const compacting = createSession({
      id: 'ses_compacting',
      title: 'fro-bot: pr-347',
      updated: 500,
      compacting: 900,
    })
    const client = createMockSdkClient({sessionListResponse: {data: [compacting]}})

    // #when
    const result = await resolveSessionForLogicalKey(
      client as unknown as SessionClient,
      '/workspace',
      key,
      createMockLogger(),
    )

    // #then
    expect(result).toEqual({status: 'not-found'})
  })
})
