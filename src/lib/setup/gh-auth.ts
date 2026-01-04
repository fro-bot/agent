import type {ExecAdapter, ExecOptions, GhAuthResult, Logger} from './types.js'
import process from 'node:process'

/**
 * Configure gh CLI with GitHub App token or fallback to GITHUB_TOKEN.
 *
 * Uses GH_TOKEN environment variable (preferred over GITHUB_TOKEN)
 * to avoid conflicts with the Actions-provided token.
 */
export async function configureGhAuth(
  appToken: string | null,
  defaultToken: string,
  logger: Logger,
  execAdapter: ExecAdapter,
): Promise<GhAuthResult> {
  const token = appToken ?? defaultToken
  const method: GhAuthResult['method'] =
    appToken == null ? (defaultToken.length > 0 ? 'github-token' : 'none') : 'app-token'

  if (token.length === 0) {
    logger.warning('No GitHub token available for gh CLI')
    return {authenticated: false, method: 'none', botLogin: null}
  }

  // GH_TOKEN takes priority over GITHUB_TOKEN for gh CLI
  process.env.GH_TOKEN = token

  logger.info('Configured gh CLI authentication', {method})

  const botLogin = await getBotLogin(token, logger, execAdapter)

  return {authenticated: true, method, botLogin}
}

/**
 * Get the authenticated user/bot login.
 */
export async function getBotLogin(token: string, logger: Logger, execAdapter: ExecAdapter): Promise<string | null> {
  try {
    const {stdout} = await execAdapter.getExecOutput('gh', ['api', '/user', '--jq', '.login'], {
      env: {...process.env, GH_TOKEN: token},
      silent: true,
    })

    const login = stdout.trim()
    if (login.length > 0) {
      logger.info('Authenticated as', {login})
      return login
    }
    return null
  } catch {
    logger.debug('Could not determine bot login')
    return null
  }
}

/**
 * Configure git identity for commits.
 *
 * Uses GitHub App bot identity format: <app-slug>[bot]
 */
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

/**
 * Get GitHub App bot user ID for commit attribution.
 */
export async function getBotUserId(
  appSlug: string,
  token: string,
  logger: Logger,
  execAdapter: ExecAdapter,
): Promise<string | null> {
  try {
    const options: ExecOptions = {
      env: {...process.env, GH_TOKEN: token},
      silent: true,
    }
    const {stdout} = await execAdapter.getExecOutput('gh', ['api', `/users/${appSlug}[bot]`, '--jq', '.id'], options)

    const userId = stdout.trim()
    if (userId.length > 0) {
      return userId
    }
    return null
  } catch {
    logger.debug('Could not get bot user ID')
    return null
  }
}
