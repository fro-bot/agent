/**
 * Tests for the main-dispatch.ts argv dispatch layer.
 *
 * Verifies:
 * - `backfill-deny-keys` subcommand (no flag) → dryRun: true (safe preview default)
 * - `backfill-deny-keys --apply` → dryRun: false (real write)
 * - `backfill-deny-keys --help` / `-h` → usage printed, exit 0, runner NOT called
 * - `backfill-deny-keys --bogus` (unknown flag) → error + usage, exit 1, runner NOT called
 * - `operator-route-smoke` → runs the diagnostic, exits with its code
 * - `operator-route-smoke --help` / `-h` → usage printed, exit 0, diagnostic NOT called
 * - `operator-route-smoke --bogus` (unknown flag) → error + usage, exit 1, diagnostic NOT called
 * - No subcommand → gateway program path is taken (runner not called)
 * - Startup failure → `gateway startup failed` with no detail, except an object-store settings error, which logs
 *   `gateway config invalid` with the (value-free) message
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

const mockLoadGatewayConfig = vi.fn()

vi.mock('./config.js', () => ({
  loadGatewayConfig: mockLoadGatewayConfig,
}))

vi.mock('./program.js', () => ({
  makeDiscordClientFromConfig: vi.fn(),
  makeGatewayProgram: vi.fn(),
  makeLogger: vi.fn().mockReturnValue({
    error: (context: Record<string, unknown>, msg: string) =>
      console.error(JSON.stringify({level: 'error', ...context, msg})),
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

vi.mock('./runtime-effect.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./runtime-effect.js')>()
  return {
    ...actual,
    validateProviderSemanticsEffect: vi.fn(),
  }
})

vi.mock('./web/server.js', () => ({
  createOperatorServer: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock the operator-route-smoke diagnostic so we never build a real Hono app
// ---------------------------------------------------------------------------

const mockRunOperatorRouteSmoke = vi.fn()

vi.mock('./web/operator-route-smoke.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./web/operator-route-smoke.js')>()
  return {
    ...actual,
    runOperatorRouteSmoke: mockRunOperatorRouteSmoke,
  }
})

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

    // Default: config loads (as an empty object; the program itself is mocked) and the gateway program resolves
    mockLoadGatewayConfig.mockReturnValue({})
    mockEffectRunPromise.mockResolvedValue(undefined)
    // Default: diagnostic returns success
    mockRunOperatorRouteSmoke.mockResolvedValue(0)
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
  // operator-route-smoke subcommand — runs diagnostic, exits with its code
  // -------------------------------------------------------------------------

  it('operator-route-smoke: runs the diagnostic and exits with its code (0 = success)', async () => {
    // #given — argv simulates `node dist/main.mjs operator-route-smoke`
    const {restore} = withArgv(['node', 'main.js', 'operator-route-smoke'])
    mockRunOperatorRouteSmoke.mockResolvedValue(0)

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — diagnostic called
      expect(mockRunOperatorRouteSmoke).toHaveBeenCalledOnce()

      // #and — process.exit called with the diagnostic's code
      expect(exitSpy).toHaveBeenCalledWith(0)

      // #and — gateway program was NOT started
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('operator-route-smoke: exits with code 1 when diagnostic returns 1 (routes absent)', async () => {
    // #given — diagnostic returns failure
    const {restore} = withArgv(['node', 'main.js', 'operator-route-smoke'])
    mockRunOperatorRouteSmoke.mockResolvedValue(1)

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — process.exit called with 1
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('operator-route-smoke --help: prints usage to stdout and exits 0 without calling diagnostic', async () => {
    // #given — argv simulates `node dist/main.mjs operator-route-smoke --help`
    const {restore} = withArgv(['node', 'main.js', 'operator-route-smoke', '--help'])

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — usage printed to stdout
      expect(stdoutSpy).toHaveBeenCalledOnce()

      // #and — exit 0
      expect(exitSpy).toHaveBeenCalledWith(0)

      // #and — diagnostic NOT called
      expect(mockRunOperatorRouteSmoke).not.toHaveBeenCalled()

      // #and — gateway program NOT started
      expect(mockEffectRunPromise).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('operator-route-smoke -h: prints usage to stdout and exits 0 without calling diagnostic', async () => {
    // #given — argv simulates `node dist/main.mjs operator-route-smoke -h`
    const {restore} = withArgv(['node', 'main.js', 'operator-route-smoke', '-h'])

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — usage printed to stdout
      expect(stdoutSpy).toHaveBeenCalledOnce()

      // #and — exit 0
      expect(exitSpy).toHaveBeenCalledWith(0)

      // #and — diagnostic NOT called
      expect(mockRunOperatorRouteSmoke).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('operator-route-smoke --bogus (unknown flag): prints error + usage, exits 1, diagnostic NOT called', async () => {
    // #given — argv simulates `node dist/main.mjs operator-route-smoke --bogus`
    const {restore} = withArgv(['node', 'main.js', 'operator-route-smoke', '--bogus'])

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

      // #and — diagnostic NOT called
      expect(mockRunOperatorRouteSmoke).not.toHaveBeenCalled()

      // #and — gateway program NOT started
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

  it('gateway startup failure does not log rejection details and exits nonzero', async () => {
    // #given — the gateway Effect rejects with a fabricated credential-bearing error
    const fabricatedSecret = 'FABRICATED_STARTUP_TOKEN_DO_NOT_LOG'
    const {restore} = withArgv(['node', 'main.js'])
    mockEffectRunPromise.mockRejectedValueOnce(new Error(`startup failed with token=${fabricatedSecret}`))

    try {
      // #when — call the real dispatcher and let its startup failure handler run
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — stderr retains fixed context but never includes rejection details
      expect(consoleErrorSpy).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({level: 'error', msg: 'gateway startup failed'}),
      )
      expect(consoleErrorSpy.mock.calls.flat().join(' ')).not.toContain(fabricatedSecret)
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      restore()
    }
  })

  it('startup failure from an object-store settings error logs gateway config invalid with the message', async () => {
    // #given — the gateway Effect fails with an ObjectStoreConfigError, wrapped in a FiberFailure as the real
    // Effect.runPromise does
    const {ObjectStoreConfigError} = await import('./object-store-config.js')
    const {Effect: ActualEffect} = await vi.importActual<typeof import('effect')>('effect')
    const {restore} = withArgv(['node', 'main.js'])
    mockEffectRunPromise.mockImplementationOnce(async () =>
      ActualEffect.runPromise(ActualEffect.fail(new ObjectStoreConfigError('S3_ENDPOINT: must use https'))),
    )

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then — the value-free message is logged under the fixed config message
      expect(consoleErrorSpy).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({level: 'error', error: 'S3_ENDPOINT: must use https', msg: 'gateway config invalid'}),
      )
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      restore()
    }
  })

  it('startup failure that is an unwrapped ObjectStoreConfigError also logs gateway config invalid', async () => {
    // #given
    const {ObjectStoreConfigError} = await import('./object-store-config.js')
    const {restore} = withArgv(['node', 'main.js'])
    mockEffectRunPromise.mockRejectedValueOnce(new ObjectStoreConfigError('S3_PREFIX: bad prefix'))

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then
      expect(consoleErrorSpy).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({level: 'error', error: 'S3_PREFIX: bad prefix', msg: 'gateway config invalid'}),
      )
    } finally {
      restore()
    }
  })

  it('a non-object-store failure inside a FiberFailure keeps the detail-free message', async () => {
    // #given — a different config failure (value-echoing messages exist elsewhere in loadGatewayConfig)
    const fabricated = 'FABRICATED_LOG_LEVEL_VALUE_DO_NOT_LOG'
    const {Effect: ActualEffect} = await vi.importActual<typeof import('effect')>('effect')
    const {restore} = withArgv(['node', 'main.js'])
    mockEffectRunPromise.mockImplementationOnce(async () =>
      ActualEffect.runPromise(ActualEffect.fail(new Error(`Invalid LOG_LEVEL value: "${fabricated}"`))),
    )

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then
      expect(consoleErrorSpy).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({level: 'error', msg: 'gateway startup failed'}),
      )
      expect(consoleErrorSpy.mock.calls.flat().join(' ')).not.toContain(fabricated)
    } finally {
      restore()
    }
  })

  it('a real loadGatewayConfig failure from a bad S3_ENDPOINT logs gateway config invalid, never the value', async () => {
    // #given — the real loader and the real program run: S3 settings with an http endpoint and no opt-in
    const {loadGatewayConfig} = await vi.importActual<typeof import('./config.js')>('./config.js')
    const {Effect: ActualEffect} = await vi.importActual<typeof import('effect')>('effect')
    mockLoadGatewayConfig.mockImplementation(loadGatewayConfig)
    mockEffectRunPromise.mockImplementationOnce(async (program: Parameters<typeof ActualEffect.runPromise>[0]) =>
      ActualEffect.runPromise(program),
    )
    const savedEnv = {...process.env}
    Object.assign(process.env, {
      DISCORD_TOKEN: 'test-token',
      DISCORD_APPLICATION_ID: 'test-app-id',
      S3_BUCKET: 'test-bucket',
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: 'http://secret-host-marker.internal:9000',
    })
    for (const key of ['S3_ENDPOINT_FILE', 'S3_ALLOW_INSECURE_ENDPOINT', 'S3_ALLOW_INSECURE_ENDPOINT_FILE']) {
      delete process.env[key]
    }
    const {restore} = withArgv(['node', 'main.js'])

    try {
      // #when
      const {dispatchArgv} = await import('./main-dispatch.js')
      await dispatchArgv()

      // #then
      const logged = consoleErrorSpy.mock.calls.flat().join(' ')
      expect(logged).toContain('"msg":"gateway config invalid"')
      expect(logged).toContain('S3_ENDPOINT: ')
      expect(logged).not.toContain('secret-host-marker')
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      restore()
      process.env = savedEnv
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
// parseOperatorRouteSmokeArgs — pure unit tests (no process.exit)
// ---------------------------------------------------------------------------

describe('parseOperatorRouteSmokeArgs — pure arg parsing', () => {
  it('no args → run mode', async () => {
    const {parseOperatorRouteSmokeArgs} = await import('./main-dispatch.js')
    const result = parseOperatorRouteSmokeArgs([])
    expect(result).toEqual({mode: 'run'})
  })

  it('--help → help mode', async () => {
    const {parseOperatorRouteSmokeArgs} = await import('./main-dispatch.js')
    const result = parseOperatorRouteSmokeArgs(['--help'])
    expect(result).toEqual({mode: 'help'})
  })

  it('-h → help mode', async () => {
    const {parseOperatorRouteSmokeArgs} = await import('./main-dispatch.js')
    const result = parseOperatorRouteSmokeArgs(['-h'])
    expect(result).toEqual({mode: 'help'})
  })

  it('unknown flag → error with flag name', async () => {
    const {parseOperatorRouteSmokeArgs} = await import('./main-dispatch.js')
    const result = parseOperatorRouteSmokeArgs(['--bogus'])
    expect(result).toEqual({error: 'Unknown flag: --bogus'})
  })

  it('unknown flag among known flags → error (first unknown wins)', async () => {
    const {parseOperatorRouteSmokeArgs} = await import('./main-dispatch.js')
    const result = parseOperatorRouteSmokeArgs(['--help', '--bogus'])
    expect(result).toEqual({error: 'Unknown flag: --bogus'})
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
