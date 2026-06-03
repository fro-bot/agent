/**
 * postinstall.ts — integrity-verifying binary resolver run at install time.
 *
 * Runs after `npm install @fro.bot/harness` to:
 *   1. Detect the host platform.
 *   2. Locate the per-platform binary from the installed optionalDependencies package.
 *   3. Verify the binary is executable (basic probe — npm provenance attestation
 *      is the cryptographic integrity gate; this is a belt-and-suspenders exec check).
 *   4. Print a clear status message.
 *
 * Exits 0 on success or when no platform binary is available (optional dep not installed).
 * The `|| true` in package.json scripts.postinstall ensures install never fails here.
 *
 * A missing binary is NOT a fatal install error — the harness falls back to the
 * dev scaffold (opencode on PATH). The action setup (Unit 4) fails loud if the
 * binary is absent in CI, where it is required.
 */

import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {binaryPathInPackage, getHostPlatformInfo, UnsupportedPlatformError} from './platform.js'

// Resolve the package root (postinstall runs from the package root).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function log(msg: string): void {
  process.stderr.write(`[harness postinstall] ${msg}\n`)
}

function main(): void {
  // 1. Detect host platform.
  let info
  try {
    info = getHostPlatformInfo()
  } catch (error) {
    if (error instanceof UnsupportedPlatformError) {
      log(`Platform not supported: ${error.message}`)
      log('No platform binary available. Using opencode on PATH as fallback.')
      process.exit(0)
    }
    throw error
  }

  log(`Host platform: ${info.os}/${info.arch} → ${info.packageName}`)

  // 2. Locate the platform binary.
  const platformPkgRoot = path.join(packageRoot, 'node_modules', info.packageName)
  const binaryPath = binaryPathInPackage(platformPkgRoot, info)

  if (!existsSync(binaryPath)) {
    log(`Platform binary not found at: ${binaryPath}`)
    log(`The ${info.packageName} optional dependency may not be installed.`)
    log('Using opencode on PATH as fallback.')
    process.exit(0)
  }

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
