import type {Logger} from '../logger.js'
import type {Octokit} from './types.js'
import * as github from '@actions/github'

export interface ClientOptions {
  readonly token: string
  readonly logger: Logger
}

/**
 * Create Octokit client with standard token.
 * Used for all GitHub API operations.
 */
export function createClient(options: ClientOptions): Octokit {
  const {token, logger} = options

  logger.debug('Creating GitHub client with token')

  return github.getOctokit(token, {
    log: {
      debug: (msg: string) => logger.debug(msg),
      info: (msg: string) => logger.info(msg),
      warn: (msg: string) => logger.warning(msg),
      error: (msg: string) => logger.error(msg),
    },
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
