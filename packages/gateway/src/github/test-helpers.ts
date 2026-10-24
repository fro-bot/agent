/**
 * Test support: the REAL `createAppClient` (so the REAL `@octokit/auth-app` and `authForRepo` deadline) over a
 * stubbed `fetch`, with an ephemeral RSA key and no network traffic. Tests of callers that must never be held
 * by a stalled installation-token mint use it instead of a hand-rolled never-settling `authForRepo`, which no
 * longer describes a real path: `authForRepo` itself returns an `AuthTimeoutError` Result at its deadline.
 *
 * Each installer registers its own cleanup with `onTestFinished`, so it must be called inside a test.
 */

import type {AppClient} from './app-client.js'

import {generateKeyPairSync} from 'node:crypto'
import {expect, onTestFinished, vi} from 'vitest'
import {createAppClient} from './app-client.js'

let cachedPrivateKey: string | undefined

function privateKey(): string {
  cachedPrivateKey ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
    publicKeyEncoding: {type: 'spki', format: 'pem'},
  }).privateKey
  return cachedPrivateKey
}

export function createRealAppClient(): AppClient {
  return createAppClient({appId: '12345', privateKey: privateKey()})
}

export interface StalledGitHub {
  /** Every request URL the stub has seen, in order. */
  readonly seen: string[]
  /**
   * Answer every request held so far (and any later one) as a healthy GitHub would, IGNORING the abort
   * signal: a response that arrives after the caller's deadline has already expired.
   */
  readonly answerLate: () => void
}

/**
 * Stub `fetch` so GitHub never answers until `answerLate()`. A held request still rejects when its signal
 * aborts, like the real `fetch`, unless `ignoreSignal` is set (a transport that does not honour it).
 */
export function installStalledGitHub(options?: {readonly ignoreSignal?: boolean}): StalledGitHub {
  const seen: string[] = []
  const held: (() => void)[] = []
  let answering = false

  const answer = (url: string): Response => {
    const body = url.includes('/access_tokens')
      ? {
          token: 'ghs_late_token',
          expires_at: '2099-01-01T00:00:00Z',
          permissions: {contents: 'read'},
          repository_selection: 'selected',
          repositories: [{id: 1, name: 'bar'}],
        }
      : {id: 99, permissions: {contents: 'read'}}
    return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}})
  }

  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push(url)
    if (answering) return answer(url)
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      if (options?.ignoreSignal !== true) {
        if (signal?.aborted === true) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => {
          reject(signal.reason)
        })
      }
      held.push(() => {
        resolve(answer(url))
      })
    })
  })

  return {
    seen,
    answerLate: () => {
      answering = true
      for (const release of held.splice(0)) release()
    },
  }
}

/**
 * `AbortSignal.timeout` handed out as controllable signals, one per call, so a test can fire "the deadline"
 * without waiting for it. `spy` records the millisecond ceiling each call asked for. With `fireAfterMs`, every
 * deadline fires by itself after that many real milliseconds (for tests that cannot reach the signal).
 */
export function controllableDeadlines(options?: {readonly fireAfterMs?: number}) {
  const controllers: AbortController[] = []
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController()
    controllers.push(controller)
    if (options?.fireAfterMs !== undefined) {
      setTimeout(() => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
      }, options.fireAfterMs)
    }
    return controller.signal
  })
  onTestFinished(() => {
    spy.mockRestore()
  })
  return {
    controllers,
    spy,
    fire: (index = 0) => controllers[index]?.abort(new DOMException('The operation timed out.', 'TimeoutError')),
  }
}

/** Resolves to the settled value, or `'pending'` if it has not settled within `ms` of real time. */
export async function settleWithin<T>(promise: Promise<T>, ms = 200): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms))])
}

/** Waits until the stub has seen at least `count` requests. */
export async function untilRequests(github: StalledGitHub, count: number): Promise<void> {
  await vi.waitFor(() => expect(github.seen.length).toBeGreaterThanOrEqual(count), {timeout: 2_000, interval: 5})
}
