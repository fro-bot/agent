#!/usr/bin/env node
/**
 * bin/postinstall.mjs — committed install-time shim for the harness postinstall hook.
 *
 * Dynamically imports dist/postinstall.mjs when built; exits 0 silently when absent
 * (clean checkout / pre-build). Never exits non-zero — postinstall must never break
 * `pnpm install`. This shim is self-contained-non-fatal so the package.json
 * postinstall script needs no `|| true` guard.
 *
 * Published tarballs ship both bin/ (this shim) and dist/ (built postinstall.mjs),
 * so the shim resolves correctly in both workspace-dev and installed-package layouts.
 */

import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join, dirname} from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const postinstallPath = join(__dirname, '..', 'dist', 'postinstall.mjs')

if (existsSync(postinstallPath)) {
  try {
    await import(postinstallPath)
  } catch (err) {
    process.stderr.write(
      `[harness] postinstall import failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
} else {
  process.stderr.write('[harness] dist not built yet; skipping postinstall (workspace dev)\n')
}
