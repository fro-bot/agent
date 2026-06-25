import process from 'node:process'

import {Effect} from 'effect'

import {parseBackfillArgs, runDenyKeyBackfill, USAGE} from './bindings/backfill-runner.js'
import {loadGatewayConfig} from './config.js'
import {createAnnounceServer} from './http/server.js'
import {makeDiscordClientFromConfig, makeGatewayProgram, makeLogger} from './program.js'
import {setupReadinessFlag} from './readiness.js'
import {validateProviderSemanticsEffect} from './runtime-effect.js'
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
//   'backfill-deny-keys' → parse flags, run the deny-key backfill, exit with its code
//   anything else        → fall through to the gateway Effect program (today's behavior)
//
// Flag semantics for backfill-deny-keys:
//   (no flag)   → dry-run / preview (SAFE DEFAULT — no writes)
//   --apply     → real run (writes to the live S3 bindings store)
//   --help / -h → print usage, exit 0
//   unknown     → print error + usage, exit 1 (strict validation)
// ---------------------------------------------------------------------------

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
