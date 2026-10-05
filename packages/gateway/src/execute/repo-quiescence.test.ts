import type {GatewayLogger} from '../discord/client.js'
import type {SessionStatusClient} from './repo-quiescence.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createRepoQuiescenceChecker} from './repo-quiescence.js'

const attachOpencodeMock = vi.hoisted(() => vi.fn())
vi.mock('./opencode-attach.js', () => ({attachOpencode: attachOpencodeMock}))

const TOKEN = 'super-secret-bearer'
const NOW = new Date('2026-04-24T18:15:00.000Z')

type StatusFn = SessionStatusClient['session']['status']
type StatusResult = Awaited<ReturnType<StatusFn>>

function logger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function jsonResponse(
  overrides: Partial<{ok: boolean; status: number; type: string | null; length: string | null}> = {},
) {
  const {ok = true, status = 200, type = 'application/json', length = '10'} = overrides
  return {
    ok,
    status,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type' ? type : name.toLowerCase() === 'content-length' ? length : null,
    },
  }
}

function okResult(data: unknown): StatusResult {
  return {data, response: jsonResponse()}
}

function checkerFor(status: StatusFn, log: GatewayLogger = logger()) {
  const client: SessionStatusClient = {session: {status}}
  return createRepoQuiescenceChecker({
    workspaceOpencodeUrl: 'http://workspace:9200',
    workspaceOpencodeToken: TOKEN,
    logger: log,
    createClient: () => client,
    now: () => NOW,
  })
}

const signal = () => new AbortController().signal

describe('createRepoQuiescenceChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queries the canonical lowercased repo directory with the caller signal chain', async () => {
    // #given
    const status = vi.fn<StatusFn>(async () => okResult({}))

    // #when
    await checkerFor(status)({repo: 'Acme/Widget', signal: signal()})

    // #then
    expect(status).toHaveBeenCalledWith({
      query: {directory: '/workspace/repos/acme/widget'},
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      signal: expect.any(AbortSignal),
    })
  })

  it('reports clear for an empty status map and for idle-only entries (sound only because the queried directory is the canonical checkout)', async () => {
    // #given — `session.status` returns `{}` for ANY directory without sessions, so `{}` means "quiescent" only
    // because this checker queries the same canonical directory the run's sessions use (canonicalWorkspaceTarget).
    const empty = checkerFor(async () => okResult({}))
    const idle = checkerFor(async () => okResult({ses_a: {type: 'idle'}}))

    // #when
    const [a, b] = await Promise.all([
      empty({repo: 'acme/widget', signal: signal()}),
      idle({repo: 'acme/widget', signal: signal()}),
    ])

    // #then
    const expected = {
      kind: 'clear',
      source: 'opencode-session-status',
      directory: '/workspace/repos/acme/widget',
      checkedAt: NOW.toISOString(),
    }
    expect(a).toEqual(expected)
    expect(b).toEqual(expected)
  })

  it('blocks on a busy child even when the root session is idle or missing', async () => {
    // #given — child sessions appear independently of their (idle/absent) root
    const rootIdle = checkerFor(async () => okResult({ses_root: {type: 'idle'}, ses_child: {type: 'busy'}}))
    const rootMissing = checkerFor(async () => okResult({ses_child: {type: 'busy'}}))

    // #when
    const [a, b] = await Promise.all([
      rootIdle({repo: 'acme/widget', signal: signal()}),
      rootMissing({repo: 'acme/widget', signal: signal()}),
    ])

    // #then
    expect(a).toMatchObject({kind: 'busy', sessionIds: ['ses_child']})
    expect(b).toMatchObject({kind: 'busy', sessionIds: ['ses_child']})
  })

  it('treats retry as busy', async () => {
    // #given
    const checker = checkerFor(async () => okResult({ses_a: {type: 'retry', attempt: 1, message: 'x', next: 1}}))

    // #when
    const result = await checker({repo: 'acme/widget', signal: signal()})

    // #then
    expect(result).toMatchObject({kind: 'busy', sessionIds: ['ses_a']})
  })

  it('does not let another repo instance block this one', async () => {
    // #given — the server scopes the map by directory; only widget is busy
    const status = vi.fn<StatusFn>(async ({query}) =>
      okResult(query.directory === '/workspace/repos/acme/widget' ? {ses_busy: {type: 'busy'}} : {}),
    )
    const checker = checkerFor(status)

    // #when
    const gadget = await checker({repo: 'acme/gadget', signal: signal()})
    const widget = await checker({repo: 'acme/widget', signal: signal()})

    // #then
    expect(gadget.kind).toBe('clear')
    expect(widget.kind).toBe('busy')
  })

  it('logs at most 32 busy ids but returns and counts all of them', async () => {
    // #given
    const data = Object.fromEntries(Array.from({length: 40}, (_unused, index) => [`ses_${index}`, {type: 'busy'}]))
    const log = logger()

    // #when
    const result = await checkerFor(async () => okResult(data), log)({repo: 'acme/widget', signal: signal()})

    // #then
    expect(result.kind === 'busy' ? result.sessionIds : []).toHaveLength(40)
    expect(log.info).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      expect.objectContaining({busyCount: 40, sessionIds: expect.arrayContaining(['ses_0'])}),
      expect.any(String),
    )
    const logged = vi.mocked(log.info).mock.calls[0]?.[0] as {sessionIds: string[]}
    expect(logged.sessionIds).toHaveLength(32)
  })

  it.each(['acme', 'a/b/c', '', '../widget', 'acme/..', 'acme/wid get', '/acme/widget', 'acme/widget/'])(
    'returns unknown without calling the client for invalid repo %j',
    async repo => {
      // #given
      const status = vi.fn<StatusFn>(async () => okResult({}))

      // #when
      const result = await checkerFor(status)({repo, signal: signal()})

      // #then
      expect(result).toEqual({kind: 'unknown', source: 'unavailable', directory: null, reason: 'invalid-repo'})
      expect(status).not.toHaveBeenCalled()
    },
  )

  describe('every failure mode is unknown', () => {
    const cases: readonly (readonly [string, StatusFn])[] = [
      [
        'thrown error',
        async () => {
          throw new Error(`connect refused ${TOKEN}`)
        },
      ],
      ['SDK error envelope', async () => ({error: {message: 'bad'}, response: jsonResponse({ok: false, status: 400})})],
      ['non-2xx without envelope', async () => ({response: jsonResponse({ok: false, status: 502})})],
      ['missing data', async () => ({response: jsonResponse()})],
      ['null data', async () => okResult(null)],
      ['array data', async () => okResult([])],
      ['string data', async () => okResult('nope')],
      ['204 (SDK rewrites to {})', async () => ({data: {}, response: jsonResponse({status: 204})})],
      ['zero-length body (SDK rewrites to {})', async () => ({data: {}, response: jsonResponse({length: '0'})})],
      ['non-json content type', async () => ({data: {}, response: jsonResponse({type: 'text/html'})})],
      ['missing content type', async () => ({data: {}, response: jsonResponse({type: null})})],
      ['missing response object', async () => ({data: {}})],
      ['invalid entry shape', async () => okResult({ses_a: 'busy'})],
      ['unrecognized status type', async () => okResult({ses_a: {type: 'sleeping'}})],
      ['null entry', async () => okResult({ses_a: null})],
    ]

    it.each(cases)('%s', async (_label, status) => {
      // #given
      const log = logger()

      // #when
      const result = await checkerFor(status, log)({repo: 'acme/widget', signal: signal()})

      // #then
      expect(result.kind).toBe('unknown')
      expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(TOKEN)
    })

    it('a busy entry still wins over an invalid sibling', async () => {
      // #given
      const checker = checkerFor(async () => okResult({ses_a: 'garbage', ses_b: {type: 'busy'}}))

      // #when
      const result = await checker({repo: 'acme/widget', signal: signal()})

      // #then
      expect(result.kind).toBe('busy')
    })

    it('times out when the request hangs, even if the client ignores the abort signal', async () => {
      // #given
      const checker = checkerFor(async () => new Promise<StatusResult>(() => {}))

      // #when
      const pending = checker({repo: 'acme/widget', signal: signal()})
      await vi.advanceTimersByTimeAsync(4_000)
      const result = await pending

      // #then
      expect(result).toMatchObject({
        kind: 'unknown',
        source: 'opencode-session-status',
        reason: 'status-request-timeout',
      })
    })

    it('aborts promptly when the caller signal aborts', async () => {
      // #given
      const controller = new AbortController()
      const checker = checkerFor(async () => new Promise<StatusResult>(() => {}))

      // #when
      const pending = checker({repo: 'acme/widget', signal: controller.signal})
      controller.abort()
      const result = await pending

      // #then
      expect(result).toMatchObject({kind: 'unknown', reason: 'status-request-aborted'})
    })

    it('returns unknown immediately when the caller signal is already aborted', async () => {
      // #given
      const controller = new AbortController()
      controller.abort()
      const status = vi.fn<StatusFn>(async () => new Promise<StatusResult>(() => {}))

      // #when
      const result = await checkerFor(status)({repo: 'acme/widget', signal: controller.signal})

      // #then
      expect(result).toMatchObject({kind: 'unknown', reason: 'status-request-aborted'})
    })
  })

  it('does not cache clearance between calls', async () => {
    // #given — first call clear, second call busy
    const status = vi
      .fn<StatusFn>()
      .mockResolvedValueOnce(okResult({}))
      .mockResolvedValueOnce(okResult({ses_a: {type: 'busy'}}))
    const checker = checkerFor(status)

    // #when
    const first = await checker({repo: 'acme/widget', signal: signal()})
    const second = await checker({repo: 'acme/widget', signal: signal()})

    // #then
    expect([first.kind, second.kind]).toEqual(['clear', 'busy'])
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('attaches with the workspace URL and bearer token by default and never logs the token', async () => {
    // #given
    const status = vi.fn<StatusFn>(async () => okResult({}))
    attachOpencodeMock.mockReturnValue({client: {session: {status}}})
    const log = logger()

    // #when
    const result = await createRepoQuiescenceChecker({
      workspaceOpencodeUrl: 'http://workspace:9200',
      workspaceOpencodeToken: TOKEN,
      logger: log,
    })({repo: 'acme/widget', signal: signal()})

    // #then
    expect(attachOpencodeMock).toHaveBeenCalledWith('http://workspace:9200', TOKEN)
    expect(result.kind).toBe('clear')
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(TOKEN)
  })
})
