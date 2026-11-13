import type {AddressInfo} from 'node:net'
import type {KeyProxyProviderPlan} from '../../services/setup/key-proxy-providers.js'
import http from 'node:http'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls} from '../../shared/test-helpers.js'
import {KEY_PROXY_PROBE_TIMEOUT_MS, probeKeyProxy} from './key-proxy-probe.js'

const PLACEHOLDER = 'placeholder-probe-0123456789abcdefghijklmnopqrstuv'
const BODY_CANARY = 'upstream-body-CANARY-must-never-be-logged'

const ANTHROPIC: KeyProxyProviderPlan = {providerId: 'anthropic', baseUrl: null, protocols: ['anthropic-messages']}
const OPENAI: KeyProxyProviderPlan = {
  providerId: 'openai',
  baseUrl: null,
  protocols: ['openai-responses', 'openai-chat'],
}

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
}

describe('probeKeyProxy', () => {
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })

  /** A loopback server standing in for the proxy. `handler` decides the answer; every request is recorded. */
  async function proxyStandIn(handler: (res: http.ServerResponse) => void) {
    const seen: Seen[] = []
    const server = http.createServer((req, res) => {
      seen.push({method: req.method ?? '', url: req.url ?? '', headers: req.headers})
      handler(res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    closers.push(async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    return {seen, baseUrl: (providerId: string) => `http://127.0.0.1:${port}/${providerId}`}
  }

  const answer =
    (status: number, body = BODY_CANARY) =>
    (res: http.ServerResponse) => {
      res.writeHead(status, {'content-type': 'application/json'})
      res.end(body)
    }

  async function probe(
    plan: KeyProxyProviderPlan,
    handler: (res: http.ServerResponse) => void,
    extra: {readonly timeoutMs?: number; readonly signal?: AbortSignal} = {},
  ) {
    const stand = await proxyStandIn(handler)
    const logger = createMockLogger()
    const result = await probeKeyProxy({
      plan,
      proxy: {baseUrl: stand.baseUrl, placeholder: PLACEHOLDER},
      logger,
      ...extra,
    })
    return {result, logger, seen: stand.seen}
  }

  it('passes on a 200 and sends one GET to the models route with the Bearer placeholder', async () => {
    // #given an OpenAI provider and a proxy that answers 200
    // #when probed
    const {result, seen, logger} = await probe(OPENAI, answer(200, '{"data":[]}'))

    // #then it passed with one GET to /openai/models, carrying only the placeholder
    expect(result).toEqual({status: 'passed'})
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({method: 'GET', url: '/openai/models'})
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${PLACEHOLDER}`)
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('uses x-api-key for a Messages provider', async () => {
    const {result, seen} = await probe(ANTHROPIC, answer(200, '{}'))

    expect(result).toEqual({status: 'passed'})
    expect(seen[0]).toMatchObject({method: 'GET', url: '/anthropic/models'})
    expect(seen[0]?.headers['x-api-key']).toBe(PLACEHOLDER)
    expect(seen[0]?.headers.authorization).toBeUndefined()
  })

  it('passes on a 200 whatever the body is, and never reads it', async () => {
    const {result} = await probe(OPENAI, answer(200, 'not json at all {{{'))

    expect(result).toEqual({status: 'passed'})
  })

  it.each([401, 403])('fails as auth-rejected on a %i, naming the provider and never the body', async status => {
    // #given the upstream rejects the key
    // #when probed
    const {result, logger} = await probe(OPENAI, answer(status))

    // #then the probe fails with the class and a message that names the provider and holds no body
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected a failure')
    expect(result.class).toBe('auth-rejected')
    expect(result.message).toContain('openai')
    expect(result.message).toContain('auth-rejected')
    expect(result.message).not.toContain(BODY_CANARY)
    expect(result.message).not.toContain(PLACEHOLDER)
    expect(serializeLoggerCalls(logger)).not.toContain(BODY_CANARY)
  })

  it.each([
    [429, 'rate-limited'],
    [404, 'unverifiable'],
    [405, 'unverifiable'],
    [500, 'unverifiable'],
    [302, 'unverifiable'],
  ])('warns with the class and continues on a %i (%s)', async (status, expectedClass) => {
    // #given a status that does not prove the key bad
    // #when probed
    const {result, logger} = await probe(OPENAI, answer(status))

    // #then the run continues, with one warning that names the provider and the class
    expect(result).toEqual({status: 'warned', class: expectedClass})
    expect(logger.warning).toHaveBeenCalledTimes(1)
    const logged = serializeLoggerCalls(logger)
    expect(logged).toContain('openai')
    expect(logged).toContain(expectedClass)
    expect(logged).not.toContain(BODY_CANARY)
    expect(logged).not.toContain(PLACEHOLDER)
  })

  it('warns unreachable on a timeout and continues', async () => {
    // #given a proxy that never answers
    const never = (_res: http.ServerResponse): void => undefined

    // #when probed with a short bound
    const started = Date.now()
    const {result, logger} = await probe(OPENAI, never, {timeoutMs: 100})

    // #then it gave up at the bound and warned
    expect(result).toEqual({status: 'warned', class: 'unreachable'})
    expect(Date.now() - started).toBeLessThan(5000)
    expect(serializeLoggerCalls(logger)).toContain('unreachable')
  })

  it('warns unverifiable when the answer is not an HTTP response', async () => {
    // #given a server that writes garbage and hangs up
    const server = http.createServer()
    server.on('connection', socket => socket.end('this is not http\r\n\r\n'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    closers.push(async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    const logger = createMockLogger()

    // #when probed
    const result = await probeKeyProxy({
      plan: OPENAI,
      proxy: {baseUrl: id => `http://127.0.0.1:${port}/${id}`, placeholder: PLACEHOLDER},
      logger,
    })

    // #then it is unverifiable, not a failure
    expect(result).toEqual({status: 'warned', class: 'unverifiable'})
    expect(logger.warning).toHaveBeenCalledTimes(1)
  })

  it('aborts when the run signal aborts, and does not warn', async () => {
    // #given a proxy that never answers and a run that is cancelled
    const controller = new AbortController()
    const stand = await proxyStandIn(() => undefined)
    const logger = createMockLogger()
    const pending = probeKeyProxy({
      plan: OPENAI,
      proxy: {baseUrl: stand.baseUrl, placeholder: PLACEHOLDER},
      logger,
      signal: controller.signal,
    })

    // #when the run aborts
    await vi.waitFor(() => {
      expect(stand.seen).toHaveLength(1)
    })
    controller.abort()

    // #then the probe stops with an aborted result (the run is ending, so this is not a provider verdict)
    expect(await pending).toEqual({status: 'aborted', message: expect.stringContaining('openai') as string})
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('does not send when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const {result, seen} = await probe(OPENAI, answer(200), {signal: controller.signal})

    expect(result.status).toBe('aborted')
    expect(seen).toHaveLength(0)
  })

  it('warns unverifiable when the provider has no models route to probe', async () => {
    // #given a plan the route table cannot build (an unknown provider with no base URL)
    const stand = await proxyStandIn(answer(200))
    const logger = createMockLogger()

    // #when probed
    const result = await probeKeyProxy({
      plan: {providerId: 'groq', baseUrl: null, protocols: ['openai-chat']},
      proxy: {baseUrl: stand.baseUrl, placeholder: PLACEHOLDER},
      logger,
    })

    // #then nothing is sent and the run continues
    expect(result).toEqual({status: 'warned', class: 'unverifiable'})
    expect(stand.seen).toHaveLength(0)
  })

  it('bounds the probe at 10 seconds by default', () => {
    expect(KEY_PROXY_PROBE_TIMEOUT_MS).toBe(10_000)
  })
})
