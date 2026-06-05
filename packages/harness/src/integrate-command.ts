/**
 * integrate-command.ts — `harness integrate` subcommand implementation.
 *
 * Reads harness.config.json for: baseVersion, releaseRepo, integrationRefs,
 * agent, model, opencodeBin. Parses --work-dir, --prompt-path, --out from argv.
 * Assembles IntegrationConfig and calls runIntegration(config, makeRealAdapters()).
 *
 * Exit codes: 0 on {ok:true}, 1 on {ok:false} or exception.
 * Error output: one-line message only — no stack traces, no secrets.
 *
 * No classes; functions only; explicit boolean checks; no as-any.
 */

import type {IntegrationConfig} from './integrate.js'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {makeRealAdapters, runIntegration} from './integrate.js'

// ---------------------------------------------------------------------------
// Config file shape
// ---------------------------------------------------------------------------

interface HarnessConfig {
  readonly release_repo: string
  readonly base_version: string
  readonly integrationRefs: readonly string[]
  readonly agent: string
  readonly model: string
  readonly opencode_bin?: string
}

function isValidHarnessConfig(value: unknown): value is HarnessConfig {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.release_repo !== 'string' || v.release_repo.length === 0) return false
  if (typeof v.base_version !== 'string' || v.base_version.length === 0) return false
  if (!Array.isArray(v.integrationRefs)) return false
  if (typeof v.agent !== 'string' || v.agent.length === 0) return false
  if (typeof v.model !== 'string' || v.model.length === 0) return false
  if (v.opencode_bin !== undefined && typeof v.opencode_bin !== 'string') return false
  return true
}

// ---------------------------------------------------------------------------
// Default config path (relative to this file's package root)
// ---------------------------------------------------------------------------

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_PATH = path.join(packageRoot, 'harness.config.json')

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface ParsedFlags {
  readonly workDir: string | undefined
  readonly promptPath: string | undefined
  readonly out: string | undefined
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  let workDir: string | undefined
  let promptPath: string | undefined
  let out: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--work-dir' && i + 1 < argv.length) {
      workDir = argv[i + 1]
      i++
    } else if (arg === '--prompt-path' && i + 1 < argv.length) {
      promptPath = argv[i + 1]
      i++
    } else if (arg === '--out' && i + 1 < argv.length) {
      out = argv[i + 1]
      i++
    }
  }

  return {workDir, promptPath, out}
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Implements `harness integrate`.
 *
 * @param argv       - CLI arguments (everything after "integrate").
 * @param configPath - Path to harness.config.json (defaults to package root; injectable for tests).
 * @returns Exit code: 0 on success, 1 on failure.
 */
export async function cmdIntegrate(argv: readonly string[], configPath: string = DEFAULT_CONFIG_PATH): Promise<number> {
  // Parse flags.
  const flags = parseFlags(argv)

  // Validate required flags.
  if (flags.workDir === undefined) {
    console.error('[integrate] Missing required flag: --work-dir <dir>')
    return 1
  }
  if (flags.promptPath === undefined) {
    console.error('[integrate] Missing required flag: --prompt-path <path>')
    return 1
  }

  // Read harness.config.json.
  let rawConfig: unknown
  try {
    const raw = readFileSync(configPath, 'utf8')
    rawConfig = JSON.parse(raw)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[integrate] Failed to read config: ${msg}`)
    return 1
  }

  if (!isValidHarnessConfig(rawConfig)) {
    console.error('[integrate] Invalid harness.config.json shape')
    return 1
  }

  const config: IntegrationConfig = {
    baseVersion: rawConfig.base_version,
    releaseRepo: rawConfig.release_repo,
    integrationRefs: rawConfig.integrationRefs,
    agent: rawConfig.agent,
    model: rawConfig.model,
    opencodeBin: rawConfig.opencode_bin ?? 'opencode',
    workDir: flags.workDir,
    promptPath: flags.promptPath,
  }

  // Run the integration.
  try {
    const result = await runIntegration(config, makeRealAdapters())
    if (result.ok === true) {
      return 0
    }
    console.error(`[integrate] ${result.error}`)
    return 1
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[integrate] ${msg}`)
    return 1
  }
}
