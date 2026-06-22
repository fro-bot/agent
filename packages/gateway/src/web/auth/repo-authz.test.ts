/**
 * Tests for the repo authorization helper.
 *
 * Covers:
 *   - Happy path: allowlisted operator with GitHub read access is authorized.
 *   - Error path: allowlisted operator without GitHub read access is denied and audited.
 *   - Error path: non-allowlisted operator is denied without making a GitHub API call.
 *   - Caching: positive authz result cached for 5 minutes; negative cached for 30 seconds.
 *   - Caching: concurrent misses for same operator/repo/token coalesce into one GitHub API call.
 *   - Caching: GitHub rate-limit response cached through retry window.
 *   - Caching: max-size cap evicts oldest entry; cache does not grow unbounded.
 *   - Error path: GitHub API lookup failure fails closed and emits audit event.
 *   - Validation: malformed owner/repo names are rejected before authz work begins.
 *   - Token safety: audit/logs never include userOAuthToken; cache key must not expose token.
 *   - Rate-limit classification: 403 without remaining=0 is not rate-limited.
 *   - 5xx responses return lookup_error, not github_denied.
 *   - Response bodies are canceled/drained on all paths.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AuditLogger} from '../audit.js'
import type {OperatorAllowlist} from './allowlist.js'
import type {RepoAuthzDeniedReason, RepoAuthzDeps, RepoAuthzLogger, RepoWriteAuthzResult} from './repo-authz.js'
import {describe, expect, it, vi, type Mock} from 'vitest'
import {checkRepoAuthz, checkRepoWriteAuthz, createRepoAuthzCache} from './repo-authz.js'

// ---------------------------------------------------------------------------
// Typed mock helpers (following audit.test.ts pattern)
// ---------------------------------------------------------------------------

type AuditLogFn = AuditLogger['info']
type AuditLogMock = ReturnType<typeof vi.fn<AuditLogFn>>

interface MockAuditLogger extends AuditLogger {
  readonly info: AuditLogMock
  readonly warn: AuditLogMock
}

function makeAuditLogger(): MockAuditLogger {
  return {
    info: vi.fn<AuditLogFn>(),
    warn: vi.fn<AuditLogFn>(),
  }
}

type LogFn = RepoAuthzLogger['info']
type LogMock = ReturnType<typeof vi.fn<LogFn>>

interface MockLogger extends RepoAuthzLogger {
  readonly debug: LogMock
  readonly info: LogMock
  readonly warn: LogMock
  readonly error: LogMock
}

function makeLogger(): MockLogger {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  }
}

function makeAllowlist(authorizedIds: readonly number[]): OperatorAllowlist {
  const set = new Set(authorizedIds)
  return {
    isAuthorized: (id: number) => set.has(id),
    size: set.size,
  }
}

/** Build a Response for fetch stubs with a cancelable body. */
function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, {status, headers})
}

/** Build a Response with a trackable body cancel. */
function makeResponseWithBody(
  status: number,
  headers: Record<string, string> = {},
): {response: Response; cancelSpy: ReturnType<typeof vi.fn>} {
  const cancelSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  // Create a ReadableStream with a cancel hook
  const stream = new ReadableStream({cancel: cancelSpy})
  const response = new Response(stream, {status, headers})
  return {response, cancelSpy}
}

type FetchMock = Mock<typeof globalThis.fetch>

/** Build a fetch stub that returns a given status code. */
function makeFetch(status: number, headers: Record<string, string> = {}): FetchMock {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(makeResponse(status, headers))
}

/** Build a fetch stub that throws. */
function makeThrowingFetch(error: unknown): FetchMock {
  return vi.fn<typeof globalThis.fetch>().mockRejectedValue(error)
}

const OPERATOR_ID = 12345
const OTHER_OPERATOR_ID = 99999
const OWNER = 'acme'
const REPO = 'widget'
const TOKEN = 'ghp_testtoken'

function makeDeps(overrides: Partial<RepoAuthzDeps> = {}): RepoAuthzDeps {
  return {
    allowlist: makeAllowlist([OPERATOR_ID]),
    fetch: makeFetch(200),
    clock: () => 0,
    random: () => 0.5,
    auditLogger: makeAuditLogger(),
    logger: makeLogger(),
    cache: createRepoAuthzCache(),
    ...overrides,
  }
}

/** Serialize all captured audit log calls to a single string for redaction assertions. */
function serializeAuditCalls(logger: MockAuditLogger): string {
  return JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])
}

/** Serialize all captured logger calls to a single string for redaction assertions. */
function serializeLogCalls(logger: MockLogger): string {
  return JSON.stringify([
    ...logger.debug.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ])
}

// ---------------------------------------------------------------------------
// Validation — malformed owner/repo names
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — validation', () => {
  it('rejects empty owner', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, '', REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    // No GitHub call made
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('emits authz.denied with reason invalid_repo_name on empty owner', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, '', REPO, TOKEN, deps)

    // #then
    expect(auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining<Partial<{kind: string; githubUserId: number; reason: RepoAuthzDeniedReason}>>({
        kind: 'authz.denied',
        githubUserId: OPERATOR_ID,
        reason: 'invalid_repo_name',
      }),
      expect.stringContaining('audit:'),
    )
  })

  it('rejects empty repo', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, '', TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('rejects repo name "."', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, '.', TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('rejects repo name ".."', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, '..', TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('rejects owner with path traversal (..) characters', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, '..', REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('rejects repo with slash characters', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, 'foo/bar', TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('rejects owner with special characters', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, 'owner<script>', REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('rejects repo with null bytes', async () => {
    // #given
    const deps = makeDeps()

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, 'repo\u0000name', TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('accepts valid owner/repo names', async () => {
    // #given
    const deps = makeDeps({fetch: makeFetch(200)})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, 'my-org', 'my-repo.js', TOKEN, deps)

    // #then — validation passes, GitHub call is made, result is authorized
    expect(result.authorized).toBe(true)
    expect(deps.fetch).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Allowlist gate
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — allowlist gate', () => {
  it('denies non-allowlisted operator without making a GitHub API call', async () => {
    // #given
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy})

    // #when
    const result = await checkRepoAuthz(OTHER_OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'not_allowlisted'})
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('emits authz.denied audit event for non-allowlisted operator', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})

    // #when
    await checkRepoAuthz(OTHER_OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining<Partial<{kind: string; githubUserId: number; reason: RepoAuthzDeniedReason}>>({
        kind: 'authz.denied',
        githubUserId: OTHER_OPERATOR_ID,
        reason: 'not_allowlisted',
      }),
      expect.stringContaining('audit:'),
    )
  })

  it('audit event for non-allowlisted operator never includes token', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})

    // #when
    await checkRepoAuthz(OTHER_OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — token must not appear in any audit call
    const serialized = serializeAuditCalls(auditLogger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — happy path', () => {
  it('authorizes allowlisted operator with GitHub read access', async () => {
    // #given
    const deps = makeDeps({fetch: makeFetch(200)})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result.authorized).toBe(true)
  })

  it('calls GitHub repos API with correct URL and auth header', async () => {
    // #given
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — inspect call args directly
    const firstCall = fetchSpy.mock.calls[0]
    if (firstCall === undefined) throw new Error('expected fetch to be called')
    const [url, init] = firstCall
    expect(url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}`)
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('includes Accept and API version headers in GitHub call', async () => {
    // #given
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — inspect call args directly
    const firstCall = fetchSpy.mock.calls[0]
    if (firstCall === undefined) throw new Error('expected fetch to be called')
    const [, init] = firstCall
    const headers = init?.headers as Record<string, string>
    expect(headers.accept).toBe('application/vnd.github+json')
    expect(headers['x-github-api-version']).toBe('2022-11-28')
  })

  it('does not emit audit event on successful authorization', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeFetch(200), auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — no authz.denied audit events
    const deniedCalls = auditLogger.warn.mock.calls.filter(c => c[0]?.kind === 'authz.denied')
    expect(deniedCalls).toHaveLength(0)
  })

  it('cancels response body on success', async () => {
    // #given
    const {response, cancelSpy} = makeResponseWithBody(200)
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    const deps = makeDeps({fetch: fetchSpy})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — body was canceled/drained
    expect(cancelSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Denial paths
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — denial paths', () => {
  it('denies allowlisted operator with 404 from GitHub (no read access)', async () => {
    // #given
    const deps = makeDeps({fetch: makeFetch(404)})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'github_denied'})
  })

  it('emits authz.denied audit event with reason github_denied when GitHub returns 404', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeFetch(404), auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining<Partial<{kind: string; githubUserId: number; reason: RepoAuthzDeniedReason}>>({
        kind: 'authz.denied',
        githubUserId: OPERATOR_ID,
        reason: 'github_denied',
      }),
      expect.stringContaining('audit:'),
    )
  })

  it('denies allowlisted operator with 403 from GitHub (no rate-limit headers)', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeFetch(403), auditLogger})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'github_denied'})
    expect(auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining<Partial<{kind: string; githubUserId: number; reason: RepoAuthzDeniedReason}>>({
        kind: 'authz.denied',
        githubUserId: OPERATOR_ID,
        reason: 'github_denied',
      }),
      expect.stringContaining('audit:'),
    )
  })

  it('403 with only x-ratelimit-reset (no remaining=0) is github_denied, not rate_limited', async () => {
    // #given — reset header present but remaining is not '0'
    const deps = makeDeps({fetch: makeFetch(403, {'x-ratelimit-reset': '9999999999'})})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — must NOT be rate_limited
    expect(result).toMatchObject({authorized: false, reason: 'github_denied'})
  })

  it('denies on GitHub API fetch error (fail closed)', async () => {
    // #given
    const deps = makeDeps({fetch: makeThrowingFetch(new Error('network error'))})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'lookup_error'})
  })

  it('emits authz.denied audit event with reason lookup_error on GitHub API fetch error', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeThrowingFetch(new Error('network error')), auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining<Partial<{kind: string; githubUserId: number; reason: RepoAuthzDeniedReason}>>({
        kind: 'authz.denied',
        githubUserId: OPERATOR_ID,
        reason: 'lookup_error',
      }),
      expect.stringContaining('audit:'),
    )
  })

  it('does not log error.message in lookup_error path (safe error kind only)', async () => {
    // #given — error with a message that could be hostile
    const logger = makeLogger()
    const hostileMessage = 'HOSTILE_MESSAGE_THAT_MUST_NOT_APPEAR'
    const deps = makeDeps({fetch: makeThrowingFetch(new Error(hostileMessage)), logger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — raw error message must not appear in any log call
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(hostileMessage)
  })

  it('fail-closed even when thrown value has hostile toString()', async () => {
    // #given — thrown value with a toString() that returns a hostile string
    const hostileToString = 'HOSTILE_TOSTRING_CONTENT'
    const hostileThrown = {
      toString: () => hostileToString,
    }
    const logger = makeLogger()
    const deps = makeDeps({fetch: makeThrowingFetch(hostileThrown), logger})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — still fails closed
    expect(result).toMatchObject({authorized: false, reason: 'lookup_error'})
    // hostile toString output must not appear in logs
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(hostileToString)
  })

  it('returns lookup_error (not github_denied) on 503', async () => {
    // #given
    const deps = makeDeps({fetch: makeFetch(503)})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — 5xx is lookup_error, not github_denied
    expect(result).toMatchObject({authorized: false, reason: 'lookup_error'})
  })

  it('returns lookup_error (not github_denied) on 500', async () => {
    // #given
    const deps = makeDeps({fetch: makeFetch(500)})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'lookup_error'})
  })

  it('cancels response body on github_denied path', async () => {
    // #given
    const {response, cancelSpy} = makeResponseWithBody(404)
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    const deps = makeDeps({fetch: fetchSpy})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('cancels response body on 5xx lookup_error path', async () => {
    // #given
    const {response, cancelSpy} = makeResponseWithBody(503)
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    const deps = makeDeps({fetch: fetchSpy})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('audit event on denial never includes token value', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeFetch(404), auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeAuditCalls(auditLogger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })
})

// ---------------------------------------------------------------------------
// Rate-limit handling
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — rate-limit handling', () => {
  it('denies and caches through retry window on 429 with Retry-After', async () => {
    // #given — clock starts at 0; Retry-After: 60 seconds
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(429, {'retry-after': '60'})
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache})

    // #when — first call hits rate limit
    const result1 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — denied
    expect(result1).toMatchObject({authorized: false, reason: 'rate_limited'})

    // #when — second call within retry window (30 seconds later)
    now = 30_000
    const result2 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — still denied from cache, no second GitHub call
    expect(result2.authorized).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('emits authz.denied audit event with reason rate_limited on 429', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeFetch(429, {'retry-after': '60'}), auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining<Partial<{kind: string; githubUserId: number; reason: RepoAuthzDeniedReason}>>({
        kind: 'authz.denied',
        githubUserId: OPERATOR_ID,
        reason: 'rate_limited',
      }),
      expect.stringContaining('audit:'),
    )
  })

  it('denies and caches through retry window on 403 with Retry-After', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(403, {'retry-after': '30'})
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache})

    // #when
    const result1 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    expect(result1.authorized).toBe(false)

    // #when — within retry window
    now = 15_000
    const result2 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cached, no second call
    expect(result2.authorized).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries after retry window expires', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, {'retry-after': '10'}))
      .mockResolvedValueOnce(makeResponse(200))
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache})

    // #when — first call hits rate limit
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — after retry window (11 seconds)
    now = 11_000
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — second GitHub call made, now authorized
    expect(result.authorized).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('uses x-ratelimit-reset when Retry-After is absent and remaining=0', async () => {
    // #given — clock at 0; reset at epoch second 60; remaining=0
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(403, {'x-ratelimit-reset': '60', 'x-ratelimit-remaining': '0'})
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache})

    // #when
    const result1 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    expect(result1).toMatchObject({authorized: false, reason: 'rate_limited'})

    // #when — 30 seconds later (before reset)
    now = 30_000
    const result2 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — still cached
    expect(result2.authorized).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caps Retry-After > 15 minutes to MAX_RATE_LIMIT_CACHE_MS', async () => {
    // #given — Retry-After: 3600 seconds (1 hour) — should be capped to 15 min
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(429, {'retry-after': '3600'})
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — 15 minutes + 1ms later (just past cap)
    now = 15 * 60 * 1000 + 1
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cache expired (capped at 15 min), second GitHub call made
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.authorized).toBe(false)
  })

  it('caps x-ratelimit-reset > 15 minutes to MAX_RATE_LIMIT_CACHE_MS', async () => {
    // #given — reset 1 hour from now; remaining=0
    let now = 0
    const resetEpochSec = Math.floor((now + 3600 * 1000) / 1000) // 1 hour from now
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(403, {
      'x-ratelimit-reset': String(resetEpochSec),
      'x-ratelimit-remaining': '0',
    })
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — 15 minutes + 1ms later (just past cap)
    now = 15 * 60 * 1000 + 1
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cache expired (capped at 15 min), second GitHub call made
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('uses NEGATIVE_TTL_MS when x-ratelimit-reset is in the past', async () => {
    // #given — reset in the past; remaining=0
    let now = 60_000 // 60 seconds in
    const pastResetEpochSec = 30 // 30 seconds ago
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(429, {
      'x-ratelimit-reset': String(pastResetEpochSec),
      'x-ratelimit-remaining': '0',
    })
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — still rate_limited (falls back to NEGATIVE_TTL_MS = 30s)
    expect(result).toMatchObject({authorized: false, reason: 'rate_limited'})

    // #when — 20 seconds later (within 30s NEGATIVE_TTL_MS)
    now = 80_000
    const result2 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    expect(result2.authorized).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retry-After of 0 is not treated as rate-limit signal — falls back to NEGATIVE_TTL_MS', async () => {
    // #given — Retry-After: 0 (zero/non-positive should not be a rate-limit window)
    const deps = makeDeps({fetch: makeFetch(429, {'retry-after': '0'})})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — still rate_limited (429 always is), but window falls back to NEGATIVE_TTL_MS
    expect(result).toMatchObject({authorized: false, reason: 'rate_limited'})
  })

  it('empty Retry-After header is not treated as rate-limit signal', async () => {
    // #given — empty Retry-After header
    const deps = makeDeps({fetch: makeFetch(429, {'retry-after': ''})})

    // #when
    const result = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — still rate_limited (429 always is), window falls back to NEGATIVE_TTL_MS
    expect(result).toMatchObject({authorized: false, reason: 'rate_limited'})
  })

  it('cancels response body on rate-limit path', async () => {
    // #given
    const {response, cancelSpy} = makeResponseWithBody(429, {'retry-after': '60'})
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    const deps = makeDeps({fetch: fetchSpy})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(cancelSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — caching', () => {
  it('caches positive authz result for 5 minutes', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache})

    // #when — first call
    const result1 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    expect(result1.authorized).toBe(true)

    // #when — second call within 5 minutes
    now = 4 * 60 * 1000 // 4 minutes
    const result2 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cached, only one GitHub call
    expect(result2.authorized).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after positive cache TTL expires', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when — first call
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — after 5 minutes + jitter
    now = 5 * 60 * 1000 + 1
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — two GitHub calls
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('caches negative authz result for 30 seconds', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(404)
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache})

    // #when — first call
    const result1 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    expect(result1.authorized).toBe(false)

    // #when — second call within 30 seconds
    now = 20_000
    const result2 = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cached, only one GitHub call
    expect(result2.authorized).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after negative cache TTL expires', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(404)
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when — first call
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — after 30 seconds + jitter
    now = 30_000 + 1
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — two GitHub calls
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('different tokens for same operator/repo are cached independently (different token identities)', async () => {
    // #given
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy, cache})

    // #when — two calls with different tokens
    // Each token gets a distinct random identity, so they map to different cache keys.
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, 'ghp_token1', deps)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, 'ghp_token2', deps)

    // #then — two GitHub calls (different token identities = different cache keys)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('different operators for same repo are cached independently', async () => {
    // #given
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(200)
    const allowlist = makeAllowlist([OPERATOR_ID, 54321])
    const deps = makeDeps({fetch: fetchSpy, cache, allowlist})

    // #when — two calls with different operators
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    await checkRepoAuthz(54321, OWNER, REPO, TOKEN, deps)

    // #then — two GitHub calls
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('positive cache hits do not emit audit events', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, auditLogger})

    // #when — first call (cache miss)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const auditCallsAfterFirst = auditLogger.warn.mock.calls.length + auditLogger.info.mock.calls.length

    // #when — second call (cache hit)
    now = 1_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — no additional audit events on cache hit
    const auditCallsAfterSecond = auditLogger.warn.mock.calls.length + auditLogger.info.mock.calls.length
    expect(auditCallsAfterSecond).toBe(auditCallsAfterFirst)
  })
})

// ---------------------------------------------------------------------------
// Cache max-size cap
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — cache max-size cap', () => {
  it('evicts oldest entry when cache reaches max size', () => {
    // #given — cache with max size 3
    const cache = createRepoAuthzCache(3)
    const nowMs = 0
    const futureExpiry = 999_999_999

    // #when — fill to capacity
    cache.set('key1', {authorized: true, expiresAt: futureExpiry})
    cache.set('key2', {authorized: true, expiresAt: futureExpiry})
    cache.set('key3', {authorized: true, expiresAt: futureExpiry})

    // All three present
    expect(cache.get('key1', nowMs)).toBeDefined()
    expect(cache.get('key2', nowMs)).toBeDefined()
    expect(cache.get('key3', nowMs)).toBeDefined()

    // #when — add a fourth entry (exceeds cap)
    cache.set('key4', {authorized: true, expiresAt: futureExpiry})

    // #then — oldest entry (key1) evicted; key2, key3, key4 remain
    expect(cache.get('key1', nowMs)).toBeUndefined()
    expect(cache.get('key2', nowMs)).toBeDefined()
    expect(cache.get('key3', nowMs)).toBeDefined()
    expect(cache.get('key4', nowMs)).toBeDefined()
  })

  it('updating an existing key does not evict when at cap', () => {
    // #given — cache with max size 2
    const cache = createRepoAuthzCache(2)
    const nowMs = 0
    const futureExpiry = 999_999_999

    cache.set('key1', {authorized: true, expiresAt: futureExpiry})
    cache.set('key2', {authorized: true, expiresAt: futureExpiry})

    // #when — update key1 (already present, no eviction needed)
    cache.set('key1', {authorized: false, reason: 'github_denied', expiresAt: futureExpiry})

    // #then — both keys still present, key1 updated
    expect(cache.get('key1', nowMs)).toMatchObject({authorized: false, reason: 'github_denied'})
    expect(cache.get('key2', nowMs)).toBeDefined()
  })

  it('cache does not grow beyond max size under sustained load', () => {
    // #given — cache with max size 5
    const cache = createRepoAuthzCache(5)
    const nowMs = 0
    const futureExpiry = 999_999_999

    // #when — insert 20 unique keys
    for (let i = 0; i < 20; i++) {
      cache.set(`key${i}`, {authorized: true, expiresAt: futureExpiry})
    }

    // #then — only the last 5 keys remain (oldest evicted)
    let presentCount = 0
    for (let i = 0; i < 20; i++) {
      if (cache.get(`key${i}`, nowMs) !== undefined) presentCount++
    }
    expect(presentCount).toBe(5)

    // The last 5 keys (15–19) must be present
    for (let i = 15; i < 20; i++) {
      expect(cache.get(`key${i}`, nowMs)).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Request coalescing
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — request coalescing', () => {
  it('concurrent misses for same operator/repo/token issue only one GitHub API call', async () => {
    // #given
    let resolveFirst!: (value: Response) => void
    const firstCallPromise = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const fetchSpy = vi.fn().mockReturnValueOnce(firstCallPromise)
    const cache = createRepoAuthzCache()
    const deps = makeDeps({fetch: fetchSpy, cache})

    // #when — fire two concurrent requests before the first resolves
    const p1 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const p2 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // Resolve the first fetch
    resolveFirst(makeResponse(200))

    const [result1, result2] = await Promise.all([p1, p2])

    // #then — both authorized, only one GitHub call
    expect(result1.authorized).toBe(true)
    expect(result2.authorized).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('after coalesced miss resolves, subsequent calls use the cache', async () => {
    // #given
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy, cache})

    // #when — first call populates cache
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — second call hits cache
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — only one GitHub call
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Cached negative audit emission
// ---------------------------------------------------------------------------

/** Count audit warn calls with kind === 'authz.denied'. */
function countDeniedAuditCalls(auditLogger: MockAuditLogger): number {
  return auditLogger.warn.mock.calls.filter(c => c[0]?.kind === 'authz.denied').length
}

describe('checkRepoAuthz — cached negative audit emission', () => {
  it('emits authz.denied audit event on each request that hits a cached negative result', async () => {
    // #given — first call populates negative cache
    let now = 0
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeFetch(404), clock: () => now, cache, auditLogger})

    // #when — first call (cache miss, GitHub returns 404)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const callsAfterFirst = countDeniedAuditCalls(auditLogger)

    // #when — second call within TTL (cache hit)
    now = 10_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — audit emitted for both the original miss AND the cached hit
    expect(countDeniedAuditCalls(auditLogger)).toBe(callsAfterFirst + 1)
    const lastCall = auditLogger.warn.mock.calls.at(-1)
    expect(lastCall?.[0]).toMatchObject({
      kind: 'authz.denied',
      githubUserId: OPERATOR_ID,
      reason: 'github_denied',
    })
  })

  it('emits authz.denied on every cached negative hit, not just the first', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: makeFetch(404), clock: () => now, cache, auditLogger})

    // #when — first call (miss)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const afterFirst = countDeniedAuditCalls(auditLogger)

    // #when — two more calls within TTL
    now = 5_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — two additional audit events (one per cached hit)
    expect(countDeniedAuditCalls(auditLogger)).toBe(afterFirst + 2)
  })

  it('cached negative emits structured logger.warn as well as audit event', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const logger = makeLogger()
    const deps = makeDeps({fetch: makeFetch(404), clock: () => now, cache, logger})

    // #when — first call (miss)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const warnCallsAfterFirst = logger.warn.mock.calls.length

    // #when — second call (cache hit)
    now = 5_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — structured logger.warn emitted for cached denial
    expect(logger.warn.mock.calls.length).toBeGreaterThan(warnCallsAfterFirst)
    const cachedWarnCall = logger.warn.mock.calls.at(-1)
    expect(cachedWarnCall?.[0]).toMatchObject({githubUserId: OPERATOR_ID, reason: 'github_denied'})
    // Must not include token
    expect(JSON.stringify(cachedWarnCall)).not.toContain(TOKEN)
    expect(JSON.stringify(cachedWarnCall)).not.toContain('ghp_')
  })

  it('cached negative audit reason propagates rate_limited correctly', async () => {
    // #given — first call hits rate limit
    let now = 0
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({
      fetch: makeFetch(429, {'retry-after': '60'}),
      clock: () => now,
      cache,
      auditLogger,
    })

    // #when — first call (miss, rate limited)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const afterFirst = countDeniedAuditCalls(auditLogger)

    // #when — second call within retry window (cache hit)
    now = 10_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cached hit emits rate_limited reason, not github_denied
    expect(countDeniedAuditCalls(auditLogger)).toBe(afterFirst + 1)
    const lastCall = auditLogger.warn.mock.calls.at(-1)
    expect(lastCall?.[0]).toMatchObject({
      kind: 'authz.denied',
      reason: 'rate_limited',
    })
  })
})

// ---------------------------------------------------------------------------
// Coalesced concurrent denial audit emission
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — coalesced concurrent denial audit emission', () => {
  it('emits authz.denied for each concurrent caller when the shared request denies', async () => {
    // #given — a fetch that denies (404), held until we control resolution
    let resolveFirst!: (value: Response) => void
    const firstCallPromise = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const fetchSpy = vi.fn().mockReturnValueOnce(firstCallPromise)
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: fetchSpy, cache, auditLogger})

    // #when — fire two concurrent requests before the first resolves
    const p1 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const p2 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // Resolve the shared fetch with a denial
    resolveFirst(makeResponse(404))

    const [result1, result2] = await Promise.all([p1, p2])

    // #then — both denied
    expect(result1.authorized).toBe(false)
    expect(result2.authorized).toBe(false)
    // Only one GitHub call
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // But two audit events — one per caller
    expect(countDeniedAuditCalls(auditLogger)).toBe(2)
  })

  it('does not emit audit for coalesced caller when the shared request succeeds', async () => {
    // #given — a fetch that succeeds, held until we control resolution
    let resolveFirst!: (value: Response) => void
    const firstCallPromise = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const fetchSpy = vi.fn().mockReturnValueOnce(firstCallPromise)
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: fetchSpy, cache, auditLogger})

    // #when — fire two concurrent requests
    const p1 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const p2 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    resolveFirst(makeResponse(200))
    await Promise.all([p1, p2])

    // #then — no authz.denied audit events
    expect(countDeniedAuditCalls(auditLogger)).toBe(0)
  })

  it('emits authz.denied for coalesced caller when shared request is rate_limited (429)', async () => {
    // #given — a fetch that returns 429, held until we control resolution
    let resolveFirst!: (value: Response) => void
    const firstCallPromise = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const fetchSpy = vi.fn().mockReturnValueOnce(firstCallPromise)
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: fetchSpy, cache, auditLogger})

    // #when — fire two concurrent requests
    const p1 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const p2 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    resolveFirst(makeResponse(429, {'retry-after': '60'}))
    const [result1, result2] = await Promise.all([p1, p2])

    // #then — both denied with rate_limited
    expect(result1).toMatchObject({authorized: false, reason: 'rate_limited'})
    expect(result2).toMatchObject({authorized: false, reason: 'rate_limited'})
    expect(countDeniedAuditCalls(auditLogger)).toBe(2)
  })

  it('emits authz.denied for coalesced caller when shared request throws (lookup_error)', async () => {
    // #given — a fetch that throws, held until we control resolution
    let rejectFirst!: (err: Error) => void
    const firstCallPromise = new Promise<Response>((_, reject) => {
      rejectFirst = reject
    })
    const fetchSpy = vi.fn().mockReturnValueOnce(firstCallPromise)
    const cache = createRepoAuthzCache()
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({fetch: fetchSpy, cache, auditLogger})

    // #when — fire two concurrent requests
    const p1 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const p2 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    rejectFirst(new Error('network failure'))
    const [result1, result2] = await Promise.all([p1, p2])

    // #then — both denied with lookup_error; two audit events
    expect(result1).toMatchObject({authorized: false, reason: 'lookup_error'})
    expect(result2).toMatchObject({authorized: false, reason: 'lookup_error'})
    expect(countDeniedAuditCalls(auditLogger)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Invalid repo audit correlationId safety
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — invalid repo audit correlationId safety', () => {
  it('uses sentinel correlationId for invalid owner/repo — does not include raw invalid input', async () => {
    // #given — path traversal in owner
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, '../../../etc/passwd', REPO, TOKEN, deps)

    // #then — correlationId must be the safe sentinel, not include raw input
    const call = auditLogger.warn.mock.calls.find(c => c[0]?.kind === 'authz.denied')
    expect(call).toBeDefined()
    expect(call?.[0]?.correlationId).toBe('repo-authz:invalid-repo-name')
    expect(String(call?.[0]?.correlationId)).not.toContain('../../../etc/passwd')
  })

  it('uses sentinel correlationId for null-byte repo — does not include raw invalid input', async () => {
    // #given — null byte in repo name
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, 'repo\u0000name', TOKEN, deps)

    // #then
    const call = auditLogger.warn.mock.calls.find(c => c[0]?.kind === 'authz.denied')
    expect(call?.[0]?.correlationId).toBe('repo-authz:invalid-repo-name')
    expect(String(call?.[0]?.correlationId)).not.toContain('\u0000')
  })

  it('invalid repo audit event does not include raw owner/repo in any field', async () => {
    // #given — junk input
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger})
    const badOwner = '<script>alert(1)</script>'

    // #when
    await checkRepoAuthz(OPERATOR_ID, badOwner, REPO, TOKEN, deps)

    // #then — raw invalid input must not appear in any audit call
    const serialized = serializeAuditCalls(auditLogger)
    expect(serialized).not.toContain(badOwner)
  })
})

// ---------------------------------------------------------------------------
// Token safety
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — token safety', () => {
  it('logger never receives the userOAuthToken value on success', async () => {
    // #given
    const logger = makeLogger()
    const deps = makeDeps({logger, fetch: makeFetch(200)})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — token must not appear in any log call
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('audit logger never receives the userOAuthToken value on success', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeDeps({auditLogger, fetch: makeFetch(200)})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeAuditCalls(auditLogger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('logger never receives the userOAuthToken value on github_denied', async () => {
    // #given
    const logger = makeLogger()
    const deps = makeDeps({logger, fetch: makeFetch(404)})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('logger never receives the userOAuthToken value on rate_limited', async () => {
    // #given
    const logger = makeLogger()
    const deps = makeDeps({logger, fetch: makeFetch(429, {'retry-after': '60'})})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('logger never receives the userOAuthToken value on lookup_error', async () => {
    // #given
    const logger = makeLogger()
    const deps = makeDeps({logger, fetch: makeThrowingFetch(new Error('network error'))})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('logger never receives the userOAuthToken value on invalid_repo_name', async () => {
    // #given
    const logger = makeLogger()
    const deps = makeDeps({logger})

    // #when
    await checkRepoAuthz(OPERATOR_ID, '', REPO, TOKEN, deps)

    // #then
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('logger never receives the userOAuthToken value on not_allowlisted', async () => {
    // #given
    const logger = makeLogger()
    const deps = makeDeps({logger})

    // #when
    await checkRepoAuthz(OTHER_OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('logger never receives the userOAuthToken value on cached negative', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const logger = makeLogger()
    const deps = makeDeps({logger, fetch: makeFetch(404), clock: () => now, cache})

    // #when — first call (miss)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — second call (cache hit)
    now = 5_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })

  it('logger never receives the userOAuthToken value on coalesced denial', async () => {
    // #given
    let resolveFirst!: (value: Response) => void
    const firstCallPromise = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const fetchSpy = vi.fn().mockReturnValueOnce(firstCallPromise)
    const cache = createRepoAuthzCache()
    const logger = makeLogger()
    const deps = makeDeps({fetch: fetchSpy, cache, logger})

    // #when — fire two concurrent requests
    const p1 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    const p2 = checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    resolveFirst(makeResponse(404))
    await Promise.all([p1, p2])

    // #then
    const serialized = serializeLogCalls(logger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })
})

// ---------------------------------------------------------------------------
// createRepoAuthzCache — token identity registry
// ---------------------------------------------------------------------------

describe('createRepoAuthzCache — tokenIdentityFor', () => {
  it('returns the same identity for the same token (cache hit)', () => {
    // #given
    const cache = createRepoAuthzCache()
    const token = 'ghp_sometoken'

    // #when
    const id1 = cache.tokenIdentityFor(token)
    const id2 = cache.tokenIdentityFor(token)

    // #then — stable identity across repeated calls
    expect(id1).toBe(id2)
    expect(typeof id1).toBe('string')
    expect(id1.length).toBeGreaterThan(0)
  })

  it('returns different identities for different tokens', () => {
    // #given
    const cache = createRepoAuthzCache()

    // #when
    const id1 = cache.tokenIdentityFor('ghp_token1')
    const id2 = cache.tokenIdentityFor('ghp_token2')

    // #then — distinct identities
    expect(id1).not.toBe(id2)
  })

  it('token identity does not contain the raw token value', () => {
    // #given
    const cache = createRepoAuthzCache()
    const token = 'ghp_supersecrettoken'

    // #when
    const identity = cache.tokenIdentityFor(token)

    // #then — opaque identity must not expose the raw token
    expect(identity).not.toContain(token)
    expect(identity).not.toContain('ghp_')
  })

  it('identities from different cache instances are independent', () => {
    // #given — two separate cache instances
    const cache1 = createRepoAuthzCache()
    const cache2 = createRepoAuthzCache()
    const token = 'ghp_sharedtoken'

    // #when
    const id1 = cache1.tokenIdentityFor(token)
    const id2 = cache2.tokenIdentityFor(token)

    // #then — different instances assign independent identities (no shared state)
    expect(id1).not.toBe(id2)
  })
})

describe('checkRepoAuthz — cache key token safety', () => {
  it('same token in same cache instance produces a cache hit (one GitHub call)', async () => {
    // #given
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(200)
    const deps = makeDeps({fetch: fetchSpy, cache})

    // #when — two calls with the same token
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — only one GitHub call (same token identity = same cache key)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('cache key does not contain the raw token value', async () => {
    // #given — intercept cache.set to capture the key used
    const capturedKeys: string[] = []
    const realCache = createRepoAuthzCache()
    const spyCache: typeof realCache = {
      ...realCache,
      set(key, entry) {
        capturedKeys.push(key)
        realCache.set(key, entry)
      },
    }
    const deps = makeDeps({fetch: makeFetch(200), cache: spyCache})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — at least one key was written, and none contain the raw token
    expect(capturedKeys.length).toBeGreaterThan(0)
    for (const key of capturedKeys) {
      expect(key).not.toContain(TOKEN)
      expect(key).not.toContain('ghp_')
    }
  })
})

// ---------------------------------------------------------------------------
// createRepoAuthzCache — invalid maxSize hardening (fix 2)
// ---------------------------------------------------------------------------

describe('createRepoAuthzCache — invalid maxSize hardening', () => {
  const futureExpiry = 999_999_999
  const nowMs = 0

  it('maxSize=0 falls back to default and accepts entries', () => {
    // #given
    const cache = createRepoAuthzCache(0)

    // #when
    cache.set('key1', {authorized: true, expiresAt: futureExpiry})

    // #then — cache works; entry is retrievable
    expect(cache.get('key1', nowMs)).toBeDefined()
  })

  it('maxSize=-1 falls back to default and accepts entries', () => {
    // #given
    const cache = createRepoAuthzCache(-1)

    // #when
    cache.set('key1', {authorized: true, expiresAt: futureExpiry})

    // #then
    expect(cache.get('key1', nowMs)).toBeDefined()
  })

  it('maxSize=NaN falls back to default and accepts entries', () => {
    // #given
    const cache = createRepoAuthzCache(Number.NaN)

    // #when
    cache.set('key1', {authorized: true, expiresAt: futureExpiry})

    // #then
    expect(cache.get('key1', nowMs)).toBeDefined()
  })

  it('maxSize=Infinity falls back to default and accepts entries', () => {
    // #given
    const cache = createRepoAuthzCache(Infinity)

    // #when
    cache.set('key1', {authorized: true, expiresAt: futureExpiry})

    // #then
    expect(cache.get('key1', nowMs)).toBeDefined()
  })

  it('maxSize=-Infinity falls back to default and accepts entries', () => {
    // #given
    const cache = createRepoAuthzCache(-Infinity)

    // #when
    cache.set('key1', {authorized: true, expiresAt: futureExpiry})

    // #then
    expect(cache.get('key1', nowMs)).toBeDefined()
  })

  it('maxSize=1 is valid — evicts on second unique key', () => {
    // #given
    const cache = createRepoAuthzCache(1)

    // #when
    cache.set('key1', {authorized: true, expiresAt: futureExpiry})
    cache.set('key2', {authorized: true, expiresAt: futureExpiry})

    // #then — key1 evicted, key2 present
    expect(cache.get('key1', nowMs)).toBeUndefined()
    expect(cache.get('key2', nowMs)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// parseRateLimitWindowMs — strict numeric parsing (fix 3)
// ---------------------------------------------------------------------------

describe('checkRepoAuthz — rate-limit strict numeric parsing', () => {
  it('retry-After: "60junk" is not treated as a valid rate-limit window', async () => {
    // #given — junk suffix on Retry-After
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(429, {'retry-after': '60junk'})
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when — first call
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — 31 seconds later (past NEGATIVE_TTL_MS=30s, not 60s)
    now = 31_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cache expired after NEGATIVE_TTL_MS (not 60s), second GitHub call made
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('x-ratelimit-reset: "123junk" is not treated as a valid reset epoch', async () => {
    // #given — junk suffix on x-ratelimit-reset; remaining=0
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(403, {
      'x-ratelimit-reset': '123junk',
      'x-ratelimit-remaining': '0',
    })
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when — first call
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — 31 seconds later (past NEGATIVE_TTL_MS=30s, not 123s)
    now = 31_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cache expired after NEGATIVE_TTL_MS, second GitHub call made
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retry-After: "60" (clean digits) is still parsed correctly', async () => {
    // #given — clean digit string
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(429, {'retry-after': '60'})
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when — first call
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — 31 seconds later (within 60s window)
    now = 31_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — still cached (60s window), only one GitHub call
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('x-ratelimit-reset: "0x1F4" (hex) is not treated as a valid reset epoch', async () => {
    // #given — hex string: parseInt("0x1F4", 10) = 0, but parseInt("0x1F4") = 500
    // The strict /^\d+$/ regex rejects it entirely.
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makeFetch(403, {
      'x-ratelimit-reset': '0x1F4',
      'x-ratelimit-remaining': '0',
    })
    const deps = makeDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — 31 seconds later (past NEGATIVE_TTL_MS=30s)
    now = 31_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cache expired after NEGATIVE_TTL_MS, second call made
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// checkRepoWriteAuthz — write-level authorization
// ---------------------------------------------------------------------------

/** Build a JSON Response body with a permissions object. */
function makePermissionsResponse(
  permissions: Record<string, boolean>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const body = JSON.stringify({id: 1, name: REPO, permissions})
  return new Response(body, {
    status,
    headers: {'content-type': 'application/json', ...headers},
  })
}

/** Build a fetch stub that returns a permissions body. */
function makePermissionsFetch(permissions: Record<string, boolean>, status = 200): FetchMock {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(makePermissionsResponse(permissions, status))
}

function makeWriteDeps(overrides: Partial<RepoAuthzDeps> = {}): RepoAuthzDeps {
  return {
    allowlist: makeAllowlist([OPERATOR_ID]),
    fetch: makePermissionsFetch({pull: true, push: true, maintain: false, admin: false, triage: false}),
    clock: () => 0,
    random: () => 0.5,
    auditLogger: makeAuditLogger(),
    logger: makeLogger(),
    cache: createRepoAuthzCache(),
    ...overrides,
  }
}

describe('checkRepoWriteAuthz — happy path', () => {
  it('returns {authorized:true, level:"write"} when push is true and admin is false', async () => {
    // #given
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: true, push: true, maintain: false, admin: false, triage: false}),
    })

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: true, level: 'write'})
  })

  it('returns {authorized:true, level:"admin"} when admin is true', async () => {
    // #given
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: true, push: true, maintain: true, admin: true, triage: true}),
    })

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: true, level: 'admin'})
  })

  it('admin:true takes precedence over push:true → level is "admin"', async () => {
    // #given — both push and admin are true
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: true, push: true, maintain: false, admin: true, triage: false}),
    })

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — admin wins
    expect(result).toMatchObject({authorized: true, level: 'admin'})
  })

  it('calls GitHub repos API with correct URL and auth header', async () => {
    // #given
    const fetchSpy = makePermissionsFetch({pull: true, push: true, maintain: false, admin: false, triage: false})
    const deps = makeWriteDeps({fetch: fetchSpy})

    // #when
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const firstCall = fetchSpy.mock.calls[0]
    if (firstCall === undefined) throw new Error('expected fetch to be called')
    const [url, init] = firstCall
    expect(url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}`)
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('does not emit audit event on successful write authorization', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeWriteDeps({auditLogger})

    // #when
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const deniedCalls = auditLogger.warn.mock.calls.filter(c => c[0]?.kind === 'authz.denied')
    expect(deniedCalls).toHaveLength(0)
  })
})

describe('checkRepoWriteAuthz — insufficient_permission (read-only)', () => {
  it('returns {authorized:false, reason:"insufficient_permission"} when only pull is true', async () => {
    // #given — read-only operator: pull=true, push=false, admin=false
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: true, push: false, maintain: false, admin: false, triage: false}),
    })

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'insufficient_permission'})
  })

  it('returns insufficient_permission when push and admin are both false', async () => {
    // #given
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: false, push: false, maintain: false, admin: false, triage: false}),
    })

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'insufficient_permission'})
  })

  it('emits authz.denied audit event with reason insufficient_permission', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: true, push: false, maintain: false, admin: false, triage: false}),
      auditLogger,
    })

    // #when
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(auditLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining<Partial<{kind: string; githubUserId: number; reason: RepoAuthzDeniedReason}>>({
        kind: 'authz.denied',
        githubUserId: OPERATOR_ID,
        reason: 'insufficient_permission',
      }),
      expect.stringContaining('audit:'),
    )
  })
})

describe('checkRepoWriteAuthz — defensive body parsing', () => {
  it('returns insufficient_permission when permissions field is missing from body', async () => {
    // #given — body without permissions field
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({id: 1, name: REPO}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    )
    const deps = makeWriteDeps({fetch: fetchSpy})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — missing permissions → insufficient_permission (fail closed)
    expect(result).toMatchObject({authorized: false, reason: 'insufficient_permission'})
  })

  it('returns insufficient_permission when body is not valid JSON', async () => {
    // #given — malformed JSON body
    const fetchSpy = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('not-json', {status: 200, headers: {'content-type': 'application/json'}}))
    const deps = makeWriteDeps({fetch: fetchSpy})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — malformed body → insufficient_permission (fail closed)
    expect(result).toMatchObject({authorized: false, reason: 'insufficient_permission'})
  })

  it('returns insufficient_permission when permissions is not an object', async () => {
    // #given — permissions is a string, not an object
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({id: 1, permissions: 'admin'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    )
    const deps = makeWriteDeps({fetch: fetchSpy})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'insufficient_permission'})
  })

  it('returns insufficient_permission when permissions.push is not a boolean', async () => {
    // #given — push is a string "true" not boolean true
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({id: 1, permissions: {pull: true, push: 'true', admin: false}}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    )
    const deps = makeWriteDeps({fetch: fetchSpy})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — non-boolean push → insufficient_permission (strict boolean check)
    expect(result).toMatchObject({authorized: false, reason: 'insufficient_permission'})
  })

  it('returns insufficient_permission when body is null JSON', async () => {
    // #given — body is JSON null
    const fetchSpy = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('null', {status: 200, headers: {'content-type': 'application/json'}}))
    const deps = makeWriteDeps({fetch: fetchSpy})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'insufficient_permission'})
  })
})

describe('checkRepoWriteAuthz — preserved denial reasons', () => {
  it('returns not_allowlisted for non-allowlisted operator without GitHub call', async () => {
    // #given
    const fetchSpy = makePermissionsFetch({pull: true, push: true, admin: false})
    const deps = makeWriteDeps({fetch: fetchSpy})

    // #when
    const result = await checkRepoWriteAuthz(OTHER_OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'not_allowlisted'})
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns invalid_repo_name for malformed owner', async () => {
    // #given
    const deps = makeWriteDeps()

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, 'owner<script>', REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'invalid_repo_name'})
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('returns github_denied on 404 from GitHub', async () => {
    // #given
    const deps = makeWriteDeps({fetch: makeFetch(404)})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'github_denied'})
  })

  it('returns rate_limited on 429 with Retry-After', async () => {
    // #given
    const deps = makeWriteDeps({fetch: makeFetch(429, {'retry-after': '60'})})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'rate_limited'})
  })

  it('returns lookup_error on network failure', async () => {
    // #given
    const deps = makeWriteDeps({fetch: makeThrowingFetch(new Error('network error'))})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'lookup_error'})
  })

  it('returns lookup_error on 5xx', async () => {
    // #given
    const deps = makeWriteDeps({fetch: makeFetch(503)})

    // #when
    const result = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    expect(result).toMatchObject({authorized: false, reason: 'lookup_error'})
  })
})

describe('checkRepoWriteAuthz — short TTL and distinct cache key', () => {
  it('caches positive write-authz result for ~60 seconds (not 5 minutes)', async () => {
    // #given — clock starts at 0; jitter=0 so TTL is exactly 60s
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makePermissionsFetch({pull: true, push: true, admin: false})
    const deps = makeWriteDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when — first call
    const result1 = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    expect(result1).toMatchObject({authorized: true, level: 'write'})

    // #when — 59 seconds later (within 60s TTL)
    now = 59_000
    const result2 = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — cached, only one GitHub call
    expect(result2).toMatchObject({authorized: true, level: 'write'})
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after 60-second positive TTL expires', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makePermissionsFetch({pull: true, push: true, admin: false})
    const deps = makeWriteDeps({fetch: fetchSpy, clock: () => now, cache, random: () => 0})

    // #when — first call
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #when — 60 seconds + 1ms later (past TTL)
    now = 60_000 + 1
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — two GitHub calls (TTL expired)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('write-level cache does not collide with read-level cache for same operator/repo/token', async () => {
    // #given — shared cache instance
    const cache = createRepoAuthzCache()
    const readFetch = makeFetch(200)
    const writeFetch = makePermissionsFetch({pull: true, push: true, admin: false})
    const readDeps = makeDeps({fetch: readFetch, cache})
    const writeDeps = makeWriteDeps({fetch: writeFetch, cache})

    // #when — read-level check populates cache
    const readResult = await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, readDeps)
    expect(readResult.authorized).toBe(true)

    // #when — write-level check on same operator/repo/token
    const writeResult = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, writeDeps)

    // #then — write check makes its own GitHub call (distinct cache key)
    expect(writeResult).toMatchObject({authorized: true, level: 'write'})
    expect(readFetch).toHaveBeenCalledTimes(1)
    expect(writeFetch).toHaveBeenCalledTimes(1)
  })

  it('write-level TTL is shorter than read-level TTL (60s vs 5min)', async () => {
    // #given — both checks succeed; advance clock to 2 minutes
    let now = 0
    const cache = createRepoAuthzCache()
    const readFetch = makeFetch(200)
    const writeFetch = makePermissionsFetch({pull: true, push: true, admin: false})
    const readDeps = makeDeps({fetch: readFetch, clock: () => now, cache, random: () => 0})
    const writeDeps = makeWriteDeps({fetch: writeFetch, clock: () => now, cache, random: () => 0})

    // #when — prime both caches
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, readDeps)
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, writeDeps)

    // #when — advance to 90 seconds (past write TTL of 60s, within read TTL of 5min)
    now = 90_000
    await checkRepoAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, readDeps)
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, writeDeps)

    // #then — read still cached (1 call total), write re-fetched (2 calls total)
    expect(readFetch).toHaveBeenCalledTimes(1)
    expect(writeFetch).toHaveBeenCalledTimes(2)
  })

  it('write-level cache level field is preserved on cache hit', async () => {
    // #given
    let now = 0
    const cache = createRepoAuthzCache()
    const fetchSpy = makePermissionsFetch({pull: true, push: false, admin: true})
    const deps = makeWriteDeps({fetch: fetchSpy, clock: () => now, cache})

    // #when — first call (admin)
    const result1 = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)
    expect(result1).toMatchObject({authorized: true, level: 'admin'})

    // #when — second call (cache hit)
    now = 1_000
    const result2 = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — level preserved from cache
    expect(result2).toMatchObject({authorized: true, level: 'admin'})
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('audit event on write-level denial never includes token value', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: true, push: false, admin: false}),
      auditLogger,
    })

    // #when
    await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then
    const serialized = serializeAuditCalls(auditLogger)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('ghp_')
  })
})

describe('checkRepoWriteAuthz — RepoWriteAuthzResult type', () => {
  it('result type carries level on authorized:true', async () => {
    // #given
    const deps = makeWriteDeps({
      fetch: makePermissionsFetch({pull: true, push: true, admin: false}),
    })

    // #when
    const result: RepoWriteAuthzResult = await checkRepoWriteAuthz(OPERATOR_ID, OWNER, REPO, TOKEN, deps)

    // #then — TypeScript narrowing works
    expect(result.authorized).toBe(true)
    // Narrow for the type-level assertion; the expect above is the behavioral check.
    const authorized = result as Extract<RepoWriteAuthzResult, {authorized: true}>
    expect(['write', 'admin']).toContain(authorized.level)
  })
})
