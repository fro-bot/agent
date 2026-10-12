/**
 * Shared entry-point plumbing for the `opencode` shim and the `harness` passthrough.
 *
 * Both entry points resolve the patched binary without probing it, run it through the signal-forwarding exec helper,
 * and turn the outcome into a process exit. Keeping that mapping in one place is what makes the two behave alike.
 */

import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {execBinary, exitStatusFor, type ExitStatus} from './exec-binary.js'
import {resolveBinaryNoProbe, type ResolveFailureKind} from './resolve-binary.js'

export type PassthroughLabel = 'opencode' | 'harness'

export interface PassthroughOptions {
  /** Prefix for diagnostics. */
  readonly label: PassthroughLabel
  /** Every argv element after the entry point, passed to the binary unchanged. */
  readonly args: readonly string[]
}

/** Safety net for a re-raised signal whose default action did not terminate us (for example an ignored SIGINT). */
const RERAISE_GRACE_MS = 100

/**
 * Absolute paths of both harness entry points, in every spelling they take: sources under `src/`, the bundled
 * `dist/*.mjs`, and the script Node was started with (which may be an npm/bun `.bin` symlink — the resolver
 * follows links and compares inodes, so a link to either entry point is caught too). Missing paths are harmless.
 */
export function harnessEntryPoints(
  moduleUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): readonly string[] {
  const dir = path.dirname(fileURLToPath(moduleUrl))
  const entries = ['opencode', 'cli'].flatMap(name =>
    ['.ts', '.mjs', '.js'].map(ext => path.join(dir, `${name}${ext}`)),
  )
  return argv1 === undefined || argv1.length === 0 ? entries : [...entries, path.resolve(argv1)]
}

/** 126 when the candidate exists but cannot be executed; 127 for everything else (the shell convention). */
export function exitCodeForResolveFailure(kind: ResolveFailureKind): number {
  return kind === 'not-executable' ? 126 : 127
}

/** Resolver messages carry a `[harness]` prefix; swap it for the entry point's own label. */
export function labelMessage(label: PassthroughLabel, message: string): string {
  return `[${label}] ${message.replace(/^\[harness\]\s*/, '')}`
}

/**
 * Act on how the child ended. Never returns.
 *
 * - `exit`: exit with that code.
 * - `reraise`: drop every listener for the signal and raise it on ourselves so our parent sees a signal death.
 *   If the process is somehow still alive shortly afterwards, exit `128 + signal` instead.
 */
export function applyExitStatus(status: ExitStatus): void {
  if (status.kind === 'exit') {
    process.exit(status.code)
  }
  const {signal} = status
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
  setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 0)), RERAISE_GRACE_MS)
}

/**
 * Resolve the binary, run it, and exit the way it did. Resolution failures and spawn failures print a diagnostic
 * and exit 126/127.
 */
export async function runPassthrough(options: PassthroughOptions): Promise<void> {
  const resolved = resolveBinaryNoProbe({entryPoints: harnessEntryPoints()})
  if (resolved.ok === false) {
    console.error(labelMessage(options.label, resolved.message))
    process.exit(exitCodeForResolveFailure(resolved.kind))
  }

  const outcome = await execBinary(resolved.path, options.args)
  if (outcome.kind === 'spawn-error') {
    console.error(`[${options.label}] Failed to spawn ${resolved.path}: ${outcome.message}`)
  }
  applyExitStatus(exitStatusFor(outcome))
}
