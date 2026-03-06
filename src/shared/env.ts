import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

export function getXdgDataHome(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome != null && xdgDataHome.trim().length > 0) {
    return xdgDataHome
  }
  return path.join(os.homedir(), '.local', 'share')
}

export function getOpenCodeStoragePath(): string {
  return path.join(getXdgDataHome(), 'opencode', 'storage')
}

export function getOpenCodeAuthPath(): string {
  return path.join(getXdgDataHome(), 'opencode', 'auth.json')
}

export function getOpenCodeLogPath(): string {
  return path.join(getXdgDataHome(), 'opencode', 'log')
}

export function isOpenCodePromptArtifactEnabled(): boolean {
  const enabled = process.env.OPENCODE_PROMPT_ARTIFACT
  return enabled === 'true' || enabled === '1'
}

export function getRunnerOS(): string {
  const runnerOs = process.env.RUNNER_OS
  if (runnerOs != null && runnerOs.trim().length > 0) {
    return runnerOs
  }
  // Fallback for local testing
  const platform = os.platform()
  switch (platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'aix':
    case 'android':
    case 'freebsd':
    case 'haiku':
    case 'linux':
    case 'openbsd':
    case 'sunos':
    case 'cygwin':
    case 'netbsd':
      return 'Linux'
  }
}

export function getGitHubRepository(): string {
  const repo = process.env.GITHUB_REPOSITORY
  if (repo != null && repo.trim().length > 0) {
    return repo
  }
  return 'unknown/unknown'
}

export function getGitHubRefName(): string {
  const refName = process.env.GITHUB_REF_NAME
  if (refName != null && refName.trim().length > 0) {
    return refName
  }
  return 'main'
}

export function getGitHubRunId(): number {
  const runId = process.env.GITHUB_RUN_ID
  if (runId != null && runId.trim().length > 0) {
    return Number(runId)
  }
  return 0
}

export function getGitHubWorkspace(): string {
  const workspace = process.env.GITHUB_WORKSPACE
  if (workspace != null && workspace.trim().length > 0) {
    return workspace
  }
  return process.cwd()
}
