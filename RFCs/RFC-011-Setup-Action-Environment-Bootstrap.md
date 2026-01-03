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
2. **Install oMo plugin** - Runs `npx oh-my-opencode install` to add Sisyphus agent capabilities
3. **Copy configuration** - Places `opencode.json` config in the correct location
4. **Configure git identity** - Sets up git user for commits
5. **Configure gh CLI** - Authenticates `gh` with GitHub App token for elevated operations
6. **Populate auth.json** - Writes LLM provider credentials from secrets
7. **Build prompt** - Constructs the agent prompt with GitHub context
8. **Launch OpenCode** - Executes OpenCode with the prompt

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
│   │   ├── omo.ts        # oMo plugin installation
│   │   ├── gh-auth.ts    # GitHub CLI authentication
│   │   ├── auth-json.ts  # auth.json population
│   │   ├── prompt.ts     # Prompt construction
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
  readonly duration: number
}

export interface OpenCodeInstallResult {
  readonly path: string
  readonly version: string
  readonly cached: boolean
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
import * as os from "node:os"
import * as path from "node:path"
import type {OpenCodeInstallResult, Logger} from "./types.js"

const TOOL_NAME = "opencode"
const DOWNLOAD_BASE_URL = "https://github.com/opencode-ai/opencode/releases/download"

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

export async function installOpenCode(version: string, logger: Logger): Promise<OpenCodeInstallResult> {
  const platformInfo = getPlatformInfo()

  // Check cache first
  let toolPath = tc.find(TOOL_NAME, version, platformInfo.arch)
  if (toolPath.length > 0) {
    logger.info("OpenCode found in cache", {version, path: toolPath})
    core.addPath(toolPath)
    return {path: toolPath, version, cached: true}
  }

  // Download
  logger.info("Downloading OpenCode", {version})
  const downloadUrl = buildDownloadUrl(version, platformInfo)
  const downloadPath = await tc.downloadTool(downloadUrl)

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
  toolPath = await tc.cacheDir(extractedPath, TOOL_NAME, version, platformInfo.arch)

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

### 5. oMo Plugin Installation (`src/lib/setup/omo.ts`)

```typescript
import * as exec from "@actions/exec"
import type {Logger} from "./types.js"

export interface OmoInstallResult {
  readonly installed: boolean
  readonly version: string | null
}

/**
 * Install Oh My OpenCode (oMo) plugin.
 *
 * This adds Sisyphus agent capabilities to OpenCode.
 */
export async function installOmo(logger: Logger): Promise<OmoInstallResult> {
  logger.info("Installing Oh My OpenCode plugin")

  try {
    // Use npx to run the installer
    let output = ""
    const exitCode = await exec.exec("npx", ["oh-my-opencode", "install"], {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        },
        stderr: (data: Buffer) => {
          output += data.toString()
        },
      },
      silent: true,
    })

    if (exitCode !== 0) {
      logger.warning("oMo installation returned non-zero exit code", {exitCode})
      return {installed: false, version: null}
    }

    // Extract version from output if available
    const versionMatch = /oh-my-opencode@(\d+\.\d+\.\d+)/i.exec(output)
    const version = versionMatch != null ? versionMatch[1] : null

    logger.info("oMo plugin installed", {version})
    return {installed: true, version}
  } catch (error) {
    logger.error("Failed to install oMo plugin", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {installed: false, version: null}
  }
}
```

### 6. GitHub CLI Authentication (`src/lib/setup/gh-auth.ts`)

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

### 7. auth.json Population (`src/lib/setup/auth-json.ts`)

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

### 8. Prompt Construction (`src/lib/setup/prompt.ts`)

```typescript
import type {Logger} from "./types.js"

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
 * Build the agent prompt with GitHub context.
 *
 * The prompt instructs the agent to:
 * 1. Use session tools to search prior work
 * 2. Use gh CLI for GitHub operations
 * 3. Include run summary in comments
 */
export function buildAgentPrompt(context: PromptContext, customPrompt: string | null, logger: Logger): string {
  const parts: string[] = []

  // System context
  parts.push(`# Agent Context

You are the Fro Bot Agent running in GitHub Actions.

## Environment
- **Repository:** ${context.repo}
- **Branch/Ref:** ${context.ref}
- **Event:** ${context.eventName}
- **Actor:** ${context.actor}
`)

  // Event-specific context
  if (context.issueNumber != null) {
    parts.push(`## Issue/PR Context
- **Number:** #${context.issueNumber}
- **Title:** ${context.issueTitle ?? "N/A"}
`)
  }

  if (context.commentBody != null) {
    parts.push(`## Trigger Comment
\`\`\`
${context.commentBody}
\`\`\`
`)
  }

  // Session instructions
  parts.push(`## Session Management (REQUIRED)

Before investigating any issue:
1. Use \`session_search\` to find relevant prior sessions
2. Use \`session_read\` to review prior work if found
3. Avoid repeating investigation already done

Before completing:
1. Ensure session contains a summary of work done
2. This summary will be searchable in future runs
`)

  // GitHub CLI instructions
  parts.push(`## GitHub Operations (Use gh CLI)

For all GitHub operations, use the \`gh\` CLI which is pre-authenticated:

### Commenting
\`\`\`bash
gh issue comment <number> --body "message"
gh pr comment <number> --body "message"
\`\`\`

### Creating PRs
\`\`\`bash
gh pr create --title "title" --body "description" --base main --head feature-branch
\`\`\`

### Pushing Commits
\`\`\`bash
git add .
git commit -m "type(scope): description"
git push origin HEAD
\`\`\`

### API Calls
\`\`\`bash
gh api repos/{owner}/{repo}/issues --jq '.[].title'
\`\`\`
`)

  // Run summary requirement
  parts.push(`## Run Summary (REQUIRED)

Every comment you post MUST include a collapsed details block:

\`\`\`markdown
<details>
<summary>Run Summary</summary>

| Field | Value |
|-------|-------|
| Event | ${context.eventName} |
| Repo | ${context.repo} |
| Session | <session_id> |
| Cache | hit/miss |

</details>
\`\`\`
`)

  // Custom prompt if provided
  if (customPrompt != null && customPrompt.length > 0) {
    parts.push(`## Custom Instructions

${customPrompt}
`)
  }

  // Task
  if (context.commentBody != null) {
    parts.push(`## Task

Respond to the trigger comment above. Follow all instructions and requirements.
`)
  }

  const prompt = parts.join("\n")
  logger.debug("Built agent prompt", {length: prompt.length})
  return prompt
}

/**
 * Extract prompt context from GitHub Actions environment.
 */
export function extractPromptContext(): PromptContext {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "unknown"
  const repo = process.env["GITHUB_REPOSITORY"] ?? "unknown/unknown"
  const ref = process.env["GITHUB_REF_NAME"] ?? "main"
  const actor = process.env["GITHUB_ACTOR"] ?? "unknown"

  // These would be extracted from the event payload in the actual implementation
  return {
    eventName,
    repo,
    ref,
    actor,
    issueNumber: null,
    issueTitle: null,
    commentBody: null,
    prNumber: null,
  }
}
```

### 9. Setup Entry Point (`src/setup.ts`)

```typescript
import * as core from "@actions/core"
import {createLogger} from "./lib/logger.js"
import {installOpenCode, getLatestVersion} from "./lib/setup/opencode.js"
import {installOmo} from "./lib/setup/omo.js"
import {configureGhAuth, configureGitIdentity, getBotUserId} from "./lib/setup/gh-auth.js"
import {populateAuthJson, parseAuthJsonInput} from "./lib/setup/auth-json.js"
import {restoreCache} from "./lib/cache.js"
import {getRunnerOS} from "./utils/env.js"
import type {SetupInputs} from "./lib/setup/types.js"

async function run(): Promise<void> {
  const startTime = Date.now()
  const logger = createLogger()

  try {
    // 1. Parse inputs
    const inputs = parseInputs()

    // 2. Install OpenCode
    const opencodeVersion =
      inputs.opencodeVersion === "latest" ? await getLatestVersion(logger) : inputs.opencodeVersion
    const opencode = await installOpenCode(opencodeVersion, logger)

    // 3. Install oMo plugin
    const omo = await installOmo(logger)

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

    // 6. Configure GitHub App authentication
    let ghAuth = await configureGhAuth(
      inputs.appId != null && inputs.privateKey != null
        ? await generateAppToken(inputs.appId, inputs.privateKey)
        : null,
      process.env["GITHUB_TOKEN"] ?? "",
      logger,
    )

    // 7. Configure git identity
    if (ghAuth.botLogin != null) {
      const userId = await getBotUserId(ghAuth.botLogin.replace("[bot]", ""), process.env["GH_TOKEN"] ?? "", logger)
      await configureGitIdentity(ghAuth.botLogin.replace("[bot]", ""), userId, logger)
    }

    // 8. Set outputs
    const duration = Math.round((Date.now() - startTime) / 1000)
    core.setOutput("opencode-path", opencode.path)
    core.setOutput("opencode-version", opencode.version)
    core.setOutput("gh-authenticated", String(ghAuth.authenticated))
    core.setOutput("setup-duration", String(duration))
    core.setOutput("cache-status", cacheResult.corrupted ? "corrupted" : cacheResult.hit ? "hit" : "miss")

    logger.info("Setup complete", {
      duration,
      opencodeVersion: opencode.version,
      omoInstalled: omo.installed,
      ghAuthenticated: ghAuth.authenticated,
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

async function generateAppToken(appId: string, privateKey: string): Promise<string> {
  // This would use @octokit/auth-app or actions/create-github-app-token
  // For now, return null to fall back to GITHUB_TOKEN
  // Implementation details in RFC-006 (Security & Permission Gating)
  return ""
}

await run()
```

### 10. Build Configuration Update

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

- [ ] Setup action installs OpenCode CLI with version caching
- [ ] Setup action installs oMo plugin via npx
- [ ] Setup action configures gh CLI with GH_TOKEN
- [ ] Setup action populates auth.json from secrets (not cached)
- [ ] Setup action configures git identity for App bot
- [ ] Setup action restores session cache
- [ ] Setup action verifies required system dependencies for the chosen log strategy:
  - [ ] `tmux` available (or setup documents the requirement)
  - [ ] `stdbuf` available (or setup documents the requirement)
- [ ] Setup action outputs all relevant paths and status
- [ ] Build produces both `dist/main.js` and `dist/setup.js`
- [ ] `setup/action.yaml` references correct entrypoint
- [ ] All setup operations are logged with structured JSON
- [ ] Agent prompt includes repository name
- [ ] Agent prompt includes branch/ref
- [ ] Agent prompt includes event type
- [ ] Agent prompt includes actor (triggering user)
- [ ] Agent prompt includes issue/PR number and title (when applicable)
- [ ] Agent prompt includes triggering comment body (when applicable)
- [ ] Agent prompt includes session tool instructions (session_search, session_read)
- [ ] Agent prompt includes gh CLI examples (comment, PR create, API calls)
- [ ] Agent prompt includes run summary requirement with template

## Real-time Log Streaming Requirement

To match the oMo/Sisyphus UX expectations, OpenCode execution logs should be visible in near real-time in the Actions log stream.

- Preferred approach (Linux): run the OpenCode entrypoint with `stdbuf -oL -eL` so output is line-buffered.
- If `tmux` is used to manage process lifetime, the implementation must still ensure logs are streamed (not only flushed at the end).

If real-time streaming cannot be guaranteed on a given runner, the limitation must be documented and the action should fall back to best-effort logging.

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
