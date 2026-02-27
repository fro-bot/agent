import type {OmoInstallOptions} from './omo.js'
import type {ExecAdapter, OpenCodeInstallResult, SetupInputs, SetupResult, ToolCacheAdapter} from './types.js'
import {homedir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {getOctokit} from '@actions/github'
import * as tc from '@actions/tool-cache'
import {getRunnerOS, getXdgDataHome} from '../../utils/env.js'
import {toErrorMessage} from '../../utils/errors.js'
import {buildPrimaryCacheKey, buildRestoreKeys} from '../cache-key.js'
import {DEFAULT_BUN_VERSION, DEFAULT_OMO_PROVIDERS, DEFAULT_OMO_VERSION} from '../constants.js'
import {createLogger} from '../logger.js'
import {parseAuthJsonInput, populateAuthJson} from './auth-json.js'
import {installBun} from './bun.js'
import {configureGhAuth, configureGitIdentity} from './gh-auth.js'
import {installOmo} from './omo.js'
import {FALLBACK_VERSION, getLatestVersion, installOpenCode} from './opencode.js'
import {restoreToolsCache, saveToolsCache} from './tools-cache.js'

const VALID_OMO_PROVIDERS = [
  'claude',
  'claude-max20',
  'copilot',
  'gemini',
  'openai',
  'opencode-zen',
  'zai-coding-plan',
] as const

function parseOmoProviders(input: string): OmoInstallOptions {
  const providers = input
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0)

  let claude: 'no' | 'yes' | 'max20' = 'no'
  let copilot: 'no' | 'yes' = 'no'
  let gemini: 'no' | 'yes' = 'no'
  let openai: 'no' | 'yes' = 'no'
  let opencodeZen: 'no' | 'yes' = 'no'
  let zaiCodingPlan: 'no' | 'yes' = 'no'

  for (const provider of providers) {
    if (!VALID_OMO_PROVIDERS.includes(provider as (typeof VALID_OMO_PROVIDERS)[number])) {
      continue
    }

    switch (provider) {
      case 'claude':
        claude = 'yes'
        break
      case 'claude-max20':
        claude = 'max20'
        break
      case 'copilot':
        copilot = 'yes'
        break
      case 'gemini':
        gemini = 'yes'
        break
      case 'openai':
        openai = 'yes'
        break
      case 'opencode-zen':
        opencodeZen = 'yes'
        break
      case 'zai-coding-plan':
        zaiCodingPlan = 'yes'
        break
    }
  }

  return {claude, copilot, gemini, openai, opencodeZen, zaiCodingPlan}
}

/**
 * Create tool cache adapter from @actions/tool-cache
 */
function createToolCacheAdapter(): ToolCacheAdapter {
  return {
    find: tc.find,
    downloadTool: tc.downloadTool,
    extractTar: tc.extractTar,
    extractZip: tc.extractZip,
    cacheDir: tc.cacheDir,
  }
}

/**
 * Create exec adapter from @actions/exec
 */
function createExecAdapter(): ExecAdapter {
  return {
    exec: exec.exec,
    getExecOutput: exec.getExecOutput,
  }
}

/**
 * Parse setup action inputs from environment.
 */
function parseSetupInputs(): SetupInputs {
  return {
    opencodeVersion: core.getInput('opencode-version') || 'latest',
    authJson: core.getInput('auth-json', {required: true}),
    appId: core.getInput('app-id') || null,
    privateKey: core.getInput('private-key') || null,
    opencodeConfig: core.getInput('opencode-config') || null,
  }
}

/**
 * Run the setup action.
 *
 * This function orchestrates:
 * 1. Installing OpenCode CLI
 * 2. Installing oMo plugin (graceful failure)
 * 3. Configuring gh CLI authentication
 * 4. Configuring git identity
 * 5. Populating auth.json
 * 6. Restoring session cache
 */
export async function runSetup(): Promise<SetupResult | null> {
  const startTime = Date.now()
  const logger = createLogger({component: 'setup'})
  const toolCache = createToolCacheAdapter()
  const execAdapter = createExecAdapter()

  try {
    // Parse inputs
    const inputs = parseSetupInputs()
    const githubToken = core.getInput('github-token', {required: true})
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

    // Determine oMo version
    const omoVersionRaw = core.getInput('omo-version').trim()
    const omoVersion = omoVersionRaw.length > 0 ? omoVersionRaw : DEFAULT_OMO_VERSION

    // Restore tools cache before installs
    const runnerToolCache = process.env.RUNNER_TOOL_CACHE ?? '/opt/hostedtoolcache'
    const toolCachePath = join(runnerToolCache, 'opencode')
    const bunCachePath = join(runnerToolCache, 'bun')
    const omoConfigPath = join(homedir(), '.config', 'opencode')
    const runnerOS = getRunnerOS()

    const toolsCacheResult = await restoreToolsCache({
      logger,
      os: runnerOS,
      opencodeVersion: version,
      omoVersion,
      toolCachePath,
      bunCachePath,
      omoConfigPath,
    })

    const toolsCacheStatus: 'hit' | 'miss' = toolsCacheResult.hit ? 'hit' : 'miss'

    let opencodeResult: OpenCodeInstallResult | undefined
    let omoInstalled = false
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

    // Install Bun runtime (required for bunx to run oMo installer)
    let bunInstalled = false
    try {
      await installBun(logger, toolCache, execAdapter, core.addPath, DEFAULT_BUN_VERSION)
      bunInstalled = true
    } catch (error) {
      logger.warning('Bun installation failed, oMo will be unavailable', {
        error: toErrorMessage(error),
      })
    }

    // Run oMo installer to ensure config values (e.g. provider settings) are current.
    // Skip if Bun install failed — bunx won't be available.
    if (bunInstalled) {
      const omoProvidersRaw = core.getInput('omo-providers').trim()
      const omoOptions = parseOmoProviders(omoProvidersRaw.length > 0 ? omoProvidersRaw : DEFAULT_OMO_PROVIDERS)
      const omoResult = await installOmo(omoVersion, {logger, execAdapter}, omoOptions)
      if (omoResult.installed) {
        logger.info('oMo installed', {version: omoResult.version})
        omoInstalled = true
      } else {
        logger.warning(`oMo installation failed, continuing without oMo`, {
          error: omoResult.error ?? 'unknown error',
        })
      }
      omoError = omoResult.error
    }

    // Export CI-safe OpenCode config. OPENCODE_CONFIG_CONTENT has highest precedence over all
    // other OpenCode config sources (project, global, etc.). User-supplied opencode-config input
    // is merged on top of the baseline, so user values override the defaults.
    const ciConfig: Record<string, unknown> = {
      autoupdate: false,
      ...(inputs.opencodeConfig == null ? {} : (JSON.parse(inputs.opencodeConfig) as Record<string, unknown>)),
    }
    core.exportVariable('OPENCODE_CONFIG_CONTENT', JSON.stringify(ciConfig))

    if (!toolsCacheResult.hit) {
      await saveToolsCache({
        logger,
        os: runnerOS,
        opencodeVersion: version,
        omoVersion,
        toolCachePath,
        bunCachePath,
        omoConfigPath,
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

    // Restore session cache
    const repo = process.env.GITHUB_REPOSITORY ?? 'unknown/unknown'
    const ref = process.env.GITHUB_REF_NAME ?? 'main'
    const os = getRunnerOS()

    const cacheKey = buildPrimaryCacheKey({agentIdentity: 'github', repo, ref, os})
    const restoreKeys = buildRestoreKeys({agentIdentity: 'github', repo, ref, os})

    let cacheStatus: 'hit' | 'miss' | 'corrupted' = 'miss'
    try {
      const restoredKey = await cache.restoreCache([storagePath], cacheKey, [...restoreKeys])
      if (restoredKey == null) {
        logger.info('No cache found')
      } else {
        cacheStatus = 'hit'
        logger.info('Cache restored', {key: restoredKey})
      }
    } catch (error) {
      cacheStatus = 'corrupted'
      logger.warning('Cache restore failed', {
        error: toErrorMessage(error),
      })
    }

    core.setOutput('cache-status', cacheStatus)
    core.setOutput('storage-path', storagePath)

    const duration = Date.now() - startTime

    const result: SetupResult = {
      opencodePath: opencodeResult.path,
      opencodeVersion: opencodeResult.version,
      ghAuthenticated: ghResult.authenticated,
      omoInstalled,
      omoError,
      cacheStatus,
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
