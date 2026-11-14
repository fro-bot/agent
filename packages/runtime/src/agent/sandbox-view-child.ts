import type {MountEntry, SandboxViewPolicy, SandboxViewStage, ViewOp} from './sandbox-view.js'
import {
  parseMountInfo,
  parseSandboxViewPolicy,
  planViewBind,
  planViewSeal,
  validateViewPolicy,
  verifyView,
} from './sandbox-view.js'

/**
 * The view builder's main loop, with its process I/O injected so tests can run it against a model of the kernel.
 *
 * It runs as root inside the launch's private mount namespace, once, before the agent starts. It reads the policy
 * (JSON, one argument), builds the view with the planned operations, re-reads the mount table and checks it. It stops at
 * the first failure. It prints nothing on success. On failure it prints one JSON line with a fixed stage name and exits
 * non-zero: no path, no message and no tool output, so nothing the agent could influence reaches the log.
 */

/** Exit codes. Zero is a built and verified view. */
export const SANDBOX_VIEW_EXIT_INVALID_POLICY = 64
export const SANDBOX_VIEW_EXIT_FAILED = 78

/** Longest one mount or umount may take. */
export const SANDBOX_VIEW_OP_TIMEOUT_MS = 10_000
/** Longest the whole build may take: a build is 60 to 90 ms on the hosted images. */
export const SANDBOX_VIEW_TOTAL_TIMEOUT_MS = 30_000

export interface SandboxViewChildIo {
  /** The policy JSON: `process.argv[2]`. */
  readonly policyText: string | undefined
  readonly readMountInfo: () => Promise<string>
  /** Runs one tool by absolute path, with a deadline that kills it. `ok` is exit 0. */
  readonly run: (argv: readonly string[], timeoutMs: number) => Promise<'failed' | 'ok' | 'timeout'>
  readonly mkdir: (directory: string) => Promise<void>
  readonly realpath: (target: string) => Promise<string>
  readonly isEmptyDirectory: (target: string) => Promise<boolean>
  readonly stdout: {readonly write: (chunk: string) => unknown}
  readonly now?: () => number
  readonly opTimeoutMs?: number
  readonly totalTimeoutMs?: number
}

function parsePolicyText(text: string | undefined): SandboxViewPolicy | null {
  if (text === undefined) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = parseSandboxViewPolicy(decoded)
  return parsed.success ? parsed.data : null
}

export async function runSandboxViewChild(io: SandboxViewChildIo): Promise<number> {
  const now = io.now ?? Date.now
  const deadline = now() + (io.totalTimeoutMs ?? SANDBOX_VIEW_TOTAL_TIMEOUT_MS)
  const opTimeoutMs = io.opTimeoutMs ?? SANDBOX_VIEW_OP_TIMEOUT_MS

  const finish = (stage: SandboxViewStage | null): number => {
    if (stage === null) return 0
    io.stdout.write(`${JSON.stringify({view: 'failed', stage})}\n`)
    return stage === 'policy' ? SANDBOX_VIEW_EXIT_INVALID_POLICY : SANDBOX_VIEW_EXIT_FAILED
  }

  const policy = parsePolicyText(io.policyText)
  if (policy === null) return finish('policy')

  const readTable = async (): Promise<readonly MountEntry[] | null> => {
    try {
      const parsed = parseMountInfo(await io.readMountInfo())
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** True when the operation ran and succeeded. */
  const execute = async (op: ViewOp): Promise<boolean> => {
    if (op.kind === 'mkdir') {
      try {
        await io.mkdir(op.path)
        return true
      } catch {
        return false
      }
    }
    const remaining = deadline - now()
    if (remaining <= 0) return false
    try {
      return (await io.run(op.argv, Math.min(opTimeoutMs, remaining))) === 'ok'
    } catch {
      return false
    }
  }

  /** The failed stage, or null for a built and verified view. */
  const build = async (): Promise<SandboxViewStage | null> => {
    // Canonical paths only: a symlink in a root could point the bind somewhere the policy did not name.
    for (const target of [policy.newRoot, ...policy.writable, ...policy.readOnly]) {
      const canonical = await io.realpath(target).catch(() => null)
      if (canonical !== target) return 'policy'
    }
    if (!(await io.isEmptyDirectory(policy.newRoot).catch(() => false))) return 'policy'

    const host = await readTable()
    if (host === null || !validateViewPolicy(policy, host).success) return 'policy'

    if (!(await execute(planViewBind(policy)))) return 'bind'

    const bound = await readTable()
    if (bound === null) return 'seal'
    const plan = planViewSeal(policy, bound)
    if (!plan.success) return 'seal'
    for (const op of plan.data) {
      if (!(await execute(op))) return op.stage
    }

    // The put-old directory is what the enter step moves the old root onto; it must be an empty directory.
    if (!(await io.isEmptyDirectory(`${policy.newRoot}${policy.putOld}`).catch(() => false))) return 'enter'

    const built = await readTable()
    if (built === null || !verifyView(policy, built).success) return 'verify'
    return null
  }

  return finish(await build().catch(() => 'seal' as const))
}
