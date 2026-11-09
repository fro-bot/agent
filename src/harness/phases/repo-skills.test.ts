import type {GitHubContext, NormalizedEvent, Octokit} from '../../services/github/types.js'
import type {ExecAdapter} from '../../services/setup/types.js'
import type {RepoSkillsDeps} from './repo-skills.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'
import {createRepoSkillsLookups, resolveRepoSkillsSource} from './repo-skills.js'

const REPO = {owner: 'fro-bot', repo: 'agent'}

function context(event: NormalizedEvent): GitHubContext {
  return {
    eventName: event.type,
    eventType: event.type,
    repo: REPO,
    ref: 'refs/heads/main',
    sha: 'sha',
    runId: 1,
    actor: 'actor',
    payload: {},
    event,
  }
}

const schedule: NormalizedEvent = {type: 'schedule'}
const dispatch: NormalizedEvent = {type: 'workflow_dispatch', inputs: {}}

function issues(association: string): NormalizedEvent {
  return {
    type: 'issues',
    action: 'opened',
    issue: {number: 3, title: 't', body: null, locked: false, authorAssociation: association},
    sender: {login: 's'},
  }
}

function issueComment(isPullRequest: boolean, association = 'OWNER'): NormalizedEvent {
  return {
    type: 'issue_comment',
    action: 'created',
    issue: {number: 12, title: 't', body: null, locked: false, isPullRequest},
    comment: {id: 1, body: 'b', author: 'a', authorAssociation: association},
  }
}

function pullRequest(headRepoFullName: string | null, association = 'MEMBER'): NormalizedEvent {
  return {
    type: 'pull_request',
    action: 'opened',
    requestedReviewer: null,
    requestedTeam: null,
    pullRequest: {
      number: 4,
      title: 't',
      body: null,
      locked: false,
      draft: false,
      headSha: 'h',
      headRepoFullName,
      authorAssociation: association,
      requestedReviewers: [],
      labels: [],
    },
    sender: {login: 's'},
  }
}

describe('resolveRepoSkillsSource', () => {
  let root: string
  let workspace: string
  let runnerTemp: string
  let deps: RepoSkillsDeps
  let lookupPullRequestHeadRepo: ReturnType<typeof vi.fn<RepoSkillsDeps['lookupPullRequestHeadRepo']>>
  let lookupDefaultBranch: ReturnType<typeof vi.fn<RepoSkillsDeps['lookupDefaultBranch']>>
  let stageDefaultBranchSkills: ReturnType<typeof vi.fn<RepoSkillsDeps['stageDefaultBranchSkills']>>

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-skills-phase-')))
    workspace = path.join(root, 'workspace')
    runnerTemp = path.join(root, 'runner-temp')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(path.join(workspace, '.agents', 'skills', 'probe'), {recursive: true})
    fs.writeFileSync(path.join(workspace, '.agents', 'skills', 'probe', 'SKILL.md'), 'PR-HEAD-WORKSPACE-CANARY')
    lookupPullRequestHeadRepo = vi.fn<RepoSkillsDeps['lookupPullRequestHeadRepo']>(async () => 'fro-bot/agent')
    lookupDefaultBranch = vi.fn<RepoSkillsDeps['lookupDefaultBranch']>(async () => 'trunk')
    stageDefaultBranchSkills = vi.fn<RepoSkillsDeps['stageDefaultBranchSkills']>(async options =>
      ok({
        sourceDir: path.join(options.stagingRoot, 'source-tree', '.agents', 'skills'),
        symlinkedSkillIds: ['linked-skill'],
      }),
    )
    deps = {
      exec: {} as ExecAdapter,
      env: {RUNNER_TEMP: runnerTemp},
      lookupPullRequestHeadRepo,
      lookupDefaultBranch,
      stageDefaultBranchSkills,
    }
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  function resolve(event: NormalizedEvent, overrides: {enabled?: boolean; generation?: 'v1' | 'v2'} = {}) {
    const logger = createMockLogger()
    const promise = resolveRepoSkillsSource({
      enabled: overrides.enabled ?? true,
      generation: overrides.generation ?? 'v2',
      githubContext: context(event),
      githubToken: 'ghs_token',
      logger,
      deps,
    })
    return {promise, logger}
  }

  function leftovers(): string[] {
    return fs.readdirSync(runnerTemp)
  }

  it('does nothing when the input is off', async () => {
    // #given repo-skills is not enabled
    // #when resolving for a scheduled run
    const {promise, logger} = resolve(schedule, {enabled: false})

    // #then there is no source, no staging and no log
    expect(await promise).toBeNull()
    expect(leftovers()).toEqual([])
    expect(serializeLoggerCalls(logger)).toBe('[]')
  })

  it('ignores the input on the V1 generation, with a warning', async () => {
    // #given V1 (deprecated, untouched)
    // #when resolving
    const {promise, logger} = resolve(schedule, {generation: 'v1'})

    // #then nothing is staged
    expect(await promise).toBeNull()
    expect(leftovers()).toEqual([])
    expect(serializeLoggerCalls(logger)).toContain('V1')
  })

  it.each([
    ['a scheduled run', schedule],
    ['a workflow_dispatch', dispatch],
    ['a maintainer issue', issues('OWNER')],
    ['a maintainer comment on a plain issue', issueComment(false)],
    ['a maintainer comment on a same-repository PR', issueComment(true)],
    ['a same-repository pull_request', pullRequest('fro-bot/agent')],
  ])('stages the fetched default branch, never the checkout, for %s', async (_label, event) => {
    // #given an eligible event, a checkout (on another branch, per the context ref) holding extra unmerged skills
    const githubContext = {...context(event), ref: 'refs/heads/some-feature-branch'}
    fs.mkdirSync(path.join(workspace, '.agents', 'skills', 'unmerged-extra'), {recursive: true})

    // #when resolving
    const source = await resolveRepoSkillsSource({
      enabled: true,
      generation: 'v2',
      githubContext,
      githubToken: 'ghs_token',
      logger: createMockLogger(),
      deps,
    })

    // #then the source is the default branch stage's output under the staging root, not the workspace
    expect(stageDefaultBranchSkills).toHaveBeenCalledWith(
      expect.objectContaining({repository: 'fro-bot/agent', defaultBranch: 'trunk', githubToken: 'ghs_token'}),
    )
    expect(stageDefaultBranchSkills.mock.calls[0]?.[0]).not.toHaveProperty('workspacePath')
    expect(source?.sourceDir).toBe(path.join(source?.stagingRoot ?? '', 'source-tree', '.agents', 'skills'))
    expect(path.dirname(source?.stagingRoot ?? '')).toBe(runnerTemp)
    expect(source?.sourceDir.startsWith(workspace)).toBe(false)
    // #and the ids of skills that held a symlink travel with the source, for admission
    expect(source?.symlinkedSkillIds).toEqual(['linked-skill'])
  })

  it('denies a stranger issue before looking anything up or staging anything', async () => {
    // #given an issue from a stranger
    // #when resolving
    const {promise, logger} = resolve(issues('NONE'))

    // #then nothing was fetched or created, and the reason is logged
    expect(await promise).toBeNull()
    expect(lookupDefaultBranch).not.toHaveBeenCalled()
    expect(stageDefaultBranchSkills).not.toHaveBeenCalled()
    expect(leftovers()).toEqual([])
    expect(serializeLoggerCalls(logger)).toContain('author-not-trusted')
  })

  it('never reads the PR head: a same-repository PR comment stages the default branch', async () => {
    // #given a maintainer comment on a PR whose head repo is the base repo
    // #when resolving
    const {promise} = resolve(issueComment(true))

    // #then the default branch was looked up and staged, and the checkout (PR head) was not the source
    const source = await promise
    expect(lookupPullRequestHeadRepo).toHaveBeenCalledWith(12)
    expect(stageDefaultBranchSkills).toHaveBeenCalledWith(
      expect.objectContaining({defaultBranch: 'trunk', githubToken: 'ghs_token'}),
    )
    expect(source?.sourceDir).toBe(path.join(source?.stagingRoot ?? '', 'source-tree', '.agents', 'skills'))
    expect(source?.sourceDir.startsWith(workspace)).toBe(false)
  })

  it('stages the default branch for a same-repository pull_request event without a PR lookup', async () => {
    // #given a same-repo pull_request from a member
    // #when resolving
    const {promise} = resolve(pullRequest('fro-bot/agent'))

    // #then the normalized head repo was enough, and the default branch is the source
    expect(await promise).not.toBeNull()
    expect(lookupPullRequestHeadRepo).not.toHaveBeenCalled()
    expect(stageDefaultBranchSkills).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a maintainer comment on a fork PR', issueComment(true), 'contributor/agent'],
    ['a PR comment whose head repo lookup found nothing', issueComment(true), null],
  ])('denies %s', async (_label, event, headRepo) => {
    // #given the PR fetch answers with a fork or nothing
    lookupPullRequestHeadRepo.mockResolvedValue(headRepo)

    // #when resolving
    const {promise} = resolve(event)

    // #then no source, no stage, nothing left behind
    expect(await promise).toBeNull()
    expect(stageDefaultBranchSkills).not.toHaveBeenCalled()
    expect(leftovers()).toEqual([])
  })

  it('denies a PR comment when the lookup throws', async () => {
    // #given the API call rejects
    lookupPullRequestHeadRepo.mockRejectedValue(new Error('boom'))

    // #when resolving
    const {promise} = resolve(issueComment(true))

    // #then it fails closed
    expect(await promise).toBeNull()
    expect(leftovers()).toEqual([])
  })

  it('denies a fork pull_request even from a member, and a null head repo', async () => {
    // #given a fork PR and a deleted-fork PR
    // #when resolving each
    const fork = await resolve(pullRequest('contributor/agent')).promise
    const deleted = await resolve(pullRequest(null)).promise

    // #then both are denied without staging
    expect(fork).toBeNull()
    expect(deleted).toBeNull()
    expect(stageDefaultBranchSkills).not.toHaveBeenCalled()
    expect(leftovers()).toEqual([])
  })

  it('denies review comments even from an owner', async () => {
    // #given a deferred surface
    const event: NormalizedEvent = {
      type: 'pull_request_review_comment',
      action: 'created',
      pullRequest: {number: 1, title: 't', locked: false},
      comment: {
        id: 1,
        body: 'b',
        author: 'o',
        authorAssociation: 'OWNER',
        path: 'a',
        line: 1,
        diffHunk: '',
        commitId: 'c',
      },
    }

    // #when resolving
    const {promise, logger} = resolve(event)

    // #then it is denied
    expect(await promise).toBeNull()
    expect(serializeLoggerCalls(logger)).toContain('event-not-eligible')
  })

  it('skips repo skills, and does not fall back to the checkout, when the default branch name is unknown', async () => {
    // #given the repo lookup fails
    lookupDefaultBranch.mockResolvedValue(null)

    // #when resolving a same-repo PR comment
    const {promise, logger} = resolve(issueComment(true))

    // #then no source: the PR-head workspace is never substituted
    expect(await promise).toBeNull()
    expect(stageDefaultBranchSkills).not.toHaveBeenCalled()
    expect(leftovers()).toEqual([])
    expect(serializeLoggerCalls(logger)).toContain('default branch')
  })

  it('skips repo skills with a warning when the default branch tree cannot be read', async () => {
    // #given the archive step fails
    stageDefaultBranchSkills.mockResolvedValue(
      err('Could not archive the default branch skills; repo skills are not loaded'),
    )

    // #when resolving a same-repo PR comment
    const {promise, logger} = resolve(issueComment(true))

    // #then no source, nothing left, a warning explains
    expect(await promise).toBeNull()
    expect(leftovers()).toEqual([])
    expect(
      vi
        .mocked(logger.warning)
        .mock.calls.map(call => String(call[0]))
        .join('\n'),
    ).toContain('archive')
  })

  it('removes the staging root when the default branch has no skills', async () => {
    // #given a default branch without .agents/skills
    stageDefaultBranchSkills.mockResolvedValue(ok(null))

    // #when resolving
    const {promise} = resolve(issueComment(true))

    // #then no source and no leftover
    expect(await promise).toBeNull()
    expect(leftovers()).toEqual([])
  })

  it('skips with a warning when RUNNER_TEMP is unusable', async () => {
    // #given no RUNNER_TEMP
    deps = {...deps, env: {}}

    // #when resolving a trusted schedule run
    const {promise, logger} = resolve(schedule)

    // #then no source and the reason is logged
    expect(await promise).toBeNull()
    expect(serializeLoggerCalls(logger)).toContain('RUNNER_TEMP')
  })

  it('never throws: an unexpected failure skips repo skills', async () => {
    // #given a stage that throws
    stageDefaultBranchSkills.mockRejectedValue(new Error('unexpected'))

    // #when resolving
    const {promise} = resolve(issueComment(true))

    // #then it resolves to null
    expect(await promise).toBeNull()
  })
})

function clientWith(rest: {pulls: {get: unknown}; repos: {get: unknown}}): Octokit {
  return {rest} as unknown as Octokit
}

describe('createRepoSkillsLookups', () => {
  const repo = {owner: 'fro-bot', repo: 'agent'}

  it('returns the head repository and the default branch, passing an abort signal to each request', async () => {
    // #given a client that answers
    interface Call {
      pull_number?: number
      request: {signal: AbortSignal}
    }
    const pullsGet = vi.fn(async (_call: Call) => ({data: {head: {repo: {full_name: 'fro-bot/agent'}}}}))
    const reposGet = vi.fn(async (_call: Call) => ({data: {default_branch: 'trunk'}}))
    const lookups = createRepoSkillsLookups(
      clientWith({pulls: {get: pullsGet}, repos: {get: reposGet}}),
      repo,
      createMockLogger(),
    )

    // #when looking both up
    const head = await lookups.lookupPullRequestHeadRepo(12)
    const branch = await lookups.lookupDefaultBranch()

    // #then the facts come back and each request carried a signal
    expect(head).toBe('fro-bot/agent')
    expect(branch).toBe('trunk')
    expect(pullsGet.mock.calls[0]?.[0].pull_number).toBe(12)
    expect(pullsGet.mock.calls[0]?.[0].request.signal).toBeInstanceOf(AbortSignal)
    expect(reposGet.mock.calls[0]?.[0].request.signal).toBeInstanceOf(AbortSignal)
  })

  it('times out a pull request fetch that never resolves, aborts it and answers null with a warning', async () => {
    // #given a request that never settles
    let seenSignal: AbortSignal | undefined
    const pullsGet = vi.fn(async (parameters: {request: {signal: AbortSignal}}) => {
      seenSignal = parameters.request.signal
      return new Promise<never>(() => undefined)
    })
    const logger = createMockLogger()
    const lookups = createRepoSkillsLookups(
      clientWith({pulls: {get: pullsGet}, repos: {get: vi.fn()}}),
      repo,
      logger,
      20,
    )

    // #when looking up
    const head = await lookups.lookupPullRequestHeadRepo(12)

    // #then it gives up with null, aborted the request, and warned
    expect(head).toBeNull()
    expect(seenSignal?.aborted).toBe(true)
    expect(serializeLoggerCalls(logger)).toContain('timed out')
  })

  it('times out a default branch fetch that never resolves and answers null', async () => {
    // #given a request that never settles
    const reposGet = vi.fn(async () => new Promise<never>(() => undefined))
    const lookups = createRepoSkillsLookups(
      clientWith({pulls: {get: vi.fn()}, repos: {get: reposGet}}),
      repo,
      createMockLogger(),
      20,
    )

    // #when looking up
    const branch = await lookups.lookupDefaultBranch()

    // #then no default branch
    expect(branch).toBeNull()
  })

  it('skips repo skills end to end when the default branch request hangs', async () => {
    // #given a trusted schedule run whose default branch request never resolves
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-skills-timeout-')))
    const stage = vi.fn<RepoSkillsDeps['stageDefaultBranchSkills']>(async () => ok(null))
    const lookups = createRepoSkillsLookups(
      clientWith({pulls: {get: vi.fn()}, repos: {get: vi.fn(async () => new Promise<never>(() => undefined))}}),
      repo,
      createMockLogger(),
      20,
    )
    const logger = createMockLogger()

    // #when resolving
    const source = await resolveRepoSkillsSource({
      enabled: true,
      generation: 'v2',
      githubContext: context(schedule),
      githubToken: 't',
      logger,
      deps: {exec: {} as ExecAdapter, env: {RUNNER_TEMP: root}, ...lookups, stageDefaultBranchSkills: stage},
    })

    // #then repo skills are skipped with a warning, nothing was fetched, and no staging root is left
    expect(source).toBeNull()
    expect(stage).not.toHaveBeenCalled()
    expect(serializeLoggerCalls(logger)).toContain('default branch')
    expect(fs.readdirSync(root)).toEqual([])
    fs.rmSync(root, {recursive: true, force: true})
  })
})
