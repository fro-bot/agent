/**
 * Admin CLI entrypoint for the active-binding deny-key backfill.
 *
 * Thin wrapper around runDenyKeyBackfill — reads argv, delegates all wiring
 * to the shared runner, and exits with the returned code.
 *
 * ## Security invariant
 *
 * This is an OFFLINE/ADMIN entrypoint only. It must NEVER be imported from any
 * request handler, Discord command, or HTTP route. Calling it from a request path
 * would violate the denylist-before-query invariant (the backfill issues GitHub
 * queries to resolve repo identity — that is only safe offline/admin).
 *
 * ## Usage
 *
 *   node --import tsx/esm src/bindings/backfill-deny-keys-cli.ts [--dry-run]
 *
 * Or via bunx (from the repo root):
 *
 *   bunx tsx src/bindings/backfill-deny-keys-cli.ts [--dry-run]
 *
 * Required env vars (same as the gateway daemon):
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (or _FILE variants)
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET, S3_PREFIX
 *   GATEWAY_IDENTITY (optional, defaults to 'discord-gateway')
 */

import process from 'node:process'

import {runDenyKeyBackfill} from './backfill-runner.js'

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const exitCode = await runDenyKeyBackfill({dryRun})
  process.exit(exitCode)
}

// ---------------------------------------------------------------------------
// Entry guard — only run when executed directly
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({level: 'error', msg: 'backfill-deny-keys-cli: unhandled error', error: String(error)}),
    )
    process.exit(1)
  })
}
