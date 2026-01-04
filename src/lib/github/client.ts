import type {Logger} from '../logger.js'
import type {Octokit} from './types.js'
import * as github from '@actions/github'

export interface ClientOptions {
  readonly token: string
  readonly logger: Logger
}

export interface AppClientOptions {
  readonly appId: string
  readonly privateKey: string
  readonly installationId?: number
  readonly logger: Logger
}

function createOctokitLogger(logger: Logger) {
  return {
    debug: (msg: string) => logger.debug(msg),
    info: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warning(msg),
    error: (msg: string) => logger.error(msg),
  }
}

/**
 * Create Octokit client with standard token.
 * Used for all GitHub API operations.
 */
export function createClient(options: ClientOptions): Octokit {
  const {token, logger} = options

  logger.debug('Creating GitHub client with token')

  return github.getOctokit(token, {
    log: createOctokitLogger(logger),
  })
}

/**
 * Get the bot's login name for self-detection.
 * Handles both regular users and GitHub Apps (with [bot] suffix).
 */
export async function getBotLogin(client: Octokit, logger: Logger): Promise<string> {
  try {
    const {data: user} = await client.rest.users.getAuthenticated()
    logger.debug('Authenticated as', {login: user.login, type: user.type})
    return user.login
  } catch {
    // For GitHub App tokens, the above may fail
    logger.debug('Failed to get authenticated user, may be app token')
    return 'fro-bot[bot]'
  }
}

/**
 * Create elevated client from GitHub App credentials.
 * Used for push/PR operations that need higher permissions.
 *
 * Returns null if credentials are not provided or authentication fails.
 * Uses dynamic import to avoid bundling @octokit/auth-app when not needed.
 */
export async function createAppClient(options: AppClientOptions): Promise<Octokit | null> {
  const {appId, privateKey, installationId, logger} = options

  if (appId.length === 0 || privateKey.length === 0) {
    logger.debug('GitHub App credentials not provided')
    return null
  }

  try {
    const {createAppAuth} = await import('@octokit/auth-app')

    const auth = createAppAuth({
      appId,
      privateKey,
      installationId,
    })

    const {token} = await auth({type: 'installation'})

    logger.info('Created GitHub App client', {appId})

    return github.getOctokit(token, {
      log: createOctokitLogger(logger),
    })
  } catch (error) {
    logger.error('Failed to create GitHub App client', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
