import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

export function getXdgDataHome(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome != null && xdgDataHome.length > 0) {
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

export function getRunnerOS(): string {
  const runnerOs = process.env.RUNNER_OS
  if (runnerOs != null && runnerOs.length > 0) {
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
