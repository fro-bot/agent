/**
 * postinstall.ts — integrity-verifying binary resolver run at install time.
 *
 * Runs after `npm install @fro.bot/harness` to:
 *   1. Detect the host platform.
 *   2. Locate the per-platform binary from the installed optionalDependencies package
 *      via Node module resolution (handles pnpm/npm hoisting correctly).
 *   3. Verify the binary is executable (basic probe — npm provenance attestation
 *      is the cryptographic integrity gate; this is a belt-and-suspenders exec check).
 *   4. Print a clear status message.
 *
 * Exits 0 on success or when no platform binary is available (optional dep not installed).
 * The postinstall hook is invoked via bin/postinstall.mjs, which is self-contained-non-fatal:
 * it catches import errors and always exits 0 when dist is absent, so install never fails
 * regardless of this module's behavior.
 *
 * A missing binary is NOT a fatal install error — the harness falls back to the
 * dev scaffold (opencode on PATH). The action setup fails loud if the binary is
 * absent in CI, where it is required.
 */

import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import path from 'node:path'
import process from 'node:process'
import {binaryPathInPackage, getHostPlatformInfo} from './platform.js'

function log(msg: string): void {
  process.stderr.write(`[harness postinstall] ${msg}\n`)
}

function main(): void {
  // 1. Detect host platform.
  const platformResult = getHostPlatformInfo()
  if (!platformResult.ok) {
    log(`Platform not supported: ${platformResult.error}`)
    log('No platform binary available. Using opencode on PATH as fallback.')
    process.exit(0)
  }

  const info = platformResult.info
  log(`Host platform: ${info.os}/${info.arch} → ${info.packageName}`)

  // 2. Locate the platform binary via Node module resolution.
  //    createRequire resolves from this file's location, correctly handling
  //    pnpm/npm hoisting (the platform package may not be in a local node_modules).
  const require = createRequire(import.meta.url)
  let platformPkgRoot: string
  try {
    const pkgJsonPath = require.resolve(`${info.packageName}/package.json`)
    platformPkgRoot = path.dirname(pkgJsonPath)
  } catch {
    log(`Platform package ${info.packageName} not found (optional dependency not installed).`)
    log('Using opencode on PATH as fallback.')
    process.exit(0)
  }

  const binaryPath = binaryPathInPackage(platformPkgRoot, info)

  // 3. Verify the binary is executable.
  try {
    const version = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    log(`Binary verified: ${binaryPath} (version: ${version})`)
    log('Platform binary ready.')
  } catch {
    log(`Binary found but not executable: ${binaryPath}`)
    log('Using opencode on PATH as fallback.')
  }
}

main()
