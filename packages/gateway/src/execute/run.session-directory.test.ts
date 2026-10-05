import type {ConfirmExpiredHolder} from '@fro-bot/runtime'
import type {SessionStatusClient} from './repo-quiescence.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  makeBinding,
  makeDeps,
  makeMessage,
  makeUpdateFn,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import {createRepoQuiescenceChecker} from './repo-quiescence.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// `session.status` returns `{}` for ANY directory without sessions, so the quiescence check is only sound if it
// queries exactly the directory the run's sessions use. Both must derive from `canonicalWorkspaceTarget`.
// ---------------------------------------------------------------------------

function jsonResponse() {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type'
          ? 'application/json'
          : name.toLowerCase() === 'content-length'
            ? '2'
            : null,
    },
  }
}

describe('session directory ↔ quiescence directory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['stale stored path', {workspacePath: '/old/stale/path'}],
    ['mixed-case owner/repo and stale path', {owner: 'Acme', repo: 'Widget', workspacePath: '/old/stale/path'}],
  ])('the run session directory equals the directory the checker queries (%s)', async (_label, overrides) => {
    // #given — a binding whose stored path and/or casing differ from the canonical checkout
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const queried: string[] = []
    const client: SessionStatusClient = {
      session: {
        status: vi.fn(async ({query}: {query: {directory: string}}) => {
          queried.push(query.directory)
          return {data: {}, response: jsonResponse()}
        }),
      },
    }
    const checkRepoQuiescence = createRepoQuiescenceChecker({
      workspaceOpencodeUrl: 'http://workspace:9200',
      workspaceOpencodeToken: 'secret-bearer-token',
      logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
      createClient: () => client,
    })
    const binding = {...makeBinding(), ...overrides}
    const deps = makeDeps({checkRepoQuiescence, update: makeUpdateFn('ready')})

    // #when — the run executes, then the lock-layer corroborator the run handed to acquireLock is invoked
    await runMention(makeMessage(), binding, deps)
    const acquireArgs = mockRuntime.acquireLock.mock.calls[0] as unknown[]
    const lockRepo = acquireArgs[1] as string
    const confirm = (acquireArgs[6] as {confirmExpiredHolder: ConfirmExpiredHolder}).confirmExpiredHolder
    await confirm({
      repo: lockRepo,
      holder: {repo: lockRepo, holder_id: 'h', surface: 'discord', acquired_at: 't', ttl_seconds: 1, run_id: 'r'},
      signal: new AbortController().signal,
    })

    // #then — one canonical directory for both, never the stored path
    const sessionDirectory = (mockRunOpenCodeCore.mock.calls[0]?.[0] as {directory: string}).directory
    expect(sessionDirectory).toBe('/workspace/repos/acme/widget')
    expect(queried).toEqual([sessionDirectory])
    expect(sessionDirectory).not.toBe('/old/stale/path')
  })
})
