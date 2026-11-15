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
 * the first failure. It prints nothing on success. On failure it prints one JSON line to its error report with the failed
 * stage, the failed operation (the tool and its arguments: paths from the policy) and the tool's own error text, each
 * on one line and bounded, then exits non-zero. Nothing the agent could influence is in it: the agent does not exist yet.
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
  /** Runs one tool by absolute path, with a deadline that kills it. `ok` is exit 0. `stderr` is what the tool printed. */
  readonly run: (
    argv: readonly string[],
    timeoutMs: number,
  ) => Promise<{readonly status: 'failed' | 'ok' | 'timeout'; readonly stderr: string}>
  readonly mkdir: (directory: string) => Promise<void>
  readonly realpath: (target: string) => Promise<string>
  readonly isEmptyDirectory: (target: string) => Promise<boolean>
  /** Where the one failure line goes: the error stream, which the chain's root steps append to the gate's error file. */
  readonly report: {readonly write: (chunk: string) => unknown}
  readonly now?: () => number
  readonly opTimeoutMs?: number
  readonly totalTimeoutMs?: number
}

/** Longest operation and detail text in the failure line. */
const OP_CHARS = 160
const DETAIL_CHARS = 240

/** One printable line of at most `max` characters, keeping the end of the text, where tools put their error. */
function oneLine(text: string, max: number): string {
  const line = text
    .replaceAll(/[^\x20-\x7E]+/g, ' ')
    .replaceAll(/ {2,}/g, ' ')
    .trim()
  return line.length > max ? `...${line.slice(-max)}` : line
}

function describeOp(op: ViewOp): string {
  const [tool, ...args] = op.kind === 'mkdir' ? ['mkdir', op.path] : op.argv
  return oneLine([tool?.split('/').pop() ?? '', ...args].join(' '), OP_CHARS)
}

interface BuildFailure {
  readonly stage: SandboxViewStage
  readonly op?: string
  readonly detail?: string
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

  const finish = (failure: BuildFailure | null): number => {
    if (failure === null) return 0
    const line = {
      view: 'failed',
      stage: failure.stage,
      ...(failure.op === undefined ? {} : {op: failure.op}),
      ...(failure.detail === undefined || failure.detail.length === 0
        ? {}
        : {detail: oneLine(failure.detail, DETAIL_CHARS)}),
    }
    io.report.write(`${JSON.stringify(line)}\n`)
    return failure.stage === 'policy' ? SANDBOX_VIEW_EXIT_INVALID_POLICY : SANDBOX_VIEW_EXIT_FAILED
  }

  const policy = parsePolicyText(io.policyText)
  if (policy === null) return finish({stage: 'policy', detail: 'the policy argument is missing or not a valid policy'})

  const readTable = async (): Promise<readonly MountEntry[] | null> => {
    try {
      const parsed = parseMountInfo(await io.readMountInfo())
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** Null when the operation ran and succeeded; else what failed. */
  const execute = async (op: ViewOp): Promise<BuildFailure | null> => {
    const named = {stage: op.stage, op: describeOp(op)}
    if (op.kind === 'mkdir') {
      try {
        await io.mkdir(op.path)
        return null
      } catch (error) {
        return {...named, detail: error instanceof Error ? error.message : 'mkdir failed'}
      }
    }
    const remaining = deadline - now()
    if (remaining <= 0) return {...named, detail: 'the build ran out of time'}
    try {
      const result = await io.run(op.argv, Math.min(opTimeoutMs, remaining))
      if (result.status === 'ok') return null
      const why = result.status === 'timeout' ? 'timed out' : 'exited non-zero'
      return {...named, detail: `${why}: ${result.stderr}`}
    } catch (error) {
      return {...named, detail: error instanceof Error ? error.message : 'the tool could not run'}
    }
  }

  /** What failed, or null for a built and verified view. */
  const build = async (): Promise<BuildFailure | null> => {
    // Canonical paths only: a symlink in a root could point the bind somewhere the policy did not name.
    for (const target of [policy.newRoot, ...policy.writable, ...policy.readOnly]) {
      const canonical = await io.realpath(target).catch(() => null)
      if (canonical !== target) {
        return {stage: 'policy', detail: `${target} does not resolve to itself (${canonical ?? 'unreadable'})`}
      }
    }
    if (!(await io.isEmptyDirectory(policy.newRoot).catch(() => false))) {
      return {stage: 'policy', detail: `the new root ${policy.newRoot} is not an empty directory`}
    }

    const host = await readTable()
    if (host === null) return {stage: 'policy', detail: 'the mount table could not be read'}
    const checked = validateViewPolicy(policy, host)
    if (!checked.success) return {stage: 'policy', detail: checked.error}

    const bind = planViewBind(policy)
    const bindFailure = await execute(bind)
    if (bindFailure !== null) return bindFailure

    const bound = await readTable()
    if (bound === null) return {stage: 'seal', detail: 'the mount table could not be read after the bind'}
    const plan = planViewSeal(policy, bound)
    if (!plan.success) return {stage: 'seal', detail: plan.error}
    for (const op of plan.data) {
      const failure = await execute(op)
      if (failure !== null) return failure
    }

    // The put-old directory is what the enter step moves the old root onto; it must be an empty directory.
    if (!(await io.isEmptyDirectory(`${policy.newRoot}${policy.putOld}`).catch(() => false))) {
      return {
        stage: 'enter',
        detail: `the put-old directory ${policy.newRoot}${policy.putOld} is not an empty directory`,
      }
    }

    const built = await readTable()
    if (built === null) return {stage: 'verify', detail: 'the mount table could not be read after the build'}
    const verified = verifyView(policy, built)
    if (!verified.success) return {stage: 'verify', detail: verified.error}
    return null
  }

  return finish(await build().catch((): BuildFailure => ({stage: 'seal', detail: 'the build threw'})))
}
