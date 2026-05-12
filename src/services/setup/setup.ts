import type {OpenCodeInstallResult, SetupInputs, SetupResult} from './types.js'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {getOctokit} from '@actions/github'
import {DEFAULT_BUN_VERSION} from '../../shared/constants.js'
import {getRunnerOS, getXdgDataHome} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLogger} from '../../shared/logger.js'
import {createExecAdapter, createToolCacheAdapter} from './adapters.js'
import {parseAuthJsonInput, populateAuthJson} from './auth-json.js'
import {installBun} from './bun.js'
import {buildCIConfig, pluginPrefix} from './ci-config.js'
import {configureGhAuth, configureGitIdentity} from './gh-auth.js'
import {installOmo} from './omo.js'
import {FALLBACK_VERSION, getLatestVersion, installOpenCode} from './opencode.js'
import {writeSystematicConfig} from './systematic-config.js'
import {restoreToolsCache, saveToolsCache} from './tools-cache.js'

export async function runSetup(inputs: SetupInputs, githubToken: string): Promise<SetupResult | null> {
  const startTime = Date.now()
  const logger = createLogger({component: 'setup'})
  const toolCache = createToolCacheAdapter()
  const execAdapter = createExecAdapter()

  try {
    logger.info('Starting setup', {version: inputs.opencodeVersion, enableOmo: inputs.enableOmo})

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

    const omoVersion = inputs.omoVersion
    const systematicVersion = inputs.systematicVersion

    // Restore tools cache before installs
    const runnerToolCache = process.env.RUNNER_TOOL_CACHE ?? '/opt/hostedtoolcache'
    const toolCachePath = join(runnerToolCache, 'opencode')
    const bunCachePath = join(runnerToolCache, 'bun')
    const configDir = join(homedir(), '.config', 'opencode')
    const opencodeCachePath = join(homedir(), '.cache', 'opencode')
    const runnerOS = getRunnerOS()

    const toolsCacheResult = await restoreToolsCache({
      logger,
      os: runnerOS,
      opencodeVersion: version,
      omoVersion,
      systematicVersion,
      cacheMode: inputs.enableOmo ? 'enabled' : 'disabled',
      toolCachePath,
      bunCachePath,
      omoConfigPath: configDir,
      opencodeCachePath,
    })

    const toolsCacheStatus: 'hit' | 'miss' = toolsCacheResult.hit ? 'hit' : 'miss'

    let opencodeResult: OpenCodeInstallResult | undefined
    let omoStatus: 'installed' | 'failed' | 'skipped' = 'skipped'
    let omoError: string | null = null

    if (toolsCacheResult.hit) {
      const cachedPath = toolCache.find('opencode', version)
      if (cachedPath.length > 0) {
        opencodeResult = {path: cachedPath, version, cached: true}
        logger.info('Tools cache hit, using cached OpenCode CLI', {version, omoVersion})
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

    // Enabled mode: Bun install, oMo telemetry, oMo install
    if (inputs.enableOmo) {
      let bunInstalled = false
      try {
        await installBun(logger, toolCache, execAdapter, core.addPath, DEFAULT_BUN_VERSION)
        bunInstalled = true
      } catch (error) {
        logger.warning('Bun installation failed, oMo will be unavailable', {
          error: toErrorMessage(error),
        })
      }

      // Disable oMo telemetry before any oMo code runs
      core.exportVariable('OMO_SEND_ANONYMOUS_TELEMETRY', '0')
      core.exportVariable('OMO_DISABLE_POSTHOG', '1')

      if (bunInstalled) {
        const omoResult = await installOmo(omoVersion, {logger, execAdapter}, inputs.omoProviders)
        if (omoResult.installed) {
          logger.info('oMo installed', {version: omoResult.version})
          omoStatus = 'installed'
        } else {
          logger.warning('oMo installation failed, continuing without oMo', {
            error: omoResult.error ?? 'unknown error',
          })
          omoStatus = 'failed'
        }
        omoError = omoResult.error
      } else {
        omoStatus = 'failed'
        omoError = 'Bun installation failed'
      }
    } else {
      logger.info('oMo disabled, skipping oMo install')
    }

    // Write Systematic config regardless of oMo mode — always honored
    if (inputs.systematicConfig != null) {
      try {
        await writeSystematicConfig(inputs.systematicConfig, configDir, logger)
      } catch (error) {
        logger.warning(`systematic-config write failed: ${toErrorMessage(error)}`)
      }
    }

    const ciConfigResult = buildCIConfig(
      {opencodeConfig: inputs.opencodeConfig, systematicVersion, enableOmo: inputs.enableOmo},
      logger,
    )
    if (ciConfigResult.error != null) {
      core.setFailed(ciConfigResult.error)
      return null
    }

    const opencodeConfigPath = join(configDir, 'opencode.json')
    await mkdir(configDir, {recursive: true})

    if (inputs.enableOmo) {
      // Enabled mode: merge CI config with existing opencode.json (e.g. oMo plugin registration)
      let existingConfig: Record<string, unknown> = {}
      try {
        const raw = await readFile(opencodeConfigPath, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existingConfig = parsed as Record<string, unknown>
        }
      } catch {
        // File doesn't exist yet or is invalid — start fresh
      }

      // Strip legacy "plugins" (plural) key — OpenCode only accepts "plugin" (singular)
      delete existingConfig.plugins

      // Normalize oMo plugin specifiers to pinned version
      const normalizePlugins = (plugins: unknown[]): unknown[] =>
        plugins.map(p => {
          if (typeof p !== 'string') return p
          if (p === 'oh-my-openagent' || p === 'oh-my-openagent@latest') {
            return `oh-my-openagent@${omoVersion}`
          }
          return p
        })

      // Merge plugin arrays: existing plugins + CI plugins, deduplicated by package name prefix
      const existingPlugins: unknown[] = normalizePlugins(
        Array.isArray(existingConfig.plugin) ? (existingConfig.plugin as unknown[]) : [],
      )
      const ciPlugins: unknown[] = Array.isArray(ciConfigResult.config.plugin)
        ? (ciConfigResult.config.plugin as unknown[])
        : []
      const mergedPlugins = [...existingPlugins]
      for (const ciPlugin of ciPlugins) {
        if (typeof ciPlugin !== 'string') continue
        const prefix = pluginPrefix(ciPlugin)
        const alreadyPresent = mergedPlugins.some(p => typeof p === 'string' && pluginPrefix(p) === prefix)
        if (!alreadyPresent) {
          mergedPlugins.push(ciPlugin)
        }
      }

      const mergedConfig = {...existingConfig, ...ciConfigResult.config, plugin: mergedPlugins}
      const mergedConfigJson = JSON.stringify(mergedConfig, null, 2)
      core.exportVariable('OPENCODE_CONFIG_CONTENT', mergedConfigJson)
      await writeFile(opencodeConfigPath, mergedConfigJson)
      logger.info('Wrote merged OpenCode config', {
        path: opencodeConfigPath,
        pluginCount: mergedPlugins.length,
        plugins: mergedPlugins,
      })
    } else {
      // Disabled mode: start fresh from CI config — no merge with existing local/restored opencode.json
      const freshConfigJson = JSON.stringify(ciConfigResult.config, null, 2)
      core.exportVariable('OPENCODE_CONFIG_CONTENT', freshConfigJson)
      await writeFile(opencodeConfigPath, freshConfigJson)
      logger.info('Wrote fresh OpenCode config (disabled oMo)', {
        path: opencodeConfigPath,
        pluginCount: Array.isArray(ciConfigResult.config.plugin) ? ciConfigResult.config.plugin.length : 0,
      })
    }

    if (!toolsCacheResult.hit) {
      await saveToolsCache({
        logger,
        os: runnerOS,
        opencodeVersion: version,
        omoVersion,
        systematicVersion,
        cacheMode: inputs.enableOmo ? 'enabled' : 'disabled',
        toolCachePath,
        bunCachePath,
        omoConfigPath: configDir,
        opencodeCachePath,
      })
    }

    core.addPath(opencodeResult.path)
    core.setOutput('opencode-path', opencodeResult.path)
    core.setOutput('opencode-version', opencodeResult.version)
    logger.info('OpenCode ready', {
      version: opencodeResult.version,
      cached: opencodeResult.cached,
    })

    // Configure gh CLI authentication
    const octokit = getOctokit(githubToken)
    const ghResult = await configureGhAuth(octokit, null, githubToken, logger)
    core.exportVariable('GH_TOKEN', githubToken)
    logger.info('GitHub CLI configured')

    await configureGitIdentity(octokit, ghResult.botLogin, logger, execAdapter)

    // Populate auth.json
    const storagePath = join(getXdgDataHome(), 'opencode')
    const authJsonPath = await populateAuthJson(authConfig, storagePath, logger)
    core.setOutput('auth-json-path', authJsonPath)
    logger.info('auth.json populated', {path: authJsonPath})

    const duration = Date.now() - startTime

    const result: SetupResult = {
      opencodePath: opencodeResult.path,
      opencodeVersion: opencodeResult.version,
      ghAuthenticated: ghResult.authenticated,
      omoStatus,
      omoError,
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
