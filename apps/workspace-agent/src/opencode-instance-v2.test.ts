import {describe, expect, it, vi} from 'vitest'

import {createInstanceDisposerV2, DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS_V2} from './opencode-instance-v2.js'
import {createUpstreamCredentials} from './opencode-server-v2.js'

function credentialed(value = 'Basic c2VjcmV0'): ReturnType<typeof createUpstreamCredentials> {
  const credentials = createUpstreamCredentials()
  credentials.set(() => value)
  return credentials
}

describe('createInstanceDisposerV2', () => {
  it('evicts the location with the narrow debug endpoint, authenticated as the current server', async () => {
    // #given
    const fetchFn = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(null, {status: 204}))
    const dispose = createInstanceDisposerV2({
      upstreamUrl: 'http://127.0.0.1:54321',
      credentials: credentialed(),
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    // #when
    const outcome = await dispose('/workspace/repos/acme/widget')

    // #then the request is DELETE /api/debug/location with the deepObject query P3 measured, and Basic auth
    expect(outcome).toEqual({kind: 'disposed'})
    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit]
    expect(url.pathname).toBe('/api/debug/location')
    expect(url.searchParams.get('location[directory]')).toBe('/workspace/repos/acme/widget')
    expect(init.method).toBe('DELETE')
    expect(new Headers(init.headers).get('authorization')).toBe('Basic c2VjcmV0')
  })

  it('never uses the V1 dispose route or the wider location reload', async () => {
    // #given
    const fetchFn = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(null, {status: 204}))
    const dispose = createInstanceDisposerV2({
      upstreamUrl: 'http://127.0.0.1:54321',
      credentials: credentialed(),
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    // #when
    await dispose('/workspace/repos/a/b')

    // #then reload rebuilds every loaded location and cancels pending permissions (P3), which is wider than needed
    const [url] = fetchFn.mock.calls[0] as [URL]
    expect(url.pathname).not.toContain('/instance/dispose')
    expect(url.pathname).not.toContain('/reload')
  })

  it('round-trips a path with characters that need encoding', async () => {
    // #given
    const fetchFn = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(null, {status: 204}))
    const dispose = createInstanceDisposerV2({
      upstreamUrl: 'http://127.0.0.1:54321',
      credentials: credentialed(),
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    // #when
    await dispose('/workspace/repos/o/r with space&x=1')

    // #then
    const [url] = fetchFn.mock.calls[0] as [URL]
    expect(url.searchParams.get('location[directory]')).toBe('/workspace/repos/o/r with space&x=1')
  })

  it('skips without a request while no server is running', async () => {
    // #given
    const fetchFn = vi.fn()
    const dispose = createInstanceDisposerV2({
      upstreamUrl: 'http://127.0.0.1:54321',
      credentials: credentialed(),
      isRunning: () => false,
      fetchFn,
    })

    // #then
    expect(await dispose('/workspace/repos/a/b')).toEqual({kind: 'skipped'})
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('skips without a request while the holder has no credential', async () => {
    // #given a server that has not published a credential, so an unauthenticated request would only 401
    const fetchFn = vi.fn()
    const dispose = createInstanceDisposerV2({
      upstreamUrl: 'http://127.0.0.1:54321',
      credentials: createUpstreamCredentials(),
      fetchFn,
    })

    // #then
    expect(await dispose('/workspace/repos/a/b')).toEqual({kind: 'skipped'})
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('reports a non-2xx status as an http error, and an upstream 401 as such', async () => {
    // #given
    const dispose = createInstanceDisposerV2({
      upstreamUrl: 'http://127.0.0.1:54321',
      credentials: credentialed(),
      fetchFn: async () => new Response('{}', {status: 401}),
    })

    // #then the status is reported and nothing about the credential is
    const outcome = await dispose('/workspace/repos/a/b')
    expect(outcome).toEqual({kind: 'failed', reason: 'http-error', status: 401})
    expect(JSON.stringify(outcome)).not.toContain('c2VjcmV0')
  })

  it('reports a network error without throwing', async () => {
    // #given
    const dispose = createInstanceDisposerV2({
      upstreamUrl: 'http://127.0.0.1:54321',
      credentials: credentialed(),
      fetchFn: async () => {
        throw new TypeError('fetch failed')
      },
    })

    // #then
    expect(await dispose('/workspace/repos/a/b')).toEqual({kind: 'failed', reason: 'network-error'})
  })

  it('times out a request that never answers', async () => {
    // #given
    vi.useFakeTimers()
    try {
      const dispose = createInstanceDisposerV2({
        upstreamUrl: 'http://127.0.0.1:54321',
        credentials: credentialed(),
        fetchFn: (async (_url: URL | string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), {name: 'AbortError'})),
            )
          })) as unknown as typeof fetch,
      })

      // #when
      const pending = dispose('/workspace/repos/a/b')
      await vi.advanceTimersByTimeAsync(DEFAULT_INSTANCE_DISPOSE_TIMEOUT_MS_V2)

      // #then
      expect(await pending).toEqual({kind: 'failed', reason: 'timeout'})
    } finally {
      vi.useRealTimers()
    }
  })
})
