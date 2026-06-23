#!/usr/bin/env node
/**
 * bin/harness.mjs — committed install-time shim for the harness CLI.
 *
 * Dynamically imports dist/cli.mjs when built; degrades gracefully when absent
 * (clean checkout / pre-build). This file is committed so `pnpm install` never
 * hits ENOENT on the bin entry even before `pnpm build` runs.
 *
 * Published tarballs ship both bin/ (this shim) and dist/ (built cli.mjs), so
 * the shim resolves correctly in both workspace-dev and installed-package layouts.
 */

import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join, dirname} from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '..', 'dist', 'cli.mjs')

if (existsSync(cliPath)) {
  await import(cliPath)
} else {
  process.stderr.write(
    '@fro.bot/harness is not built. Run: pnpm --filter @fro.bot/harness build\n',
  )
  process.exit(1)
}
