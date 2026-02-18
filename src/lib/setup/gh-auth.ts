import type {Octokit} from '../github/types.js'
import type {ExecAdapter, GhAuthResult, Logger} from './types.js'
import process from 'node:process'
import {getUserByUsername} from '../github/api.js'
import {getBotLogin as getAuthenticatedUser} from '../github/client.js'

export async function configureGhAuth(
  client: Octokit | null,
  appToken: string | null,
  defaultToken: string,
  logger: Logger,
): Promise<GhAuthResult> {
  const token = appToken ?? defaultToken
  const method: GhAuthResult['method'] =
    appToken == null ? (defaultToken.length > 0 ? 'github-token' : 'none') : 'app-token'

  if (token.length === 0) {
    logger.warning('No GitHub token available')
    return {authenticated: false, method: 'none', botLogin: null}
  }

  process.env.GH_TOKEN = token

  logger.info('Configured authentication', {method})

  let botLogin: string | null = null
  if (client != null) {
    botLogin = await getAuthenticatedUser(client, logger)
  }

  return {authenticated: true, method, botLogin}
}

export async function getBotLogin(client: Octokit, logger: Logger): Promise<string | null> {
  try {
    const {data: user} = await client.rest.users.getAuthenticated()
    logger.debug('Authenticated as', {login: user.login})
    return user.login
  } catch {
    logger.debug('Could not determine bot login')
    return null
  }
}

async function getGitConfig(key: string, execAdapter: ExecAdapter): Promise<string | null> {
  const result = await execAdapter.getExecOutput('git', ['config', key], {ignoreReturnCode: true, silent: true})
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim()
  }
  return null
}

export async function configureGitIdentity(
  client: Octokit,
  botLogin: string | null,
  logger: Logger,
  execAdapter: ExecAdapter,
): Promise<void> {
  const existingName = await getGitConfig('user.name', execAdapter)
  const existingEmail = await getGitConfig('user.email', execAdapter)

  if (existingName != null && existingEmail != null) {
    logger.info('Git identity already configured', {name: existingName, email: existingEmail})
    return
  }

  if (botLogin == null) {
    throw new Error('Cannot configure Git identity: no authenticated GitHub user')
  }

  let userId: string | null = null
  if (existingEmail == null) {
    const user = await getUserByUsername(client, botLogin, logger)
    if (user == null) {
      throw new Error(`Cannot configure Git identity: failed to look up user ID for '${botLogin}'`)
    }
    userId = String(user.id)
  }

  if (existingName == null) {
    await execAdapter.exec('git', ['config', '--global', 'user.name', botLogin], undefined)
  }

  const email = `${userId}+${botLogin}@users.noreply.github.com`
  if (existingEmail == null) {
    await execAdapter.exec('git', ['config', '--global', 'user.email', email], undefined)
  }

  logger.info('Configured git identity', {
    name: existingName ?? botLogin,
    email: existingEmail ?? email,
  })
}

export async function getBotUserId(client: Octokit, appSlug: string, logger: Logger): Promise<string | null> {
  const user = await getUserByUsername(client, `${appSlug}[bot]`, logger)
  if (user != null) {
    return String(user.id)
  }
  return null
}
