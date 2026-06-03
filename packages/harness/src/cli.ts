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

const HARNESS_SUBCOMMANDS = new Set(['info', 'patches', 'doctor'])

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
  const binary = resolveBinary()
  const p = getProvenance()

  console.log(`harness doctor`)
  console.log(`  base version:       ${p.baseVersion}`)
  console.log(`  integration commit: ${p.integrationCommit ?? '(unbuilt/dev scaffold)'}`)
  console.log(`  build sha:          ${p.buildSha}`)
  console.log(`  binary path:        ${binary.path}`)
  console.log(`  is built artifact:  ${binary.isBuilt}`)

  if (!binary.resolved) {
    console.error('\n[FAIL] No binary resolved. Install @fro.bot/harness or set OPENCODE_PATH.')
    return 1
  }

  const version = probeBinary(binary.path)
  if (version === null) {
    console.error(`\n[FAIL] Binary not runnable: ${binary.path}`)
    console.error('       Ensure opencode is on PATH or set OPENCODE_PATH.')
    return 1
  }

  console.log(`  binary version:     ${version}`)
  console.log('\n[OK] Binary is present and runnable.')
  return 0
}

function cmdPassthrough(args: readonly string[]): number {
  const binary = resolveBinary()

  if (!binary.resolved) {
    console.error('[harness] No binary resolved. Install @fro.bot/harness or set OPENCODE_PATH.')
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
  if (subcommand !== undefined && HARNESS_SUBCOMMANDS.has(subcommand)) {
    // Unreachable — all reserved subcommands handled above.
    // Kept as a safety net to satisfy exhaustiveness.
    console.error(`[harness] Unhandled reserved subcommand: ${subcommand}`)
    process.exit(1)
  }

  const code = cmdPassthrough(args)
  process.exit(code)
}

main()
