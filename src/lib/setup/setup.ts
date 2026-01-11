import type {ExecAdapter, SetupInputs, SetupResult, ToolCacheAdapter} from './types.js'
import {join} from 'node:path'
import process from 'node:process'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {getOctokit} from '@actions/github'

import * as tc from '@actions/tool-cache'
import {getRunnerOS, getXdgDataHome} from '../../utils/env.js'
import {buildPrimaryCacheKey, buildRestoreKeys} from '../cache-key.js'
import {createLogger} from '../logger.js'
import {parseAuthJsonInput, populateAuthJson} from './auth-json.js'
import {configureGhAuth, configureGitIdentity} from './gh-auth.js'
import {installOmo} from './omo.js'
import {FALLBACK_VERSION, getLatestVersion, installOpenCode} from './opencode.js'

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
      core.setFailed(`Invalid auth-json: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }

    // Determine OpenCode version
    let version = inputs.opencodeVersion
    if (version === 'latest') {
      try {
        version = await getLatestVersion(logger)
      } catch (error) {
        logger.warning('Failed to get latest version, using fallback', {
          error: error instanceof Error ? error.message : String(error),
        })
        version = FALLBACK_VERSION
      }
    }

    // Install OpenCode
    let opencodeResult
    try {
      opencodeResult = await installOpenCode(version, logger, toolCache, execAdapter)
    } catch (error) {
      core.setFailed(`Failed to install OpenCode: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }

    core.addPath(opencodeResult.path)
    core.setOutput('opencode-path', opencodeResult.path)
    core.setOutput('opencode-version', opencodeResult.version)
    logger.info('OpenCode installed', {
      version: opencodeResult.version,
      cached: opencodeResult.cached,
    })

    // Install oMo (graceful failure)
    const omoResult = await installOmo(
      {logger, execAdapter, toolCache, addPath: core.addPath},
      {claude: 'no', chatgpt: 'no', gemini: 'no'},
    )
    if (omoResult.installed) {
      logger.info('oMo installed', {version: omoResult.version})
    } else {
      core.warning(`oMo installation failed (continuing without it): ${omoResult.error ?? 'unknown error'}`)
    }

    // Configure gh CLI authentication
    const octokit = getOctokit(githubToken)
    const ghResult = await configureGhAuth(octokit, null, githubToken, logger)
    core.exportVariable('GH_TOKEN', githubToken)
    logger.info('GitHub CLI configured')

    // Configure git identity - extract app slug from botLogin (e.g., "fro-bot[bot]" -> "fro-bot")
    const appSlug = ghResult.botLogin?.replace(/\[bot\]$/, '') ?? null
    await configureGitIdentity(appSlug, null, logger, execAdapter)
    logger.info('Git identity configured', {user: ghResult.botLogin ?? 'fro-bot[bot]'})

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
        error: error instanceof Error ? error.message : String(error),
      })
    }

    core.setOutput('cache-status', cacheStatus)
    core.setOutput('storage-path', storagePath)

    const duration = Date.now() - startTime

    const result: SetupResult = {
      opencodePath: opencodeResult.path,
      opencodeVersion: opencodeResult.version,
      ghAuthenticated: ghResult.authenticated,
      omoInstalled: omoResult.installed,
      omoError: omoResult.error,
      cacheStatus,
      duration,
    }

    logger.info('Setup complete', {duration})
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Setup failed', {error: message})
    core.setFailed(message)
    return null
  }
}
