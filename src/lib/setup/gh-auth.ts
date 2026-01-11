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

export async function configureGitIdentity(
  appSlug: string | null,
  botUserId: string | null,
  logger: Logger,
  execAdapter: ExecAdapter,
): Promise<void> {
  const name = appSlug == null ? 'fro-bot[bot]' : `${appSlug}[bot]`
  const email =
    botUserId != null && appSlug != null ? `${botUserId}+${appSlug}[bot]@users.noreply.github.com` : 'agent@fro.bot'

  await execAdapter.exec('git', ['config', '--global', 'user.name', name], undefined)
  await execAdapter.exec('git', ['config', '--global', 'user.email', email], undefined)

  logger.info('Configured git identity', {name, email})
}

export async function getBotUserId(client: Octokit, appSlug: string, logger: Logger): Promise<string | null> {
  const user = await getUserByUsername(client, `${appSlug}[bot]`, logger)
  if (user != null) {
    return String(user.id)
  }
  return null
}
