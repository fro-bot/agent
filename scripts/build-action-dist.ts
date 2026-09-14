#!/usr/bin/env node

// Build orchestration wrapper for the action dist bundle.
//
// Order of operations:
//   1. PREFLIGHT: collect third-party license notices (fail-closed, before tsdown
//      mutates dist/). If this fails, exit non-zero immediately — the committed
//      dist/THIRD_PARTY_NOTICES.txt is left untouched.
//   2. BUNDLE: run the action tsdown build (tsc --noEmit + tsdown). Capture exit
//      status; do not short-circuit on failure.
//   3. ESCAPE (in finally): run the hidden-unicode escape over dist/ regardless
//      of whether the bundle succeeded, so partial dist from a failed bundle is
//      still escaped. Re-propagate the bundle's exit code.
//   4. On bundle success: write the precomputed notice to dist/THIRD_PARTY_NOTICES.txt
//      atomically (temp file + rename). On failure: leave the committed notice intact.
//
// Run via: node --experimental-strip-types scripts/build-action-dist.ts
//
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. The test file uses .js imports for Vitest.

import {execFile} from 'node:child_process'
import {existsSync} from 'node:fs'
import {rename, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {escapeDistHiddenUnicode} from './dist-hidden-unicode.ts'
import {collectThirdPartyNotices} from './third-party-notices.ts'

const execFileAsync = promisify(execFile)

// Repo root resolved from this script's location (scripts/ is one level below root).
// fileURLToPath decodes percent-encoding (e.g. spaces) so path.join works correctly.
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DIST_DIR = join(REPO_ROOT, 'dist')

interface StepResult {
  readonly exitCode: number
}

interface OrchestratorSteps {
  preflight: () => Promise<string>
  bundle: () => Promise<StepResult>
  escape: () => Promise<void>
  writeNotice: (content: string) => Promise<void>
}

/**
 * Pure orchestration function — injectable steps for testability.
 *
 * Returns the exit code the process should use:
 * - 0 on full success (preflight + bundle + escape + notice write all succeeded)
 * - non-zero on any failure, preserving the bundle's exit code when it fails
 */
export async function runBuildOrchestration(steps: OrchestratorSteps): Promise<number> {
  // Step 1: Preflight — collect notices before tsdown touches dist/
  let noticeContent: string
  try {
    noticeContent = await steps.preflight()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] preflight failed: ${message}\n`)
    if (error instanceof Error && error.cause instanceof Error) {
      process.stderr.write(`[build-action-dist] cause: ${error.cause.message}\n`)
    }
    return 1
  }

  // Step 2: Bundle — run tsdown build, capture exit status
  let bundleResult: StepResult
  try {
    bundleResult = await steps.bundle()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] bundle step threw unexpectedly: ${message}\n`)
    bundleResult = {exitCode: 1}
  }

  // Step 3: Escape — always run, even if bundle failed (finally semantics)
  try {
    await steps.escape()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] escape step failed: ${message}\n`)
    // If bundle also failed, preserve its exit code; otherwise surface escape failure
    if (bundleResult.exitCode === 0) {
      return 1
    }
  }

  // Step 4: On bundle success, write the notice atomically
  if (bundleResult.exitCode !== 0) {
    process.stderr.write(`[build-action-dist] bundle failed with exit code ${bundleResult.exitCode}\n`)
    return bundleResult.exitCode
  }

  try {
    await steps.writeNotice(noticeContent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] failed to write THIRD_PARTY_NOTICES.txt: ${message}\n`)
    return 1
  }

  return 0
}

// Ensures a stream's captured output ends in exactly one newline before it is
// interpolated between labelled sections, so a label never lands glued onto an
// unterminated tail line (e.g. `warning: foo[build-action-dist] bundle stdout:`).
function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Pure formatter for a failed bundle spawn's captured output. `tsc` writes its
 * diagnostics to stdout, not stderr, so both streams must be inspected — a
 * type error otherwise produces an empty stderr and the underlying failure is
 * silently discarded. Exported for unit testing.
 */
export function formatBundleFailureOutput(error: unknown, stdout: string, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (stdout === '' && stderr === '') {
    return `[build-action-dist] bundle spawn failed: ${message}\n`
  }
  // Unlike the spawn-failed case above, both children ran and one of them exited
  // non-zero — `error.message` here is `Command failed: <cmd> <args>`, the only thing
  // identifying *which* of tsc/tsdown failed. Always include it: for a tsdown failure
  // whose stderr is a bare rolldown message, this is the only attribution available.
  const commandLine = `[build-action-dist] bundle command failed: ${message}\n`
  if (stdout !== '' && stderr !== '') {
    return `${commandLine}[build-action-dist] bundle stderr:\n${ensureTrailingNewline(stderr)}[build-action-dist] bundle stdout:\n${ensureTrailingNewline(stdout)}`
  }
  return stdout === ''
    ? `${commandLine}${ensureTrailingNewline(stderr)}`
    : `${commandLine}[build-action-dist] bundle stdout:\n${ensureTrailingNewline(stdout)}`
}

// Node's default 1 MB `maxBuffer` silently truncates a child's stdout/stderr once
// exceeded, killing the child. Now that stdout is the primary diagnostic channel
// (tsc writes its errors there), a truncated capture would hide the real failure.
// 10 MB comfortably covers verbose tsc/rolldown output without retaining an
// effectively unbounded buffer for a build step that runs once per CI job.
const BUNDLE_MAX_BUFFER_BYTES = 10 * 1024 * 1024

// Factored out of the catch block so the non-numeric `error.code` case is an explicit,
// commented branch rather than falling through a ternary's `else` and silently
// collapsing to 1 the same way a plain tool failure would. Exported for unit testing.
export function deriveBundleExitCode(error: unknown): number {
  const code = error != null && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (typeof code === 'number') {
    return code
  }
  // execFile sets error.code to the *string* 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' (not a
  // number) when a child's output exceeds maxBuffer; there is no numeric exit code to
  // report for a killed child, so this falls back to a plain failure code (1). The
  // overflow itself is still distinguishable in the output: formatBundleFailureOutput
  // always includes error.message, and Node's maxBuffer error message names the
  // overflowing stream (e.g. "stdout maxBuffer length exceeded"), unlike a bare tool
  // failure.
  return 1
}

async function runBundle(): Promise<StepResult> {
  try {
    // Mirror apps/action/package.json build: tsc --noEmit then tsdown.
    // REPO_ROOT is resolved from this script's location, not from process.cwd().
    await execFileAsync('bunx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: BUNDLE_MAX_BUFFER_BYTES,
    })
    await execFileAsync('bunx', ['tsdown', '-c', 'tsdown.config.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: BUNDLE_MAX_BUFFER_BYTES,
    })
    return {exitCode: 0}
  } catch (error) {
    const exitCode = deriveBundleExitCode(error)
    const stderr =
      error != null && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : ''
    const stdout =
      error != null && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string'
        ? error.stdout
        : ''
    process.stderr.write(formatBundleFailureOutput(error, stdout, stderr))
    return {exitCode}
  }
}

async function runEscape(): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    console.log('[build-action-dist] dist/ does not exist — bundle failed before emitting output, skipping escape')
    return
  }
  const results = await escapeDistHiddenUnicode(DIST_DIR)
  if (results.length === 0) {
    console.log('[build-action-dist] dist/ is clean — no hidden Unicode found')
    return
  }
  for (const {file, replacements} of results) {
    console.log(`[build-action-dist] scrubbed ${replacements} char(s) in ${file}`)
  }
  console.log(`[build-action-dist] escape done — ${results.length} file(s) modified`)
}

async function writeNoticeAtomic(content: string): Promise<void> {
  // Stage the temp file inside dist/ so the rename stays on the same filesystem
  // (a cross-device rename from the OS tmpdir fails with EXDEV on some CI mounts).
  const tmpFile = join(DIST_DIR, `.THIRD_PARTY_NOTICES_${Date.now()}.tmp`)
  try {
    await writeFile(tmpFile, content, 'utf8')
    await rename(tmpFile, join(DIST_DIR, 'THIRD_PARTY_NOTICES.txt'))
  } catch (error) {
    // Clean up the temp file so it doesn't leak into dist/ or pollute git status.
    await unlink(tmpFile).catch(() => undefined)
    throw error
  }
  console.log('[build-action-dist] wrote dist/THIRD_PARTY_NOTICES.txt')
}

async function main(): Promise<void> {
  const packageJsonPath = join(REPO_ROOT, 'package.json')
  const exitCode = await runBuildOrchestration({
    preflight: async () => collectThirdPartyNotices(packageJsonPath),
    bundle: runBundle,
    escape: runEscape,
    writeNotice: writeNoticeAtomic,
  })

  process.exitCode = exitCode
}

try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[build-action-dist] fatal: ${message}\n`)
  process.exitCode = 1
}
