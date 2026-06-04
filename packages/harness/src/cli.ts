#!/usr/bin/env node
/**
 * harness CLI — patched OpenCode binary with provenance/operability commands.
 *
 * Subcommand disambiguation:
 *   Reserved harness subcommands: info, patches, doctor
 *   --version / --help: harness-own (prints provenance / usage)
 *   Everything else: passed through to the resolved patched binary.
 *
 * This is the ONLY entry point for the @fro.bot/harness package.
 * No classes; functions only; explicit boolean checks; no as-any.
 */

import {spawnSync} from 'node:child_process'
import process from 'node:process'
import {formatProvenance, getProvenance} from './provenance.js'
import {probeBinary, resolveBinary} from './resolve-binary.js'

function printUsage(): void {
  console.log(`harness — patched OpenCode binary (Fro Bot integration)

Usage:
  harness <opencode-args...>   Pass through to the patched OpenCode binary
  harness info                 Print provenance (base version, integration refs, build sha)
  harness patches              List configured integration refs
  harness doctor               Check the resolved binary is present and runnable
  harness --version            Print harness provenance version
  harness --help               Print this help

Reserved subcommands (info, patches, doctor) are handled by harness itself.
All other arguments are forwarded to the patched OpenCode binary.`)
}

function cmdInfo(): void {
  const p = getProvenance()
  console.log(formatProvenance(p))
}

function cmdPatches(): void {
  const p = getProvenance()
  if (p.integrationRefs.length === 0) {
    console.log('No integration refs configured (dev scaffold).')
    return
  }
  console.log('Integration refs:')
  for (const r of p.integrationRefs) {
    const status = r.upstreamStatus === undefined ? '' : ` [${r.upstreamStatus}]`
    console.log(`  - ${r.ref}${status}`)
    if (r.reason !== undefined) {
      console.log(`    reason: ${r.reason}`)
    }
  }
  if (p.integrationCommit !== null) {
    console.log(`\nFrozen integration commit: ${p.integrationCommit}`)
  }
}

function cmdDoctor(): number {
  let binary
  try {
    binary = resolveBinary()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`\n[FAIL] ${msg}`)
    return 1
  }

  const p = getProvenance()

  console.log(`harness doctor`)
  console.log(`  base version:       ${p.baseVersion}`)
  console.log(`  integration commit: ${p.integrationCommit ?? '(unbuilt/dev scaffold)'}`)
  console.log(`  build sha:          ${p.buildSha}`)
  console.log(`  binary path:        ${binary.path}`)
  console.log(`  is built artifact:  ${binary.isBuilt}`)

  // In production (isBuilt: false with no dev escape hatch), fail with remediation.
  if (!binary.isBuilt && process.env.HARNESS_ALLOW_PATH_FALLBACK !== '1' && process.env.OPENCODE_PATH === undefined) {
    console.error('\n[FAIL] Binary is not a built harness artifact.')
    console.error(
      '       Install the platform package or set OPENCODE_PATH / HARNESS_ALLOW_PATH_FALLBACK=1 for dev use.',
    )
    return 1
  }

  const version = probeBinary(binary.path)
  if (version === null) {
    console.error(`\n[FAIL] Binary not runnable: ${binary.path}`)
    console.error('       Ensure opencode is on PATH or set OPENCODE_PATH.')
    return 1
  }

  console.log(`  binary version:     ${version}`)

  // Verify binary version matches provenance baseVersion when we have a built artifact.
  if (binary.isBuilt && version !== p.baseVersion) {
    console.error(
      `\n[FAIL] Binary version mismatch: binary reports '${version}', provenance expects '${p.baseVersion}'.`,
    )
    console.error('       Reinstall @fro.bot/harness or check the platform package version.')
    return 1
  }

  console.log('\n[OK] Binary is present and runnable.')
  return 0
}

function cmdPassthrough(args: readonly string[]): number {
  let binary
  try {
    binary = resolveBinary()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[harness] ${msg}`)
    return 1
  }

  const result = spawnSync(binary.path, [...args], {
    stdio: 'inherit',
    env: process.env,
  })

  if (result.error !== undefined) {
    console.error(`[harness] Failed to spawn ${binary.path}: ${result.error.message}`)
    return 1
  }

  return result.status ?? 1
}

function main(): void {
  const args = process.argv.slice(2)

  // --help: harness-own
  if (args[0] === '--help' || args[0] === '-h') {
    printUsage()
    process.exit(0)
  }

  // --version: harness-own provenance version
  if (args[0] === '--version' || args[0] === '-v') {
    const p = getProvenance()
    console.log(`@fro.bot/harness base:${p.baseVersion} build:${p.buildSha}`)
    process.exit(0)
  }

  const subcommand = args[0]

  if (subcommand === 'info') {
    cmdInfo()
    process.exit(0)
  }

  if (subcommand === 'patches') {
    cmdPatches()
    process.exit(0)
  }

  if (subcommand === 'doctor') {
    const code = cmdDoctor()
    process.exit(code)
  }

  // Anything not in the reserved set passes through.
  // This includes no-args (which opencode handles as its own help/default).
  const code = cmdPassthrough(args)
  process.exit(code)
}

main()
