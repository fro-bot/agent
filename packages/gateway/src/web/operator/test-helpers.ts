/**
 * Shared fixtures for the question route tests. Routes are exercised through the
 * real HTTP handlers with a REAL question registry and request gate; only the
 * OpenCode reply/reject effects and the session/run/binding stores are stubbed,
 * so a test sees the same settlement behavior production does.
 */

import type {QuestionPromptInput, QuestionSideEffects} from '../../approvals/question-registry.js'
import type {RunLocation} from '../../execute/run-index.js'
import type {RepoKey} from '../../redaction/denylist.js'
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
    get: vi.fn((_sessionId: string) => ({
      githubUserId: 1001,
      login: 'alice',
      issuedAt: 0,
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

export const WIDGET_BINDING = {
  owner: 'acme',
  repo: 'widget',
  channelId: 'ch-123',
  channelName: 'widget-dev',
  workspacePath: '/workspace/acme/widget',
  createdAt: '2026-01-01T00:00:00Z',
  createdByDiscordId: 'discord-user-1',
  databaseId: 42,
  nodeId: 'R_node_42',
}

export function makeBindingsLookup(
  result:
    | {readonly success: true; readonly data: typeof WIDGET_BINDING | null}
    | {readonly success: false; readonly error: Error} = {success: true, data: WIDGET_BINDING},
) {
  return {getBindingByRepo: vi.fn(async (_owner: string, _repo: string) => result)}
}

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
