/**
 * Tests for the main-dispatch.ts argv dispatch layer.
 *
 * Verifies:
 * - `backfill-deny-keys` subcommand (no flag) → dryRun: true (safe preview default)
 * - `backfill-deny-keys --apply` → dryRun: false (real write)
 * - `backfill-deny-keys --help` / `-h` → usage printed, exit 0, runner NOT called
 * - `backfill-deny-keys --bogus` (unknown flag) → error + usage, exit 1, runner NOT called
 * - No subcommand → gateway program path is taken (runner not called)
 * - Unknown subcommand → falls through to gateway program (runner not called)
 * - No import-time side effects (gateway program does not start on import)
 * - parseBackfillArgs pure helper covers all branches without process.exit
 *
 * BDD comments: #given / #when / #then.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// ---------------------------------------------------------------------------
// Mock the backfill runner so we never hit real S3/GitHub
// ---------------------------------------------------------------------------

const mockRunDenyKeyBackfill = vi.fn()

vi.mock('./bindings/backfill-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./bindings/backfill-runner.js')>()
  return {
    ...actual,
    runDenyKeyBackfill: mockRunDenyKeyBackfill,
  }
})

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
  let exitSpy: {mockRestore: () => void; mock: {calls: unknown[][]}}
  let stdoutSpy: {mockRestore: () => void; mock: {calls: unknown[][]}}
  let consoleErrorSpy: {mockRestore: () => void; mock: {calls: unknown[][]}}
  let savedArgv: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    savedArgv = process.argv

    // Stub process.exit so it never actually exits the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      return undefined as never
    })

    // Stub process.stdout.write (used for --help output) and console.error.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Default: gateway program resolves cleanly
    mockEffectRunPromise.mockResolvedValue(undefined)
  })

  afterEach(() => {
    process.argv = savedArgv
    exitSpy.mockRestore()
    stdoutSpy.mockRestore()
    consoleErrorSpy.mockRestore()
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
  // backfill-deny-keys subcommand — no flag → preview (dryRun: true) SAFE DEFAULT
  // -------------------------------------------------------------------------

  it('backfill-deny-keys (no flag): dispatches runDenyKeyBackfill with dryRun: true (safe preview default)', async () => {
    // #given — argv simulates `node dist/main.mjs backfill-deny-keys` (no --apply)
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys'])
    mockRunDenyKeyBackfill.mockResolvedValue(0)

    try {
      // #when — call the exported dispatch function directly
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — runner called with dryRun: true (preview is the safe default)
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
  // backfill-deny-keys --apply → real write (dryRun: false)
  // -------------------------------------------------------------------------

  it('backfill-deny-keys --apply: dispatches runDenyKeyBackfill with dryRun: false (real write)', async () => {
    // #given — argv simulates `node dist/main.mjs backfill-deny-keys --apply`
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys', '--apply'])
    mockRunDenyKeyBackfill.mockResolvedValue(0)

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — runner called with dryRun: false (explicit apply)
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
  // backfill-deny-keys --help → usage printed, exit 0, runner NOT called
  // -------------------------------------------------------------------------

  it('backfill-deny-keys --help: prints usage to stdout and exits 0 without calling runner', async () => {
    // #given — argv simulates `node dist/main.mjs backfill-deny-keys --help`
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys', '--help'])

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — usage printed to stdout (via process.stdout.write)
      expect(stdoutSpy).toHaveBeenCalledOnce()

      // #and — exit 0
      expect(exitSpy).toHaveBeenCalledWith(0)

      // #and — runner NOT called
      expect(mockRunDenyKeyBackfill).not.toHaveBeenCalled()

      // #and — gateway program NOT started
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('backfill-deny-keys -h: prints usage to stdout and exits 0 without calling runner', async () => {
    // #given — argv simulates `node dist/main.mjs backfill-deny-keys -h`
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys', '-h'])

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — usage printed to stdout (via process.stdout.write)
      expect(stdoutSpy).toHaveBeenCalledOnce()

      // #and — exit 0
      expect(exitSpy).toHaveBeenCalledWith(0)

      // #and — runner NOT called
      expect(mockRunDenyKeyBackfill).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  // -------------------------------------------------------------------------
  // backfill-deny-keys unknown flag → error + usage, exit 1, runner NOT called
  // -------------------------------------------------------------------------

  it('backfill-deny-keys --dryrun (unknown flag): prints error + usage, exits 1, runner NOT called', async () => {
    // #given — argv simulates a typo: `node dist/main.mjs backfill-deny-keys --dryrun`
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys', '--dryrun'])

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — error printed to stderr
      expect(consoleErrorSpy).toHaveBeenCalledOnce()
      const errorMsg = (consoleErrorSpy.mock.calls[0] as string[])[0]
      expect(errorMsg).toContain('--dryrun')

      // #and — exit 1
      expect(exitSpy).toHaveBeenCalledWith(1)

      // #and — runner NOT called (strict validation closes the typo-silently-writes hole)
      expect(mockRunDenyKeyBackfill).not.toHaveBeenCalled()

      // #and — gateway program NOT started
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('backfill-deny-keys --bogus (unknown flag): prints error + usage, exits 1, runner NOT called', async () => {
    // #given — argv simulates `node dist/main.mjs backfill-deny-keys --bogus`
    const {restore} = withArgv(['node', 'main.js', 'backfill-deny-keys', '--bogus'])

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — error printed to stderr naming the bad flag
      expect(consoleErrorSpy).toHaveBeenCalledOnce()
      const errorMsg = (consoleErrorSpy.mock.calls[0] as string[])[0]
      expect(errorMsg).toContain('--bogus')

      // #and — exit 1
      expect(exitSpy).toHaveBeenCalledWith(1)

      // #and — runner NOT called
      expect(mockRunDenyKeyBackfill).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// parseBackfillArgs — pure unit tests (no process.exit)
// ---------------------------------------------------------------------------

describe('parseBackfillArgs — pure arg parsing', () => {
  it('no args → dry-run mode (safe preview default)', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs([])
    expect(result).toEqual({mode: 'dry-run'})
  })

  it('--apply → apply mode', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['--apply'])
    expect(result).toEqual({mode: 'apply'})
  })

  it('--help → help mode', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['--help'])
    expect(result).toEqual({mode: 'help'})
  })

  it('-h → help mode', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['-h'])
    expect(result).toEqual({mode: 'help'})
  })

  it('--help takes precedence over --apply', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['--apply', '--help'])
    expect(result).toEqual({mode: 'help'})
  })

  it('unknown flag --dryrun → error with flag name', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['--dryrun'])
    expect(result).toEqual({error: 'Unknown flag: --dryrun'})
  })

  it('unknown flag --dry-run → error with flag name', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['--dry-run'])
    expect(result).toEqual({error: 'Unknown flag: --dry-run'})
  })

  it('unknown flag --bogus → error with flag name', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['--bogus'])
    expect(result).toEqual({error: 'Unknown flag: --bogus'})
  })

  it('unknown flag among known flags → error (first unknown wins)', async () => {
    const {parseBackfillArgs} = await import('./bindings/backfill-runner.js')
    const result = parseBackfillArgs(['--apply', '--bogus'])
    expect(result).toEqual({error: 'Unknown flag: --bogus'})
  })
})
