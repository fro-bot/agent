import type {CloneErrorCode, CloneRequest} from './types.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {createWorkspaceClient} from './client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides?: {baseUrl?: string; timeoutMs?: number}) {
  return createWorkspaceClient({baseUrl: 'http://workspace:9100', timeoutMs: 1000, ...overrides})
}

function makeRequest(overrides?: Partial<CloneRequest>): CloneRequest {
  return {owner: 'testowner', repo: 'testrepo', token: 'ghs_testtoken123', ...overrides}
}

function mockFetch(response: {ok: boolean; status?: number; json?: () => Promise<unknown>; throws?: Error}) {
  return vi.fn().mockImplementation(async () => {
    if (response.throws !== undefined) throw response.throws
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: response.json ?? (async () => undefined),
    }
  })
}

/** Spy on all console channels and collect every string written. */
function spyConsole() {
  const lines: string[] = []
  const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(collect),
    vi.spyOn(console, 'warn').mockImplementation(collect),
    vi.spyOn(console, 'error').mockImplementation(collect),
    vi.spyOn(console, 'info').mockImplementation(collect),
    vi.spyOn(console, 'debug').mockImplementation(collect),
  ]
  return {
    lines,
    restore: () => spies.forEach(s => s.mockRestore()),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWorkspaceClient', () => {
  describe('happy path', () => {
    it('returns CloneSuccess with path and commit on 200 response', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/workspace/repos/testowner/testrepo', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(ok({ok: true, path: '/workspace/repos/testowner/testrepo', commit: 'abc123'}))
      vi.unstubAllGlobals()
    })

    it('pOSTs to /clone with correct Content-Type', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/workspace/repos/testowner/testrepo', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      await client.clone(req)

      // #then
      expect(fetchMock).toHaveBeenCalledWith(
        'http://workspace:9100/clone',
        expect.objectContaining({
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
        }),
      )
      vi.unstubAllGlobals()
    })
  })

  describe('response-mismatch', () => {
    it('returns response-mismatch when path does not end with /{owner}/{repo}', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/workspace/repos/otherowner/otherrepo', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'response-mismatch'}))
      vi.unstubAllGlobals()
    })

    it('accepts lowercase owner/repo matching the response path', async () => {
      // #given — owner/repo arrive already lowercased from the caller (add-project.ts canonicalizes)
      const client = makeClient()
      const req = makeRequest({owner: 'testowner', repo: 'testrepo'})
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/workspace/repos/testowner/testrepo', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result.success).toBe(true)
      vi.unstubAllGlobals()
    })

    // Strict prefix validation — suffix-only check accepted adversarial paths.
    it('rejects adversarial path /etc/passwd/testowner/testrepo', async () => {
      // #given — suffix matches but path root is wrong (privilege escalation attempt)
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/etc/passwd/testowner/testrepo', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then — must reject: path doesn't start with /workspace/repos
      expect(result).toEqual(err({kind: 'response-mismatch'}))
      vi.unstubAllGlobals()
    })

    it('accepts exactly /workspace/repos/{owner}/{repo}', async () => {
      // #given — exact expected path
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/workspace/repos/testowner/testrepo', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then — must succeed
      expect(result.success).toBe(true)
      vi.unstubAllGlobals()
    })

    it('rejects path with extra trailing segment /workspace/repos/testowner/testrepo/extra', async () => {
      // #given — suffix matches but there's an extra path segment after owner/repo
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/workspace/repos/testowner/testrepo/extra', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then — exact equality rejects the extra segment
      expect(result).toEqual(err({kind: 'response-mismatch'}))
      vi.unstubAllGlobals()
    })

    it('rejects path with uppercase workspace root /WORKSPACE/repos/owner/repo', async () => {
      // #given — case-variant root; lowercasing response path would bypass validation
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({
        ok: true,
        json: async () => ({ok: true, path: '/WORKSPACE/repos/testowner/testrepo', commit: 'abc123'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then — exact comparison rejects the case-variant root
      expect(result).toEqual(err({kind: 'response-mismatch'}))
      vi.unstubAllGlobals()
    })
  })

  describe('clone-error codes', () => {
    const errorCodes: CloneErrorCode[] = [
      'clone-failed',
      'disk-full',
      'repo-exists',
      'head-resolution-failed',
      'clone-timeout',
      'overloaded',
      'enospc',
      'invalid-owner',
      'invalid-repo',
      'invalid-token-shape',
      'malformed-body',
      'body-too-large',
      'clone-aborted',
      'git-not-available',
      'permission-denied',
      'too-many-files',
      'path-escaped-workspace',
    ]

    for (const code of errorCodes) {
      it(`preserves clone-error code: ${code}`, async () => {
        // #given
        const client = makeClient()
        const req = makeRequest()
        const fetchMock = mockFetch({
          ok: true,
          json: async () => ({ok: false, error: code}),
        })
        vi.stubGlobal('fetch', fetchMock)

        // #when
        const result = await client.clone(req)

        // #then
        expect(result).toEqual(err({kind: 'clone-error', code}))
        vi.unstubAllGlobals()
      })
    }
  })

  describe('http-error', () => {
    it('returns http-error with status 500 on non-2xx response', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({ok: false, status: 500})
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'http-error', status: 500}))
      vi.unstubAllGlobals()
    })

    it('returns http-error with status 409 on conflict', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({ok: false, status: 409})
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'http-error', status: 409}))
      vi.unstubAllGlobals()
    })
  })

  describe('network-error', () => {
    it('returns network-error on connection refused', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({ok: false, throws: Object.assign(new Error('ECONNREFUSED'), {name: 'TypeError'})})
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'network-error'}))
      vi.unstubAllGlobals()
    })
  })

  describe('timeout', () => {
    it('returns timeout on AbortSignal.timeout expiry (TimeoutError)', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})
      const fetchMock = mockFetch({ok: false, throws: timeoutErr})
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'timeout'}))
      vi.unstubAllGlobals()
    })

    it('returns timeout on AbortError', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const abortErr = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
      const fetchMock = mockFetch({ok: false, throws: abortErr})
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'timeout'}))
      vi.unstubAllGlobals()
    })
  })

  describe('parse-error', () => {
    it('returns parse-error when response body is not valid JSON', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'parse-error'}))
      vi.unstubAllGlobals()
    })

    it('returns parse-error when response body has wrong shape', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = mockFetch({ok: true, json: async () => ({unexpected: 'shape'})})
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'parse-error'}))
      vi.unstubAllGlobals()
    })
  })

  describe('security: no IAT in logs', () => {
    const errorPaths: {name: string; fetchSetup: () => ReturnType<typeof mockFetch> | ReturnType<typeof vi.fn>}[] = [
      {
        name: 'happy path',
        fetchSetup: () =>
          mockFetch({
            ok: true,
            json: async () => ({ok: true, path: '/workspace/repos/testowner/testrepo', commit: 'abc123'}),
          }),
      },
      {
        name: 'network-error path',
        fetchSetup: () => mockFetch({ok: false, throws: new Error('ECONNREFUSED')}),
      },
      {
        name: 'http-error path (500 no body)',
        fetchSetup: () => mockFetch({ok: false, status: 500}),
      },
      {
        name: 'parse-error path (wrong shape)',
        fetchSetup: () => mockFetch({ok: true, json: async () => ({unexpected: 'shape'})}),
      },
      {
        name: 'clone-error path',
        fetchSetup: () => mockFetch({ok: true, json: async () => ({ok: false, error: 'repo-exists'})}),
      },
      {
        name: 'response-mismatch path',
        fetchSetup: () =>
          mockFetch({ok: true, json: async () => ({ok: true, path: '/workspace/repos/other/other', commit: 'abc'})}),
      },
      {
        name: 'timeout path',
        fetchSetup: () => mockFetch({ok: false, throws: Object.assign(new Error('timeout'), {name: 'TimeoutError'})}),
      },
      {
        name: 'malformed JSON body on non-2xx',
        fetchSetup: () =>
          vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => {
              throw new SyntaxError('bad json')
            },
          }),
      },
    ]

    for (const {name, fetchSetup} of errorPaths) {
      it(`does not log ghs_* token on ${name}`, async () => {
        // #given
        const spy = spyConsole()
        const client = makeClient()
        const req = makeRequest({token: 'ghs_supersecrettoken'})
        vi.stubGlobal('fetch', fetchSetup())

        try {
          // #when
          await client.clone(req)

          // #then
          for (const line of spy.lines) {
            expect(line).not.toContain('ghs_')
          }
        } finally {
          spy.restore()
          vi.unstubAllGlobals()
        }
      })
    }
  })

  describe('structured error body on non-2xx (Critical 2)', () => {
    it('hTTP 409 with {ok:false, error:"repo-exists"} → clone-error', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ok: false, error: 'repo-exists'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'clone-error', code: 'repo-exists'}))
      vi.unstubAllGlobals()
    })

    it('hTTP 503 with {ok:false, error:"overloaded"} → clone-error', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ok: false, error: 'overloaded'}),
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'clone-error', code: 'overloaded'}))
      vi.unstubAllGlobals()
    })

    it('hTTP 500 with no body (json returns undefined) → http-error', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => undefined,
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then
      expect(result).toEqual(err({kind: 'http-error', status: 500}))
      vi.unstubAllGlobals()
    })

    it('hTTP 500 with malformed JSON body → http-error (body parse failed, non-2xx)', async () => {
      // #given
      const client = makeClient()
      const req = makeRequest()
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })
      vi.stubGlobal('fetch', fetchMock)

      // #when
      const result = await client.clone(req)

      // #then — body parse failed on non-2xx → http-error (not parse-error)
      expect(result).toEqual(err({kind: 'http-error', status: 500}))
      vi.unstubAllGlobals()
    })
  })
})
