import type {OpenCodeServerHandle} from '@fro-bot/runtime'

import {describe, expect, it, vi} from 'vitest'

import {createPostReplyFactoryV1} from './permission-reply-v1.js'

function makeHandle(post: ReturnType<typeof vi.fn>): Pick<OpenCodeServerHandle, 'client'> {
  return {client: {postSessionIdPermissionsPermissionId: post}} as unknown as Pick<OpenCodeServerHandle, 'client'>
}

describe('createPostReplyFactoryV1', () => {
  it.each([
    ['once', 'once'],
    ['always', 'once'],
    ['reject', 'reject'],
  ] as const)('sends %s upstream as %s, with the directory in the query', async (decision, sent) => {
    // #given
    const post = vi.fn().mockResolvedValue({error: null})
    const postReply = createPostReplyFactoryV1(makeHandle(post))('ses_1')

    // #when
    const result = await postReply('per_a', '/workspace/repos/o/r', decision)

    // #then — an operator `always` never reaches V1's directory-keyed `approved` list
    expect(result).toEqual({ok: true})
    expect(post).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: {id: 'ses_1', permissionID: 'per_a'},
        body: {response: sent},
        query: {directory: '/workspace/repos/o/r'},
      }),
    )
  })

  it('reports an SDK error envelope as a failed reply', async () => {
    const post = vi.fn().mockResolvedValue({error: {name: 'NotFoundError', data: {message: 'gone'}}})
    const result = await createPostReplyFactoryV1(makeHandle(post))('ses_1')('per_a', '/d', 'once')
    expect(result.ok).toBe(false)
  })

  it('reports a thrown reply as a failed reply', async () => {
    const post = vi.fn().mockRejectedValue(new Error('boom'))
    const result = await createPostReplyFactoryV1(makeHandle(post))('ses_1')('per_a', '/d', 'once')
    expect(result).toEqual({ok: false, error: 'boom'})
  })
})
