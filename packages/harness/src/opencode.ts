#!/usr/bin/env node
/**
 * opencode shim — the `opencode` command that a global `@fro.bot/harness` install puts on PATH.
 *
 * Tools that look `opencode` up by name (the OpenCode SDK, editors, scripts) get the patched binary. There are NO
 * reserved subcommands: every argument, `upgrade` included, passes through unchanged. Signals are forwarded to the
 * child and its exit code or terminating signal is propagated (see run-passthrough.ts).
 */

import process from 'node:process'
import {runPassthrough} from './run-passthrough.js'

runPassthrough({label: 'opencode', args: process.argv.slice(2)}).catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`[opencode] Unexpected error: ${msg}`)
  process.exit(1)
})
