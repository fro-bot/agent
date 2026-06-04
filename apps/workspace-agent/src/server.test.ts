import type {CloneHandlerResult} from './clone.js'
import type {CloneExecutorFn} from './server.js'

import {describe, expect, it, vi} from 'vitest'
import {createApp} from './server.js'

const VALID_TOKEN = `ghs_${'a'.repeat(36)}`

function makeCloneExecutor(result: CloneHandlerResult): CloneExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as CloneExecutorFn & ReturnType<typeof vi.fn>
}

async function postClone(
  app: ReturnType<typeof createApp>,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const bodyStr = JSON.stringify(body)
  return app.request('/clone', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(bodyStr).length),
      ...extraHeaders,
    },
    body: bodyStr,
  })
}

describe('GET /healthz', () => {
  it('returns 200 with ok: true (no opencode status)', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await app.request('/healthz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true})
  })

  it('returns {ok: true, opencode: "starting"} when server is still starting', async () => {
    // #given
    const opencodeStatus = {status: 'starting' as const}
    const app = createApp({opencodeStatus})

    // #when
    const res = await app.request('/healthz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, opencode: 'starting'})
  })

  it('returns {ok: true, opencode: "ready"} when opencode server is ready', async () => {
    // #given
    const opencodeStatus = {status: 'ready' as const}
    const app = createApp({opencodeStatus})

    // #when
    const res = await app.request('/healthz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, opencode: 'ready'})
  })

  it('returns {ok: true, opencode: "down"} when opencode server failed to start', async () => {
    // #given
    const opencodeStatus = {status: 'down' as const}
    const app = createApp({opencodeStatus})

    // #when
    const res = await app.request('/healthz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, opencode: 'down'})
  })
})

describe('POST /clone — validation', () => {
  it('returns 400 malformed-body for non-JSON body', async () => {
    // #given
    const app = createApp()
    const badBody = 'not json{{{'

    // #when
    const res = await app.request('/clone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(badBody).length),
      },
      body: badBody,
    })

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'malformed-body'})
  })

  it('returns 400 invalid-owner for traversal attempt', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await postClone(app, {owner: '../etc', repo: 'passwd', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-owner for owner with slash', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await postClone(app, {owner: 'foo/bar', repo: 'repo', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for repo with slash', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'foo/bar', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('returns 400 invalid-token-shape for missing token', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent'})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-token-shape'})
  })

  it('returns 400 invalid-token-shape for wrong token prefix', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: 'ghp_wrongprefix'})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-token-shape'})
  })

  it('does not invoke clone executor when validation fails', async () => {
    // #given
    const cloneExecutor = vi.fn()
    const app = createApp({cloneExecutor})

    // #when
    await postClone(app, {owner: '../etc', repo: 'passwd', token: VALID_TOKEN})

    // #then
    expect(cloneExecutor).not.toHaveBeenCalled()
  })
})

describe('POST /clone — success path', () => {
  it('returns 200 with path and commit on success', async () => {
    // #given
    const cloneExecutor = makeCloneExecutor({
      response: {ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'abc123'},
      statusCode: 200,
    })
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'abc123'})
  })

  it('passes sanitized owner and repo to clone executor', async () => {
    // #given
    const cloneExecutor = makeCloneExecutor({
      response: {ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'sha'},
      statusCode: 200,
    })
    const app = createApp({cloneExecutor})

    // #when
    await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    const callArg = cloneExecutor.mock.calls[0]![0] as {owner: string; repo: string; token: string}
    expect(callArg.owner).toBe('fro-bot')
    expect(callArg.repo).toBe('agent')
    // Token is passed through (clone executor handles it securely)
    expect(callArg.token).toBe(VALID_TOKEN)
  })
})

describe('POST /clone — error paths', () => {
  it('returns 409 for repo-exists', async () => {
    // #given
    const cloneExecutor = makeCloneExecutor({
      response: {ok: false, error: 'repo-exists'},
      statusCode: 409,
    })
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'repo-exists'})
  })

  it('returns 500 for clone-failed', async () => {
    // #given
    const cloneExecutor = makeCloneExecutor({
      response: {ok: false, error: 'clone-failed'},
      statusCode: 500,
    })
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'clone-failed'})
  })

  it('returns 500 for enospc with code', async () => {
    // #given
    const cloneExecutor = makeCloneExecutor({
      response: {ok: false, error: 'enospc', code: 'ENOSPC'},
      statusCode: 500,
    })
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'enospc', code: 'ENOSPC'})
  })

  it('response body never contains the token', async () => {
    // #given — even if clone executor somehow echoes the token (defense in depth)
    const cloneExecutor = makeCloneExecutor({
      response: {ok: false, error: 'clone-failed'},
      statusCode: 500,
    })
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})
    const bodyText = await res.text()

    // #then
    expect(bodyText).not.toContain(VALID_TOKEN)
    expect(bodyText).not.toContain('ghs_')
  })
})

describe('Unknown routes', () => {
  it('returns 404 for unknown GET route', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await app.request('/unknown-route')

    // #then
    expect(res.status).toBe(404)
  })

  it('returns 404 for unknown POST route', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await app.request('/fetch', {method: 'POST'})

    // #then
    expect(res.status).toBe(404)
  })
})

describe('POST /clone — body size limit (S3)', () => {
  it('returns 413 body-too-large when Content-Length exceeds 4096', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await app.request('/clone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '10000',
      },
      body: JSON.stringify({owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}),
    })

    // #then
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'body-too-large'})
  })

  it('returns 413 body-too-large when Content-Length is absent', async () => {
    // #given
    const app = createApp()

    // #when — no Content-Length header
    const res = await app.request('/clone', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}),
    })

    // #then
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'body-too-large'})
  })

  it('proceeds normally when Content-Length is within limit', async () => {
    // #given
    const cloneExecutor = makeCloneExecutor({
      response: {ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'abc123'},
      statusCode: 200,
    })
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(200)
  })
})

describe('POST /clone — HTTP-layer credential scrubbing (T1)', () => {
  it('scrubs token from response body even if clone executor returns it', async () => {
    // #given — executor returns a response that somehow contains the token literal
    // (defense in depth: HTTP layer scrubs regardless)
    const tokenLiteral = VALID_TOKEN
    const cloneExecutor = vi.fn().mockResolvedValue({
      // Simulate a buggy executor that leaks the token in an error message
      response: {ok: false, error: 'clone-failed', code: `x-access-token:${tokenLiteral}@github.com`},
      statusCode: 500,
    }) as CloneExecutorFn & ReturnType<typeof vi.fn>
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})
    const bodyText = await res.text()

    // #then — token must not appear in the HTTP response body
    expect(bodyText).not.toContain(tokenLiteral)
    expect(bodyText).not.toContain('ghs_')
  })
})

describe('POST /clone — clone-timeout returns 504 (Fix #4)', () => {
  it('returns 504 when clone executor returns clone-timeout', async () => {
    // #given
    const cloneExecutor = makeCloneExecutor({
      response: {ok: false, error: 'clone-timeout'},
      statusCode: 504,
    })
    const app = createApp({cloneExecutor})

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then — gateway timeout, not internal server error
    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'clone-timeout'})
  })
})

describe('GET /readyz', () => {
  it('returns 200 with ready: true when opencode status is "ready"', async () => {
    // #given
    const opencodeStatus = {status: 'ready' as const}
    const app = createApp({opencodeStatus})

    // #when
    const res = await app.request('/readyz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ready: true, opencode: 'ready'})
  })

  it('returns 503 with ready: false when opencode status is "starting"', async () => {
    // #given
    const opencodeStatus = {status: 'starting' as const}
    const app = createApp({opencodeStatus})

    // #when
    const res = await app.request('/readyz')

    // #then
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ready: false, opencode: 'starting'})
  })

  it('returns 503 with ready: false when opencode status is "down"', async () => {
    // #given
    const opencodeStatus = {status: 'down' as const}
    const app = createApp({opencodeStatus})

    // #when
    const res = await app.request('/readyz')

    // #then
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ready: false, opencode: 'down'})
  })

  it('returns 503 (fail-closed) when no opencode status ref is provided', async () => {
    // #given — createApp without opencodeStatus (clone-only mode)
    const app = createApp()

    // #when
    const res = await app.request('/readyz')

    // #then — unknown liveness → not ready
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ready: false, opencode: 'unknown'})
  })

  it('does not affect /healthz — always 200 regardless of opencode status', async () => {
    // #given — test all three status values
    const statuses = ['ready', 'starting', 'down'] as const
    for (const status of statuses) {
      const opencodeStatus = {status}
      const app = createApp({opencodeStatus})

      // #when
      const res = await app.request('/healthz')

      // #then — /healthz is always 200 (clone-only liveness invariant)
      expect(res.status).toBe(200)
    }
  })

  it('does not affect /healthz when no opencode status ref is provided', async () => {
    // #given
    const app = createApp()

    // #when
    const res = await app.request('/healthz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true})
  })
})
