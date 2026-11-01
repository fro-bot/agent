import type {ActionOpenCodeV2Client} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {resolveAmbiguousAdmission} from './admission-v2.js'

const SESSION = 'ses_root'
const SENT_AT = 1_000_000

const ok = <T>(data: T) => ({success: true as const, data})

function client(overrides: {
  messages?: () => Promise<unknown>
  active?: () => Promise<Record<string, unknown>>
  inbox?: () => Promise<unknown>
}): ActionOpenCodeV2Client {
  return {
    listRecentUserMessages: vi.fn(overrides.messages ?? (async () => ok([]))),
    session: {active: vi.fn(overrides.active ?? (async () => ({})))},
    listSessionInbox: vi.fn(overrides.inbox ?? (async () => ok({queued: 0}))),
  } as unknown as ActionOpenCodeV2Client
}

async function resolve(api: ActionOpenCodeV2Client) {
  return resolveAmbiguousAdmission({
    client: api,
    sessionId: SESSION,
    promptText: 'do the thing',
    sentAt: SENT_AT,
    logger: createMockLogger(),
    retryDelayMs: 1,
    timeoutMs: 2_000,
  })
}

describe('resolveAmbiguousAdmission', () => {
  it('reports admitted when a user message with the prompt text was created since the send began', async () => {
    // #given a message created a moment after the POST started
    const api = client({messages: async () => ok([{id: 'msg_1', text: 'do the thing', createdAt: SENT_AT + 5}])})

    // #when / #then
    expect(await resolve(api)).toBe('admitted')
  })

  it('does not take an older message with the same text for this prompt', async () => {
    // #given an identical prompt from an earlier turn, well before the send
    const api = client({messages: async () => ok([{id: 'msg_0', text: 'do the thing', createdAt: SENT_AT - 60_000}])})

    // #when / #then the root is idle and the inbox empty: nothing of this prompt is in flight
    expect(await resolve(api)).toBe('absent')
  })

  it('reports absent only when the root is idle and nothing is queued', async () => {
    // #given / #when / #then
    expect(await resolve(client({}))).toBe('absent')
  })

  it('cannot tell when the root is running, because a prompt queued behind a turn is not a message yet', async () => {
    // #given
    const api = client({active: async () => ({[SESSION]: {type: 'running'}})})

    // #when / #then
    expect(await resolve(api)).toBe('unknown')
  })

  it('cannot tell when the inbox holds an item', async () => {
    // #given
    const api = client({inbox: async () => ok({queued: 1})})

    // #when / #then
    expect(await resolve(api)).toBe('unknown')
  })

  it('cannot tell when the reads keep failing, after bounded attempts', async () => {
    // #given
    const api = client({messages: async () => ({success: false, error: {kind: 'network', message: 'down'}})})

    // #when
    const verdict = await resolve(api)

    // #then
    expect(verdict).toBe('unknown')
    expect(api.listRecentUserMessages).toHaveBeenCalledTimes(3)
  })

  it('gives an answer within its bound even when a read never returns', async () => {
    // #given a read that only ends when its signal aborts
    const api = client({
      messages: async () => new Promise<never>(() => undefined),
    })
    vi.mocked(api.listRecentUserMessages).mockImplementation(
      async ({signal}: {signal?: AbortSignal}) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
        }),
    )
    const startedAt = Date.now()

    // #when
    const verdict = await resolveAmbiguousAdmission({
      client: api,
      sessionId: SESSION,
      promptText: 'x',
      sentAt: SENT_AT,
      logger: createMockLogger(),
      timeoutMs: 80,
      retryDelayMs: 1,
    })

    // #then
    expect(verdict).toBe('unknown')
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  })
})
