import type {V2SessionApi, V2SessionInfoLike} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {REPO_QUIESCENCE_TIMEOUT_MS} from './recovery-budget.js'
import {createRepoQuiescenceCheckerV2} from './repo-quiescence-v2.js'

const DIRECTORY = '/workspace/repos/o/r'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

interface Options {
  readonly active?: Readonly<Record<string, {readonly type: string}>>
  readonly sessions?: readonly V2SessionInfoLike[]
  readonly active_?: () => Promise<Readonly<Record<string, {readonly type: string}>>>
}

function makeChecker(options: Options = {}) {
  const list = vi.fn(async (input: {readonly directory?: string}) => ({
    data: (options.sessions ?? []).filter(session => session.location?.directory === input.directory),
  }))
  const api: V2SessionApi = {
    active: options.active_ ?? (async () => options.active ?? {}),
    list,
  }
  const logger = makeLogger()
  const checker = createRepoQuiescenceCheckerV2({
    workspaceOpencodeUrl: 'http://workspace:9200',
    workspaceOpencodeToken: 'secret',
    logger,
    createClient: () => ({session: api}),
    now: () => new Date('2026-10-28T00:00:00.000Z'),
  })
  return {checker, list, logger}
}

const context = (signal: AbortSignal = new AbortController().signal) => ({repo: 'o/r', signal})

afterEach(() => {
  vi.useRealTimers()
})

describe('createRepoQuiescenceCheckerV2', () => {
  it('is clear when nothing is active, and asks the server for nothing else', async () => {
    // #given
    const {checker, list} = makeChecker()

    // #when
    const result = await checker(context())

    // #then
    expect(result).toEqual({
      kind: 'clear',
      source: 'opencode-session-status',
      directory: DIRECTORY,
      checkedAt: '2026-10-28T00:00:00.000Z',
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('is busy when an active session lives in the repo directory, a background child included', async () => {
    // #given — the parent finished; its child is still running (probe P2, P9)
    const {checker, list} = makeChecker({
      active: {ses_child: {type: 'running'}},
      sessions: [
        {id: 'ses_parent', location: {directory: DIRECTORY}},
        {id: 'ses_child', parentID: 'ses_parent', location: {directory: DIRECTORY}},
      ],
    })

    // #when
    const result = await checker(context())

    // #then
    expect(result).toMatchObject({kind: 'busy', directory: DIRECTORY, sessionIds: ['ses_child']})
    expect(list).toHaveBeenCalledWith(expect.objectContaining({directory: DIRECTORY}), expect.anything())
  })

  it('is clear when the active session belongs to another repo', async () => {
    // #given
    const {checker} = makeChecker({
      active: {ses_other: {type: 'running'}},
      sessions: [{id: 'ses_other', location: {directory: '/workspace/repos/o/elsewhere'}}],
    })

    // #when / #then
    expect(await checker(context())).toMatchObject({kind: 'clear'})
  })

  it('is unknown for a repo slug that names no workspace directory', async () => {
    // #given
    const {checker} = makeChecker()

    // #when
    const result = await checker({repo: '../etc', signal: new AbortController().signal})

    // #then
    expect(result).toEqual({kind: 'unknown', source: 'unavailable', directory: null, reason: 'invalid-repo'})
  })

  it('is unknown, never clear, when the active list cannot be read', async () => {
    // #given
    const {checker} = makeChecker({
      active_: async () => {
        throw new Error('session.active failed: http 503')
      },
    })

    // #when
    const result = await checker(context())

    // #then
    expect(result).toMatchObject({kind: 'unknown', source: 'opencode-session-status', reason: 'status-request-failed'})
  })

  it('is unknown when the caller aborts', async () => {
    // #given
    const controller = new AbortController()
    const {checker} = makeChecker({active_: async () => new Promise(() => undefined)})

    // #when
    const pending = checker(context(controller.signal))
    controller.abort()

    // #then
    await expect(pending).resolves.toMatchObject({kind: 'unknown', reason: 'status-request-aborted'})
  })

  it('is unknown once its own bound passes, even if the request ignores the signal', async () => {
    // #given
    vi.useFakeTimers()
    const {checker} = makeChecker({active_: async () => new Promise(() => undefined)})

    // #when
    const pending = checker(context())
    await vi.advanceTimersByTimeAsync(REPO_QUIESCENCE_TIMEOUT_MS + 1)

    // #then
    await expect(pending).resolves.toMatchObject({kind: 'unknown', reason: 'status-request-timeout'})
  })

  it('lists the session ids it reports busy with a bound on how many it logs', async () => {
    // #given
    const ids = Array.from({length: 40}, (_, index) => `ses_${index}`)
    const {checker, logger} = makeChecker({
      active: Object.fromEntries(ids.map(id => [id, {type: 'running'}])),
      sessions: ids.map(id => ({id, location: {directory: DIRECTORY}})),
    })

    // #when
    const result = await checker(context())

    // #then
    expect(result).toMatchObject({kind: 'busy'})
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({busyCount: 40, sessionIds: ids.slice(0, 32)}),
      'repo-quiescence: workspace busy',
    )
  })
})
