import type {OpenCodeInstallResult, SetupInputs, SetupResult} from './types.js'
import {mkdir, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {getOctokit} from '@actions/github'
import {getRunnerOS, getXdgDataHome} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLogger} from '../../shared/logger.js'
import {createExecAdapter, createToolCacheAdapter} from './adapters.js'
import {parseAuthJsonInput, populateAuthJson} from './auth-json.js'
import {buildCIConfig} from './ci-config.js'
import {configureGhAuth, configureGitIdentity} from './gh-auth.js'
import {defaultOpenCodeConfigDir} from './no-task-reuse-config.js'
import {FALLBACK_VERSION, getLatestVersion, installOpenCode, opencodeBinaryPath, toolCacheVersion} from './opencode.js'
import {writeSessionToolsFile} from './session-tools-config.js'
import {writeSystematicConfig} from './systematic-config.js'
import {installSystematicPlugin} from './systematic-plugin.js'
import {restoreToolsCache, saveToolsCache} from './tools-cache.js'

// OpenCode reads boolean env flags through Effect's Config.boolean (true/yes/on/1/y vs false/no/off/0/n) and
// the older Flag helpers ("true"/"1"); anything non-empty that is not an explicit "off" word counts as set.
function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized !== '' && !['0', 'false', 'no', 'off', 'n'].includes(normalized)
}

export async function runSetup(inputs: SetupInputs, githubToken: string): Promise<SetupResult | null> {
  const startTime = Date.now()
  const logger = createLogger({component: 'setup'})
  const toolCache = createToolCacheAdapter()
  const execAdapter = createExecAdapter()

  try {
    logger.info('Starting setup', {version: inputs.opencodeVersion})

    // Parse auth.json early to fail fast
    let authConfig
    try {
      authConfig = parseAuthJsonInput(inputs.authJson)
    } catch (error) {
      core.setFailed(`Invalid auth-json: ${toErrorMessage(error)}`)
      return null
    }

    // Determine OpenCode version
    let version = inputs.opencodeVersion
    if (version === 'latest') {
      try {
        version = await getLatestVersion(logger)
      } catch (error) {
        logger.warning('Failed to get latest version, using fallback', {
          error: toErrorMessage(error),
        })
        version = FALLBACK_VERSION
      }
    }

    const systematicVersion = inputs.systematicVersion

    // Restore tools cache before installs
    const runnerToolCache = process.env.RUNNER_TOOL_CACHE ?? '/opt/hostedtoolcache'
    const toolCachePath = join(runnerToolCache, 'opencode')
    const configDir = defaultOpenCodeConfigDir()
    const opencodeCachePath = join(homedir(), '.cache', 'opencode')
    const runnerOS = getRunnerOS()

    const toolsCacheResult = await restoreToolsCache({
      logger,
      os: runnerOS,
      opencodeVersion: version,
      systematicVersion,
      toolCachePath,
      opencodeCachePath,
    })

    const toolsCacheStatus: 'hit' | 'miss' = toolsCacheResult.hit ? 'hit' : 'miss'

    let opencodeResult: OpenCodeInstallResult | undefined

    if (toolsCacheResult.hit) {
      const cachedPath = toolCache.find('opencode', toolCacheVersion(version))
      if (cachedPath.length > 0) {
        opencodeResult = {path: cachedPath, version, cached: true}
        logger.info('Tools cache hit, using cached OpenCode CLI', {version})
      } else {
        logger.warning('Tools cache hit but binary not found in tool-cache, falling through to install', {
          requestedVersion: version,
          restoredKey: toolsCacheResult.restoredKey,
        })
      }
    }

    if (opencodeResult == null) {
      try {
        opencodeResult = await installOpenCode(version, logger, toolCache, execAdapter)
      } catch (error) {
        core.setFailed(`Failed to install OpenCode: ${toErrorMessage(error)}`)
        return null
      }
    }

    // Write Systematic config — always honored
    if (inputs.systematicConfig != null) {
      try {
        await writeSystematicConfig(inputs.systematicConfig, configDir, logger)
      } catch (error) {
        logger.warning(`systematic-config write failed: ${toErrorMessage(error)}`)
      }
    }

    // Native session tools are always-on.
    await writeSessionToolsFile(configDir, logger)

    // OPENCODE_PURE makes OpenCode skip every external plugin (plugin/index.ts:181), Systematic and the
    // task-reuse guard included, and the guard's config layer is no exception. filterAgentEnv denies it for
    // the server child; say so rather than letting an operator think it took effect. (The guard itself is
    // provisioned at server start, not here: features/agent/server-adapter.ts.)
    if (isTruthyFlag(process.env.OPENCODE_PURE)) {
      logger.warning(
        'OPENCODE_PURE is set in the runner environment; it is withheld from the OpenCode server so the task-reuse guard and Systematic plugins still load.',
      )
    }

    const ciConfigResult = buildCIConfig(
      {
        opencodeConfig: inputs.opencodeConfig,
        systematicVersion,
        integrationWorkDir: process.env.FRO_BOT_INTEGRATION_WORK_DIR,
      },
      logger,
    )
    if (ciConfigResult.error != null) {
      core.setFailed(ciConfigResult.error)
      return null
    }

    const opencodeConfigPath = join(configDir, 'opencode.json')
    await mkdir(configDir, {recursive: true})

    // Start fresh from the CI config: no merge with a local or restored opencode.json
    const freshConfigJson = JSON.stringify(ciConfigResult.config, null, 2)
    core.exportVariable('OPENCODE_CONFIG_CONTENT', freshConfigJson)
    await writeFile(opencodeConfigPath, freshConfigJson)
    logger.info('Wrote fresh OpenCode config', {
      path: opencodeConfigPath,
      pluginCount: Array.isArray(ciConfigResult.config.plugin) ? ciConfigResult.config.plugin.length : 0,
    })

    core.addPath(opencodeResult.path)

    // Both disjuncts are needed — the two flags are independent, not nested. A tools-cache hit
    // whose binary went missing falls through to a fresh install (cached: false), which still needs
    // the plugin installed and the cache re-saved; and `installOpenCode` reports cached: true from
    // RUNNER_TOOL_CACHE alone, so a tools-cache key miss (bumped systematicVersion, or an earlier
    // invocation that skipped its save) must still install and save even on a warm tool cache.
    if (opencodeResult.cached !== true || toolsCacheResult.hit === false) {
      const systematicPluginInstall = await installSystematicPlugin({
        logger,
        execAdapter,
        opencodeBinaryPath: opencodeBinaryPath(opencodeResult.path),
        systematicVersion,
      })

      if (systematicPluginInstall.status === 'installed') {
        await saveToolsCache({
          logger,
          os: runnerOS,
          opencodeVersion: version,
          systematicVersion,
          toolCachePath,
          opencodeCachePath,
        })
      } else {
        // Name the likely cause when the parent env had NPM_CONFIG_* set: the install child
        // (systematic-plugin.ts) deliberately does not inherit NPM_CONFIG_* so a network-fetched
        // package's lifecycle scripts can't see registry/proxy overrides. List key NAMES only —
        // never values — and never propose allowlisting; that would defeat the scrub.
        // Case-insensitive: filterAgentEnv is deny-by-default, so lowercase `npm_config_*` (what
        // npm itself exports) is dropped from the child too.
        const npmConfigKeys = Object.keys(process.env).filter(key => key.toUpperCase().startsWith('NPM_CONFIG_'))
        const npmConfigNote =
          npmConfigKeys.length > 0
            ? ` The install child does not inherit NPM_CONFIG_* environment variables (present in the parent env: ${npmConfigKeys.join(', ')}), which may explain the failure.`
            : ''
        const warningMessage = `Skipping tools cache save because Systematic plugin install did not complete${npmConfigNote}`
        logger.warning(warningMessage, {
          status: systematicPluginInstall.status,
        })
        core.warning(warningMessage)
      }
    }

    core.setOutput('opencode-path', opencodeResult.path)
    core.setOutput('opencode-version', opencodeResult.version)
    logger.info('OpenCode ready', {
      version: opencodeResult.version,
      cached: opencodeResult.cached,
    })

    // Configure gh CLI authentication. The action's own in-process Octokit
    // client (`octokit`) is unaffected by credential withholding — it never
    // reads process.env.GH_TOKEN, $GITHUB_ENV, or the gh CLI config; it holds
    // the token in-heap directly (accepted residual — see plan Scope Boundaries).
    const octokit = getOctokit(githubToken)
    const provisionChildCredential = inputs.credential === 'provision'
    const ghResult = await configureGhAuth(octokit, null, githubToken, logger, execAdapter, provisionChildCredential)
    if (provisionChildCredential) {
      core.exportVariable('GH_TOKEN', githubToken)
      if (process.env.GH_CONFIG_DIR != null && process.env.GH_CONFIG_DIR.length > 0) {
        core.exportVariable('GH_CONFIG_DIR', process.env.GH_CONFIG_DIR)
      }
      logger.info('GitHub CLI configured')
    } else {
      logger.info('GitHub CLI credential withheld from child (affected trigger)')
    }

    await configureGitIdentity(octokit, ghResult.botLogin, logger, execAdapter)

    // Populate auth.json
    const storagePath = join(getXdgDataHome(), 'opencode')
    const authJsonPath = await populateAuthJson(authConfig, storagePath, logger)
    core.setOutput('auth-json-path', authJsonPath)
    logger.info('auth.json populated', {path: authJsonPath})

    const duration = Date.now() - startTime

    const result: SetupResult = {
      opencodePath: opencodeResult.path,
      opencodeBinaryPath: opencodeBinaryPath(opencodeResult.path),
      opencodeVersion: opencodeResult.version,
      ghAuthenticated: ghResult.authenticated,
      toolsCacheStatus,
      duration,
    }

    logger.info('Setup complete', {duration})
    return result
  } catch (error) {
    const message = toErrorMessage(error)
    logger.error('Setup failed', {error: message})
    core.setFailed(message)
    return null
  }
}
