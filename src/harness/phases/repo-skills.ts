import type {Result} from '@bfra.me/es/result'
import type {GitHubContext, Octokit} from '../../services/github/types.js'
import type {RepoSkillsSource, StageDefaultBranchSkillsOptions, StagedSkills} from '../../services/setup/repo-skills.js'
import type {ExecAdapter} from '../../services/setup/types.js'
import type {Logger} from '../../shared/logger.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {RoutingPhaseResult} from './routing.js'
import * as fs from 'node:fs/promises'
import process from 'node:process'
import {evaluateRepoSkillsTrust, needsPullRequestHeadLookup} from '../../features/agent/repo-skills-trust.js'
import {resolveSessionGeneration} from '../../services/cache/cache-key.js'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {
  createRepoSkillsStagingRoot,
  removeRepoSkillsStagingRoot,
  stageDefaultBranchSkills,
} from '../../services/setup/repo-skills.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLogger} from '../../shared/logger.js'

/**
 * The `repo-skills` input (fro-bot/agent#2129), decided after routing, so a skipped event costs nothing: trust, then a
 * run-scoped staging root, then a fresh fetch of the default branch's skills. The server start
 * (`startActionOpenCodeV2`) admits and copies from the source this returns, because collision checks need the installed
 * bundled skills. The checkout is never a source, for any event.
 *
 * Fail-closed and fail-soft together: every denial, lookup failure, timeout or read failure returns null and the run
 * proceeds exactly as a run without the input.
 */

export interface RepoSkillsDeps {
  readonly exec: ExecAdapter
  readonly env: Readonly<Record<string, string | undefined>>
  /** `head.repo.full_name` of a pull request, or null when it could not be fetched or no longer exists. */
  readonly lookupPullRequestHeadRepo: (pullNumber: number) => Promise<string | null>
  /** The repository's default branch, or null on failure. Deliberately has no `main` fallback. */
  readonly lookupDefaultBranch: () => Promise<string | null>
  readonly stageDefaultBranchSkills: (
    options: StageDefaultBranchSkillsOptions,
  ) => Promise<Result<StagedSkills | null, string>>
}

export interface ResolveRepoSkillsSourceOptions {
  /** The `repo-skills` input. */
  readonly enabled: boolean
  readonly generation: 'v1' | 'v2'
  readonly githubContext: GitHubContext
  /** Used only to let a checkout without the default branch fetch it. Never logged. */
  readonly githubToken: string
  readonly logger: Logger
  readonly deps: RepoSkillsDeps
}

export async function resolveRepoSkillsSource(
  options: ResolveRepoSkillsSourceOptions,
): Promise<RepoSkillsSource | null> {
  const {enabled, generation, githubContext, githubToken, logger, deps} = options
  if (!enabled) return null
  if (generation !== 'v2') {
    logger.warning('repo-skills is not supported on the OpenCode V1 generation and is ignored')
    return null
  }

  let stagingRoot: string | null = null
  try {
    const {event} = githubContext
    const repository = `${githubContext.repo.owner}/${githubContext.repo.repo}`
    const lookedUp =
      needsPullRequestHeadLookup(event) && event.type === 'issue_comment'
        ? await deps.lookupPullRequestHeadRepo(event.issue.number)
        : null

    const trust = evaluateRepoSkillsTrust({event, repository, lookedUpHeadRepoFullName: lookedUp})
    if (!trust.trusted) {
      logger.info('Repository skills are not loaded for this run', {reason: trust.reason})
      return null
    }

    const created = createRepoSkillsStagingRoot(deps.env.RUNNER_TEMP)
    if (!created.success) {
      logger.warning(`Repository skills are not loaded: ${created.error}`)
      return null
    }
    stagingRoot = created.data

    // Every eligible event reads the default branch, fetched fresh from the base repository: never the checkout (which
    // may be a PR head, a dispatched branch, or hold anything an earlier step left) and never a ref already in it.
    const defaultBranch = await deps.lookupDefaultBranch()
    if (defaultBranch === null) {
      logger.warning('Repository skills are not loaded: the default branch could not be determined')
      await removeStagingRoot(stagingRoot)
      return null
    }
    const staged = await deps.stageDefaultBranchSkills({
      exec: deps.exec,
      repository,
      defaultBranch,
      stagingRoot,
      logger,
      env: deps.env,
      githubToken,
    })
    if (!staged.success) {
      logger.warning(`Repository skills are not loaded: ${staged.error}`)
      await removeStagingRoot(stagingRoot)
      return null
    }
    const stagedSkills = staged.data

    if (stagedSkills === null) {
      logger.info('Repository skills are enabled but the default branch has no .agents/skills')
      await removeStagingRoot(stagingRoot)
      return null
    }
    return {sourceDir: stagedSkills.sourceDir, symlinkedSkillIds: stagedSkills.symlinkedSkillIds, stagingRoot}
  } catch (error) {
    logger.warning(`Repository skills are not loaded: ${toErrorMessage(error)}`)
    if (stagingRoot !== null) await removeStagingRoot(stagingRoot)
    return null
  }
}

async function removeStagingRoot(stagingRoot: string): Promise<void> {
  await fs.rm(stagingRoot, {recursive: true, force: true}).catch(() => undefined)
}

/** Bound on each GitHub lookup. Ten seconds: these are single small reads, and a hung one must not stall the run. */
export const REPO_SKILLS_LOOKUP_TIMEOUT_MS = 10_000

/**
 * Runs `run` with an abort signal and rejects after `timeoutMs`, aborting the request. The race, not only the signal, is
 * what bounds it: a request that ignores the signal (or never settles) still ends here.
 */
async function bounded<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([run(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The two GitHub facts the predicate and the source read need, from the routing phase's authenticated client. Each call
 * is bounded by `timeoutMs`; a failure or timeout is a warning and a null, which denies or skips repo skills.
 */
export function createRepoSkillsLookups(
  client: Octokit,
  repo: {readonly owner: string; readonly repo: string},
  logger: Logger,
  timeoutMs: number = REPO_SKILLS_LOOKUP_TIMEOUT_MS,
): Pick<RepoSkillsDeps, 'lookupDefaultBranch' | 'lookupPullRequestHeadRepo'> {
  return {
    lookupPullRequestHeadRepo: async pullNumber => {
      try {
        const {data} = await bounded(timeoutMs, async signal =>
          client.rest.pulls.get({owner: repo.owner, repo: repo.repo, pull_number: pullNumber, request: {signal}}),
        )
        return data.head.repo?.full_name ?? null
      } catch (error) {
        logger.warning('Could not fetch the pull request head repository', {error: toErrorMessage(error)})
        return null
      }
    },
    lookupDefaultBranch: async () => {
      try {
        const {data} = await bounded(timeoutMs, async signal =>
          client.rest.repos.get({owner: repo.owner, repo: repo.repo, request: {signal}}),
        )
        return data.default_branch.length > 0 ? data.default_branch : null
      } catch (error) {
        logger.warning('Could not fetch the default branch', {error: toErrorMessage(error)})
        return null
      }
    },
  }
}

/** The harness phase: wires the real GitHub client, exec adapter and environment into `resolveRepoSkillsSource`. */
export async function runRepoSkills(
  bootstrap: BootstrapPhaseResult,
  routing: RoutingPhaseResult,
): Promise<RepoSkillsSource | null> {
  if (!bootstrap.inputs.repoSkills) return null
  const logger = createLogger({phase: 'repo-skills'})
  // `TriggerContext.raw` is the `GitHubContext` the router was given (see `triggers/issue-comment.ts`).
  const githubContext = routing.triggerResult.context.raw as GitHubContext
  return resolveRepoSkillsSource({
    enabled: bootstrap.inputs.repoSkills,
    generation: resolveSessionGeneration(bootstrap.opencodeResult.version),
    githubContext,
    githubToken: bootstrap.inputs.githubToken,
    logger,
    deps: {
      exec: createExecAdapter(),
      env: process.env,
      ...createRepoSkillsLookups(routing.githubClient, githubContext.repo, logger),
      stageDefaultBranchSkills,
    },
  })
}

/**
 * Removes the run's staging root. Called from the run's `finally`, after cleanup has stopped the V2 server, on success,
 * on failure and on a failed start. Never throws; a failure is a warning.
 */
export async function removeRepoSkillsStaging(stagingRoot: string | null): Promise<void> {
  await removeRepoSkillsStagingRoot(stagingRoot, createLogger({phase: 'repo-skills'}))
}
