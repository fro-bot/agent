import type {RemoteOpenCodeV2Client} from '@fro-bot/runtime'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {createPostReplyFactoryV2, OPERATOR_REJECT_MESSAGE_V2} from './permission-reply-v2.js'

function makeClient(reply: ReturnType<typeof vi.fn>): RemoteOpenCodeV2Client {
  return {replyPermission: reply} as unknown as RemoteOpenCodeV2Client
}

describe('createPostReplyFactoryV2', () => {
  it.each([
    ['once', 'once'],
    ['always', 'once'],
    ['reject', 'reject'],
  ] as const)('sends %s as %s keyed by the request id on the asking session', async (decision, sent) => {
    // #given
    const reply = vi.fn().mockResolvedValue(ok(undefined))
    const postReply = createPostReplyFactoryV2(makeClient(reply))('ses_1')

    // #when
    const result = await postReply('per_a', '/workspace/repos/o/r', decision)

    // #then
    expect(result).toEqual({ok: true})
    const input = reply.mock.calls[0]?.[0] as {
      sessionId: string
      requestId: string
      decision: string
      signal: unknown
    }
    expect(input).toMatchObject({sessionId: 'ses_1', requestId: 'per_a', decision: sent})
    expect(input.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends the exact operator message with every reject, so the turn continues', async () => {
    // #given
    const reply = vi.fn().mockResolvedValue(ok(undefined))
    const postReply = createPostReplyFactoryV2(makeClient(reply))('ses_1')

    // #when
    await postReply('per_a', '/d', 'reject')

    // #then — a bare reject would interrupt the execution upstream
    const input = reply.mock.calls[0]?.[0] as {message?: string}
    expect(input.message).toBe(
      "The operator rejected this request. Don't retry it; continue without it, or explain what you need.",
    )
    expect(OPERATOR_REJECT_MESSAGE_V2).toBe(input.message)
  })

  it.each(['once', 'always'] as const)('sends no message with %s', async decision => {
    // #given
    const reply = vi.fn().mockResolvedValue(ok(undefined))
    const postReply = createPostReplyFactoryV2(makeClient(reply))('ses_1')

    // #when
    await postReply('per_a', '/d', decision)

    // #then
    expect(reply.mock.calls[0]?.[0]).not.toHaveProperty('message')
  })

  it('keeps two nested approvals from one execute call distinct', async () => {
    // #given — one execute call asked twice; the two replies differ
    const reply = vi.fn().mockResolvedValue(ok(undefined))
    const postReply = createPostReplyFactoryV2(makeClient(reply))('ses_1')

    // #when
    await postReply('per_1', '/d', 'once')
    await postReply('per_2', '/d', 'reject')

    // #then
    const sent = reply.mock.calls.map(([input]) => input as {requestId: string; decision: string})
    expect(sent.map(input => [input.requestId, input.decision])).toEqual([
      ['per_1', 'once'],
      ['per_2', 'reject'],
    ])
  })

  it('reports a failed reply as a short code, never as response text', async () => {
    // #given
    const reply = vi.fn().mockResolvedValue(err({kind: 'http', status: 404}))
    const postReply = createPostReplyFactoryV2(makeClient(reply))('ses_1')

    // #when
    const result = await postReply('per_a', '/d', 'once')

    // #then
    expect(result).toEqual({ok: false, error: 'http 404'})
  })

  it('reports a thrown reply without its message', async () => {
    // #given
    const reply = vi.fn().mockRejectedValue(new Error('secret detail'))
    const postReply = createPostReplyFactoryV2(makeClient(reply))('ses_1')

    // #when
    const result = await postReply('per_a', '/d', 'once')

    // #then
    expect(result).toEqual({ok: false, error: 'threw'})
  })
})
