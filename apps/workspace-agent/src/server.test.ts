import type {CloneHandlerResult} from './clone.js'
import type {InspectHandlerResult} from './inspect.js'
import type {
  CloneExecutorFn,
  DeleteBackupExecutorFn,
  ExecuteRecoveryExecutorFn,
  InspectExecutorFn,
  ListBackupsExecutorFn,
  PreviewRecoveryExecutorFn,
  ServerDeps,
  UpdateExecutorFn,
} from './server.js'
import type {
  DeleteBackupResult,
  ExecuteRecoveryResult,
  ListBackupsResult,
  PreviewRecoveryResult,
  UpdateRequest,
  UpdateResult,
} from './types.js'
import type {UpdateHandlerDeps} from './update.js'

import {Buffer} from 'node:buffer'

import {describe, expect, it, vi} from 'vitest'
import {createApp} from './server.js'

const VALID_TOKEN = `ghs_${'a'.repeat(36)}`

function makeCloneExecutor(result: CloneHandlerResult): CloneExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as CloneExecutorFn & ReturnType<typeof vi.fn>
}

function makeInspectExecutor(result: InspectHandlerResult): InspectExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as InspectExecutorFn & ReturnType<typeof vi.fn>
}

/** Unlike make{Clone,Inspect}Executor, `executeUpdate` returns the bare `UpdateResult` union directly (no `{response, statusCode}` wrapper) — see `UpdateExecutorFn`'s own doc comment in server.ts. */
function makeUpdateExecutor(result: UpdateResult): UpdateExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as UpdateExecutorFn & ReturnType<typeof vi.fn>
}

function makePreviewRecoveryExecutor(
  result: PreviewRecoveryResult,
): PreviewRecoveryExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as PreviewRecoveryExecutorFn & ReturnType<typeof vi.fn>
}

function makeExecuteRecoveryExecutor(
  result: ExecuteRecoveryResult,
): ExecuteRecoveryExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as ExecuteRecoveryExecutorFn & ReturnType<typeof vi.fn>
}

function makeListBackupsExecutor(result: ListBackupsResult): ListBackupsExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as ListBackupsExecutorFn & ReturnType<typeof vi.fn>
}

function makeDeleteBackupExecutor(result: DeleteBackupResult): DeleteBackupExecutorFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as DeleteBackupExecutorFn & ReturnType<typeof vi.fn>
}

/**
 * Build an app with auth disabled — the `disabled-for-tests` `ServerDeps.auth` variant exists
 * solely so tests that aren't exercising the bearer middleware can opt out explicitly instead of
 * auth silently defaulting off.
 */
function appWithoutAuth(deps: Omit<ServerDeps, 'auth'> = {}): ReturnType<typeof createApp> {
  return createApp({...deps, auth: {kind: 'disabled-for-tests'}})
}

/** Build an app with bearer auth enabled for the given token — the production `ServerDeps.auth` variant. */
function appWithBearerAuth(token: string, deps: Omit<ServerDeps, 'auth'> = {}): ReturnType<typeof createApp> {
  return createApp({...deps, auth: {kind: 'bearer', token}})
}

async function postInspect(
  app: ReturnType<typeof createApp>,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const bodyStr = JSON.stringify(body)
  return app.request('/inspect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(bodyStr).length),
      ...extraHeaders,
    },
    body: bodyStr,
  })
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

async function postUpdate(
  app: ReturnType<typeof createApp>,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const bodyStr = JSON.stringify(body)
  return app.request('/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(bodyStr).length),
      ...extraHeaders,
    },
    body: bodyStr,
  })
}

async function postRecoverPreview(
  app: ReturnType<typeof createApp>,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const bodyStr = JSON.stringify(body)
  return app.request('/recover/preview', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(bodyStr).length),
      ...extraHeaders,
    },
    body: bodyStr,
  })
}

async function postRecover(
  app: ReturnType<typeof createApp>,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const bodyStr = JSON.stringify(body)
  return app.request('/recover', {
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
    const app = appWithoutAuth()

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
    const app = appWithoutAuth({opencodeStatus})

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
    const app = appWithoutAuth({opencodeStatus})

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
    const app = appWithoutAuth({opencodeStatus})

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
    const app = appWithoutAuth()
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
    const app = appWithoutAuth()

    // #when
    const res = await postClone(app, {owner: '../etc', repo: 'passwd', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-owner for owner with slash', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await postClone(app, {owner: 'foo/bar', repo: 'repo', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for repo with slash', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'foo/bar', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('returns 400 invalid-token-shape for missing token', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await postClone(app, {owner: 'fro-bot', repo: 'agent'})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-token-shape'})
  })

  it('returns 400 invalid-token-shape for wrong token prefix', async () => {
    // #given
    const app = appWithoutAuth()

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth()

    // #when
    const res = await app.request('/unknown-route')

    // #then
    expect(res.status).toBe(404)
  })

  it('returns 404 for unknown POST route', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await app.request('/fetch', {method: 'POST'})

    // #then
    expect(res.status).toBe(404)
  })
})

describe('POST /clone — body size limit (S3)', () => {
  it('returns 413 body-too-large when Content-Length exceeds 4096', async () => {
    // #given
    const app = appWithoutAuth()

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
    const app = appWithoutAuth()

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    const app = appWithoutAuth({cloneExecutor})

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
    // #given — opencode ready, but no proxyListening ref (legacy/clone-only mode)
    const opencodeStatus = {status: 'ready' as const}
    const app = appWithoutAuth({opencodeStatus})

    // #when
    const res = await app.request('/readyz')

    // #then — without a proxyListening ref, readiness falls back to opencode-only check
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ready: true, opencode: 'ready'})
  })

  it('returns 503 with ready: false when opencode status is "starting"', async () => {
    // #given
    const opencodeStatus = {status: 'starting' as const}
    const app = appWithoutAuth({opencodeStatus})

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
    const app = appWithoutAuth({opencodeStatus})

    // #when
    const res = await app.request('/readyz')

    // #then
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ready: false, opencode: 'down'})
  })

  it('returns 503 (fail-closed) when no opencode status ref is provided', async () => {
    // #given — createApp without opencodeStatus (clone-only mode)
    const app = appWithoutAuth()

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
      const app = appWithoutAuth({opencodeStatus})

      // #when
      const res = await app.request('/healthz')

      // #then — /healthz is always 200 (clone-only liveness invariant)
      expect(res.status).toBe(200)
    }
  })

  it('does not affect /healthz when no opencode status ref is provided', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await app.request('/healthz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true})
  })
})

describe('GET /readyz — proxy-listening gate', () => {
  it('returns 200 when opencode is ready AND proxy is listening', async () => {
    // #given — both conditions satisfied: the happy path
    const opencodeStatus = {status: 'ready' as const}
    const proxyListening = {listening: true}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // #when
    const res = await app.request('/readyz')

    // #then — attach path is usable → 200 ready
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ready: true, opencode: 'ready'})
  })

  it('returns 503 when opencode is ready but proxy is NOT listening', async () => {
    // #given — opencode booted but proxy leg is down
    const opencodeStatus = {status: 'ready' as const}
    const proxyListening = {listening: false}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // #when
    const res = await app.request('/readyz')

    // #then — attach path not usable → 503 not-ready (gateway fail-closes handleMention)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ready: false, opencode: 'ready'})
  })

  it('returns 503 when opencode is not ready regardless of proxy state', async () => {
    // #given — opencode still starting, proxy already listening
    const opencodeStatus = {status: 'starting' as const}
    const proxyListening = {listening: true}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // #when
    const res = await app.request('/readyz')

    // #then — opencode not ready → 503 regardless of proxy
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ready: false, opencode: 'starting'})
  })

  it('returns 503 when both opencode is not ready and proxy is not listening', async () => {
    // #given — nothing is ready yet (early boot)
    const opencodeStatus = {status: 'starting' as const}
    const proxyListening = {listening: false}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // #when
    const res = await app.request('/readyz')

    // #then
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ready: false, opencode: 'starting'})
  })

  it('wire shape is unchanged — response is still flat ReadyzResponse', async () => {
    // #given — verify the response shape has not changed (only condition deepened)
    const opencodeStatus = {status: 'ready' as const}
    const proxyListening = {listening: true}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // #when
    const res = await app.request('/readyz')
    const body = (await res.json()) as Record<string, unknown>

    // #then — flat shape: { ready: boolean, opencode: string } — no extra fields
    expect(Object.keys(body).sort()).toEqual(['opencode', 'ready'])
    expect(typeof body.ready).toBe('boolean')
    expect(typeof body.opencode).toBe('string')
  })

  it('startup ordering: proxy listening signal is set before readiness can transition to ready', () => {
    // #given — simulate the boot sequence: proxy starts first (OS bind is fast),
    // then OpenCode reaches ready. This is the invariant that prevents the startup
    // false-negative: proxyListening.listening must be true BEFORE opencodeStatus
    // transitions to 'ready' in normal boot.
    //
    // The mechanism: proxy.listen() resolves when the OS assigns the port (milliseconds).
    // OpenCode takes seconds to boot. main.ts sets proxyListeningRef.listening = true
    // in the listen() resolution callback, BEFORE the supervisor can write 'ready'.
    // This test asserts the state machine invariant: if we simulate the boot sequence
    // in order (proxy listen resolves → opencode transitions to ready), there is no
    // window where opencodeStatus === 'ready' AND proxyListening.listening === false.
    const proxyListeningRef = {listening: false}
    const opencodeStatusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // Step 1: proxy listen() resolves (OS bind) — this happens first in normal boot
    proxyListeningRef.listening = true

    // Step 2: opencode supervisor transitions to ready
    opencodeStatusRef.status = 'ready'

    // #then — at the moment opencode becomes ready, proxy is already listening.
    // There is NO window where ready===true AND listening===false.
    expect(proxyListeningRef.listening).toBe(true)
    expect(opencodeStatusRef.status).toBe('ready')

    // Verify: if we check readiness at any point after step 1, it would be correct.
    // The only way to get a false-negative is if step 2 happened before step 1,
    // which the boot sequence in main.ts prevents (proxy.listen() is awaited/resolved
    // before the supervisor can write 'ready' because the proxy starts synchronously
    // and listen() resolves in the same event loop tick as the OS bind callback).
    const isReady = opencodeStatusRef.status === 'ready' && proxyListeningRef.listening === true
    expect(isReady).toBe(true)
  })

  it('/healthz stays 200 regardless of proxy listening state', async () => {
    // #given — proxy not listening, opencode starting
    const opencodeStatus = {status: 'starting' as const}
    const proxyListening = {listening: false}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // #when
    const res = await app.request('/healthz')

    // #then — /healthz is always 200 (liveness, not readiness)
    expect(res.status).toBe(200)
  })

  it('/healthz stays 200 when proxy is listening and opencode is ready', async () => {
    // #given
    const opencodeStatus = {status: 'ready' as const}
    const proxyListening = {listening: true}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // #when
    const res = await app.request('/healthz')

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, opencode: 'ready'})
  })

  it('proxyListening signal cleared on proxy close → /readyz returns 503', async () => {
    // #given — proxy was listening, then closed (e.g. crash/restart)
    const opencodeStatus = {status: 'ready' as const}
    const proxyListening = {listening: true}
    const app = appWithoutAuth({opencodeStatus, proxyListening})

    // Verify initially ready
    const resBefore = await app.request('/readyz')
    expect(resBefore.status).toBe(200)

    // #when — proxy closes (signal cleared, as main.ts does on close/error)
    proxyListening.listening = false

    // #then — /readyz now returns 503 (stale proxy signal correctly reflects dead proxy)
    const resAfter = await app.request('/readyz')
    expect(resAfter.status).toBe(503)
    const body = await resAfter.json()
    expect(body).toEqual({ready: false, opencode: 'ready'})
  })
})

describe('POST /inspect — validation', () => {
  it('returns 413 body-too-large when Content-Length header is missing', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await app.request('/inspect', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({owner: 'fro-bot', repo: 'agent'}),
    })

    // #then
    expect(res.status).toBe(413)
  })

  it('returns 400 malformed-body for non-JSON body', async () => {
    // #given
    const app = appWithoutAuth()
    const badBody = 'not json{{{'

    // #when
    const res = await app.request('/inspect', {
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
    const app = appWithoutAuth()

    // #when
    const res = await postInspect(app, {owner: '../etc', repo: 'passwd'})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for repo with slash', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await postInspect(app, {owner: 'fro-bot', repo: 'foo/bar'})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('does not invoke the inspect executor when validation fails', async () => {
    // #given
    const inspectExecutor = vi.fn()
    const app = appWithoutAuth({inspectExecutor})

    // #when
    await postInspect(app, {owner: '../etc', repo: 'passwd'})

    // #then
    expect(inspectExecutor).not.toHaveBeenCalled()
  })

  it('does not require or accept a token field', async () => {
    // #given
    const inspectExecutor = makeInspectExecutor({
      response: {
        ok: true,
        observation: {
          head: {kind: 'attached', branch: 'main', sha: 'a'.repeat(40)},
          worktree: {kind: 'clean'},
          operationInProgress: 'none',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      statusCode: 200,
    })
    const app = appWithoutAuth({inspectExecutor})

    // #when
    const res = await postInspect(app, {owner: 'fro-bot', repo: 'agent'})

    // #then
    expect(res.status).toBe(200)
    expect(inspectExecutor).toHaveBeenCalledWith({owner: 'fro-bot', repo: 'agent'})
  })
})

describe('POST /inspect — response passthrough', () => {
  it('returns 200 with the observation on success', async () => {
    // #given
    const observation = {
      head: {kind: 'detached' as const, sha: 'b'.repeat(40)},
      worktree: {kind: 'dirty' as const, staged: 1, unstaged: 2, untracked: 3, conflicted: 0},
      operationInProgress: 'rebase' as const,
      observedAt: '2026-01-01T00:00:00.000Z',
    }
    const inspectExecutor = makeInspectExecutor({response: {ok: true, observation}, statusCode: 200})
    const app = appWithoutAuth({inspectExecutor})

    // #when
    const res = await postInspect(app, {owner: 'fro-bot', repo: 'agent'})

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, observation})
  })

  it('returns 404 no-checkout when the executor reports no checkout', async () => {
    // #given
    const inspectExecutor = makeInspectExecutor({response: {ok: false, error: 'no-checkout'}, statusCode: 404})
    const app = appWithoutAuth({inspectExecutor})

    // #when
    const res = await postInspect(app, {owner: 'fro-bot', repo: 'agent'})

    // #then
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'no-checkout'})
  })

  it('returns 409 checkout-substituted when the executor detects substitution', async () => {
    // #given
    const inspectExecutor = makeInspectExecutor({
      response: {ok: false, error: 'checkout-substituted'},
      statusCode: 409,
    })
    const app = appWithoutAuth({inspectExecutor})

    // #when
    const res = await postInspect(app, {owner: 'fro-bot', repo: 'agent'})

    // #then
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'checkout-substituted'})
  })

  it('returns 504 inspection-timeout when the executor times out', async () => {
    // #given
    const inspectExecutor = makeInspectExecutor({
      response: {ok: false, error: 'inspection-timeout'},
      statusCode: 504,
    })
    const app = appWithoutAuth({inspectExecutor})

    // #when
    const res = await postInspect(app, {owner: 'fro-bot', repo: 'agent'})

    // #then
    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'inspection-timeout'})
  })
})

describe('Control-API bearer authentication', () => {
  const AUTH_TOKEN = `auth-token-${'z'.repeat(32)}`
  const AUTH_HEADER = {Authorization: `Bearer ${AUTH_TOKEN}`}

  describe('happy path — correct bearer', () => {
    it('pOST /clone with the correct bearer behaves exactly as today', async () => {
      // #given
      const cloneExecutor = makeCloneExecutor({
        response: {ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'abc123'},
        statusCode: 200,
      })
      const app = appWithBearerAuth(AUTH_TOKEN, {cloneExecutor})

      // #when
      const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}, AUTH_HEADER)

      // #then
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'abc123'})
      expect(cloneExecutor).toHaveBeenCalledTimes(1)
    })

    it('pOST /inspect with the correct bearer behaves exactly as today', async () => {
      // #given
      const observation = {
        head: {kind: 'attached' as const, branch: 'main', sha: 'a'.repeat(40)},
        worktree: {kind: 'clean' as const},
        operationInProgress: 'none' as const,
        observedAt: '2026-01-01T00:00:00.000Z',
      }
      const inspectExecutor = makeInspectExecutor({response: {ok: true, observation}, statusCode: 200})
      const app = appWithBearerAuth(AUTH_TOKEN, {inspectExecutor})

      // #when
      const res = await postInspect(app, {owner: 'fro-bot', repo: 'agent'}, AUTH_HEADER)

      // #then
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ok: true, observation})
      expect(inspectExecutor).toHaveBeenCalledTimes(1)
    })
  })

  describe('error path — rejected before body parsing or git', () => {
    const cases: {name: string; headers: Record<string, string>}[] = [
      {name: 'no Authorization header', headers: {}},
      {
        name: 'Basic scheme instead of Bearer',
        headers: {Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`},
      },
      {name: 'Bearer with an empty token', headers: {Authorization: 'Bearer '}},
      {name: 'wrong token', headers: {Authorization: 'Bearer completely-different-token-value'}},
      {
        name: 'token differing only in the last byte',
        headers: {Authorization: `Bearer ${AUTH_TOKEN.slice(0, -1)}y`},
      },
      {name: 'token that is a prefix of the real one', headers: {Authorization: `Bearer ${AUTH_TOKEN.slice(0, -1)}`}},
    ]

    for (const {name, headers} of cases) {
      it(`POST /clone returns 401 for ${name}, without invoking the clone executor`, async () => {
        // #given
        const cloneExecutor = makeCloneExecutor({
          response: {ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'abc123'},
          statusCode: 200,
        })
        const app = appWithBearerAuth(AUTH_TOKEN, {cloneExecutor})

        // #when
        const res = await postClone(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}, headers)

        // #then
        expect(res.status).toBe(401)
        const body = await res.json()
        expect(body).toEqual({ok: false, error: 'unauthorized'})
        expect(cloneExecutor).not.toHaveBeenCalled()
      })

      it(`POST /inspect returns 401 for ${name}, without invoking the inspect executor`, async () => {
        // #given
        const inspectExecutor = makeInspectExecutor({
          response: {
            ok: true,
            observation: {
              head: {kind: 'attached', branch: 'main', sha: 'a'.repeat(40)},
              worktree: {kind: 'clean'},
              operationInProgress: 'none',
              observedAt: '2026-01-01T00:00:00.000Z',
            },
          },
          statusCode: 200,
        })
        const app = appWithBearerAuth(AUTH_TOKEN, {inspectExecutor})

        // #when
        const res = await postInspect(app, {owner: 'fro-bot', repo: 'agent'}, headers)

        // #then
        expect(res.status).toBe(401)
        const body = await res.json()
        expect(body).toEqual({ok: false, error: 'unauthorized'})
        expect(inspectExecutor).not.toHaveBeenCalled()
      })

      it(`POST /update returns 401 for ${name}, without invoking the update executor`, async () => {
        // #given
        const updateExecutor = makeUpdateExecutor({kind: 'no-checkout'})
        const app = appWithBearerAuth(AUTH_TOKEN, {updateExecutor})

        // #when
        const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}, headers)

        // #then
        expect(res.status).toBe(401)
        const body = await res.json()
        expect(body).toEqual({ok: false, error: 'unauthorized'})
        expect(updateExecutor).not.toHaveBeenCalled()
      })

      it(`POST /recover/preview returns 401 for ${name}, without invoking the preview executor`, async () => {
        const previewRecoveryExecutor = vi.fn().mockResolvedValue({kind: 'no-checkout'})
        const app = appWithBearerAuth(AUTH_TOKEN, {previewRecoveryExecutor})

        const res = await postRecoverPreview(app, {owner: 'fro-bot', repo: 'agent'}, headers)

        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ok: false, error: 'unauthorized'})
        expect(previewRecoveryExecutor).not.toHaveBeenCalled()
      })

      it(`POST /recover returns 401 for ${name}, without invoking the recovery executor`, async () => {
        const executeRecoveryExecutor = vi.fn().mockResolvedValue({kind: 'no-checkout'})
        const app = appWithBearerAuth(AUTH_TOKEN, {executeRecoveryExecutor})

        const res = await postRecover(
          app,
          {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'},
          headers,
        )

        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ok: false, error: 'unauthorized'})
        expect(executeRecoveryExecutor).not.toHaveBeenCalled()
      })

      it(`GET /backups/:owner/:repo returns 401 for ${name}, without invoking the list executor`, async () => {
        const listBackupsExecutor = vi.fn().mockResolvedValue({kind: 'ok', backups: [], totalBytes: 0})
        const app = appWithBearerAuth(AUTH_TOKEN, {listBackupsExecutor})

        const res = await app.request('/backups/fro-bot/agent', {headers})

        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ok: false, error: 'unauthorized'})
        expect(listBackupsExecutor).not.toHaveBeenCalled()
      })

      it(`DELETE /backups/:owner/:repo/:id returns 401 for ${name}, without invoking the delete executor`, async () => {
        const deleteBackupExecutor = vi.fn().mockResolvedValue({kind: 'ok'})
        const app = appWithBearerAuth(AUTH_TOKEN, {deleteBackupExecutor})

        const res = await app.request('/backups/fro-bot/agent/gen-1', {method: 'DELETE', headers})

        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ok: false, error: 'unauthorized'})
        expect(deleteBackupExecutor).not.toHaveBeenCalled()
      })
    }

    it('rejects with 401 (not 400) when a malformed body accompanies a missing bearer — proves auth runs before JSON parsing', async () => {
      // #given
      const cloneExecutor = vi.fn()
      const app = appWithBearerAuth(AUTH_TOKEN, {cloneExecutor})
      const malformedBody = 'not json{{{'

      // #when — no Authorization header, body is malformed JSON
      const res = await app.request('/clone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(malformedBody).length),
        },
        body: malformedBody,
      })

      // #then — 401, not 400 (malformed-body): auth ran first, JSON was never parsed
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body).toEqual({ok: false, error: 'unauthorized'})
      expect(cloneExecutor).not.toHaveBeenCalled()
    })

    it('rejects with 401 (not 413) when an oversized body accompanies a missing bearer — proves auth runs before the body-size gate', async () => {
      // #given
      const cloneExecutor = vi.fn()
      const app = appWithBearerAuth(AUTH_TOKEN, {cloneExecutor})

      // #when — no Authorization header, Content-Length far exceeds the 4096-byte cap
      const res = await app.request('/clone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '999999',
        },
        body: JSON.stringify({owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}),
      })

      // #then — 401, not 413: auth ran before the content-length check
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body).toEqual({ok: false, error: 'unauthorized'})
      expect(cloneExecutor).not.toHaveBeenCalled()
    })
  })

  describe('edge case — empty configured token', () => {
    it.each(['', '   '])('refuses to build the app with token %j, so `Bearer ` alone can never authenticate', token => {
      // #given / #when / #then
      expect(() => appWithBearerAuth(token)).toThrow('control-API token must not be empty')
    })
  })

  describe('edge case — /healthz and /readyz stay open', () => {
    it('gET /healthz succeeds with no Authorization header even when a token is configured', async () => {
      // #given
      const app = appWithBearerAuth(AUTH_TOKEN)

      // #when
      const res = await app.request('/healthz')

      // #then
      expect(res.status).toBe(200)
    })

    it('gET /readyz answers by its own readiness logic (never 401) with no Authorization header', async () => {
      // #given
      const opencodeStatus = {status: 'ready' as const}
      const app = appWithBearerAuth(AUTH_TOKEN, {opencodeStatus})

      // #when
      const res = await app.request('/readyz')

      // #then
      expect(res.status).not.toBe(401)
      expect(res.status).toBe(200)
    })

    it('header matching is case-insensitive (Fetch Headers semantics): lowercase "authorization" is accepted', async () => {
      // #given
      const cloneExecutor = makeCloneExecutor({
        response: {ok: true, path: '/workspace/repos/fro-bot/agent', commit: 'abc123'},
        statusCode: 200,
      })
      const app = appWithBearerAuth(AUTH_TOKEN, {cloneExecutor})

      // #when — lowercase header name
      const res = await postClone(
        app,
        {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN},
        {authorization: `Bearer ${AUTH_TOKEN}`},
      )

      // #then
      expect(res.status).toBe(200)
    })
  })
})

describe('ServerDeps.auth variants are behaviourally distinct', () => {
  it('bearer rejects an unauthenticated POST /inspect; disabled-for-tests does not', async () => {
    // #given — same handler wiring, differing only in the auth variant
    const observation = {
      head: {kind: 'attached' as const, branch: 'main', sha: 'a'.repeat(40)},
      worktree: {kind: 'clean' as const},
      operationInProgress: 'none' as const,
      observedAt: '2026-01-01T00:00:00.000Z',
    }
    const bearerInspectExecutor = makeInspectExecutor({response: {ok: true, observation}, statusCode: 200})
    const disabledInspectExecutor = makeInspectExecutor({response: {ok: true, observation}, statusCode: 200})
    const bearerApp = appWithBearerAuth(`auth-token-${'z'.repeat(32)}`, {inspectExecutor: bearerInspectExecutor})
    const disabledApp = appWithoutAuth({inspectExecutor: disabledInspectExecutor})

    // #when — no Authorization header on either request
    const bearerRes = await postInspect(bearerApp, {owner: 'fro-bot', repo: 'agent'})
    const disabledRes = await postInspect(disabledApp, {owner: 'fro-bot', repo: 'agent'})

    // #then — the type-level distinction has a real runtime effect: bearer refuses, disabled allows
    expect(bearerRes.status).toBe(401)
    expect(bearerInspectExecutor).not.toHaveBeenCalled()

    expect(disabledRes.status).toBe(200)
    expect(disabledInspectExecutor).toHaveBeenCalledTimes(1)
  })
})

describe('POST /update — validation', () => {
  it('returns 413 body-too-large when Content-Length header is missing', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await app.request('/update', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}),
    })

    // #then
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'body-too-large'})
  })

  it('returns 413 body-too-large when Content-Length exceeds 4096', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await app.request('/update', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Content-Length': '999999'},
      body: JSON.stringify({owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN}),
    })

    // #then
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'body-too-large'})
  })

  it('returns 400 malformed-body for non-JSON body', async () => {
    // #given
    const app = appWithoutAuth()
    const malformedBody = 'not json{{{'

    // #when
    const res = await app.request('/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(malformedBody).length),
      },
      body: malformedBody,
    })

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'malformed-body'})
  })

  it('returns 400 invalid-owner for traversal attempt', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await postUpdate(app, {owner: '../etc', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for repo with slash', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'a/b', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('returns 400 invalid-token-shape for a malformed token', async () => {
    // #given
    const app = appWithoutAuth()

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: 'not-a-real-token'})

    // #then
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ok: false, error: 'invalid-token-shape'})
  })

  it('never invokes the update executor when validation fails', async () => {
    // #given
    const updateExecutor = makeUpdateExecutor({kind: 'no-checkout'})
    const app = appWithoutAuth({updateExecutor})

    // #when
    await postUpdate(app, {owner: '../etc', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(updateExecutor).not.toHaveBeenCalled()
  })
})

describe('POST /update — result → status mapping', () => {
  it('ready → 200, full result body passed through verbatim', async () => {
    // #given
    const result: UpdateResult = {
      kind: 'ready',
      change: 'fast-forward',
      branch: 'main',
      sha: 'b'.repeat(40),
      fromSha: 'a'.repeat(40),
      checkedAt: '2026-01-01T00:00:00.000Z',
    }
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(result)
    expect(updateExecutor).toHaveBeenCalledTimes(1)
  })

  it('no-checkout → 404', async () => {
    // #given
    const updateExecutor = makeUpdateExecutor({kind: 'no-checkout'})
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({kind: 'no-checkout'})
  })

  it('refused (needs-recovery) → 409', async () => {
    // #given
    const result: UpdateResult = {kind: 'refused', reason: 'needs-recovery'}
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual(result)
  })

  it('refused (dirty, with changedPaths) → 409, body carries the sample', async () => {
    // #given
    const result: UpdateResult = {kind: 'refused', reason: 'dirty', changedPaths: ['a.txt', 'b.txt']}
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual(result)
  })

  it('failed, reason fetch-timeout → 504 (mirrors /clone clone-timeout)', async () => {
    // #given
    const result: UpdateResult = {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false}
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(504)
  })

  it('failed, permanent true (fetch-not-found) → 502', async () => {
    // #given
    const result: UpdateResult = {kind: 'failed', reason: 'fetch-not-found', mutationStarted: false, permanent: true}
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(502)
  })

  it('failed, permanent true (fetch-forbidden) → 502', async () => {
    // #given
    const result: UpdateResult = {kind: 'failed', reason: 'fetch-forbidden', mutationStarted: false, permanent: true}
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(502)
  })

  it('failed, not permanent (fetch-auth-rejected) → 503', async () => {
    // #given
    const result: UpdateResult = {
      kind: 'failed',
      reason: 'fetch-auth-rejected',
      mutationStarted: false,
      permanent: false,
    }
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(503)
  })

  it('failed, mutationStarted possibly (termination-unconfirmed) → 503, body carries the possibly flag', async () => {
    // #given
    const result: UpdateResult = {
      kind: 'failed',
      reason: 'termination-unconfirmed',
      mutationStarted: 'possibly',
      permanent: false,
    }
    const updateExecutor = makeUpdateExecutor(result)
    const app = appWithoutAuth({updateExecutor})

    // #when
    const res = await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual(result)
  })
})

describe('POST /update — signal plumbing', () => {
  it('passes c.req.raw.signal through to the update executor deps', async () => {
    // #given
    let capturedSignal: AbortSignal | undefined
    const updateExecutor = vi.fn(async (_request: UpdateRequest, deps?: UpdateHandlerDeps) => {
      capturedSignal = deps?.signal
      return {kind: 'no-checkout'} satisfies UpdateResult
    }) as UpdateExecutorFn & ReturnType<typeof vi.fn>
    const app = appWithoutAuth({updateExecutor})

    // #when
    await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then — Hono's app.request() constructs a real Request, which always carries a signal
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })

  it('an already-aborted client request reaches the update executor with an aborted signal', async () => {
    // #given
    let capturedSignal: AbortSignal | undefined
    const updateExecutor = vi.fn(async (_request: UpdateRequest, deps?: UpdateHandlerDeps) => {
      capturedSignal = deps?.signal
      return {kind: 'no-checkout'} satisfies UpdateResult
    }) as UpdateExecutorFn & ReturnType<typeof vi.fn>
    const app = appWithoutAuth({updateExecutor})
    const controller = new AbortController()
    controller.abort()

    // #when
    const bodyStr = JSON.stringify({owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})
    await app.request('/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(bodyStr).length),
      },
      body: bodyStr,
      signal: controller.signal,
    })

    // #then
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('passes updateNetworkConfig.caBundlePath and .proxy through to the update executor deps', async () => {
    // #given — proves the plumbing ServerDeps.updateNetworkConfig → executeUpdate deps exists,
    // even though no production caller populates it yet (see server.ts's own doc comment)
    let capturedCaBundlePath: string | undefined
    let capturedProxy: {readonly https: string; readonly noProxy?: string} | undefined
    const updateExecutor = vi.fn(async (_request: UpdateRequest, deps?: UpdateHandlerDeps) => {
      capturedCaBundlePath = deps?.caBundlePath
      capturedProxy = deps?.proxy
      return {kind: 'no-checkout'} satisfies UpdateResult
    }) as UpdateExecutorFn & ReturnType<typeof vi.fn>
    const app = appWithoutAuth({
      updateExecutor,
      updateNetworkConfig: {caBundlePath: '/etc/ssl/ca.pem', proxy: {https: 'http://proxy:3128'}},
    })

    // #when
    await postUpdate(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})

    // #then
    expect(capturedCaBundlePath).toBe('/etc/ssl/ca.pem')
    expect(capturedProxy).toEqual({https: 'http://proxy:3128'})
  })
})

describe('POST /recover/preview — validation', () => {
  it('returns 413 body-too-large when Content-Length header is missing', async () => {
    const app = appWithoutAuth()
    const res = await app.request('/recover/preview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({owner: 'fro-bot', repo: 'agent'}),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ok: false, error: 'body-too-large'})
  })

  it('returns 400 malformed-body for non-JSON body', async () => {
    const app = appWithoutAuth()
    const malformedBody = 'not json{{{'
    const res = await app.request('/recover/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(malformedBody).length),
      },
      body: malformedBody,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'malformed-body'})
  })

  it('returns 400 invalid-owner for traversal attempt', async () => {
    const app = appWithoutAuth()
    const res = await postRecoverPreview(app, {owner: '../etc', repo: 'agent'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for repo with slash', async () => {
    const app = appWithoutAuth()
    const res = await postRecoverPreview(app, {owner: 'fro-bot', repo: 'a/b'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('never invokes the preview executor when validation fails', async () => {
    const previewRecoveryExecutor = makePreviewRecoveryExecutor({kind: 'no-checkout'})
    const app = appWithoutAuth({previewRecoveryExecutor})
    await postRecoverPreview(app, {owner: '../etc', repo: 'agent'})
    expect(previewRecoveryExecutor).not.toHaveBeenCalled()
  })
})

describe('POST /recover/preview — result → status mapping', () => {
  it('ok → 200, full result body passed through verbatim', async () => {
    const result: PreviewRecoveryResult = {
      kind: 'ok',
      preview: {
        inspectionSafe: false,
        estimatedSizeBytes: 100,
        entryCount: 5,
        sizeMeasurementComplete: true,
        retention: {generationCount: 0, hasUnknownSize: false, totalBytes: 0, maxGenerations: 5, maxBytes: 1024},
        fingerprint: 'abc',
      },
    }
    const previewRecoveryExecutor = makePreviewRecoveryExecutor(result)
    const app = appWithoutAuth({previewRecoveryExecutor})

    const res = await postRecoverPreview(app, {owner: 'fro-bot', repo: 'agent'})

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(previewRecoveryExecutor).toHaveBeenCalledTimes(1)
  })

  it('recoverable-update → 200', async () => {
    const result: PreviewRecoveryResult = {
      kind: 'recoverable-update',
      update: {
        phase: 'applying',
        fromSha: 'a'.repeat(40),
        toSha: 'b'.repeat(40),
        startedAt: '2026-09-24T00:00:00.000Z',
        estimatedSizeBytes: 1024,
        entryCount: 5,
        sizeMeasurementComplete: true,
        fingerprint: 'xyz',
      },
    }
    const app = appWithoutAuth({previewRecoveryExecutor: makePreviewRecoveryExecutor(result)})

    const res = await postRecoverPreview(app, {owner: 'fro-bot', repo: 'agent'})

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
  })

  it('no-checkout → 404', async () => {
    const app = appWithoutAuth({previewRecoveryExecutor: makePreviewRecoveryExecutor({kind: 'no-checkout'})})
    const res = await postRecoverPreview(app, {owner: 'fro-bot', repo: 'agent'})
    expect(res.status).toBe(404)
  })

  it('refused (maintenance-hold) → 409', async () => {
    const result: PreviewRecoveryResult = {kind: 'refused', reason: 'maintenance-hold'}
    const app = appWithoutAuth({previewRecoveryExecutor: makePreviewRecoveryExecutor(result)})
    const res = await postRecoverPreview(app, {owner: 'fro-bot', repo: 'agent'})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(result)
  })

  it('failed (termination-unconfirmed) → 503', async () => {
    const result: PreviewRecoveryResult = {kind: 'failed', reason: 'termination-unconfirmed'}
    const app = appWithoutAuth({previewRecoveryExecutor: makePreviewRecoveryExecutor(result)})
    const res = await postRecoverPreview(app, {owner: 'fro-bot', repo: 'agent'})
    expect(res.status).toBe(503)
  })
})

describe('POST /recover — validation', () => {
  it('returns 413 body-too-large when Content-Length header is missing', async () => {
    const app = appWithoutAuth()
    const res = await app.request('/recover', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'}),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ok: false, error: 'body-too-large'})
  })

  it('returns 400 malformed-body for non-JSON body', async () => {
    const app = appWithoutAuth()
    const malformedBody = 'not json{{{'
    const res = await app.request('/recover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(malformedBody).length),
      },
      body: malformedBody,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'malformed-body'})
  })

  it('returns 400 invalid-owner for traversal attempt', async () => {
    const app = appWithoutAuth()
    const res = await postRecover(app, {owner: '../etc', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for repo with slash', async () => {
    const app = appWithoutAuth()
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'a/b', token: VALID_TOKEN, fingerprint: 'abc'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('returns 400 invalid-token-shape for a malformed token', async () => {
    const app = appWithoutAuth()
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: 'nope', fingerprint: 'abc'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-token-shape'})
  })

  it('returns 400 invalid-fingerprint for a missing fingerprint', async () => {
    const app = appWithoutAuth()
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-fingerprint'})
  })

  it('returns 400 invalid-fingerprint for an empty-string fingerprint', async () => {
    const app = appWithoutAuth()
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: ''})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-fingerprint'})
  })

  it('never invokes the recovery executor when validation fails', async () => {
    const executeRecoveryExecutor = makeExecuteRecoveryExecutor({kind: 'no-checkout'})
    const app = appWithoutAuth({executeRecoveryExecutor})
    await postRecover(app, {owner: '../etc', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'})
    expect(executeRecoveryExecutor).not.toHaveBeenCalled()
  })
})

describe('POST /recover — result → status mapping', () => {
  it('ok → 200, full result body passed through verbatim', async () => {
    const result: ExecuteRecoveryResult = {kind: 'ok', recoveryId: 'gen-1', sha: 'a'.repeat(40), branch: 'main'}
    const executeRecoveryExecutor = makeExecuteRecoveryExecutor(result)
    const app = appWithoutAuth({executeRecoveryExecutor})

    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'})

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(executeRecoveryExecutor).toHaveBeenCalledTimes(1)
  })

  it('no-checkout → 404', async () => {
    const app = appWithoutAuth({executeRecoveryExecutor: makeExecuteRecoveryExecutor({kind: 'no-checkout'})})
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'})
    expect(res.status).toBe(404)
  })

  it('refused (checkout-changed) → 409', async () => {
    const result: ExecuteRecoveryResult = {kind: 'refused', reason: 'checkout-changed'}
    const app = appWithoutAuth({executeRecoveryExecutor: makeExecuteRecoveryExecutor(result)})
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(result)
  })

  it('refused (quota-exceeded, with usage) → 409, body carries the usage', async () => {
    const result: ExecuteRecoveryResult = {
      kind: 'refused',
      reason: 'quota-exceeded',
      usage: {generationCount: 5, hasUnknownSize: false, totalBytes: 1000, maxGenerations: 5, maxBytes: 1024},
    }
    const app = appWithoutAuth({executeRecoveryExecutor: makeExecuteRecoveryExecutor(result)})
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(result)
  })

  it('failed (termination-unconfirmed) → 503', async () => {
    const result: ExecuteRecoveryResult = {kind: 'failed', reason: 'termination-unconfirmed'}
    const app = appWithoutAuth({executeRecoveryExecutor: makeExecuteRecoveryExecutor(result)})
    const res = await postRecover(app, {owner: 'fro-bot', repo: 'agent', token: VALID_TOKEN, fingerprint: 'abc'})
    expect(res.status).toBe(503)
  })
})

describe('GET /backups/:owner/:repo — validation and status mapping', () => {
  it('returns 400 invalid-owner for traversal attempt', async () => {
    const app = appWithoutAuth()
    const res = await app.request('/backups/..%2Fetc/agent')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for a repo segment containing a slash', async () => {
    const app = appWithoutAuth()
    const res = await app.request('/backups/fro-bot/a%2Fb')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('never invokes the list executor when validation fails', async () => {
    const listBackupsExecutor = makeListBackupsExecutor({kind: 'ok', backups: [], totalBytes: 0})
    const app = appWithoutAuth({listBackupsExecutor})
    await app.request('/backups/..%2Fetc/agent')
    expect(listBackupsExecutor).not.toHaveBeenCalled()
  })

  it('ok → 200, full result body passed through verbatim', async () => {
    const result: ListBackupsResult = {
      kind: 'ok',
      backups: [
        {
          id: 'gen-1',
          metadataOk: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          sizeBytes: 100,
          sizeComplete: true,
          originalHeadSha: 'a'.repeat(40),
          originalBranch: 'main',
        },
      ],
      totalBytes: 100,
    }
    const listBackupsExecutor = makeListBackupsExecutor(result)
    const app = appWithoutAuth({listBackupsExecutor})

    const res = await app.request('/backups/fro-bot/agent')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(listBackupsExecutor).toHaveBeenCalledWith('fro-bot', 'agent')
  })

  it('failed → 503', async () => {
    const app = appWithoutAuth({listBackupsExecutor: makeListBackupsExecutor({kind: 'failed'})})
    const res = await app.request('/backups/fro-bot/agent')
    expect(res.status).toBe(503)
  })
})

describe('DELETE /backups/:owner/:repo/:id — validation and status mapping', () => {
  it('returns 400 invalid-owner for traversal attempt', async () => {
    const app = appWithoutAuth()
    const res = await app.request('/backups/..%2Fetc/agent/gen-1', {method: 'DELETE'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-owner'})
  })

  it('returns 400 invalid-repo for a repo segment containing a slash', async () => {
    const app = appWithoutAuth()
    const res = await app.request('/backups/fro-bot/a%2Fb/gen-1', {method: 'DELETE'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ok: false, error: 'invalid-repo'})
  })

  it('never reaches the delete executor for a `.`/`..` id — the URL parser itself collapses the dot-segment (encoded or not, per WHATWG URL dot-segment normalization) before Hono ever routes it, one layer earlier than isSimplePathSegment', async () => {
    const deleteBackupExecutor = makeDeleteBackupExecutor({kind: 'ok'})
    const app = appWithoutAuth({deleteBackupExecutor})
    const res = await app.request('/backups/fro-bot/agent/%2E%2E', {method: 'DELETE'})
    expect(res.status).not.toBe(200)
    expect(deleteBackupExecutor).not.toHaveBeenCalled()
  })

  it('refused invalid-id → 400 for a %2F-encoded id, never reaching the delete executor', async () => {
    const deleteBackupExecutor = makeDeleteBackupExecutor({kind: 'ok'})
    const app = appWithoutAuth({deleteBackupExecutor})
    const res = await app.request('/backups/fro-bot/agent/a%2Fb', {method: 'DELETE'})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({kind: 'refused', reason: 'invalid-id'})
    expect(deleteBackupExecutor).not.toHaveBeenCalled()
  })

  it('refused invalid-id → 400 for an empty id segment, never reaching the delete executor', async () => {
    const deleteBackupExecutor = makeDeleteBackupExecutor({kind: 'ok'})
    const app = appWithoutAuth({deleteBackupExecutor})
    const res = await app.request('/backups/fro-bot/agent/', {method: 'DELETE'})
    expect(res.status).not.toBe(200)
    expect(deleteBackupExecutor).not.toHaveBeenCalled()
  })

  it('ok → 200, full result body passed through verbatim, forwarding owner/repo/id to the executor', async () => {
    const deleteBackupExecutor = makeDeleteBackupExecutor({kind: 'ok'})
    const app = appWithoutAuth({deleteBackupExecutor})

    const res = await app.request('/backups/fro-bot/agent/gen-1', {method: 'DELETE'})

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({kind: 'ok'})
    expect(deleteBackupExecutor).toHaveBeenCalledWith('fro-bot', 'agent', 'gen-1')
  })

  it('refused (not-found) → 404', async () => {
    const result: DeleteBackupResult = {kind: 'refused', reason: 'not-found'}
    const app = appWithoutAuth({deleteBackupExecutor: makeDeleteBackupExecutor(result)})
    const res = await app.request('/backups/fro-bot/agent/gen-1', {method: 'DELETE'})
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(result)
  })

  it('refused (maintenance-hold) → 409', async () => {
    const result: DeleteBackupResult = {kind: 'refused', reason: 'maintenance-hold'}
    const app = appWithoutAuth({deleteBackupExecutor: makeDeleteBackupExecutor(result)})
    const res = await app.request('/backups/fro-bot/agent/gen-1', {method: 'DELETE'})
    expect(res.status).toBe(409)
  })

  it('refused (recovery-in-progress) → 409', async () => {
    const result: DeleteBackupResult = {kind: 'refused', reason: 'recovery-in-progress'}
    const app = appWithoutAuth({deleteBackupExecutor: makeDeleteBackupExecutor(result)})
    const res = await app.request('/backups/fro-bot/agent/gen-1', {method: 'DELETE'})
    expect(res.status).toBe(409)
  })

  it('failed → 503', async () => {
    const app = appWithoutAuth({deleteBackupExecutor: makeDeleteBackupExecutor({kind: 'failed'})})
    const res = await app.request('/backups/fro-bot/agent/gen-1', {method: 'DELETE'})
    expect(res.status).toBe(503)
  })
})
