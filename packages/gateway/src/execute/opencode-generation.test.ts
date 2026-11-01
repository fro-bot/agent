import type {RepoQuiescence} from '../runtime-effect.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {RepoQuiescenceChecker} from './repo-quiescence.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {createGenerationAwareQuiescenceChecker} from './opencode-generation.js'

describe('createGenerationAwareQuiescenceChecker', () => {
  const CLEAR: RepoQuiescence = {
    kind: 'clear',
    source: 'opencode-session-status',
    directory: '/d',
    checkedAt: '2026-01-01T00:00:00.000Z',
  }
  const context = {repo: 'o/r', signal: new AbortController().signal}

  function make(readyz: () => Promise<ReturnType<typeof ok<ReadyzResponse>> | ReturnType<typeof err<WorkspaceError>>>) {
    const v1 = vi.fn<RepoQuiescenceChecker>().mockResolvedValue(CLEAR)
    const v2 = vi.fn<RepoQuiescenceChecker>().mockResolvedValue(CLEAR)
    const warn = vi.fn()
    const checker = createGenerationAwareQuiescenceChecker({
      readyz,
      v1,
      v2,
      logger: {debug: vi.fn(), info: vi.fn(), warn, error: vi.fn()},
    })
    return {checker, v1, v2, warn}
  }

  it('checks with the V2 sibling when the workspace reports a V2 version', async () => {
    // #given
    const {checker, v1, v2} = make(async () => ok({ready: true, opencode: 'ready', opencodeVersion: '2.2.0'}))

    // #when
    const result = await checker(context)

    // #then
    expect(result).toBe(CLEAR)
    expect(v2).toHaveBeenCalledWith(context)
    expect(v1).not.toHaveBeenCalled()
  })

  it('checks with the V1 checker when the workspace reports no version', async () => {
    // #given
    const {checker, v1, v2} = make(async () => ok({ready: true, opencode: 'ready'}))

    // #when
    await checker(context)

    // #then
    expect(v1).toHaveBeenCalledWith(context)
    expect(v2).not.toHaveBeenCalled()
  })

  it('still selects from the version when the workspace is not ready', async () => {
    // #given — a starting workspace answers 503 with the same fields
    const {checker, v2} = make(async () => ok({ready: false, opencode: 'starting', opencodeVersion: '2.2.0'}))

    // #when
    await checker(context)

    // #then
    expect(v2).toHaveBeenCalled()
  })

  it('reports unknown, and runs no check, when the workspace cannot be asked', async () => {
    // #given — guessing a generation could read an empty answer from the wrong API as "clear"
    const {checker, v1, v2, warn} = make(async () => err({kind: 'network-error'}))

    // #when
    const result = await checker(context)

    // #then
    expect(result).toEqual({kind: 'unknown', source: 'unavailable', directory: null, reason: 'generation-unavailable'})
    expect(v1).not.toHaveBeenCalled()
    expect(v2).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('reports unknown when the reported version cannot be read', async () => {
    // #given
    const {checker, v1, v2} = make(async () => ok({ready: true, opencode: 'ready', opencodeVersion: 'latest'}))

    // #when
    const result = await checker(context)

    // #then
    expect(result).toMatchObject({kind: 'unknown', reason: 'generation-unreadable'})
    expect(v1).not.toHaveBeenCalled()
    expect(v2).not.toHaveBeenCalled()
  })

  it('does not hang on a readyz that never answers once the caller aborts', async () => {
    // #given
    const controller = new AbortController()
    const {checker} = make(async () => new Promise(() => undefined))

    // #when
    const pending = checker({repo: 'o/r', signal: controller.signal})
    controller.abort()

    // #then
    await expect(pending).resolves.toMatchObject({kind: 'unknown', reason: 'generation-unavailable'})
  })
})
