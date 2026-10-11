import {createHash} from 'node:crypto'
import process from 'node:process'

/**
 * Names the job (and, for a matrix leg, the leg) that is running this Action invocation.
 *
 * `GITHUB_RUN_ID` + `GITHUB_RUN_ATTEMPT` identify the *workflow run*, not the job: two jobs in
 * one run (e.g. `needs:`-chained "Remediate" then "Observe") share both. Anything keyed only on
 * run + attempt (the cache save key, the log artifact name, a run-scoped session key) therefore
 * collides across those jobs. The identity returned here is the missing job-level component.
 *
 * Shape: `{sanitized GITHUB_JOB}` for a plain job, `{sanitized GITHUB_JOB}-m{8 hex}` for a matrix
 * leg, where the hex is a short stable hash of the leg's matrix context. Deterministic across
 * re-run attempts of the same job (a re-run keeps the same job id and matrix), so it never
 * changes what a re-run resolves to -- run ID / run attempt keep carrying that. There is
 * deliberately no random nonce.
 *
 * Returns `null` outside a runner (no `GITHUB_JOB`), in which case callers omit the segment.
 */
export function buildInvocationIdentity(input: {
  readonly job: string | undefined
  readonly matrixContext: string | undefined
}): string | null {
  const job = input.job?.trim() ?? ''
  if (job.length === 0) {
    return null
  }

  const jobSegment = sanitizeIdentitySegment(job)
  const matrixHash = hashMatrixContext(input.matrixContext)
  return matrixHash == null ? jobSegment : `${jobSegment}-m${matrixHash}`
}

/**
 * Reads the identity from the runner environment: `GITHUB_JOB` plus the `matrix-context` action
 * input (`INPUT_MATRIX-CONTEXT`, which `action.yaml` defaults to `${{ toJSON(matrix) }}`). Read
 * from the environment directly -- the same variable `core.getInput('matrix-context')` reads --
 * so it is available identically in the main step and the post-action hook with no state
 * hand-off, and both always derive the same identity.
 */
export function getInvocationIdentity(): string | null {
  return buildInvocationIdentity({
    job: process.env.GITHUB_JOB,
    matrixContext: process.env['INPUT_MATRIX-CONTEXT'],
  })
}

/**
 * Restricts a value to characters that are valid in both Actions cache keys (no commas) and
 * artifact names (none of `" : < > | * ? \ /`). Job ids are already `[A-Za-z0-9_-]` per the
 * workflow syntax, so this is defense in depth rather than a lossy transform in practice.
 */
function sanitizeIdentitySegment(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '-')
}

function hashMatrixContext(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  if (trimmed.length === 0) {
    return null
  }

  let canonical: string
  try {
    const parsed: unknown = JSON.parse(trimmed)
    // `toJSON(matrix)` yields `null` (or an empty object) for a job without a matrix.
    if (parsed == null || (typeof parsed === 'object' && Object.keys(parsed).length === 0)) {
      return null
    }
    canonical = JSON.stringify(sortKeys(parsed))
  } catch {
    // Not JSON (e.g. an operator passed an explicit string): hash it as-is.
    canonical = trimmed
  }

  return createHash('sha256').update(canonical).digest('hex').slice(0, 8)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    )
  }
  return value
}
