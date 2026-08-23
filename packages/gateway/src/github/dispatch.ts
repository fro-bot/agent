/**
 * GitHub Actions workflow-dispatch adapter for the gateway.
 *
 * The adapter owns the fixed workflow, default-branch resolution, raw Octokit
 * request shape, and closed outcome mapping. It deliberately has no queue,
 * concurrency, or local run-state participation.
 */

import type {Octokit} from '@octokit/core'
import type {GatewayLogger} from '../discord/client.js'

import {AppNotInstalledError, InsufficientPermissionsError, type AppClient, type AuthError} from './app-client.js'
import {isOctokitNotFound, safeErrorMessage} from './errors.js'

export const WORKFLOW_PATH = '.github/workflows/fro-bot.yaml'
export const GITHUB_API_VERSION = '2026-03-10'
export const WORKFLOW_DISPATCH_REQUEST_TIMEOUT_MS = 5_000

export type DispatchOutcome =
  | {
      readonly outcome: 'accepted'
      readonly owner: string
      readonly repo: string
      readonly runId?: number
      readonly runUrl?: string
    }
  | {readonly outcome: 'invalid-task'}
  | {readonly outcome: 'app-not-installed'; readonly owner: string; readonly repo: string; readonly installUrl: string}
  | {
      readonly outcome: 'missing-actions-permission'
      readonly owner: string
      readonly repo: string
      readonly installUrl: string
    }
  | {
      readonly outcome: 'missing-permissions'
      readonly owner: string
      readonly repo: string
      readonly missingPermissions: readonly string[]
      readonly installUrl: string
    }
  | {readonly outcome: 'repo-not-found'; readonly owner: string; readonly repo: string}
  | {readonly outcome: 'workflow-not-found'; readonly owner: string; readonly repo: string}
  | {readonly outcome: 'dispatch-rejected'; readonly owner: string; readonly repo: string}
  | {readonly outcome: 'github-unavailable'; readonly owner: string; readonly repo: string}

export type DispatchWorkflow = (owner: string, repo: string, task: string) => Promise<DispatchOutcome>

export interface WorkflowDispatcherDeps {
  readonly appClient: AppClient
  readonly logger: GatewayLogger
}

interface WorkflowRun {
  readonly id: number
  readonly html_url: string
}

interface WorkflowDispatchResponse {
  readonly workflow_run: WorkflowRun
}

const API_HEADERS = {'X-GitHub-Api-Version': GITHUB_API_VERSION}

function responseStatus(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null || !('status' in response)) return undefined
  const status = response.status
  return typeof status === 'number' ? status : undefined
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  const status = error.status
  return typeof status === 'number' ? status : undefined
}

function isSuccessStatus(status: number | undefined): boolean {
  return status === undefined || (status >= 200 && status < 300)
}

function isServerError(status: number | undefined): boolean {
  return status !== undefined && status >= 500 && status < 600
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseDefaultBranch(response: unknown): string | null {
  if (!isRecord(response) || !isRecord(response.data)) return null
  const defaultBranch = response.data.default_branch
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) return null
  return defaultBranch
}

function parseWorkflowRun(response: unknown): WorkflowDispatchResponse | null {
  if (!isRecord(response) || !isRecord(response.data) || !isRecord(response.data.workflow_run)) return null
  const workflowRun = response.data.workflow_run
  const id = workflowRun.id
  const htmlUrl = workflowRun.html_url
  if (typeof id !== 'number' || Number.isInteger(id) === false || id <= 0) return null
  if (typeof htmlUrl !== 'string' || htmlUrl.length === 0) return null
  return {workflow_run: {id, html_url: htmlUrl}}
}

function logGithubFailure(logger: GatewayLogger, owner: string, repo: string, error: unknown, message: string): void {
  logger.warn({owner, repo, status: errorStatus(error), err: safeErrorMessage(error)}, message)
}

async function resolveDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  logger: GatewayLogger,
): Promise<
  | {readonly outcome: 'ok'; readonly branch: string}
  | {readonly outcome: 'repo-not-found'}
  | {readonly outcome: 'github-unavailable'}
> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo,
      headers: API_HEADERS,
      request: {signal: AbortSignal.timeout(WORKFLOW_DISPATCH_REQUEST_TIMEOUT_MS)},
    })
    const status = responseStatus(response)
    if (status === 404) return {outcome: 'repo-not-found'}
    if (isServerError(status)) return {outcome: 'github-unavailable'}
    if (isSuccessStatus(status) === false) return {outcome: 'github-unavailable'}

    const branch = parseDefaultBranch(response)
    return branch === null ? {outcome: 'github-unavailable'} : {outcome: 'ok', branch}
  } catch (error) {
    if (errorStatus(error) === 404 || isOctokitNotFound(error)) return {outcome: 'repo-not-found'}
    if (isServerError(errorStatus(error))) return {outcome: 'github-unavailable'}
    logGithubFailure(logger, owner, repo, error, 'workflow dispatch: repository metadata lookup failed')
    return {outcome: 'github-unavailable'}
  }
}

async function dispatchWorkflowRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  task: string,
  logger: GatewayLogger,
): Promise<DispatchOutcome> {
  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
      owner,
      repo,
      workflow_id: WORKFLOW_PATH,
      ref: branch,
      return_run_details: true,
      inputs: {prompt: task},
      headers: API_HEADERS,
      request: {signal: AbortSignal.timeout(WORKFLOW_DISPATCH_REQUEST_TIMEOUT_MS)},
    })
    const status = responseStatus(response)
    if (status === 404) return {outcome: 'workflow-not-found', owner, repo}
    if (isServerError(status)) return {outcome: 'github-unavailable', owner, repo}
    if (isSuccessStatus(status) === false) return {outcome: 'dispatch-rejected', owner, repo}

    const parsedResponse = parseWorkflowRun(response)
    if (parsedResponse === null) return {outcome: 'accepted', owner, repo}
    return {
      outcome: 'accepted',
      owner,
      repo,
      runId: parsedResponse.workflow_run.id,
      runUrl: parsedResponse.workflow_run.html_url,
    }
  } catch (error) {
    const status = errorStatus(error)
    if (status === 404 || isOctokitNotFound(error)) return {outcome: 'workflow-not-found', owner, repo}
    if (isServerError(status)) return {outcome: 'github-unavailable', owner, repo}
    if (status !== undefined) return {outcome: 'dispatch-rejected', owner, repo}
    logGithubFailure(logger, owner, repo, error, 'workflow dispatch: GitHub request failed')
    return {outcome: 'github-unavailable', owner, repo}
  }
}

function mapAuthFailure(
  owner: string,
  repo: string,
  error: AppNotInstalledError | InsufficientPermissionsError | AuthError,
): DispatchOutcome {
  if (error instanceof AppNotInstalledError) {
    return {outcome: 'app-not-installed', owner, repo, installUrl: error.installUrl}
  }
  if (
    error instanceof InsufficientPermissionsError &&
    error.missingPermissions.some(permission => permission.startsWith('actions:'))
  ) {
    return {outcome: 'missing-actions-permission', owner, repo, installUrl: error.installUrl}
  }
  if (error instanceof InsufficientPermissionsError) {
    return {
      outcome: 'missing-permissions',
      owner,
      repo,
      missingPermissions: error.missingPermissions,
      installUrl: error.installUrl,
    }
  }
  return {outcome: 'github-unavailable', owner, repo}
}

export function createWorkflowDispatcher(deps: WorkflowDispatcherDeps): DispatchWorkflow {
  return async (owner: string, repo: string, task: string): Promise<DispatchOutcome> => {
    const trimmedTask = task.trim()
    if (trimmedTask.length === 0) return {outcome: 'invalid-task'}

    const authResult = await deps.appClient.authForWorkflowDispatch(owner, repo)
    if (authResult.success === false) return mapAuthFailure(owner, repo, authResult.error)

    const branchResult = await resolveDefaultBranch(authResult.data.octokit, owner, repo, deps.logger)
    if (branchResult.outcome === 'repo-not-found') return {outcome: 'repo-not-found', owner, repo}
    if (branchResult.outcome === 'github-unavailable') return {outcome: 'github-unavailable', owner, repo}

    return dispatchWorkflowRequest(authResult.data.octokit, owner, repo, branchResult.branch, trimmedTask, deps.logger)
  }
}
