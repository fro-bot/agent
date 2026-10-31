import type {SessionClientV2} from '@fro-bot/runtime/session-v2'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {pruneSessionsV2} from './prune-v2.js'

const NOW = Date.UTC(2026, 9, 31)
const DAY = 24 * 60 * 60 * 1000

function session(id: string, daysOld: number) {
  return {
    id,
    projectID: 'prj_1',
    location: {directory: '/w'},
    title: id,
    time: {created: NOW - daysOld * DAY, updated: NOW - daysOld * DAY},
  }
}

function reader(items: readonly unknown[] | Error): SessionClientV2 {
  return {
    list: vi.fn(async () => {
      if (items instanceof Error) throw items
      return {data: items}
    }),
    get: vi.fn(),
    messages: vi.fn(),
  }
}

function fetchRoute(status = 204) {
  return vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, {status}))
}

describe('pruneSessionsV2', () => {
  it('deletes root sessions that are both older than the age limit and outside the newest few', async () => {
    // #given five roots, the age limit at 30 days, and room for the newest two
    const route = fetchRoute()
    const items = [session('ses_new', 0), session('ses_2', 5), session('ses_old_a', 40), session('ses_old_b', 60)]

    // #when
    const result = await pruneSessionsV2({
      reader: reader(items),
      fetchRoute: route,
      directory: '/w',
      config: {maxSessions: 2, maxAgeDays: 30},
      logger: createMockLogger(),
      now: () => NOW,
    })

    // #then
    expect(route.mock.calls.map(([path]) => path)).toEqual(['/api/session/ses_old_a', '/api/session/ses_old_b'])
    expect(route.mock.calls.every(([, init]) => init?.method === 'DELETE')).toBe(true)
    expect(result).toEqual({prunedCount: 2, remainingCount: 2})
  })

  it('keeps a recent session that is outside the newest few, because it is within the age limit', async () => {
    // #given room for one session, but three are within 30 days
    const route = fetchRoute()

    // #when
    const result = await pruneSessionsV2({
      reader: reader([session('ses_a', 1), session('ses_b', 10), session('ses_c', 29), session('ses_d', 31)]),
      fetchRoute: route,
      directory: '/w',
      config: {maxSessions: 1, maxAgeDays: 30},
      logger: createMockLogger(),
      now: () => NOW,
    })

    // #then only the one that is both old and outside the newest is deleted
    expect(route.mock.calls.map(([path]) => path)).toEqual(['/api/session/ses_d'])
    expect(result).toEqual({prunedCount: 1, remainingCount: 3})
  })

  it('keeps an old session while it is among the newest maxSessions', async () => {
    // #given
    const route = fetchRoute()

    // #when
    const result = await pruneSessionsV2({
      reader: reader([session('ses_a', 90), session('ses_b', 120)]),
      fetchRoute: route,
      directory: '/w',
      config: {maxSessions: 5, maxAgeDays: 30},
      logger: createMockLogger(),
      now: () => NOW,
    })

    // #then
    expect(route).not.toHaveBeenCalled()
    expect(result).toEqual({prunedCount: 0, remainingCount: 2})
  })

  it('counts a session that is already gone as pruned and one that fails as not', async () => {
    // #given
    const items = [session('ses_keep', 0), session('ses_gone', 90), session('ses_fail', 91)]
    const route = vi.fn(async (path: string) => new Response(null, {status: path.endsWith('ses_gone') ? 404 : 500}))
    const logger = createMockLogger()

    // #when
    const result = await pruneSessionsV2({
      reader: reader(items),
      fetchRoute: route,
      directory: '/w',
      config: {maxSessions: 1, maxAgeDays: 30},
      logger,
      now: () => NOW,
    })

    // #then
    expect(result.prunedCount).toBe(1)
    expect(logger.warning).toHaveBeenCalledWith('Failed to prune session', {sessionId: 'ses_fail'})
  })

  it('prunes nothing when the list cannot be read, and never throws', async () => {
    // #given
    const route = fetchRoute()

    // #when
    const result = await pruneSessionsV2({
      reader: reader(new Error('connection refused')),
      fetchRoute: route,
      directory: '/w',
      config: {maxSessions: 1, maxAgeDays: 1},
      logger: createMockLogger(),
      now: () => NOW,
    })

    // #then
    expect(route).not.toHaveBeenCalled()
    expect(result).toEqual({prunedCount: 0, remainingCount: 0})
  })
})
