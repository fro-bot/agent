import type {Octokit} from '../github/types.js'
import type {ExecAdapter, GhAuthResult, Logger} from './types.js'
import {Buffer} from 'node:buffer'
import {chmod, mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {toErrorMessage} from '../../shared/errors.js'
import {getUserByUsername} from '../github/api.js'
import {getBotLogin as getAuthenticatedUser} from '../github/client.js'

export async function configureGhAuth(
  client: Octokit | null,
  appToken: string | null,
  defaultToken: string,
  logger: Logger,
  execAdapter: ExecAdapter,
  provisionChildCredential = true,
): Promise<GhAuthResult> {
  const token = appToken ?? defaultToken
  const method: GhAuthResult['method'] =
    appToken == null ? (defaultToken.length > 0 ? 'github-token' : 'none') : 'app-token'

  if (token.length === 0) {
    logger.warning('No GitHub token available')
    return {authenticated: false, method: 'none', botLogin: null}
  }

  // The child (model bash) can read process.env.GH_TOKEN and the hosts.yml
  // written below via the temp GH_CONFIG_DIR. When the credential is being
  // withheld, skip both so nothing same-UID-readable is left for the child —
  // the action's own Octokit `client` (passed in) is unaffected; it never
  // reads process.env.GH_TOKEN or the gh CLI config.
  if (provisionChildCredential) {
    process.env.GH_TOKEN = token
  }

  logger.info('Configured authentication', {method})

  if (provisionChildCredential && token.length > 0) {
    // Off-environment gh auth (#1147): the model's bash child has GH_TOKEN/GITHUB_TOKEN
    // scrubbed from its env before spawn, so `gh` can no longer authenticate via env var.
    // Persist auth to a temp GH_CONFIG_DIR/hosts.yml instead — GH_CONFIG_DIR is allowlisted
    // through the scrub and reaches the child, so `gh` falls back to it there while the
    // harness process (which still has GH_TOKEN) keeps using the env var (gh prefers env
    // over hosts.yml, so there's no conflict).
    //
    // This whole block is wrapped in try/catch: a disk/permission failure creating the temp
    // dir, or `gh` not being on PATH (ENOENT), must degrade to a warning rather than crash
    // setup — the harness already has GH_TOKEN set above; only the model's child `gh` usage
    // is affected.
    try {
      const baseTmp =
        process.env.RUNNER_TEMP != null && process.env.RUNNER_TEMP.length > 0 ? process.env.RUNNER_TEMP : tmpdir()
      const ghConfigDir = await mkdtemp(join(baseTmp, 'gh-config-'))
      await chmod(ghConfigDir, 0o700)

      // `gh auth login --with-token` refuses to persist credentials when GH_TOKEN/GITHUB_TOKEN
      // is present in its environment (it uses the env token instead of writing hosts.yml). Strip
      // both from THIS exec's env only — the harness process keeps process.env.GH_TOKEN for its
      // own gh usage; we only want the child's persisted hosts.yml here.
      const loginEnv: Record<string, string> = {...process.env, GH_CONFIG_DIR: ghConfigDir}
      delete loginEnv.GH_TOKEN
      delete loginEnv.GITHUB_TOKEN
      const loginResult = await execAdapter.getExecOutput('gh', ['auth', 'login', '--with-token'], {
        env: loginEnv,
        input: Buffer.from(token, 'utf8'),
        silent: true,
        ignoreReturnCode: true,
      })
      if (loginResult.exitCode === 0) {
        // Only repoint the global env at the temp config dir once we know login succeeded —
        // if login fails, leave GH_CONFIG_DIR unset so gh falls back to any pre-existing
        // default config instead of an empty directory.
        process.env.GH_CONFIG_DIR = ghConfigDir
        // Defense-in-depth: gh normally writes hosts.yml as 0600 already; this is a backstop,
        // not the primary guarantee. Best-effort — ignore if the file doesn't exist.
        try {
          await chmod(join(ghConfigDir, 'hosts.yml'), 0o600)
        } catch {
          // hosts.yml may not exist if gh's write layout differs; ignore.
        }
      } else {
        // Non-fatal: the harness process still has GH_TOKEN for its own needs. A failed
        // `gh auth login` only degrades the model's own `gh` usage in the child, it does not
        // break setup.
        logger.warning('gh auth login failed; model gh CLI usage in the child may be unauthenticated', {
          exitCode: loginResult.exitCode,
        })
      }

      // HONEST RESIDUAL: the token now lives in `${ghConfigDir}/hosts.yml`, readable by the
      // model's same-user bash (`cat "$GH_CONFIG_DIR/hosts.yml"` or `gh auth token`). This
      // closes the #1147 *accidental* `${GH_TOKEN}` shell-expansion vector (no env var to
      // expand) but does NOT close *deliberate* exfiltration — that's the deferred credential
      // broker's job. Tight perms (0700/0600) bound cross-user/cross-process reach only.
      //
      // No explicit cleanup: ghConfigDir lives under the ephemeral runner temp dir, wiped at
      // job end.
    } catch (error) {
      logger.warning('Failed to configure off-environment gh auth; child gh CLI will be unauthenticated', {
        error: toErrorMessage(error),
      })
    }
  }

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
