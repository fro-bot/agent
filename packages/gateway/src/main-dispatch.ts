import process from 'node:process'

import {Effect} from 'effect'

import {parseBackfillArgs, runDenyKeyBackfill, USAGE} from './bindings/backfill-runner.js'
import {loadGatewayConfig} from './config.js'
import {createAnnounceServer} from './http/server.js'
import {makeDiscordClientFromConfig, makeGatewayProgram, makeLogger} from './program.js'
import {setupReadinessFlag} from './readiness.js'
import {validateProviderSemanticsEffect} from './runtime-effect.js'
import {runOperatorRouteSmoke} from './web/operator-route-smoke.js'
import {createOperatorServer} from './web/server.js'

// ---------------------------------------------------------------------------
// Main Effect program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // a. Load config
  const config = yield* Effect.try({
    try: () => loadGatewayConfig(),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })

  yield* makeGatewayProgram(
    {
      makeClient: makeDiscordClientFromConfig,
      setupReadinessFlag,
      login: async (client, token) => {
        await client.login(token)
      },
      startAnnounceServer: (serverDeps, serverConfig) => createAnnounceServer(serverDeps, serverConfig),
      startOperatorServer: (serverDeps, serverConfig) => createOperatorServer(serverDeps, serverConfig),
      runProviderSelfTest: async (cc, lg) => {
        await Effect.runPromise(validateProviderSemanticsEffect(cc, lg))
      },
    },
    config,
  )
})

// ---------------------------------------------------------------------------
// Argv dispatch
//
// Branches on process.argv[2]:
//   'backfill-deny-keys'    → parse flags, run the deny-key backfill, exit with its code
//   'operator-route-smoke'  → parse flags, run the route-registration diagnostic, exit with its code
//   anything else           → fall through to the gateway Effect program (today's behavior)
//
// Flag semantics for backfill-deny-keys:
//   (no flag)   → dry-run / preview (SAFE DEFAULT — no writes)
//   --apply     → real run (writes to the live S3 bindings store)
//   --help / -h → print usage, exit 0
//   unknown     → print error + usage, exit 1 (strict validation)
//
// Flag semantics for operator-route-smoke:
//   (no flag)   → run the diagnostic (no side effects — read-only route inspection)
//   --help / -h → print usage, exit 0
//   unknown     → print error + usage, exit 1 (strict validation)
// ---------------------------------------------------------------------------

export const OPERATOR_ROUTE_SMOKE_USAGE = `
Usage: node dist/main.mjs operator-route-smoke [--help|-h]

Offline operator-route registration diagnostic.

Builds the operator Hono app via the production deps-construction path
(buildOperatorServerInputs → buildOperatorApp) with realistic-but-offline
stubs, reads app.routes, and asserts the expected operator route set is
present. No port is bound, no network is required, no credentials are needed.

Exits 0 when all expected operator routes are registered.
Exits 1 when one or more expected routes are absent (names the missing routes).

Options:
  --help, -h  Print this usage message and exit.

Exit codes:
  0  All expected operator routes are registered
  1  One or more routes absent — check logs for which routes are missing
`.trim()

const OPERATOR_ROUTE_SMOKE_KNOWN_FLAGS = new Set(['--help', '-h'])

export function parseOperatorRouteSmokeArgs(
  args: readonly string[],
): {readonly mode: 'help' | 'run'} | {readonly error: string} {
  for (const arg of args) {
    if (!OPERATOR_ROUTE_SMOKE_KNOWN_FLAGS.has(arg)) {
      return {error: `Unknown flag: ${arg}`}
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    return {mode: 'help'}
  }

  return {mode: 'run'}
}

export async function dispatchArgv(): Promise<void> {
  const subcommand = process.argv[2]

  if (subcommand === 'backfill-deny-keys') {
    const parsed = parseBackfillArgs(process.argv.slice(3))

    if ('error' in parsed) {
      console.error(`backfill-deny-keys: ${parsed.error}\n\n${USAGE}`)
      process.exit(1)
    } else if (parsed.mode === 'help') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else {
      const dryRun = parsed.mode !== 'apply'
      const exitCode = await runDenyKeyBackfill({dryRun})
      process.exit(exitCode)
    }
  } else if (subcommand === 'operator-route-smoke') {
    const parsed = parseOperatorRouteSmokeArgs(process.argv.slice(3))

    if ('error' in parsed) {
      console.error(`operator-route-smoke: ${parsed.error}\n\n${OPERATOR_ROUTE_SMOKE_USAGE}`)
      process.exit(1)
    } else if (parsed.mode === 'help') {
      process.stdout.write(`${OPERATOR_ROUTE_SMOKE_USAGE}\n`)
      process.exit(0)
    } else {
      const exitCode = await runOperatorRouteSmoke()
      process.exit(exitCode)
    }
  } else {
    // No subcommand (or unrecognized subcommand) — start the gateway program.
    // Config may not have loaded, so instantiate the logger at a fixed 'error'
    // level here rather than reading the configured level.
    await Effect.runPromise(program).catch((error: unknown) => {
      const startupLogger = makeLogger('error')
      startupLogger.error({err: String(error)}, 'gateway startup failed')
      process.exit(1)
    })
  }
}
