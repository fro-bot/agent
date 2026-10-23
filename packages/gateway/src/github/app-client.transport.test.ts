/**
 * Transport-boundary tests for the `authForRepo` / `authForWorkflowDispatch` deadlines.
 *
 * These use the REAL `@octokit/auth-app`, `@octokit/core` and `@octokit/request` and replace only the
 * network (`fetch`) with a hanging stub, with an ephemeral RSA key and no network traffic. The mocked
 * tests in `app-client.test.ts` fake the auth function, so they accept any option they are handed; the
 * installed `@octokit/auth-app` ignores a per-invocation `request` option when it mints an installation
 * token, so only a test at this boundary proves the deadline reaches the token POST.
 */

import {generateKeyPairSync} from 'node:crypto'
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {AuthTimeoutError, createAppClient, INSTALLATION_TOKEN_MINT_TIMEOUT_MS} from './app-client.js'

let privateKey = ''

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
    publicKeyEncoding: {type: 'spki', format: 'pem'},
  })
  privateKey = pair.privateKey
})

interface SeenRequest {
  readonly method: string
  readonly url: string
  readonly signal: AbortSignal | null | undefined
  readonly authorization: string | undefined
  readonly userAgent: string | undefined
}

type Behaviour = 'respond' | 'hang'

interface FakeGitHub {
  readonly seen: SeenRequest[]
  readonly installationBehaviour: {current: Behaviour}
  readonly tokenBehaviour: {current: Behaviour}
  readonly permissions: {current: Record<string, string>}
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}})
}

/** A fetch that never answers, and rejects with the signal's reason when the signal aborts, like the real one. */
async function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    signal?.addEventListener('abort', () => {
      reject(signal.reason)
    })
  })
}

function installFakeGitHub(): FakeGitHub {
  const state: FakeGitHub = {
    seen: [],
    installationBehaviour: {current: 'respond'},
    tokenBehaviour: {current: 'respond'},
    permissions: {current: {contents: 'read'}},
  }
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    state.seen.push({
      method: init?.method ?? 'GET',
      url,
      signal: init?.signal,
      authorization: headers.get('authorization') ?? undefined,
      userAgent: headers.get('user-agent') ?? undefined,
    })
    if (url.includes('/access_tokens')) {
      if (state.tokenBehaviour.current === 'hang') return hang(init?.signal)
      return json({
        token: 'ghs_transport_token',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: state.permissions.current,
        repository_selection: 'selected',
        repositories: [{id: 1, name: 'bar'}],
      })
    }
    if (url.endsWith('/installation')) {
      if (state.installationBehaviour.current === 'hang') return hang(init?.signal)
      return json({id: 99, permissions: state.permissions.current})
    }
    throw new Error(`unexpected request to ${url}`)
  })
  return state
}

function tokenPosts(github: FakeGitHub): SeenRequest[] {
  return github.seen.filter(request => request.url.includes('/access_tokens'))
}

function discoveries(github: FakeGitHub): SeenRequest[] {
  return github.seen.filter(request => request.url.endsWith('/installation'))
}

/** `AbortSignal.timeout` handed out as controllable signals, one per call, so a test can fire "the deadline". */
function controllableDeadlines() {
  const controllers: AbortController[] = []
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController()
    controllers.push(controller)
    return controller.signal
  })
  return {
    controllers,
    spy,
    fire: (index = 0) => controllers[index]?.abort(new DOMException('The operation timed out.', 'TimeoutError')),
  }
}

/** Resolves to the settled value, or `'pending'` if it has not settled within `ms` of real time. */
async function settleWithin<T>(promise: Promise<T>, ms = 1_000): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms))])
}

/** Waits until the stub has seen `count` requests matching `pick` (the JWT signing and discovery take a few ms). */
async function untilSeen(count: number, pick: () => readonly unknown[]): Promise<void> {
  await vi.waitFor(() => expect(pick().length).toBeGreaterThanOrEqual(count), {timeout: 2_000, interval: 5})
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

function makeClient() {
  return createAppClient({appId: '12345', privateKey})
}

describe('authForRepo at the transport boundary', () => {
  let github: FakeGitHub

  beforeEach(() => {
    github = installFakeGitHub()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('succeeds against the fake transport, sending the app JWT on discovery and the installation request', async () => {
    // #given / #when
    const result = await makeClient().authForRepo('foo', 'bar')

    // #then a baseline: the real libraries work end to end with the stubbed network
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.token).toBe('ghs_transport_token')
    expect(discoveries(github)).toHaveLength(1)
    expect(tokenPosts(github)).toHaveLength(1)
    expect(tokenPosts(github)[0]?.authorization).toMatch(/^bearer /)
    expect(tokenPosts(github)[0]?.userAgent).toBeTruthy()
  })

  it('the token POST receives the deadline signal, and the mint ends with an AuthTimeoutError when it fires', async () => {
    // #given the token request hangs
    github.tokenBehaviour.current = 'hang'
    const deadline = controllableDeadlines()
    const pending = makeClient().authForRepo('foo', 'bar')
    await untilSeen(1, () => tokenPosts(github))

    // #then the transport has the request in hand, with a live (not yet aborted) signal
    expect(deadline.spy).toHaveBeenCalledExactlyOnceWith(INSTALLATION_TOKEN_MINT_TIMEOUT_MS)
    expect(tokenPosts(github)).toHaveLength(1)
    expect(tokenPosts(github)[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(tokenPosts(github)[0]?.signal?.aborted).toBe(false)

    // #when the deadline fires
    deadline.fire()
    const result = await settleWithin(pending)

    // #then the POST was aborted through its transport signal and the call ended as a timeout Result
    expect(tokenPosts(github)[0]?.signal?.aborted).toBe(true)
    expect(result).not.toBe('pending')
    if (result === 'pending') return
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(AuthTimeoutError)
  })

  it('a warm discovery cache still bounds the token POST', async () => {
    // #given a first call populates the discovery cache
    const client = makeClient()
    expect((await client.authForRepo('foo', 'bar')).success).toBe(true)
    expect(discoveries(github)).toHaveLength(1)

    // #when the second call's token request hangs
    github.tokenBehaviour.current = 'hang'
    const deadline = controllableDeadlines()
    const pending = client.authForRepo('foo', 'bar')
    await untilSeen(1, () => tokenPosts(github))
    deadline.fire()
    const result = await settleWithin(pending)

    // #then no new discovery ran, and the mint was aborted at the deadline
    expect(discoveries(github)).toHaveLength(1)
    expect(result).not.toBe('pending')
    if (result === 'pending') return
    expect(result.success === false && result.error instanceof AuthTimeoutError).toBe(true)
  })

  it('discovery and the token POST share ONE deadline: after discovery used part of the budget, the POST ends with it', async () => {
    // #given discovery succeeds, then the token request hangs
    github.tokenBehaviour.current = 'hang'
    const deadline = controllableDeadlines()
    const pending = makeClient().authForRepo('foo', 'bar')
    await untilSeen(1, () => tokenPosts(github))

    // #then one signal was created, and both requests carry the same one
    expect(deadline.controllers).toHaveLength(1)
    expect(discoveries(github)[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(tokenPosts(github)).toHaveLength(1)

    // #when the single deadline fires
    deadline.fire()
    const result = await settleWithin(pending)

    // #then both transport signals are aborted and the call is a timeout
    expect(discoveries(github)[0]?.signal?.aborted).toBe(true)
    expect(tokenPosts(github)[0]?.signal?.aborted).toBe(true)
    expect(result === 'pending' ? undefined : result.success).toBe(false)
  })

  it('discovery really forwards the deadline to the transport: a hung discovery ends at the deadline and caches nothing', async () => {
    // #given the discovery request hangs
    github.installationBehaviour.current = 'hang'
    const deadline = controllableDeadlines()
    const client = makeClient()
    const pending = client.authForRepo('foo', 'bar')
    await untilSeen(1, () => discoveries(github))
    expect(discoveries(github)[0]?.signal?.aborted).toBe(false)

    // #when
    deadline.fire()
    const result = await settleWithin(pending)

    // #then the discovery request itself was aborted
    expect(discoveries(github)[0]?.signal?.aborted).toBe(true)
    expect(result).not.toBe('pending')
    if (result === 'pending') return
    expect(result.success === false && result.error instanceof AuthTimeoutError).toBe(true)
    expect(tokenPosts(github)).toHaveLength(0)

    // #and nothing was cached: the next call discovers again
    github.installationBehaviour.current = 'respond'
    expect((await client.authForRepo('foo', 'bar')).success).toBe(true)
    expect(discoveries(github)).toHaveLength(2)
  })

  it('a retry after a timeout starts a FRESH token request instead of joining the stuck one', async () => {
    // #given a first mint that hangs and is aborted at its deadline
    github.tokenBehaviour.current = 'hang'
    const deadline = controllableDeadlines()
    const client = makeClient()
    const first = client.authForRepo('foo', 'bar')
    await untilSeen(1, () => tokenPosts(github))
    deadline.fire()
    await settleWithin(first)
    expect(tokenPosts(github)).toHaveLength(1)

    // #when the retry runs against a healthy transport
    github.tokenBehaviour.current = 'respond'
    const retry = await settleWithin(client.authForRepo('foo', 'bar'))

    // #then it sent its own POST (the library's pending-promise entry was cleared by the abort) and succeeded
    expect(tokenPosts(github)).toHaveLength(2)
    expect(retry).not.toBe('pending')
    if (retry === 'pending') return
    expect(retry.success).toBe(true)
  })

  it('a concurrent caller that joined the same request ends as a timeout too, and the next call is fresh', async () => {
    // #given two concurrent mints for the same repo: the library shares one pending request between them
    github.tokenBehaviour.current = 'hang'
    const deadline = controllableDeadlines()
    const firstClient = makeClient()
    const secondClient = makeClient()
    const a = firstClient.authForRepo('foo', 'bar')
    await untilSeen(1, () => tokenPosts(github))
    const b = secondClient.authForRepo('foo', 'bar')
    await untilSeen(2, () => discoveries(github))
    await tick()
    const posts = tokenPosts(github).length

    // #when only A's deadline fires (B has its own, later one)
    expect(deadline.controllers).toHaveLength(2)
    deadline.fire(0)
    const [resultA, resultB] = await Promise.all([settleWithin(a), settleWithin(b)])

    // #then both end, B as a timeout although ITS signal never fired: it was waiting on A's request
    expect(resultA).not.toBe('pending')
    expect(resultB).not.toBe('pending')
    if (resultA === 'pending' || resultB === 'pending') return
    expect(resultA.success === false && resultA.error instanceof AuthTimeoutError).toBe(true)
    expect(resultB.success === false && resultB.error instanceof AuthTimeoutError).toBe(true)
    expect(posts).toBe(1) // B joined A's request instead of sending its own

    // #and the shared entry is gone: a later call sends a new POST
    github.tokenBehaviour.current = 'respond'
    const before = tokenPosts(github).length
    const later = await settleWithin(makeClient().authForRepo('foo', 'bar'))
    expect(tokenPosts(github)).toHaveLength(before + 1)
    expect(later === 'pending' ? undefined : later.success).toBe(true)
  })
})

describe('authForWorkflowDispatch at the transport boundary', () => {
  let github: FakeGitHub

  beforeEach(() => {
    github = installFakeGitHub()
    github.permissions.current = {contents: 'read', actions: 'write'}
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('its token POST is actually bounded now: the 5 s deadline reaches the transport and the call ends as a timeout', async () => {
    // #given the token request hangs
    github.tokenBehaviour.current = 'hang'
    const deadline = controllableDeadlines()
    const pending = makeClient().authForWorkflowDispatch('foo', 'bar')
    await untilSeen(1, () => tokenPosts(github))
    expect(tokenPosts(github)).toHaveLength(1)
    expect(tokenPosts(github)[0]?.signal?.aborted).toBe(false)

    // #when the mint's own deadline fires (discovery and the mint each get one)
    deadline.fire(deadline.controllers.length - 1)
    const result = await settleWithin(pending)

    // #then
    expect(tokenPosts(github)[0]?.signal?.aborted).toBe(true)
    expect(result).not.toBe('pending')
    if (result === 'pending') return
    expect(result.success === false && result.error instanceof AuthTimeoutError).toBe(true)
  })
})
