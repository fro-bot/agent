/**
 * Tests for the main-dispatch.ts argv dispatch layer.
 *
 * Verifies:
 * - `backfill-deny-keys` subcommand dispatches to runDenyKeyBackfill and exits
 * - `--dry-run` flag is parsed and threaded through
 * - No subcommand → gateway program path is taken (runner not called)
 * - Unknown subcommand → falls through to gateway program (runner not called)
 * - No import-time side effects (gateway program does not start on import)
 *
 * BDD comments: #given / #when / #then.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// ---------------------------------------------------------------------------
// Mock the backfill runner so we never hit real S3/GitHub
// ---------------------------------------------------------------------------

const mockRunDenyKeyBackfill = vi.fn()

vi.mock('./bindings/backfill-runner.js', () => ({
  runDenyKeyBackfill: mockRunDenyKeyBackfill,
}))

// ---------------------------------------------------------------------------
// Mock the gateway program so importing main-dispatch.ts never starts the gateway
// ---------------------------------------------------------------------------

const mockEffectRunPromise = vi.fn()

vi.mock('effect', async importOriginal => {
  const actual = await importOriginal<typeof import('effect')>()
  return {
    ...actual,
    Effect: {
      ...actual.Effect,
      runPromise: mockEffectRunPromise,
    },
  }
})

// ---------------------------------------------------------------------------
// Mock config and program so the Effect program construction doesn't fail
// ---------------------------------------------------------------------------

vi.mock('./config.js', () => ({
  loadGatewayConfig: vi.fn().mockReturnValue({}),
}))

vi.mock('./program.js', () => ({
  makeDiscordClientFromConfig: vi.fn(),
  makeGatewayProgram: vi.fn(),
  makeLogger: vi.fn().mockReturnValue({
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}))

vi.mock('./http/server.js', () => ({
  createAnnounceServer: vi.fn(),
}))

vi.mock('./readiness.js', () => ({
  setupReadinessFlag: vi.fn(),
}))

vi.mock('./runtime-effect.js', () => ({
  validateProviderSemanticsEffect: vi.fn(),
}))

vi.mock('./web/server.js', () => ({
  createOperatorServer: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore process.argv around each test. */
function withArgv(argv: string[]): {restore: () => void} {
  const original = process.argv
  process.argv = argv
  return {
    restore: () => {
      process.argv = original
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('main-dispatch.ts argv dispatch', () => {
  let exitSpy: {mockRestore: () => void; mock: {calls: unknown[]}}
  let savedArgv: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    savedArgv = process.argv

    // Stub process.exit so it never actually exits the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      return undefined as never
    })

    // Default: gateway program resolves cleanly
    mockEffectRunPromise.mockResolvedValue(undefined)
  })

  afterEach(() => {
    process.argv = savedArgv
    exitSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // No import-time side effects
  // -------------------------------------------------------------------------

  it('importing main-dispatch.ts does not start the gateway program (no side effects on import)', async () => {
    // #given — argv has no subcommand (normal gateway invocation)
    process.argv = ['node', 'main.js']

    // #when — import main-dispatch.ts (no top-level execution in this module)
    await import('./main-dispatch.js')

    // #then — Effect.runPromise was NOT called at import time
    expect(mockEffectRunPromise).not.toHaveBeenCalled()
    expect(mockRunDenyKeyBackfill).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // backfill-deny-keys subcommand — happy path (dryRun: false)
  // -------------------------------------------------------------------------

  it('backfill-deny-keys: dispatches runDenyKeyBackfill with dryRun: false and exits with its code', async () => {
    // #given — argv simulates `node dist/main.mjs backfill-deny-keys`
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys'])
    mockRunDenyKeyBackfill.mockResolvedValue(0)

    try {
      // #when — call the exported dispatch function directly
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — runner called with dryRun: false
      expect(mockRunDenyKeyBackfill).toHaveBeenCalledExactlyOnceWith({dryRun: false})

      // #and — process.exit called with the runner's code
      expect(exitSpy).toHaveBeenCalledWith(0)

      // #and — gateway program was NOT started
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  // -------------------------------------------------------------------------
  // backfill-deny-keys subcommand — happy path (dryRun: true)
  // -------------------------------------------------------------------------

  it('backfill-deny-keys --dry-run: dispatches runDenyKeyBackfill with dryRun: true', async () => {
    // #given — argv simulates `node dist/main.mjs backfill-deny-keys --dry-run`
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys', '--dry-run'])
    mockRunDenyKeyBackfill.mockResolvedValue(0)

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — runner called with dryRun: true
      expect(mockRunDenyKeyBackfill).toHaveBeenCalledExactlyOnceWith({dryRun: true})

      // #and — process.exit called with the runner's code
      expect(exitSpy).toHaveBeenCalledWith(0)

      // #and — gateway program was NOT started
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  // -------------------------------------------------------------------------
  // backfill-deny-keys — non-zero exit code propagation
  // -------------------------------------------------------------------------

  it('backfill-deny-keys: exits with code 2 when runner returns 2 (partial failure)', async () => {
    // #given — runner returns partial failure code
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys'])
    mockRunDenyKeyBackfill.mockResolvedValue(2)

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — process.exit called with 2
      expect(exitSpy).toHaveBeenCalledWith(2)
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  // -------------------------------------------------------------------------
  // No subcommand → gateway program path (regression)
  // -------------------------------------------------------------------------

  it('no subcommand: starts the gateway program and does NOT call the backfill runner', async () => {
    // #given — argv has no subcommand (normal gateway invocation)
    const {restore} = withArgv(['node', 'main.js'])
    mockEffectRunPromise.mockResolvedValue(undefined)

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — gateway program was started
      expect(mockEffectRunPromise).toHaveBeenCalledOnce()

      // #and — backfill runner was NOT called
      expect(mockRunDenyKeyBackfill).not.toHaveBeenCalled()

      // #and — process.exit was NOT called (gateway runs as a daemon)
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  // -------------------------------------------------------------------------
  // Unknown subcommand → falls through to gateway (edge case)
  // -------------------------------------------------------------------------

  it('unknown subcommand: falls through to gateway program (runner not called)', async () => {
    // #given — argv has an unrecognized subcommand
    const {restore} = withArgv(['node', 'main.js', 'frobnicate'])
    mockEffectRunPromise.mockResolvedValue(undefined)

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — gateway program was started (unknown args fall through)
      expect(mockEffectRunPromise).toHaveBeenCalledOnce()

      // #and — backfill runner was NOT called
      expect(mockRunDenyKeyBackfill).not.toHaveBeenCalled()

      // #and — process.exit was NOT called
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})
