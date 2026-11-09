import type {OpenCodeInstallResult, SetupInputs, SetupResult} from './types.js'
import {join} from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {getOctokit} from '@actions/github'
import {FRO_BOT_PLUGIN_VERSION} from '@fro-bot/runtime'
import {getRunnerOS} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLogger} from '../../shared/logger.js'
import {createExecAdapter, createToolCacheAdapter} from './adapters.js'
import {parseAuthJsonInput} from './auth-json.js'
import {parseProviderKeysV2} from './credential-files-v2.js'
import {configureGhAuth, configureGitIdentity} from './gh-auth.js'
import {defaultOpenCodeConfigDir} from './opencode-config-dir.js'
import {
  getPlatformInfo,
  installOpenCode,
  opencodeBinaryPath,
  RECORDED_V2_PIN,
  resolveRequestedVersion,
  resolveStockV2Policy,
} from './opencode.js'
import {arePluginsCachedV2, installPluginsV2, resolveCacheHome, resolvePluginSpecsV2} from './plugin-install-v2.js'
import {writeSystematicConfig} from './systematic-config.js'
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

    // Determine OpenCode version. `latest` is the recorded V2 pin: no upstream lookup, so it cannot resolve to an
    // unverified release. Any other value is held to the pin by the policy below.
    const version = resolveRequestedVersion(inputs.opencodeVersion)

    // The version is checked against the recorded pin BEFORE any cache is consulted, and every reusable
    // installation is keyed by the recorded digest. An unpinned version, a platform with no recorded digest, or a
    // cache entry written before digests were recorded can never be accepted.
    let v2Policy: ReturnType<typeof resolveStockV2Policy>
    try {
      v2Policy = resolveStockV2Policy(version, getPlatformInfo(), RECORDED_V2_PIN)
    } catch (error) {
      core.setFailed(`Failed to install OpenCode: ${toErrorMessage(error)}`)
      return null
    }

    // OpenCode V2 installs its plugins as exact versions, writes its provider keys as {file:} references at spawn
    // time and never writes auth.json.
    const keys = parseProviderKeysV2(authConfig)
    if (!keys.success) {
      core.setFailed(`Invalid auth-json for OpenCode V2: ${keys.error.message}`)
      return null
    }
    const specs = resolvePluginSpecsV2(inputs.systematicVersion)
    if (!specs.success) {
      core.setFailed(specs.error.message)
      return null
    }
    const v2Specs = specs.data.specs

    // `latest` resolves to the pinned exact version, so the tools-cache key names what is actually installed.
    const systematicVersion = specs.data.systematicVersion

    // Restore tools cache before installs
    const runnerToolCache = process.env.RUNNER_TOOL_CACHE ?? '/opt/hostedtoolcache'
    const toolCachePath = join(runnerToolCache, 'opencode')
    const configDir = defaultOpenCodeConfigDir()
    // V2 finds its plugins under the cache home the server will read, so that is the directory the tools cache carries.
    const opencodeCachePath = join(resolveCacheHome(process.env), 'opencode')
    const runnerOS = getRunnerOS()
    const frobotPluginKey = {frobotPluginVersion: FRO_BOT_PLUGIN_VERSION}

    const toolsCacheResult = await restoreToolsCache({
      logger,
      os: runnerOS,
      opencodeVersion: version,
      opencodeDigestId: v2Policy.cacheId,
      systematicVersion,
      ...frobotPluginKey,
      toolCachePath,
      opencodeCachePath,
    })

    const toolsCacheStatus: 'hit' | 'miss' = toolsCacheResult.hit ? 'hit' : 'miss'

    // Never short-circuits on a tools-cache hit: installOpenCode looks up the digest-bound identity itself.
    let opencodeResult: OpenCodeInstallResult
    try {
      opencodeResult = await installOpenCode(version, logger, toolCache, execAdapter)
    } catch (error) {
      core.setFailed(`Failed to install OpenCode: ${toErrorMessage(error)}`)
      return null
    }

    // Write Systematic config — always honored
    if (inputs.systematicConfig != null) {
      try {
        await writeSystematicConfig(inputs.systematicConfig, configDir, logger)
      } catch (error) {
        logger.warning(`systematic-config write failed: ${toErrorMessage(error)}`)
      }
    }

    // OPENCODE_PURE makes OpenCode skip every external plugin, Systematic and the fro.bot plugin included.
    // filterAgentEnv denies it for the server child; say so rather than letting an operator think it took effect.
    if (isTruthyFlag(process.env.OPENCODE_PURE)) {
      logger.warning(
        'OPENCODE_PURE is set in the runner environment; it is withheld from the OpenCode server so the Systematic and fro.bot plugins still load.',
      )
    }

    // The config is built at spawn time (`buildCIConfigV2`, called from the cache-restore phase): it carries
    // run-scoped paths and the provider key files, and must exist even when this setup is skipped because a matching
    // binary is already installed. Nothing is written to the global config or exported here.

    core.addPath(opencodeResult.path)

    // Install both plugins as exact versions before the server ever starts, each under its own bound, unless the
    // cache already holds them. A failure fails startup: the server would otherwise install them at boot with no
    // bound, or skip a plugin that failed to load and keep serving.
    const cacheHome = resolveCacheHome(process.env)
    let installedNow = false
    if (await arePluginsCachedV2(cacheHome, v2Specs)) {
      logger.info('OpenCode V2 plugins already in the cache', {specs: v2Specs})
    } else {
      const installed = await installPluginsV2({
        logger,
        execAdapter,
        opencodeBinaryPath: opencodeBinaryPath(opencodeResult.path),
        specs: v2Specs,
        cacheHome,
      })
      if (!installed.success) {
        core.setFailed(`OpenCode plugin install failed: ${installed.error.message}`)
        return null
      }
      installedNow = true
    }
    if (installedNow || toolsCacheResult.hit === false) {
      await saveToolsCache({
        logger,
        os: runnerOS,
        opencodeVersion: version,
        opencodeDigestId: v2Policy.cacheId,
        systematicVersion,
        ...frobotPluginKey,
        toolCachePath,
        opencodeCachePath,
      })
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

    // auth.json is never written: provider keys become 0600 files referenced from the config at spawn time, so the
    // V2 migration that imports auth.json (m39) has nothing to import and the saved database holds no key.

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
