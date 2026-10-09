/**
 * Shared fixtures for the question route tests. Routes are exercised through the
 * real HTTP handlers with a REAL question registry and request gate; only the
 * OpenCode reply/reject effects, GitHub authz fetch, and session/run stores are
 * stubbed, so a test sees the same settlement behavior production does.
 */

import type {QuestionPromptInput, QuestionSideEffects} from '../../approvals/question-registry.js'
import type {RunLocation} from '../../execute/run-index.js'
import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import {Hono} from 'hono'
import {vi} from 'vitest'
import {createQuestionRegistry} from '../../approvals/question-registry.js'
import {createRequestGate} from '../../approvals/request-gate.js'
import {setOperatorRouteGuard} from '../operator-route.js'

export const RUN_ID = 'run-abc'
export const DISCORD_THREAD = 'thread-777'

export function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

export function makeAuditLogger() {
  return {info: vi.fn(), warn: vi.fn()}
}

export function makeSessionStore() {
  return {
    getOperatorToken: vi.fn((_sessionId: string, _nowMs: number) => 'oauth-token-stub'),
    get: vi.fn((_sessionId: string, _nowMs: number) => ({
      githubUserId: 1001,
      login: 'alice',
      issuedAt: 0,
      lastAccessedAt: 0,
      revoked: false,
    })),
  }
}

export function makeRunIndex(location?: RunLocation | 'miss') {
  return {
    lookup: vi.fn(async (_runId: string) =>
      location === 'miss' ? undefined : (location ?? {repo: 'acme/widget', surface: 'web' as const}),
    ),
  }
}

export function makeDenylistCache(denied = false) {
  return {
    getDenylistState: vi.fn(async () => undefined),
    isRepoDenied: vi.fn((_keys: RepoKey) => denied),
  }
}

export function makeBindingsLookup() {
  return {
    getBindingByRepo: vi.fn(async (_owner: string, _repo: string) => ({
      success: true as const,
      data: {
        owner: 'acme',
        repo: 'widget',
        channelId: 'ch-123',
        channelName: 'widget-dev',
        workspacePath: '/workspace/acme/widget',
        createdAt: '2026-01-01T00:00:00Z',
        createdByDiscordId: 'discord-user-1',
        databaseId: 42,
        nodeId: 'R_node_42',
      },
    })),
  }
}

/** Authz deps whose GitHub permission fetch answers with the given permission body. */
export function makeRepoAuthzDeps(permissions: Record<string, boolean>): RepoAuthzDeps {
  return {
    allowlist: {isAuthorized: vi.fn(() => true), size: 1},
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({permissions}), {status: 200, headers: {'content-type': 'application/json'}}),
    ),
    clock: () => 0,
    random: () => 0.5,
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    cache: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      getInFlight: vi.fn(() => undefined),
      setInFlight: vi.fn(),
      deleteInFlight: vi.fn(),
      tokenIdentityFor: vi.fn(() => 'stub-token-identity'),
    },
  }
}

export const writeAuthz = (): RepoAuthzDeps => makeRepoAuthzDeps({push: true, admin: false})
export const readOnlyAuthz = (): RepoAuthzDeps => makeRepoAuthzDeps({pull: true, push: false, admin: false})

export function makeEffects() {
  return {
    replyQuestion: vi.fn(async (_requestID: string, _answers: readonly (readonly string[])[]) => ({ok: true as const})),
    rejectQuestion: vi.fn(async (_requestID: string) => ({ok: true as const})),
  } satisfies QuestionSideEffects
}

export function makeRegistry() {
  const logger = makeLogger()
  return createQuestionRegistry({logger, gate: createRequestGate({logger})})
}

export const SECRET = 'S3CRET-QUESTION-TEXT'

export function pickQuestion(overrides?: Partial<QuestionPromptInput>): QuestionPromptInput {
  return {
    header: 'Env',
    question: 'Which environment?',
    options: [
      {label: 'staging', description: 'safe'},
      {label: 'prod', description: 'careful'},
    ],
    multiple: false,
    custom: true,
    ...overrides,
  }
}

/** Mount a route builder on an app whose guard always authenticates `guardUserId`. */
export function buildGuardedApp(build: (app: Hono) => void, guardUserId = 1001, guardSessionId = 'sess-abc'): Hono {
  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true as const, githubUserId: guardUserId, sessionId: guardSessionId}))
  build(app)
  return app
}
