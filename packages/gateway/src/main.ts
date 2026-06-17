import process from 'node:process'

import {Effect} from 'effect'

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
// Top-level runner — config may not have loaded, so I instantiate the logger
// at a fixed 'error' level here rather than reading the configured level.
// ---------------------------------------------------------------------------

Effect.runPromise(program).catch((error: unknown) => {
  // Config failed to load, so the configured log level is unavailable — use 'error' directly.
  const startupLogger = makeLogger('error')
  startupLogger.error({err: String(error)}, 'gateway startup failed')
  process.exit(1)
})
