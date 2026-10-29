import type {V2CallError, V2SessionApi, V2SessionInfoLike, V2ShellSummary} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {err, ok} from '@fro-bot/runtime'
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
  /** Shells the server lists as running for the location, whoever owns them. */
  readonly shells?: readonly V2ShellSummary[]
  readonly shellsError?: V2CallError
  readonly shells_?: () => Promise<never>
}

function makeChecker(options: Options = {}) {
  const list = vi.fn(async (input: {readonly directory?: string}) => ({
    data: (options.sessions ?? []).filter(session => session.location?.directory === input.directory),
  }))
  const listShells = vi.fn(async (_input: {readonly directory: string; readonly signal?: AbortSignal}) => {
    if (options.shells_ !== undefined) return options.shells_()
    if (options.shellsError !== undefined) return err(options.shellsError)
    return ok(options.shells ?? [])
  })
  const api: V2SessionApi = {
    active: options.active_ ?? (async () => options.active ?? {}),
    list,
  }
  const logger = makeLogger()
  const checker = createRepoQuiescenceCheckerV2({
    workspaceOpencodeUrl: 'http://workspace:9200',
    workspaceOpencodeToken: 'secret',
    logger,
    createClient: () => ({session: api, listShells}),
    now: () => new Date('2026-10-28T00:00:00.000Z'),
  })
  return {checker, list, listShells, logger}
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

  describe('background shells', () => {
    const shell = (id: string, owner: string | null, status: V2ShellSummary['status'] = 'running'): V2ShellSummary => ({
      id,
      status,
      ownerSessionId: owner,
      pid: 4242,
    })

    it('is busy while a shell runs in the repo directory, with every session idle', async () => {
      // #given — the root finished, the lock holder is gone, and a background shell still runs (probe p20)
      const {checker, listShells} = makeChecker({shells: [shell('sh_bg', 'ses_root')]})

      // #when
      const result = await checker(context())

      // #then — a shell can write the checkout whether or not any session is active
      expect(result).toMatchObject({kind: 'busy', directory: DIRECTORY, sessionIds: ['sh_bg']})
      expect(listShells).toHaveBeenCalledWith(expect.objectContaining({directory: DIRECTORY}))
    })

    it('is busy for a shell nobody tagged and one whose owner this check cannot name', async () => {
      // #given — `POST /api/shell` has no owner, and the dead run's sessions are not recoverable from its lease
      const {checker} = makeChecker({shells: [shell('sh_untagged', null), shell('sh_stranger', 'ses_unrelated')]})

      // #when
      const result = await checker(context())

      // #then
      expect(result).toMatchObject({kind: 'busy', sessionIds: ['sh_untagged', 'sh_stranger']})
    })

    it('lists busy sessions and running shells together', async () => {
      // #given
      const {checker} = makeChecker({
        active: {ses_child: {type: 'running'}},
        sessions: [{id: 'ses_child', location: {directory: DIRECTORY}}],
        shells: [shell('sh_bg', 'ses_child')],
      })

      // #when
      const result = await checker(context())

      // #then
      expect(result).toMatchObject({kind: 'busy', sessionIds: ['ses_child', 'sh_bg']})
    })

    it('is clear when the only shells are stopped ones', async () => {
      // #given — a list that includes records with a stopped status is not a running shell
      const {checker} = makeChecker({shells: [shell('sh_a', 'ses_root', 'exited'), shell('sh_b', null, 'killed')]})

      // #when / #then
      expect(await checker(context())).toMatchObject({kind: 'clear'})
    })

    it('reads a shell with a status it does not know as running', async () => {
      // #given
      const {checker} = makeChecker({shells: [shell('sh_a', null, 'unknown')]})

      // #when / #then
      expect(await checker(context())).toMatchObject({kind: 'busy', sessionIds: ['sh_a']})
    })

    it('is unknown, never clear, when the shell list cannot be read', async () => {
      // #given — the session side answers, the shell side does not
      const {checker} = makeChecker({shellsError: {kind: 'http', status: 503}})

      // #when
      const result = await checker(context())

      // #then
      expect(result).toMatchObject({
        kind: 'unknown',
        source: 'opencode-session-status',
        reason: 'status-request-failed',
      })
    })

    it('is unknown when the shell request outlives the bound', async () => {
      // #given
      vi.useFakeTimers()
      const {checker} = makeChecker({shells_: async () => new Promise<never>(() => undefined)})

      // #when
      const pending = checker(context())
      await vi.advanceTimersByTimeAsync(REPO_QUIESCENCE_TIMEOUT_MS + 1)

      // #then
      await expect(pending).resolves.toMatchObject({kind: 'unknown', reason: 'status-request-timeout'})
    })
  })
})
