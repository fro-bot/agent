# RFC-011: Setup Action & Environment Bootstrap

**Status:** Pending
**Priority:** MUST
**Complexity:** High
**Phase:** 1

---

## Summary

Implement a dedicated `setup` action (`uses: fro-bot/agent/setup@v0`) that bootstraps the complete agent environment: installs OpenCode CLI, installs Oh My OpenCode (oMo) plugin, configures `gh` CLI with GitHub App credentials, populates `auth.json`, and prepares the workspace for agent execution. This mirrors the functionality of the oMo Sisyphus reusable workflow but as a composable TypeScript GitHub Action.

## Dependencies

- **Builds Upon:** RFC-001 (Foundation & Core Types), RFC-002 (Cache Infrastructure)
- **Enables:** All agent execution RFCs (RFC-004 through RFC-010)
- **Uses:** RFC-003 (GitHub API Client) - `createAppClient()` for GitHub App token generation

> **Note:** GitHub App authentication (`app-id`, `private-key` inputs) is optional. Setup works with `GITHUB_TOKEN` alone for read-only operations. App token enables elevated permissions (push, PR creation).

## Features Addressed

| Feature ID | Feature Name                | Priority |
| ---------- | --------------------------- | -------- |
| F10        | Setup Action Entrypoint     | P1 → P0  |
| F37        | Action Inputs Configuration | P0       |
| F25        | auth.json Population        | P0       |
| F27        | Credential Strategy         | P0       |

## Background: oMo Sisyphus Workflow

The Sisyphus agent workflow (reference: `oh-my-opencode/.github/workflows/sisyphus-agent.yml`) performs these setup steps:

1. **Install OpenCode CLI** - Downloads and installs the OpenCode binary
2. **Install Bun runtime** - Downloads and installs Bun (required for oMo)
3. **Install oMo plugin** - Runs `bunx oh-my-opencode install` to add Sisyphus agent capabilities
4. **Copy configuration** - Places `opencode.json` config in the correct location
5. **Configure git identity** - Sets up git user for commits
6. **Configure gh CLI** - Authenticates `gh` with GitHub App token for elevated operations
7. **Populate auth.json** - Writes LLM provider credentials from secrets
8. **Build prompt** - Constructs the agent prompt with GitHub context
9. **Launch OpenCode** - Executes OpenCode with the prompt

The Fro Bot setup action must replicate this functionality.

---

## Technical Specification

### 1. File Structure

```
setup/
├── action.yaml           # Setup action metadata
src/
├── setup.ts              # Setup action entry point
├── lib/
│   ├── setup/
│   │   ├── types.ts      # Setup-specific types
│   │   ├── opencode.ts   # OpenCode installation
│   │   ├── bun.ts        # Bun runtime installation
│   │   ├── omo.ts        # oMo plugin installation (uses bunx)
│   │   ├── gh-auth.ts    # GitHub CLI authentication
│   │   ├── auth-json.ts  # auth.json population
│   │   └── index.ts      # Public exports
```

### 2. Setup Action Metadata (`setup/action.yaml`)

```yaml
name: "Setup Fro Bot Agent"
description: "Install OpenCode, oMo plugin, and configure environment for agent execution"
author: "Fro Bot <agent@fro.bot>"

inputs:
  opencode-version:
    description: "OpenCode version to install (default: latest)"
    required: false
    default: "latest"
  auth-json:
    description: |
      JSON object mapping provider IDs to auth configs.
      Example: { "anthropic": { "type": "api", "key": "sk-ant-..." } }
    required: true
  app-id:
    description: "GitHub App ID for elevated operations (push, PR creation)"
    required: false
  private-key:
    description: "GitHub App private key (PEM format)"
    required: false
  opencode-config:
    description: "Custom opencode.json configuration (JSON string)"
    required: false

outputs:
  opencode-path:
    description: "Path to installed OpenCode binary"
  opencode-version:
    description: "Installed OpenCode version"
  gh-authenticated:
    description: "Whether gh CLI was authenticated with App token"
  setup-duration:
    description: "Setup duration in seconds"
  cache-status:
    description: "Cache restore status (hit, miss, corrupted)"
  omo-installed:
    description: "Whether oMo plugin was installed successfully"
  bun-version:
    description: "Installed Bun version (if oMo installed)"

runs:
  using: "node24"
  main: "../dist/setup.js"
```

### 3. Setup Types (`src/lib/setup/types.ts`)

```typescript
export interface SetupInputs {
  readonly opencodeVersion: string
  readonly authJson: string
  readonly appId: string | null
  readonly privateKey: string | null
  readonly opencodeConfig: string | null
}

export interface SetupResult {
  readonly opencodePath: string
  readonly opencodeVersion: string
  readonly ghAuthenticated: boolean
  readonly omoInstalled: boolean
  readonly omoError: string | null
  readonly cacheStatus: "hit" | "miss" | "corrupted"
  readonly duration: number
}

export interface OpenCodeInstallResult {
  readonly path: string
  readonly version: string
  readonly cached: boolean
}

export interface OmoInstallResult {
  readonly installed: boolean
  readonly version: string | null
  readonly error: string | null
}

export interface GhAuthResult {
  readonly authenticated: boolean
  readonly method: "app-token" | "github-token" | "none"
  readonly botLogin: string | null
}

/**
 * Re-export types from security module (RFC-006) to ensure consistency.
 * In the actual implementation, these would be imported from ../security/types.js
 */
export interface OAuthAuth {
  readonly type: "oauth"
  readonly refresh: string
  readonly access: string
  readonly expires: number
  readonly enterpriseUrl?: string
}

export interface ApiAuth {
  readonly type: "api"
  readonly key: string
}

export interface WellKnownAuth {
  readonly type: "wellknown"
  readonly key: string
  readonly token: string
}

export type AuthInfo = OAuthAuth | ApiAuth | WellKnownAuth

export type AuthConfig = Record<string, AuthInfo>
```

### 4. OpenCode Installation (`src/lib/setup/opencode.ts`)

```typescript
import * as tc from "@actions/tool-cache"
import * as core from "@actions/core"
import * as exec from "@actions/exec"
import * as os from "node:os"
import * as path from "node:path"
import type {OpenCodeInstallResult, Logger} from "./types.js"

const TOOL_NAME = "opencode"
const DOWNLOAD_BASE_URL = "https://github.com/opencode-ai/opencode/releases/download"
const FALLBACK_VERSION = "1.0.204" // Known stable version for fallback

interface PlatformInfo {
  readonly os: string
  readonly arch: string
  readonly ext: string
}

function getPlatformInfo(): PlatformInfo {
  const platform = os.platform()
  const arch = os.arch()

  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  }

  const archMap: Record<string, string> = {
    x64: "amd64",
    arm64: "arm64",
  }

  return {
    os: osMap[platform] ?? "linux",
    arch: archMap[arch] ?? "amd64",
    ext: platform === "win32" ? ".zip" : ".tar.gz",
  }
}

function buildDownloadUrl(version: string, info: PlatformInfo): string {
  const versionTag = version.startsWith("v") ? version : `v${version}`
  const filename = `opencode_${info.os}_${info.arch}${info.ext}`
  return `${DOWNLOAD_BASE_URL}/${versionTag}/${filename}`
}

/**
 * Validate downloaded archive is not corrupted.
 * Uses `file` command on Unix to check file type.
 */
async function validateDownload(downloadPath: string, ext: string, logger: Logger): Promise<boolean> {
  if (process.platform === "win32") {
    // Skip validation on Windows - trust HTTP response
    return true
  }

  try {
    let output = ""
    await exec.exec("file", [downloadPath], {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
      },
      silent: true,
    })

    const expectedTypes = ext === ".zip" ? ["Zip archive", "ZIP"] : ["gzip", "tar", "compressed"]
    const isValid = expectedTypes.some(type => output.includes(type))

    if (!isValid) {
      logger.warning("Download validation failed", {output: output.trim()})
    }
    return isValid
  } catch {
    logger.debug("Could not validate download (file command unavailable)")
    return true // Assume valid if we can't check
  }
}

/**
 * Install OpenCode CLI with version fallback.
 *
 * Tries requested version first, falls back to known stable version on failure.
 * Pattern from oMo Sisyphus workflow.
 */
export async function installOpenCode(
  version: string,
  logger: Logger,
  fallbackVersion: string = FALLBACK_VERSION,
): Promise<OpenCodeInstallResult> {
  const platformInfo = getPlatformInfo()

  // Check cache first
  let toolPath = tc.find(TOOL_NAME, version, platformInfo.arch)
  if (toolPath.length > 0) {
    logger.info("OpenCode found in cache", {version, path: toolPath})
    core.addPath(toolPath)
    return {path: toolPath, version, cached: true}
  }

  // Try primary version
  try {
    const result = await downloadAndInstall(version, platformInfo, logger)
    return result
  } catch (error) {
    logger.warning("Primary version install failed, trying fallback", {
      requestedVersion: version,
      fallbackVersion,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Fallback to known stable version
  if (version !== fallbackVersion) {
    try {
      const result = await downloadAndInstall(fallbackVersion, platformInfo, logger)
      logger.info("Installed fallback version", {version: fallbackVersion})
      return result
    } catch (error) {
      throw new Error(
        `Failed to install OpenCode (tried ${version} and ${fallbackVersion}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  throw new Error(`Failed to install OpenCode version ${version}`)
}

async function downloadAndInstall(
  version: string,
  platformInfo: PlatformInfo,
  logger: Logger,
): Promise<OpenCodeInstallResult> {
  // Download
  logger.info("Downloading OpenCode", {version})
  const downloadUrl = buildDownloadUrl(version, platformInfo)
  const downloadPath = await tc.downloadTool(downloadUrl)

  // Validate download
  const isValid = await validateDownload(downloadPath, platformInfo.ext, logger)
  if (!isValid) {
    throw new Error("Downloaded archive appears corrupted")
  }

  // Extract
  logger.info("Extracting OpenCode")
  let extractedPath: string
  if (platformInfo.ext === ".zip") {
    extractedPath = await tc.extractZip(downloadPath)
  } else {
    extractedPath = await tc.extractTar(downloadPath)
  }

  // Cache
  logger.info("Caching OpenCode")
  const toolPath = await tc.cacheDir(extractedPath, TOOL_NAME, version, platformInfo.arch)

  // Add to PATH
  core.addPath(toolPath)

  logger.info("OpenCode installed", {version, path: toolPath})
  return {path: toolPath, version, cached: false}
}

export async function getLatestVersion(logger: Logger): Promise<string> {
  // Fetch latest release from GitHub API
  const response = await fetch("https://api.github.com/repos/opencode-ai/opencode/releases/latest")
  if (!response.ok) {
    throw new Error(`Failed to fetch latest OpenCode version: ${response.statusText}`)
  }
  const data = (await response.json()) as {tag_name: string}
  const version = data.tag_name.replace(/^v/, "")
  logger.info("Latest OpenCode version", {version})
  return version
}
```

### 5. Bun Runtime Installation (`src/lib/setup/bun.ts`)

```typescript
import * as core from "@actions/core"
import * as os from "node:os"
import * as path from "node:path"
import type {Logger} from "../logger.js"

const TOOL_NAME = "bun"
const DEFAULT_VERSION = "latest"

export interface ToolCacheAdapter {
  find: (toolName: string, version: string, arch?: string) => string
  downloadTool: (url: string) => Promise<string>
  extractTar: (file: string) => Promise<string>
  extractZip: (file: string) => Promise<string>
  cacheDir: (sourceDir: string, tool: string, version: string, arch?: string) => Promise<string>
}

export interface BunInstallResult {
  readonly installed: boolean
  readonly path: string | null
  readonly version: string
  readonly cached: boolean
  readonly error: string | null
}

interface PlatformInfo {
  readonly os: "darwin" | "linux" | "windows"
  readonly arch: "x64" | "aarch64"
  readonly ext: ".zip" | ".tar.gz"
}

function getPlatformInfo(): PlatformInfo {
  const platform = os.platform()
  const arch = os.arch()

  const osMap: Record<string, "darwin" | "linux" | "windows"> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  }

  const archMap: Record<string, "x64" | "aarch64"> = {
    x64: "x64",
    arm64: "aarch64",
  }

  return {
    os: osMap[platform] ?? "linux",
    arch: archMap[arch] ?? "x64",
    ext: platform === "darwin" || platform === "linux" ? ".zip" : ".zip",
  }
}

export function getBunDownloadUrl(version: string, info: PlatformInfo): string {
  const baseUrl = "https://github.com/oven-sh/bun/releases"
  const versionPath = version === "latest" ? "latest/download" : `download/bun-v${version}`
  const filename = `bun-${info.os}-${info.arch}.zip`
  return `${baseUrl}/${versionPath}/${filename}`
}

/**
 * Install Bun runtime for oMo plugin execution.
 *
 * Bun is required because oh-my-opencode is built with `--target bun`
 * and has native bindings that only work with Bun runtime.
 */
export async function installBun(
  version: string,
  logger: Logger,
  toolCache: ToolCacheAdapter,
  addPath: (inputPath: string) => void,
): Promise<BunInstallResult> {
  const platformInfo = getPlatformInfo()
  const resolvedVersion = version === "latest" ? DEFAULT_VERSION : version

  logger.info("Installing Bun runtime", {version: resolvedVersion})

  // Check cache first
  const cachedPath = toolCache.find(TOOL_NAME, resolvedVersion, platformInfo.arch)
  if (cachedPath.length > 0) {
    const bunBinPath = path.join(cachedPath, "bun")
    addPath(cachedPath)
    logger.info("Bun found in cache", {version: resolvedVersion, path: cachedPath})
    return {installed: true, path: bunBinPath, version: resolvedVersion, cached: true, error: null}
  }

  try {
    // Download
    const downloadUrl = getBunDownloadUrl(resolvedVersion, platformInfo)
    logger.info("Downloading Bun", {url: downloadUrl})
    const downloadPath = await toolCache.downloadTool(downloadUrl)

    // Extract
    logger.info("Extracting Bun")
    const extractedPath = await toolCache.extractZip(downloadPath)

    // Find bun binary in extracted folder
    const bunDir = path.join(extractedPath, `bun-${platformInfo.os}-${platformInfo.arch}`)

    // Cache
    logger.info("Caching Bun")
    const cachedDir = await toolCache.cacheDir(bunDir, TOOL_NAME, resolvedVersion, platformInfo.arch)

    // Add to PATH
    addPath(cachedDir)

    const bunBinPath = path.join(cachedDir, "bun")
    logger.info("Bun installed", {version: resolvedVersion, path: bunBinPath})

    return {installed: true, path: bunBinPath, version: resolvedVersion, cached: false, error: null}
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error("Failed to install Bun", {error: errorMsg})
    return {installed: false, path: null, version: resolvedVersion, cached: false, error: errorMsg}
  }
}

/**
 * Check if Bun is available in PATH.
 */
export async function isBunAvailable(execAdapter: {
  exec: (cmd: string, args: string[]) => Promise<number>
}): Promise<boolean> {
  try {
    const exitCode = await execAdapter.exec("bun", ["--version"])
    return exitCode === 0
  } catch {
    return false
  }
}
```

### 7. oMo Plugin Installation (`src/lib/setup/omo.ts`)

```typescript
import type {Logger} from "../logger.js"
import {installBun, isBunAvailable, type ToolCacheAdapter} from "./bun.js"

export interface OmoInstallResult {
  readonly installed: boolean
  readonly version: string | null
  readonly error: string | null
  readonly bunVersion: string | null
}

export interface OmoInstallDeps {
  readonly toolCache: ToolCacheAdapter
  readonly addPath: (inputPath: string) => void
}

export interface OmoInstallOptions {
  readonly claude?: string
  readonly chatgpt?: string
  readonly gemini?: string
}

export interface ExecAdapter {
  exec: (command: string, args: string[]) => Promise<number>
}

/**
 * Install Oh My OpenCode (oMo) plugin.
 *
 * This adds Sisyphus agent capabilities to OpenCode.
 *
 * NOTE: oh-my-opencode is Bun-targeted with native bindings and cannot be
 * imported as a library. Must use bunx to run as CLI tool.
 * Bun is automatically installed if not available.
 */
export async function installOmo(
  deps: OmoInstallDeps,
  options: OmoInstallOptions,
  logger: Logger,
  execAdapter: ExecAdapter,
): Promise<OmoInstallResult> {
  logger.info("Installing Oh My OpenCode plugin", {
    claude: options.claude ?? "no",
    chatgpt: options.chatgpt ?? "no",
    gemini: options.gemini ?? "no",
  })

  // Check if Bun is available, install if needed
  let bunVersion: string | null = null
  const bunAvailable = await isBunAvailable(execAdapter)

  if (!bunAvailable) {
    logger.info("Bun not found, installing...")
    const bunResult = await installBun("latest", logger, deps.toolCache, deps.addPath)
    if (!bunResult.installed) {
      const errorMsg = `Failed to install Bun: ${bunResult.error}`
      logger.error(errorMsg)
      return {installed: false, version: null, error: errorMsg, bunVersion: null}
    }
    bunVersion = bunResult.version
  }

  try {
    // Build args for bunx oh-my-opencode install
    const args = ["oh-my-opencode", "install", "--no-tui"]

    if (options.claude != null && options.claude.length > 0) {
      args.push("--claude", options.claude)
    }
    if (options.chatgpt != null && options.chatgpt.length > 0) {
      args.push("--chatgpt", options.chatgpt)
    }
    if (options.gemini != null && options.gemini.length > 0) {
      args.push("--gemini", options.gemini)
    }

    // Use bunx to run the installer
    const exitCode = await execAdapter.exec("bunx", args)

    if (exitCode !== 0) {
      const errorMsg = `oMo installation returned exit code ${exitCode}`
      logger.warning(errorMsg)
      return {installed: false, version: null, error: errorMsg, bunVersion}
    }

    logger.info("oMo plugin installed successfully")
    return {installed: true, version: null, error: null, bunVersion}
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error("Failed to install oMo plugin", {error: errorMsg})
    return {installed: false, version: null, error: errorMsg, bunVersion}
  }
}
```

### 8. GitHub CLI Authentication (`src/lib/setup/gh-auth.ts`)

```typescript
import * as exec from "@actions/exec"
import * as core from "@actions/core"
import type {GhAuthResult, Logger} from "./types.js"

/**
 * Configure gh CLI with GitHub App token.
 *
 * Uses GH_TOKEN environment variable (preferred over GITHUB_TOKEN)
 * to avoid conflicts with the Actions-provided token.
 */
export async function configureGhAuth(
  appToken: string | null,
  defaultToken: string,
  logger: Logger,
): Promise<GhAuthResult> {
  const token = appToken ?? defaultToken
  const method = appToken != null ? "app-token" : "github-token"

  if (token.length === 0) {
    logger.warning("No GitHub token available for gh CLI")
    return {authenticated: false, method: "none", botLogin: null}
  }

  // Set GH_TOKEN environment variable for subsequent steps
  // GH_TOKEN takes priority over GITHUB_TOKEN for gh CLI
  core.exportVariable("GH_TOKEN", token)

  logger.info("Configured gh CLI authentication", {method})

  // Get bot login for anti-loop detection and commit attribution
  const botLogin = await getBotLogin(token, logger)

  return {authenticated: true, method, botLogin}
}

/**
 * Get the authenticated user/bot login.
 */
async function getBotLogin(token: string, logger: Logger): Promise<string | null> {
  try {
    let output = ""
    await exec.exec("gh", ["api", "/user", "--jq", ".login"], {
      env: {...process.env, GH_TOKEN: token},
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
      },
      silent: true,
    })

    const login = output.trim()
    logger.info("Authenticated as", {login})
    return login.length > 0 ? login : null
  } catch {
    logger.debug("Could not determine bot login")
    return null
  }
}

/**
 * Configure git identity for commits.
 *
 * Uses GitHub App bot identity format: <app-slug>[bot]
 */
export async function configureGitIdentity(
  appSlug: string | null,
  botUserId: string | null,
  logger: Logger,
): Promise<void> {
  const name = appSlug != null ? `${appSlug}[bot]` : "fro-bot[bot]"
  const email =
    botUserId != null && appSlug != null ? `${botUserId}+${appSlug}[bot]@users.noreply.github.com` : "agent@fro.bot"

  await exec.exec("git", ["config", "--global", "user.name", name])
  await exec.exec("git", ["config", "--global", "user.email", email])

  logger.info("Configured git identity", {name, email})
}

/**
 * Get GitHub App bot user ID for commit attribution.
 */
export async function getBotUserId(appSlug: string, token: string, logger: Logger): Promise<string | null> {
  try {
    let output = ""
    await exec.exec("gh", ["api", `/users/${appSlug}[bot]`, "--jq", ".id"], {
      env: {...process.env, GH_TOKEN: token},
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
      },
      silent: true,
    })

    const userId = output.trim()
    return userId.length > 0 ? userId : null
  } catch {
    logger.debug("Could not get bot user ID")
    return null
  }
}
```

### 9. auth.json Population (`src/lib/setup/auth-json.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type {AuthConfig, Logger} from "./types.js"
import {getXdgDataHome} from "../../utils/env.js"

/**
 * Populate auth.json with LLM provider credentials.
 *
 * This file is written fresh each run from secrets and NEVER cached.
 */
export async function populateAuthJson(authConfig: AuthConfig, logger: Logger): Promise<string> {
  const xdgDataHome = getXdgDataHome()
  const opencodeDir = path.join(xdgDataHome, "opencode")
  const authPath = path.join(opencodeDir, "auth.json")

  // Ensure directory exists
  await fs.mkdir(opencodeDir, {recursive: true})

  // Write auth.json
  const content = JSON.stringify(authConfig, null, 2)
  await fs.writeFile(authPath, content, {mode: 0o600}) // Restrict permissions

  logger.info("Populated auth.json", {path: authPath, providers: Object.keys(authConfig).length})
  return authPath
}

/**
 * Parse and validate auth-json input.
 */
export function parseAuthJsonInput(input: string): AuthConfig {
  try {
    const parsed = JSON.parse(input) as unknown
    if (typeof parsed !== "object" || parsed == null) {
      throw new Error("auth-json must be a JSON object")
    }
    return parsed as AuthConfig
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid auth-json format: ${error.message}`)
    }
    throw error
  }
}
```

### 10. Setup Entry Point (`src/setup.ts`)

```typescript
import * as core from "@actions/core"
import {createLogger} from "./lib/logger.js"
import {createAppClient} from "./lib/github/client.js"
import {installOpenCode, getLatestVersion} from "./lib/setup/opencode.js"
import {installOmo, verifyOmoInstallation} from "./lib/setup/omo.js"
import {configureGhAuth, configureGitIdentity, getBotUserId} from "./lib/setup/gh-auth.js"
import {populateAuthJson, parseAuthJsonInput} from "./lib/setup/auth-json.js"
import {restoreCache} from "./lib/cache.js"
import {getRunnerOS} from "./utils/env.js"
import type {SetupInputs, SetupResult} from "./lib/setup/types.js"

async function run(): Promise<void> {
  const startTime = Date.now()
  const logger = createLogger()

  try {
    // 1. Parse inputs
    const inputs = parseInputs()

    // 2. Install OpenCode (with fallback)
    const opencodeVersion =
      inputs.opencodeVersion === "latest" ? await getLatestVersion(logger) : inputs.opencodeVersion
    const opencode = await installOpenCode(opencodeVersion, logger)

    // 3. Install oMo plugin (non-fatal on failure)
    const omo = await installOmo(logger)
    if (!omo.installed) {
      core.warning(`oMo plugin installation failed: ${omo.error}. Agent may have limited functionality.`)
    }

    // 4. Restore cache (early, for session continuity)
    const cacheResult = await restoreCache({
      components: {
        agentIdentity: "github",
        repo: process.env["GITHUB_REPOSITORY"] ?? "unknown/unknown",
        ref: process.env["GITHUB_REF_NAME"] ?? "main",
        os: getRunnerOS(),
      },
      logger,
    })

    // 5. Populate auth.json
    const authConfig = parseAuthJsonInput(inputs.authJson)
    await populateAuthJson(authConfig, logger)

    // 6. Configure GitHub authentication
    // Use createAppClient from RFC-003 for GitHub App token generation
    // Falls back to GITHUB_TOKEN when App credentials not provided or auth fails
    let appToken: string | null = null
    if (inputs.appId != null && inputs.privateKey != null) {
      const appClient = await createAppClient({
        appId: inputs.appId,
        privateKey: inputs.privateKey,
        logger,
      })
      if (appClient != null) {
        // Extract token from authenticated client for gh CLI
        // Note: createAppClient returns Octokit, we need the raw token for GH_TOKEN
        appToken = await extractTokenFromAppClient(inputs.appId, inputs.privateKey, logger)
      } else {
        core.warning("GitHub App authentication failed, falling back to GITHUB_TOKEN")
      }
    }

    const ghAuth = await configureGhAuth(appToken, process.env["GITHUB_TOKEN"] ?? "", logger)

    // 7. Configure git identity
    if (ghAuth.botLogin != null) {
      const appSlug = ghAuth.botLogin.replace("[bot]", "")
      const userId = await getBotUserId(appSlug, process.env["GH_TOKEN"] ?? "", logger)
      await configureGitIdentity(appSlug, userId, logger)
    } else {
      // Fallback to generic bot identity when no App credentials
      await configureGitIdentity(null, null, logger)
    }

    // 8. Set outputs
    const duration = Math.round((Date.now() - startTime) / 1000)
    core.setOutput("opencode-path", opencode.path)
    core.setOutput("opencode-version", opencode.version)
    core.setOutput("gh-authenticated", String(ghAuth.authenticated))
    core.setOutput("setup-duration", String(duration))
    core.setOutput("cache-status", cacheResult.corrupted ? "corrupted" : cacheResult.hit ? "hit" : "miss")
    core.setOutput("omo-installed", String(omo.installed))

    logger.info("Setup complete", {
      duration,
      opencodeVersion: opencode.version,
      omoInstalled: omo.installed,
      ghAuthenticated: ghAuth.authenticated,
      ghAuthMethod: ghAuth.method,
      cacheHit: cacheResult.hit,
    })
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Setup failed: ${error.message}`)
    }
  }
}

function parseInputs(): SetupInputs {
  return {
    opencodeVersion: core.getInput("opencode-version") || "latest",
    authJson: core.getInput("auth-json", {required: true}),
    appId: core.getInput("app-id") || null,
    privateKey: core.getInput("private-key") || null,
    opencodeConfig: core.getInput("opencode-config") || null,
  }
}

/**
 * Extract raw installation token from GitHub App credentials.
 *
 * This is needed because createAppClient() returns an Octokit instance,
 * but we need the raw token for GH_TOKEN environment variable.
 *
 * Uses same auth mechanism as createAppClient() from RFC-003.
 */
async function extractTokenFromAppClient(appId: string, privateKey: string, logger: Logger): Promise<string | null> {
  try {
    const {createAppAuth} = await import("@octokit/auth-app")
    const auth = createAppAuth({appId, privateKey})
    const {token} = await auth({type: "installation"})
    logger.debug("Extracted GitHub App installation token")
    return token
  } catch (error) {
    logger.error("Failed to extract App token", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

await run()
```

### 11. Build Configuration Update

Update `tsdown.config.ts`:

```typescript
import {defineConfig} from "tsdown"

export default defineConfig({
  entry: {
    main: "src/main.ts",
    setup: "src/setup.ts",
  },
  format: "esm",
  target: "node24",
  clean: true,
  dts: false,
  noExternal: ["@actions/core", "@actions/cache", "@actions/exec", "@actions/tool-cache"],
  minify: true,
})
```

---

## Acceptance Criteria

### Core Installation

- [ ] Setup action installs OpenCode CLI with version caching
- [ ] OpenCode installation has fallback to pinned version (1.0.204) on failure
- [ ] Downloaded archives are validated before extraction (corruption check)
- [ ] Setup action installs Bun runtime via `@actions/tool-cache` (auto-installed for oMo)
- [ ] Setup action installs oMo plugin via `bunx oh-my-opencode install`
- [ ] Users do NOT need to manually install Bun (e.g., `oven-sh/setup-bun`)
- [ ] Setup continues if oMo install fails (with warning logged)
- [ ] oMo installation includes error details in result

### Authentication & Configuration

- [ ] Setup action configures gh CLI with GH_TOKEN
- [ ] Setup action populates auth.json from secrets (not cached)
- [ ] Setup action configures git identity for App bot
- [ ] Setup works without GitHub App credentials (fallback to GITHUB_TOKEN)

### Cache Integration

- [ ] Setup action restores session cache
- [ ] Cache key includes agent identity, repo, ref, os

### System Dependencies

- [ ] Setup action verifies required system dependencies for the chosen log strategy:
  - [ ] `tmux` available (or setup documents the requirement)
  - [ ] `stdbuf` available (or setup documents the requirement)
- [ ] stdbuf command documented with exact syntax for main action

### Outputs

- [ ] Setup action outputs all relevant paths and status
- [ ] All setup operations are logged with structured JSON

### Build Integration

- [ ] Build produces both `dist/main.js` and `dist/setup.js`
- [ ] `setup/action.yaml` references correct entrypoint

---

## Test Cases

### OpenCode Installation

```typescript
describe("installOpenCode", () => {
  it("checks cache before downloading", async () => {
    // Mock tc.find to return cached path
    const result = await installOpenCode("1.0.0", logger)
    expect(result.cached).toBe(true)
  })

  it("downloads and caches on miss", async () => {
    // Mock tc.find to return empty, tc.downloadTool to succeed
    const result = await installOpenCode("1.0.0", logger)
    expect(result.cached).toBe(false)
    expect(result.path).toBeDefined()
  })
})
```

### gh Authentication

```typescript
describe("configureGhAuth", () => {
  it("prefers app token over default token", async () => {
    const result = await configureGhAuth("app-token", "default-token", logger)
    expect(result.method).toBe("app-token")
  })

  it("falls back to github token", async () => {
    const result = await configureGhAuth(null, "default-token", logger)
    expect(result.method).toBe("github-token")
  })
})
```

### auth.json

```typescript
describe("parseAuthJsonInput", () => {
  it("parses valid JSON", () => {
    const input = '{"anthropic": {"type": "api", "key": "sk-..."} }'
    const result = parseAuthJsonInput(input)
    expect(result.anthropic.type).toBe("api")
  })

  it("throws on invalid JSON", () => {
    expect(() => parseAuthJsonInput("not json")).toThrow()
  })
})
```

---

## Security Considerations

1. **auth.json permissions**: Written with mode 0o600 (owner read/write only)
2. **GH_TOKEN priority**: Use GH_TOKEN over GITHUB_TOKEN to avoid conflicts
3. **Never cache auth.json**: Populated fresh each run from secrets
4. **Token masking**: GitHub Actions automatically masks secret values in logs

## System Dependencies (Runner Assumptions)

The Sisyphus reference workflow uses shell utilities to support a good UX in CI.

- `tmux`: used to run OpenCode / agent processes in a controllable background session.
- `stdbuf`: used to disable stdout/stderr buffering for real-time log streaming.

**v1 assumption:** GitHub-hosted `ubuntu-latest` runners.

- `tmux` is typically preinstalled.
- `stdbuf` is provided by GNU coreutils.

If alternate runners (macOS/Windows or self-hosted) are supported later, the setup action must either:

- verify these tools exist and document required packages, or
- switch to an alternative streaming strategy.

---

## Implementation Notes

1. **@actions/tool-cache**: Required for OpenCode binary caching across runs
2. **@actions/exec**: Required for running npx, gh, and git commands
3. **Parallel execution**: OpenCode install and cache restore can run in parallel
4. **Graceful degradation**: oMo install failure should warn, not fail the run
5. **Version fallback**: OpenCode installation tries latest, falls back to pinned version (1.0.204)
6. **Download validation**: Archives validated with `file` command on Linux before extraction
7. **App token via RFC-003**: Uses `createAppClient()` from `src/lib/github/client.ts` for GitHub App authentication
8. **GITHUB_TOKEN fallback**: When App credentials missing or auth fails, falls back to `GITHUB_TOKEN` for basic operations

---

## SDK vs CLI Decision

> **Updated (PRD v1.1, 2026-01-10):** The decision has been revised. SDK execution is now the PRIMARY model, replacing CLI.

RFC-011 originally chose **CLI invocation** (`opencode run`). As of PRD v1.1, the project uses **SDK execution** (`@opencode-ai/sdk`).

### Rationale (Updated)

| Factor                    | CLI                  | SDK                      | v1.1 Decision  |
| ------------------------- | -------------------- | ------------------------ | -------------- |
| Proven in production      | ✅ Sisyphus workflow | ✅ OpenCode Action       | SDK            |
| Implementation complexity | ✅ Simple spawn      | ⚠️ Server lifecycle mgmt | SDK (worth it) |
| Type safety               | ❌ Parse stdout      | ✅ Typed responses       | SDK            |
| Session management        | ❌ Manual            | ✅ `session.*` methods   | SDK            |
| File attachments          | ❌ Not supported     | ✅ `type: "file"` parts  | SDK            |
| Event streaming           | ⚠️ stdbuf workaround | ✅ Native SSE            | SDK            |
| Model/agent selection     | ⚠️ Env vars only     | ✅ Explicit API params   | SDK            |

**Original Decision (v1.0):** CLI for v1. SDK provides advantages for RFC-004 (Session Management) but adds complexity. Revisit for v2.

**Revised Decision (v1.1):** SDK is now PRIMARY. The additional complexity is justified by:

- File attachment support (P0 requirement)
- Explicit model/agent configuration (P0 requirement)
- Session event streaming for progress logging
- Alignment with OpenCode GitHub Action and oh-my-opencode patterns

**Note:** RFC-013 (SDK Execution Mode) will detail the implementation. The CLI may be reintroduced medium-term as a fro-bot-specific harness built on top of the SDK.

See `RFC-011-RESEARCH-SUMMARY.md` for original detailed analysis.

---

## Estimated Effort

- **Development**: 10-14 hours
- **Testing**: 4-6 hours
- **Total**: 14-20 hours

---

## Appendix: Reactions & Labels (Acknowledgment UX)

The main action (not setup) handles reactions and labels to provide visual feedback:

### Acknowledgment Flow

```typescript
// src/lib/reactions.ts
import * as exec from "@actions/exec"
import type {Logger} from "./types.js"

export interface ReactionContext {
  readonly repo: string
  readonly commentId: number
  readonly issueNumber: number
  readonly issuePr: "issue" | "pr"
  readonly botLogin: string
}

/**
 * Add eyes reaction to acknowledge receipt.
 */
export async function addEyesReaction(ctx: ReactionContext, logger: Logger): Promise<void> {
  try {
    await exec.exec("gh", [
      "api",
      "--method",
      "POST",
      `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
      "-f",
      "content=eyes",
    ])
    logger.info("Added eyes reaction", {commentId: ctx.commentId})
  } catch {
    logger.warning("Failed to add eyes reaction (non-fatal)")
  }
}

/**
 * Add "agent: working" label.
 */
export async function addWorkingLabel(ctx: ReactionContext, logger: Logger): Promise<void> {
  try {
    // Create label if not exists
    await exec.exec("gh", [
      "label",
      "create",
      "agent: working",
      "--color",
      "fcf2e1",
      "--description",
      "Agent is currently working on this",
      "--force",
    ])

    // Add to issue/PR
    const cmd = ctx.issuePr === "pr" ? "pr" : "issue"
    await exec.exec("gh", [cmd, "edit", String(ctx.issueNumber), "--add-label", "agent: working"])
    logger.info("Added working label", {number: ctx.issueNumber})
  } catch {
    logger.warning("Failed to add working label (non-fatal)")
  }
}

/**
 * Update reaction from eyes to thumbs up on completion.
 */
export async function updateReactionOnComplete(ctx: ReactionContext, logger: Logger): Promise<void> {
  try {
    // Find and remove eyes reaction
    const {stdout} = await exec.getExecOutput("gh", [
      "api",
      `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
      "--jq",
      `.[] | select(.content=="eyes" and .user.login=="${ctx.botLogin}") | .id`,
    ])
    const reactionId = stdout.trim()
    if (reactionId) {
      await exec.exec("gh", ["api", "--method", "DELETE", `/repos/${ctx.repo}/reactions/${reactionId}`])
    }

    // Add thumbs up
    await exec.exec("gh", [
      "api",
      "--method",
      "POST",
      `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
      "-f",
      "content=+1",
    ])
    logger.info("Updated reaction to thumbs up", {commentId: ctx.commentId})
  } catch {
    logger.warning("Failed to update reaction (non-fatal)")
  }
}

/**
 * Remove "agent: working" label on completion.
 */
export async function removeWorkingLabel(ctx: ReactionContext, logger: Logger): Promise<void> {
  try {
    const cmd = ctx.issuePr === "pr" ? "pr" : "issue"
    await exec.exec("gh", [cmd, "edit", String(ctx.issueNumber), "--remove-label", "agent: working"])
    logger.info("Removed working label", {number: ctx.issueNumber})
  } catch {
    logger.warning("Failed to remove working label (non-fatal)")
  }
}
```

### Context Collection

```typescript
// src/lib/context.ts
import * as exec from "@actions/exec"
import type {Logger} from "./types.js"

export interface GitHubContext {
  readonly eventName: string
  readonly repo: string
  readonly issueNumber: number
  readonly type: "issue" | "pr"
  readonly title: string
  readonly commentBody: string
  readonly commentAuthor: string
  readonly commentId: number
  readonly defaultBranch: string
}

/**
 * Collect GitHub context from event payload and API.
 */
export async function collectContext(logger: Logger): Promise<GitHubContext> {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "unknown"
  const repo = process.env["GITHUB_REPOSITORY"] ?? ""
  const issueNumber = parseInt(process.env["ISSUE_NUMBER"] ?? "0", 10)
  const commentBody = process.env["COMMENT_BODY"] ?? ""
  const commentAuthor = process.env["COMMENT_AUTHOR"] ?? ""
  const commentId = parseInt(process.env["COMMENT_ID"] ?? "0", 10)
  const defaultBranch = process.env["DEFAULT_BRANCH"] ?? "main"

  // Determine if issue or PR
  let type: "issue" | "pr" = "issue"
  let title = ""

  if (issueNumber > 0) {
    try {
      const {stdout} = await exec.getExecOutput("gh", [
        "api",
        `/repos/${repo}/issues/${issueNumber}`,
        "--jq",
        "{title: .title, has_pr: .pull_request != null}",
      ])
      const data = JSON.parse(stdout)
      title = data.title ?? ""
      type = data.has_pr ? "pr" : "issue"
    } catch {
      logger.warning("Failed to determine issue/PR type")
    }
  }

  logger.info("Collected context", {eventName, repo, issueNumber, type})

  return {
    eventName,
    repo,
    issueNumber,
    type,
    title,
    commentBody,
    commentAuthor,
    commentId,
    defaultBranch,
  }
}
```

### Integration in Main Action

The main action (`src/main.ts`) integrates these:

```typescript
// Simplified main action flow
async function run(): Promise<void> {
  const logger = createLogger()
  const ctx = await collectContext(logger)

  // Acknowledge immediately
  await addEyesReaction(ctx, logger)
  await addWorkingLabel(ctx, logger)

  try {
    // Run agent...
    await runAgent(ctx, logger)
  } finally {
    // Always cleanup
    await updateReactionOnComplete(ctx, logger)
    await removeWorkingLabel(ctx, logger)
  }
}
```
