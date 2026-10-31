import {createOwnershipLedger, shellLedgerKey} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {collectRunUsageV2, parseSessionUsageV2, readSessionUsageV2} from './usage-v2.js'

function sessionRecord(input: number, cost: number, model: {providerID: string; id: string} | null = null) {
  return {
    data: {
      id: 'ses',
      cost,
      tokens: {input, output: input / 2, reasoning: 1, cache: {read: 10, write: 5}},
      ...(model === null ? {} : {model}),
    },
  }
}

function routeOf(records: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    const id = decodeURIComponent(path.replace('/api/session/', ''))
    return id in records ? new Response(JSON.stringify(records[id]), {status: 200}) : new Response(null, {status: 404})
  })
}

describe('parseSessionUsageV2', () => {
  it('reads cumulative tokens, cost and the model from a V2 session record', () => {
    // #given / #when
    const usage = parseSessionUsageV2(sessionRecord(100, 0.25, {providerID: 'anthropic', id: 'claude-x'}))

    // #then
    expect(usage).toEqual({
      tokens: {input: 100, output: 50, reasoning: 1, cache: {read: 10, write: 5}},
      cost: 0.25,
      model: 'anthropic/claude-x',
    })
  })

  it('reads a record with no model as a null model, and a record with no usage as nothing', () => {
    // #given / #when / #then
    expect(parseSessionUsageV2(sessionRecord(1, 0))?.model).toBeNull()
    expect(parseSessionUsageV2({data: {id: 'ses'}})).toBeNull()
    expect(parseSessionUsageV2(null)).toBeNull()
  })
})

describe('readSessionUsageV2', () => {
  it('is null when the session cannot be read, rather than throwing', async () => {
    // #given / #when / #then
    expect(await readSessionUsageV2(routeOf({}), 'ses_gone')).toBeNull()
    expect(
      await readSessionUsageV2(async () => {
        throw new Error('socket closed')
      }, 'ses'),
    ).toBeNull()
  })
})

describe('collectRunUsageV2', () => {
  it('reports the root growth since the baseline plus every child session the run started', async () => {
    // #given a continued root that already carried 100 tokens and 0.1, and one child; a shell is not a session
    const fetchRoute = routeOf({
      ses_root: sessionRecord(300, 0.4, {providerID: 'p', id: 'm'}),
      ses_child: sessionRecord(40, 0.05),
    })
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'child')
    ledger.adopt(shellLedgerKey('sh_1'), 'shell')
    const baseline = parseSessionUsageV2(sessionRecord(100, 0.1))

    // #when
    const usage = await collectRunUsageV2({fetchRoute, rootSessionId: 'ses_root', baseline, ledger})

    // #then 200 + 40 input, cost 0.3 + 0.05, and no request was made for the shell
    expect(usage.tokens).toEqual({input: 240, output: 120, reasoning: 1, cache: {read: 10, write: 5}})
    expect(usage.cost).toBeCloseTo(0.35)
    expect(usage.model).toBe('p/m')
    expect(fetchRoute.mock.calls.map(([path]) => path)).toEqual(['/api/session/ses_root', '/api/session/ses_child'])
  })

  it('reports nothing rather than a partial when the root cannot be read', async () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'child')

    // #when
    const usage = await collectRunUsageV2({
      fetchRoute: routeOf({ses_child: sessionRecord(40, 0.05)}),
      rootSessionId: 'ses_root',
      baseline: null,
      ledger,
    })

    // #then
    expect(usage).toEqual({tokens: null, cost: null, model: null})
  })
})
