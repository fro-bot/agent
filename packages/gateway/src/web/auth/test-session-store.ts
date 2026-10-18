/**
 * Shared durable session store fixture for tests: the real store and persistence over the shared
 * in-memory object-store fake. Passing the same `objectStore` to a second harness models a restart.
 */

import type {OperatorAllowlist} from './allowlist.js'
import type {DurableSessionStore, SessionIdentity} from './session.js'
import type {TestObjectStore} from './test-object-store.js'

import {Buffer} from 'node:buffer'
import {createSessionPersistence, deriveSessionRecordKey} from './session-persistence.js'
import {createDurableSessionStore, DURABLE_SESSION_TTL_MS} from './session.js'
import {createTestObjectStore} from './test-object-store.js'

export const TEST_SESSION_MAC_KEY = deriveSessionRecordKey(Buffer.from('test-session-record-secret-0123456789', 'utf8'))

export interface TestSessionStoreOptions {
  readonly objectStore?: TestObjectStore
  readonly clock?: () => number
  /** User IDs the load policy treats as allowlisted. Defaults to everyone. */
  readonly allowed?: readonly number[]
  readonly onSessionRevoked?: (githubUserId: number) => void
  readonly maxEntries?: number
  /** Skip the startup load, leaving the store not ready. */
  readonly skipLoad?: boolean
}

export interface TestSessionStoreHarness {
  readonly store: DurableSessionStore
  readonly objectStore: TestObjectStore
}

const noop = (): void => {}
const silentLogger = {debug: noop, info: noop, warn: noop, error: noop}

/** The store and fake, built synchronously and not yet loaded: `create` reports `not_ready`. */
export function buildTestSessionStoreHarness(options: TestSessionStoreOptions = {}): TestSessionStoreHarness {
  const objectStore = options.objectStore ?? createTestObjectStore()
  const clock = options.clock ?? Date.now
  const allowed = options.allowed === undefined ? undefined : new Set(options.allowed)
  const allowlist: OperatorAllowlist = {
    isAuthorized: id => allowed === undefined || allowed.has(id),
    size: allowed?.size ?? 1,
  }
  const store = createDurableSessionStore({
    persistence: createSessionPersistence({
      adapter: objectStore.adapter,
      logger: silentLogger,
      clock,
      macKey: TEST_SESSION_MAC_KEY,
      absoluteTtlMs: DURABLE_SESSION_TTL_MS,
    }),
    clock,
    logger: silentLogger,
    auditLogger: {info: noop, warn: noop},
    allowlist,
    ...(options.onSessionRevoked === undefined ? {} : {onSessionRevoked: options.onSessionRevoked}),
    ...(options.maxEntries === undefined ? {} : {maxEntries: options.maxEntries}),
  })
  return {store, objectStore}
}

export async function createTestSessionStoreHarness(
  options: TestSessionStoreOptions = {},
): Promise<TestSessionStoreHarness> {
  const harness = buildTestSessionStoreHarness(options)
  if (options.skipLoad !== true) {
    const loaded = await harness.store.load()
    if (loaded.success === false) {
      throw new Error(`test session store failed to load: ${loaded.error.phase}`)
    }
  }
  return harness
}

/** A loaded durable store over a fresh object-store fake. */
export async function createTestSessionStore(options: TestSessionStoreOptions = {}): Promise<DurableSessionStore> {
  return (await createTestSessionStoreHarness(options)).store
}

/** Creates a session and returns its ID, failing the test setup on any refusal. */
export async function mintTestSession(
  store: DurableSessionStore,
  identity: SessionIdentity = {githubUserId: 42, login: 'octocat'},
): Promise<string> {
  const created = await store.create(identity)
  if (created.outcome !== 'ok') {
    throw new Error(`expected the test session to be created, got ${created.outcome}`)
  }
  return created.sessionId
}
