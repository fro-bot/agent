// Daily maintenance sweep: has each downstream repository from issue
// fro-bot/agent#1598 been OBSERVED RUNNING a release containing the
// credential-preflight fix (commit 9d971b4cc5d1e47cbbb4ea5cb60e2d703ceabf97,
// v0.111.0)? Runtime evidence, distinct from the static workflow-pin
// inspection the issue already completed. Makes no decision about the
// issue; a separate step consumes this JSON to do that.
//
// Note: `pull_request` runs execute the workflow from the merge ref, so the
// pin read at head_sha is the head ref's version rather than exactly what
// executed; `issues`/`issue_comment` always run from the default branch, so
// the correspondence there is exact.
//
// Run via: node --experimental-strip-types scripts/dmr-runtime-verification.ts <output-path>
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. The test file uses .js imports for Vitest.

import {Buffer} from 'node:buffer'
import {writeFile} from 'node:fs/promises'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {parse} from 'yaml'

export const PREFLIGHT_COMMIT = '9d971b4cc5d1e47cbbb4ea5cb60e2d703ceabf97'

const QUALIFYING_EVENTS = new Set(['pull_request', 'issue_comment', 'issues'])
const FRO_BOT_AGENT_REF_RE = /^fro-bot\/agent@(.+)$/
const SHA_RE = /^[0-9a-f]{40}$/
// The repository component may begin with a dot -- `bfra-me/.github`, `fro-bot/.github`,
// and `marcusrbrown/.dotfiles` are all in the roster, and dropping them silently
// undercounts the sweep.
const REPO_SLUG_RE = /\b(\w(?:[\w.-]*\w)?\/\.?\w(?:[\w.-]*\w)?)\b/
const TARGET_HEADINGS = new Set(['checkout posture verified', 'migration merged'])
const MAX_RESPONSE_BYTES = 2_000_000
// GitHub secondary rate limits trigger on concurrency, not just request volume;
// bounding the sweep keeps a 403 from making the whole run flaky.
const SWEEP_CONCURRENCY = 5

export interface WorkflowRunSummary {
  readonly id: number
  readonly htmlUrl: string
  readonly event: string
  readonly conclusion: string | null
  readonly updatedAt: string
  readonly headSha: string
}

export interface GithubClient {
  readonly listWorkflowRuns: (repository: string) => Promise<readonly WorkflowRunSummary[]>
  readonly getWorkflowFileAtSha: (repository: string, sha: string) => Promise<string>
  readonly compareCommits: (base: string, head: string) => Promise<number>
  readonly getIssueBody: (owner: string, repo: string, issueNumber: number) => Promise<string>
  readonly resolveRef: (ref: string) => Promise<string>
}

export type SweepStatus = 'verified' | 'not-verified' | 'no-qualifying-run' | 'unavailable'

export interface RepositoryResult {
  readonly repository: string
  readonly status: SweepStatus
  readonly runId: number | null
  readonly runUrl: string | null
  readonly event: string | null
  readonly observedAt: string | null
  readonly pin: string | null
  readonly behindBy: number | null
  readonly detail: string | null
}

export interface SweepResult {
  readonly generatedAt: string
  readonly preflightCommit: string
  readonly repositoryCount: number
  readonly repositories: readonly RepositoryResult[]
}

/**
 * Extracts every `owner/repo` checklist entry from issue #1598's body that
 * falls under the "Checkout posture verified" or "Migration merged"
 * headings. Skips "Accepted risk while archived" and the "Private
 * repositories" aggregate line — neither is bare `owner/repo` text, so they
 * fall out naturally once a line is required to match the repo-slug shape.
 */
export function parseRepositoriesFromIssueBody(body: string): readonly string[] {
  const repositories = new Set<string>()
  let inTargetSection = false

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    const headingMatch = line.match(/^#{1,6}\s(.*)$/)
    if (headingMatch?.[1] !== undefined) {
      inTargetSection = TARGET_HEADINGS.has(headingMatch[1].trim().toLowerCase())
      continue
    }
    if (!inTargetSection || !line.startsWith('- [')) {
      continue
    }
    const afterCheckbox = line.replace(/^- \[.\]\s*/, '')
    const slugMatch = afterCheckbox.match(REPO_SLUG_RE)
    if (slugMatch?.[1] !== undefined) {
      repositories.add(slugMatch[1])
    }
  }

  return [...repositories]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pushUsesValue(step: unknown, values: string[]): void {
  if (isRecord(step) && typeof step.uses === 'string') {
    values.push(step.uses)
  }
}

/**
 * Collects every `uses:` value that GitHub Actions would actually execute:
 * job steps, reusable-workflow job invocations, and composite-action manifest
 * steps. Anything outside a `uses:` position -- comments, prose, other keys --
 * is structurally unreachable because it was never part of the parsed
 * document in the first place.
 */
function collectUsesValues(document: unknown): readonly string[] {
  const values: string[] = []
  if (!isRecord(document)) {
    return values
  }

  if (isRecord(document.jobs)) {
    for (const job of Object.values(document.jobs)) {
      if (!isRecord(job)) {
        continue
      }
      if (typeof job.uses === 'string') {
        values.push(job.uses)
      }
      if (Array.isArray(job.steps)) {
        for (const step of job.steps) {
          pushUsesValue(step, values)
        }
      }
    }
  }

  if (isRecord(document.runs) && Array.isArray(document.runs.steps)) {
    for (const step of document.runs.steps) {
      pushUsesValue(step, values)
    }
  }

  return values
}

/**
 * Parses a workflow file and returns every `fro-bot/agent@<ref>` reference in
 * an executable `uses:` position. Returns `null` when the file does not parse
 * as YAML at all -- that is `unavailable`, never a verification signal.
 */
export function extractFroBotAgentRefs(workflowFile: string): readonly string[] | null {
  let document: unknown
  try {
    document = parse(workflowFile)
  } catch {
    return null
  }

  const refs: string[] = []
  for (const usesValue of collectUsesValues(document)) {
    const match = FRO_BOT_AGENT_REF_RE.exec(usesValue)
    if (match?.[1] !== undefined) {
      refs.push(match[1])
    }
  }
  return refs
}

/** Runs `fn` over `items` with at most `concurrency` calls in flight at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({length: items.length})
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) {
        return
      }
      const item = items[index] as T
      results[index] = await fn(item)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({length: workerCount}, async () => worker()))
  return results
}

function buildResult(
  repository: string,
  status: SweepStatus,
  detail: string | null,
  partial: Partial<RepositoryResult> = {},
): RepositoryResult {
  return {
    repository,
    status,
    runId: null,
    runUrl: null,
    event: null,
    observedAt: null,
    pin: null,
    behindBy: null,
    detail,
    ...partial,
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const httpStatus = (error as {httpStatus?: unknown}).httpStatus
    if (typeof httpStatus === 'number') {
      return `http-${httpStatus}`
    }
    return error.message.slice(0, 60)
  }
  return 'unknown-error'
}

/** Evaluates one downstream repository against the validated algorithm. */
export async function sweepRepository(client: GithubClient, repository: string): Promise<RepositoryResult> {
  let runs: readonly WorkflowRunSummary[]
  try {
    runs = await client.listWorkflowRuns(repository)
  } catch (error) {
    return buildResult(repository, 'unavailable', describeError(error))
  }

  const qualifying = runs.filter(run => QUALIFYING_EVENTS.has(run.event) && run.conclusion === 'success')
  if (qualifying.length === 0) {
    return buildResult(repository, 'no-qualifying-run', 'no-qualifying-run')
  }

  const latest = qualifying.reduce((newest, run) => (run.updatedAt > newest.updatedAt ? run : newest))
  const observed: Partial<RepositoryResult> = {
    runId: latest.id,
    runUrl: latest.htmlUrl,
    event: latest.event,
    observedAt: latest.updatedAt,
  }

  let workflowFile: string
  try {
    workflowFile = await client.getWorkflowFileAtSha(repository, latest.headSha)
  } catch (error) {
    return buildResult(repository, 'unavailable', describeError(error), observed)
  }

  const refs = extractFroBotAgentRefs(workflowFile)
  if (refs === null) {
    return buildResult(repository, 'unavailable', 'workflow-unparseable', observed)
  }
  if (refs.length === 0) {
    return buildResult(repository, 'not-verified', 'no-executable-references', observed)
  }

  let worstBehindBy = 0
  let worstPin: string | null = null

  for (const ref of refs) {
    let sha: string
    if (SHA_RE.test(ref)) {
      sha = ref
    } else {
      try {
        sha = await client.resolveRef(ref)
      } catch (error) {
        return buildResult(repository, 'unavailable', describeError(error), observed)
      }
    }

    let behindBy: number
    try {
      behindBy = await client.compareCommits(PREFLIGHT_COMMIT, sha)
    } catch (error) {
      return buildResult(repository, 'unavailable', describeError(error), {...observed, pin: sha})
    }

    if (worstPin === null || behindBy > worstBehindBy) {
      worstBehindBy = behindBy
      worstPin = sha
    }
  }

  return {
    repository,
    status: worstBehindBy === 0 ? 'verified' : 'not-verified',
    runId: latest.id,
    runUrl: latest.htmlUrl,
    event: latest.event,
    observedAt: latest.updatedAt,
    pin: worstPin,
    behindBy: worstBehindBy,
    detail: worstBehindBy === 0 ? null : 'behind-preflight',
  }
}

/** Runs the full sweep: reads the repository list from #1598, then evaluates each. */
export async function runSweep(client: GithubClient, now: () => Date = () => new Date()): Promise<SweepResult> {
  const issueBody = await client.getIssueBody('fro-bot', 'agent', 1598)
  const repositories = parseRepositoriesFromIssueBody(issueBody)
  if (repositories.length === 0) {
    throw new Error('parsed roster is empty -- issue #1598 headings may have been renamed')
  }
  const repositoryResults = await mapWithConcurrency(repositories, SWEEP_CONCURRENCY, async repository =>
    sweepRepository(client, repository),
  )

  return {
    generatedAt: now().toISOString(),
    preflightCommit: PREFLIGHT_COMMIT,
    repositoryCount: repositories.length,
    repositories: repositoryResults,
  }
}

/** Reads a fetch Response body, refusing to buffer a response beyond a fixed byte cap. */
async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('response-too-large')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('response-too-large')
  }
  return text
}

/** Live GithubClient backed by the GitHub REST API, authenticated with a bearer token. */
export function createGithubClient(token: string): GithubClient {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  async function fetchOk(url: string): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, {headers, signal: AbortSignal.timeout(15_000)})
    } catch {
      throw new Error('network-error')
    }
    if (!response.ok) {
      throw Object.assign(new Error(`http-${response.status}`), {httpStatus: response.status})
    }
    return response
  }

  async function getJson(url: string): Promise<unknown> {
    const text = await readBoundedText(await fetchOk(url))
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('malformed-json')
    }
  }

  return {
    async listWorkflowRuns(repository) {
      const body = await getJson(
        `https://api.github.com/repos/${repository}/actions/workflows/fro-bot.yaml/runs?per_page=100`,
      )
      const runs = (body as {workflow_runs?: unknown} | null)?.workflow_runs
      if (!Array.isArray(runs)) {
        throw new TypeError('malformed-runs-response')
      }
      return runs.map(raw => {
        const run = raw as Record<string, unknown>
        return {
          id: typeof run.id === 'number' ? run.id : 0,
          htmlUrl: typeof run.html_url === 'string' ? run.html_url : '',
          event: typeof run.event === 'string' ? run.event : '',
          conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
          updatedAt: typeof run.updated_at === 'string' ? run.updated_at : '',
          headSha: typeof run.head_sha === 'string' ? run.head_sha : '',
        }
      })
    },
    async getWorkflowFileAtSha(repository, sha) {
      return readBoundedText(
        await fetchOk(`https://raw.githubusercontent.com/${repository}/${sha}/.github/workflows/fro-bot.yaml`),
      )
    },
    async compareCommits(base, head) {
      const body = await getJson(`https://api.github.com/repos/fro-bot/agent/compare/${base}...${head}`)
      const behindBy = (body as {behind_by?: unknown} | null)?.behind_by
      if (typeof behindBy !== 'number') {
        throw new TypeError('malformed-compare-response')
      }
      return behindBy
    },
    async getIssueBody(owner, repo, issueNumber) {
      const body = await getJson(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`)
      const issueBody = (body as {body?: unknown} | null)?.body
      if (typeof issueBody !== 'string') {
        throw new TypeError('malformed-issue-response')
      }
      return issueBody
    },
    async resolveRef(ref) {
      const body = await getJson(`https://api.github.com/repos/fro-bot/agent/commits/${ref}`)
      const sha = (body as {sha?: unknown} | null)?.sha
      if (typeof sha !== 'string') {
        throw new TypeError('malformed-commit-response')
      }
      return sha
    },
  }
}

async function main(): Promise<void> {
  const outputPath = process.argv[2]
  if (outputPath === undefined || outputPath === '') {
    throw new Error('usage: dmr-runtime-verification.ts <output-path>')
  }
  const token = process.env.GH_TOKEN
  if (token === undefined || token === '') {
    throw new Error('GH_TOKEN is required')
  }

  const result = await runSweep(createGithubClient(token))
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

// Only run when executed directly (node --experimental-strip-types ...), not
// when imported by the test file under Vitest.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
