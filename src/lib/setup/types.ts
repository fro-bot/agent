import type {Buffer} from 'node:buffer'

import type {Logger} from '../logger.js'

// Re-export Logger for convenience in setup modules
export type {Logger}

/**
 * Setup action inputs (parsed from action.yaml)
 */
export interface SetupInputs {
  readonly opencodeVersion: string
  readonly authJson: string
  readonly appId: string | null
  readonly privateKey: string | null
  readonly opencodeConfig: string | null
}

/**
 * Setup action result summary
 */
export interface SetupResult {
  readonly opencodePath: string
  readonly opencodeVersion: string
  readonly ghAuthenticated: boolean
  readonly omoInstalled: boolean
  readonly omoError: string | null
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly duration: number
}

/**
 * OpenCode CLI installation result
 */
export interface OpenCodeInstallResult {
  readonly path: string
  readonly version: string
  readonly cached: boolean
}

/**
 * oMo plugin installation result
 */
export interface OmoInstallResult {
  readonly installed: boolean
  readonly version: string | null
  readonly error: string | null
}

/**
 * GitHub CLI authentication result
 */
export interface GhAuthResult {
  readonly authenticated: boolean
  readonly method: 'app-token' | 'github-token' | 'none'
  readonly botLogin: string | null
}

/**
 * Platform information for binary downloads
 */
export interface PlatformInfo {
  readonly os: string
  readonly arch: string
  readonly ext: string
}

// Auth config types for auth.json population
// These match OpenCode's expected auth.json format

export interface OAuthAuth {
  readonly type: 'oauth'
  readonly refresh: string
  readonly access: string
  readonly expires: number
  readonly enterpriseUrl?: string
}

export interface ApiAuth {
  readonly type: 'api'
  readonly key: string
}

export interface WellKnownAuth {
  readonly type: 'wellknown'
  readonly key: string
  readonly token: string
}

export type AuthInfo = ApiAuth | OAuthAuth | WellKnownAuth

/**
 * Auth configuration mapping provider IDs to auth info
 * Example: { "anthropic": { "type": "api", "key": "sk-ant-..." } }
 */
export type AuthConfig = Record<string, AuthInfo>

/**
 * Prompt context extracted from GitHub Actions environment
 */
export interface PromptContext {
  readonly eventName: string
  readonly repo: string
  readonly ref: string
  readonly actor: string
  readonly issueNumber: number | null
  readonly issueTitle: string | null
  readonly commentBody: string | null
  readonly prNumber: number | null
}

/**
 * Adapter for tool-cache operations (for testing)
 */
export interface ToolCacheAdapter {
  readonly find: (toolName: string, version: string, arch?: string) => string
  readonly downloadTool: (url: string) => Promise<string>
  readonly extractTar: (file: string) => Promise<string>
  readonly extractZip: (file: string) => Promise<string>
  readonly cacheDir: (sourceDir: string, tool: string, version: string, arch?: string) => Promise<string>
}

/**
 * Adapter for exec operations (for testing)
 */
export interface ExecAdapter {
  readonly exec: (commandLine: string, args?: string[], options?: ExecOptions) => Promise<number>
  readonly getExecOutput: (commandLine: string, args?: string[], options?: ExecOptions) => Promise<ExecOutput>
}

export interface ExecOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly silent?: boolean
  readonly ignoreReturnCode?: boolean
  readonly listeners?: {
    readonly stdout?: (data: Buffer) => void
    readonly stderr?: (data: Buffer) => void
  }
}

export interface ExecOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}
