# RFC-012: Agent Execution & Main Action Lifecycle

**Status:** Pending
**Priority:** MUST
**Complexity:** High
**Phase:** 1

---

## Summary

Implement the core agent execution lifecycle in the main action: acknowledge receipt with reactions/labels, collect GitHub context, construct the agent prompt, launch OpenCode via CLI with real-time log streaming, handle completion/failure, and update reactions on finish. This RFC bridges RFC-011 (environment bootstrap) with Phase 2 RFCs (session management, event handling, etc.).

## Dependencies

- **Requires:** RFC-001 (Foundation), RFC-002 (Cache), RFC-003 (GitHub Client), RFC-011 (Setup Action)
- **Enables:** RFC-004 (Sessions), RFC-005 (Triggers), RFC-006 (Security), RFC-007 (Observability)
- **Consumes:** Setup action outputs (`opencode-path`, `gh-authenticated`, `cache-status`)

## Features Addressed

| Feature ID | Feature Name                      | Priority |
| ---------- | --------------------------------- | -------- |
| F41        | Agent Prompt Context Injection    | P0       |
| F42        | gh CLI Operation Instructions     | P0       |
| F43        | Reactions & Labels Acknowledgment | P0       |
| F44        | Issue vs PR Context Detection     | P0       |
| NEW        | OpenCode CLI Execution            | P0       |
| NEW        | Real-time Log Streaming           | P0       |
| NEW        | Agent Completion Handling         | P0       |

## Background: The Gap

RFC-011 defines the **setup action** that:

- Installs OpenCode CLI
- Installs oMo plugin
- Configures `gh` CLI authentication
- Populates `auth.json`
- Restores session cache
- Constructs the agent prompt

However, RFC-011 stops at environment preparation. The **main action** (`src/main.ts`) currently only:

- Restores/saves cache
- Has TODO placeholders for RFC-003 through RFC-006

**Missing:** The actual agent execution - launching OpenCode with the prompt, streaming logs, handling reactions/labels, and managing the execution lifecycle.

---

## Technical Specification

### 1. File Structure

```
src/
├── main.ts                    # Updated main entry point
├── lib/
│   ├── execution/
│   │   ├── types.ts           # Execution types
│   │   ├── opencode.ts        # OpenCode CLI execution
│   │   ├── context.ts         # GitHub context collection
│   │   ├── prompt.ts          # Prompt construction
│   │   ├── reactions.ts       # Reactions & labels
│   │   └── index.ts           # Public exports
```

### 2. Execution Types (`src/lib/execution/types.ts`)

```typescript
export interface ExecutionContext {
  readonly eventName: string
  readonly repo: string
  readonly ref: string
  readonly actor: string
  readonly runId: string
  readonly issueNumber: number | null
  readonly issueTitle: string | null
  readonly issueType: "issue" | "pr" | null
  readonly commentBody: string | null
  readonly commentAuthor: string | null
  readonly commentId: number | null
  readonly defaultBranch: string
}

export interface ExecutionResult {
  readonly success: boolean
  readonly exitCode: number
  readonly duration: number
  readonly sessionId: string | null
  readonly error: string | null
}

export interface ReactionContext {
  readonly repo: string
  readonly commentId: number | null
  readonly issueNumber: number | null
  readonly issueType: "issue" | "pr" | null
  readonly botLogin: string | null
}

export interface PromptOptions {
  readonly context: ExecutionContext
  readonly customPrompt: string | null
  readonly cacheStatus: "hit" | "miss" | "corrupted"
}

export type AcknowledgmentState = "pending" | "acknowledged" | "completed" | "failed"
```

### 3. GitHub Context Collection (`src/lib/execution/context.ts`)

```typescript
import * as exec from "@actions/exec"
import type {ExecutionContext, Logger} from "./types.js"

/**
 * Collect GitHub context from environment and event payload.
 *
 * Determines if the trigger is an issue or PR, extracts comment details,
 * and gathers all context needed for prompt construction.
 */
export async function collectExecutionContext(logger: Logger): Promise<ExecutionContext> {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "unknown"
  const repo = process.env["GITHUB_REPOSITORY"] ?? ""
  const ref = process.env["GITHUB_REF_NAME"] ?? "main"
  const actor = process.env["GITHUB_ACTOR"] ?? "unknown"
  const runId = process.env["GITHUB_RUN_ID"] ?? "0"

  // Event payload provides comment context
  const commentBody = process.env["COMMENT_BODY"] ?? null
  const commentAuthor = process.env["COMMENT_AUTHOR"] ?? null
  const commentId = parseIntOrNull(process.env["COMMENT_ID"])
  const issueNumber = parseIntOrNull(process.env["ISSUE_NUMBER"])

  // Determine issue vs PR and get title
  let issueType: "issue" | "pr" | null = null
  let issueTitle: string | null = null
  let defaultBranch = "main"

  if (issueNumber != null && repo.length > 0) {
    const typeInfo = await detectIssueType(repo, issueNumber, logger)
    issueType = typeInfo.type
    issueTitle = typeInfo.title
    defaultBranch = typeInfo.defaultBranch
  }

  logger.info("Collected execution context", {
    eventName,
    repo,
    issueNumber,
    issueType,
    hasComment: commentBody != null,
  })

  return {
    eventName,
    repo,
    ref,
    actor,
    runId,
    issueNumber,
    issueTitle,
    issueType,
    commentBody,
    commentAuthor,
    commentId,
    defaultBranch,
  }
}

interface IssueTypeInfo {
  type: "issue" | "pr"
  title: string | null
  defaultBranch: string
}

async function detectIssueType(repo: string, issueNumber: number, logger: Logger): Promise<IssueTypeInfo> {
  try {
    const {stdout} = await exec.getExecOutput(
      "gh",
      ["api", `/repos/${repo}/issues/${issueNumber}`, "--jq", "{title: .title, has_pr: (.pull_request != null)}"],
      {silent: true},
    )

    const data = JSON.parse(stdout) as {title: string | null; has_pr: boolean}

    // Also get default branch
    const {stdout: repoStdout} = await exec.getExecOutput("gh", ["api", `/repos/${repo}`, "--jq", ".default_branch"], {
      silent: true,
    })

    return {
      type: data.has_pr ? "pr" : "issue",
      title: data.title,
      defaultBranch: repoStdout.trim() || "main",
    }
  } catch (error) {
    logger.warning("Failed to detect issue/PR type", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {type: "issue", title: null, defaultBranch: "main"}
  }
}

function parseIntOrNull(value: string | undefined): number | null {
  if (value == null || value.length === 0) return null
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}
```

### 4. Prompt Construction (`src/lib/execution/prompt.ts`)

```typescript
import type {PromptOptions, Logger} from "./types.js"

/**
 * Build the complete agent prompt with GitHub context and instructions.
 *
 * The prompt includes:
 * - Environment context (repo, branch, event, actor)
 * - Issue/PR context when applicable
 * - Triggering comment when applicable
 * - Session management instructions
 * - gh CLI operation examples
 * - Run summary requirement
 * - Custom prompt if provided
 */
export function buildAgentPrompt(options: PromptOptions, logger: Logger): string {
  const {context, customPrompt, cacheStatus} = options
  const parts: string[] = []

  // System context header
  parts.push(`# Agent Context

You are the Fro Bot Agent running in GitHub Actions.

## Environment
- **Repository:** ${context.repo}
- **Branch/Ref:** ${context.ref}
- **Event:** ${context.eventName}
- **Actor:** ${context.actor}
- **Run ID:** ${context.runId}
- **Cache Status:** ${cacheStatus}
`)

  // Issue/PR context
  if (context.issueNumber != null) {
    const typeLabel = context.issueType === "pr" ? "Pull Request" : "Issue"
    parts.push(`## ${typeLabel} Context
- **Number:** #${context.issueNumber}
- **Title:** ${context.issueTitle ?? "N/A"}
- **Type:** ${context.issueType ?? "unknown"}
`)
  }

  // Triggering comment
  if (context.commentBody != null) {
    parts.push(`## Trigger Comment
**Author:** ${context.commentAuthor ?? "unknown"}

\`\`\`
${context.commentBody}
\`\`\`
`)
  }

  // Session management instructions (REQUIRED)
  parts.push(`## Session Management (REQUIRED)

Before investigating any issue:
1. Use \`session_search\` to find relevant prior sessions for this repository
2. Use \`session_read\` to review prior work if found
3. Avoid repeating investigation already completed in previous sessions

Before completing:
1. Ensure your session contains a summary of work done
2. Include key decisions, findings, and outcomes
3. This summary will be searchable in future agent runs
`)

  // GitHub CLI instructions
  parts.push(`## GitHub Operations (Use gh CLI)

The \`gh\` CLI is pre-authenticated. Use it for all GitHub operations:

### Commenting
\`\`\`bash
# Comment on issue
gh issue comment ${context.issueNumber ?? "<number>"} --body "Your message"

# Comment on PR
gh pr comment ${context.issueNumber ?? "<number>"} --body "Your message"
\`\`\`

### Creating PRs
\`\`\`bash
# Create a new PR
gh pr create --title "feat(scope): description" --body "Details..." --base ${context.defaultBranch} --head feature-branch
\`\`\`

### Pushing Commits
\`\`\`bash
# Commit and push changes
git add .
git commit -m "type(scope): description"
git push origin HEAD
\`\`\`

### API Calls
\`\`\`bash
# Query the GitHub API
gh api repos/${context.repo}/issues --jq '.[].title'
gh api repos/${context.repo}/pulls/${context.issueNumber ?? "<number>"}/files --jq '.[].filename'
\`\`\`
`)

  // Run summary requirement
  parts.push(`## Run Summary (REQUIRED)

Every comment you post MUST include a collapsed details block at the end:

\`\`\`markdown
<details>
<summary>Run Summary</summary>

| Field | Value |
|-------|-------|
| Event | ${context.eventName} |
| Repository | ${context.repo} |
| Run ID | ${context.runId} |
| Cache | ${cacheStatus} |
| Session | <your_session_id> |

</details>
\`\`\`
`)

  // Custom prompt if provided
  if (customPrompt != null && customPrompt.trim().length > 0) {
    parts.push(`## Custom Instructions

${customPrompt.trim()}
`)
  }

  // Task directive
  if (context.commentBody != null) {
    parts.push(`## Task

Respond to the trigger comment above. Follow all instructions and requirements listed in this prompt.
`)
  } else {
    parts.push(`## Task

Execute the requested operation for repository ${context.repo}. Follow all instructions and requirements listed in this prompt.
`)
  }

  const prompt = parts.join("\n")
  logger.debug("Built agent prompt", {length: prompt.length, hasCustom: customPrompt != null})
  return prompt
}
```

### 5. Reactions & Labels (`src/lib/execution/reactions.ts`)

```typescript
import * as exec from "@actions/exec"
import type {ReactionContext, AcknowledgmentState, Logger} from "./types.js"

const WORKING_LABEL = "agent: working"
const WORKING_LABEL_COLOR = "fcf2e1"
const WORKING_LABEL_DESCRIPTION = "Agent is currently working on this"

/**
 * Add eyes reaction to acknowledge receipt of the triggering comment.
 */
export async function addEyesReaction(ctx: ReactionContext, logger: Logger): Promise<boolean> {
  if (ctx.commentId == null) {
    logger.debug("No comment ID, skipping eyes reaction")
    return false
  }

  try {
    await exec.exec(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
        "-f",
        "content=eyes",
      ],
      {silent: true},
    )

    logger.info("Added eyes reaction", {commentId: ctx.commentId})
    return true
  } catch (error) {
    logger.warning("Failed to add eyes reaction (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Add "agent: working" label to the issue/PR.
 */
export async function addWorkingLabel(ctx: ReactionContext, logger: Logger): Promise<boolean> {
  if (ctx.issueNumber == null) {
    logger.debug("No issue number, skipping working label")
    return false
  }

  try {
    // Ensure label exists (--force updates if exists)
    await exec.exec(
      "gh",
      [
        "label",
        "create",
        WORKING_LABEL,
        "--color",
        WORKING_LABEL_COLOR,
        "--description",
        WORKING_LABEL_DESCRIPTION,
        "--force",
      ],
      {silent: true},
    )

    // Add label to issue/PR
    const cmd = ctx.issueType === "pr" ? "pr" : "issue"
    await exec.exec("gh", [cmd, "edit", String(ctx.issueNumber), "--add-label", WORKING_LABEL], {silent: true})

    logger.info("Added working label", {issueNumber: ctx.issueNumber})
    return true
  } catch (error) {
    logger.warning("Failed to add working label (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Acknowledge receipt by adding eyes reaction and working label.
 */
export async function acknowledgeReceipt(ctx: ReactionContext, logger: Logger): Promise<void> {
  // Run both in parallel - neither is dependent on the other
  await Promise.all([addEyesReaction(ctx, logger), addWorkingLabel(ctx, logger)])
}

/**
 * Select a random peace sign emoji variant for success reaction.
 * Matches oMo Sisyphus behavior of using peace sign with random skin tone.
 */
function getRandomPeaceReaction(): string {
  // GitHub API reaction options don't include peace sign directly
  // Available options: +1, -1, laugh, confused, heart, hooray, rocket, eyes
  // Use 'hooray' (🎉) as the closest celebratory alternative
  // Note: If peace sign becomes available, this should be updated
  return "hooray"
}

/**
 * Update reaction from eyes to success indicator on successful completion.
 * Uses hooray (🎉) as GitHub API doesn't support peace sign reactions.
 */
export async function updateReactionOnSuccess(ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) {
    logger.debug("Missing comment ID or bot login, skipping reaction update")
    return
  }

  try {
    // Find and remove eyes reaction
    const {stdout} = await exec.getExecOutput(
      "gh",
      [
        "api",
        `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
        "--jq",
        `.[] | select(.content=="eyes" and .user.login=="${ctx.botLogin}") | .id`,
      ],
      {silent: true},
    )

    const reactionId = stdout.trim()
    if (reactionId.length > 0) {
      await exec.exec("gh", ["api", "--method", "DELETE", `/repos/${ctx.repo}/reactions/${reactionId}`], {silent: true})
    }

    // Add success reaction (hooray/🎉 - closest to peace sign in available reactions)
    const successReaction = getRandomPeaceReaction()
    await exec.exec(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
        "-f",
        `content=${successReaction}`,
      ],
      {silent: true},
    )

    logger.info("Updated reaction to success indicator", {commentId: ctx.commentId, reaction: successReaction})
  } catch (error) {
    logger.warning("Failed to update reaction (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Update reaction to confused (😕) on failure.
 */
export async function updateReactionOnFailure(ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.commentId == null || ctx.botLogin == null) {
    logger.debug("Missing comment ID or bot login, skipping reaction update")
    return
  }

  try {
    // Find and remove eyes reaction
    const {stdout} = await exec.getExecOutput(
      "gh",
      [
        "api",
        `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
        "--jq",
        `.[] | select(.content=="eyes" and .user.login=="${ctx.botLogin}") | .id`,
      ],
      {silent: true},
    )

    const reactionId = stdout.trim()
    if (reactionId.length > 0) {
      await exec.exec("gh", ["api", "--method", "DELETE", `/repos/${ctx.repo}/reactions/${reactionId}`], {silent: true})
    }

    // Add confused reaction
    await exec.exec(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${ctx.repo}/issues/comments/${ctx.commentId}/reactions`,
        "-f",
        "content=confused",
      ],
      {silent: true},
    )

    logger.info("Updated reaction to confused", {commentId: ctx.commentId})
  } catch (error) {
    logger.warning("Failed to update failure reaction (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Remove "agent: working" label on completion (success or failure).
 */
export async function removeWorkingLabel(ctx: ReactionContext, logger: Logger): Promise<void> {
  if (ctx.issueNumber == null) {
    logger.debug("No issue number, skipping label removal")
    return
  }

  try {
    const cmd = ctx.issueType === "pr" ? "pr" : "issue"
    await exec.exec("gh", [cmd, "edit", String(ctx.issueNumber), "--remove-label", WORKING_LABEL], {silent: true})

    logger.info("Removed working label", {issueNumber: ctx.issueNumber})
  } catch (error) {
    logger.warning("Failed to remove working label (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Complete acknowledgment cycle based on success/failure.
 */
export async function completeAcknowledgment(ctx: ReactionContext, success: boolean, logger: Logger): Promise<void> {
  // Update reaction based on outcome
  if (success) {
    await updateReactionOnSuccess(ctx, logger)
  } else {
    await updateReactionOnFailure(ctx, logger)
  }

  // Always remove working label
  await removeWorkingLabel(ctx, logger)
}
```

### 6. OpenCode CLI Execution (`src/lib/execution/opencode.ts`)

```typescript
import * as exec from "@actions/exec"
import type {ExecutionResult, Logger} from "./types.js"

/**
 * Execute OpenCode CLI with the given prompt.
 *
 * On Linux, wraps execution with `stdbuf` for real-time log streaming.
 * This matches the oMo Sisyphus workflow pattern.
 *
 * @param prompt - The complete agent prompt
 * @param opencodePath - Path to OpenCode binary (from setup action)
 * @param logger - Logger instance
 * @returns Execution result with exit code and duration
 */
export async function executeOpenCode(
  prompt: string,
  opencodePath: string | null,
  logger: Logger,
): Promise<ExecutionResult> {
  const startTime = Date.now()

  // Determine OpenCode command - use PATH if not explicitly provided
  const opencodeCmd = opencodePath ?? "opencode"

  logger.info("Executing OpenCode agent", {
    promptLength: prompt.length,
    platform: process.platform,
    useStdbuf: process.platform === "linux",
  })

  try {
    let exitCode: number

    if (process.platform === "linux") {
      // Use stdbuf for real-time log streaming on Linux
      // -oL: line-buffered stdout
      // -eL: line-buffered stderr
      exitCode = await exec.exec("stdbuf", ["-oL", "-eL", opencodeCmd, "run", prompt])
    } else {
      // macOS/Windows: direct execution (buffered output)
      exitCode = await exec.exec(opencodeCmd, ["run", prompt])
    }

    const duration = Date.now() - startTime

    logger.info("OpenCode execution completed", {
      exitCode,
      durationMs: duration,
    })

    return {
      success: exitCode === 0,
      exitCode,
      duration,
      sessionId: null, // Will be populated by RFC-004 session integration
      error: null,
    }
  } catch (error) {
    const duration = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)

    logger.error("OpenCode execution failed", {
      error: errorMessage,
      durationMs: duration,
    })

    return {
      success: false,
      exitCode: 1,
      duration,
      sessionId: null,
      error: errorMessage,
    }
  }
}

/**
 * Verify OpenCode is available and working.
 *
 * Runs `opencode --version` to ensure the binary is accessible.
 */
export async function verifyOpenCodeAvailable(
  opencodePath: string | null,
  logger: Logger,
): Promise<{available: boolean; version: string | null}> {
  const opencodeCmd = opencodePath ?? "opencode"

  try {
    let version = ""
    await exec.exec(opencodeCmd, ["--version"], {
      listeners: {
        stdout: (data: Buffer) => {
          version += data.toString()
        },
      },
      silent: true,
    })

    const versionMatch = /(\d+\.\d+\.\d+)/.exec(version)
    const parsedVersion = versionMatch != null ? versionMatch[1] : null

    logger.debug("OpenCode version verified", {version: parsedVersion})
    return {available: true, version: parsedVersion}
  } catch {
    logger.warning("OpenCode not available")
    return {available: false, version: null}
  }
}
```

### 7. Updated Main Entry Point (`src/main.ts`)

```typescript
/**
 * Fro Bot Agent - Main Entry Point
 *
 * GitHub Action harness for OpenCode + oMo agents with persistent session state.
 * This is the entry point that orchestrates the agent workflow.
 */

import type {CacheKeyComponents} from "./lib/cache-key.js"
import type {CacheResult} from "./lib/types.js"
import type {ReactionContext} from "./lib/execution/types.js"
import * as core from "@actions/core"
import {restoreCache, saveCache} from "./lib/cache.js"
import {parseActionInputs} from "./lib/inputs.js"
import {createLogger} from "./lib/logger.js"
import {setActionOutputs} from "./lib/outputs.js"
import {collectExecutionContext} from "./lib/execution/context.js"
import {buildAgentPrompt} from "./lib/execution/prompt.js"
import {executeOpenCode, verifyOpenCodeAvailable} from "./lib/execution/opencode.js"
import {acknowledgeReceipt, completeAcknowledgment} from "./lib/execution/reactions.js"
import {
  getGitHubRefName,
  getGitHubRepository,
  getGitHubRunId,
  getOpenCodeAuthPath,
  getOpenCodeStoragePath,
  getRunnerOS,
} from "./utils/env.js"

/**
 * Main action entry point.
 * Orchestrates: acknowledge → collect context → execute agent → complete acknowledgment
 */
async function run(): Promise<void> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: "bootstrap"})

  // Track execution state for cleanup
  let reactionCtx: ReactionContext | null = null
  let executionSuccess = false

  try {
    bootstrapLogger.info("Starting Fro Bot Agent")

    // 1. Parse and validate action inputs
    const inputsResult = parseActionInputs()

    if (!inputsResult.success) {
      core.setFailed(`Invalid inputs: ${inputsResult.error.message}`)
      return
    }

    const inputs = inputsResult.data
    const logger = createLogger({phase: "main"})

    logger.info("Action inputs parsed", {
      sessionRetention: inputs.sessionRetention,
      s3Backup: inputs.s3Backup,
      hasGithubToken: inputs.githubToken.length > 0,
      hasPrompt: inputs.prompt != null,
    })

    // 2. Verify OpenCode is available (from setup action)
    const opencodePath = process.env["OPENCODE_PATH"] ?? null
    const opencodeCheck = await verifyOpenCodeAvailable(opencodePath, logger)

    if (!opencodeCheck.available) {
      core.setFailed("OpenCode is not available. Did you run the setup action first?")
      return
    }

    logger.info("OpenCode verified", {version: opencodeCheck.version})

    // 3. Collect GitHub context
    const contextLogger = createLogger({phase: "context"})
    const executionContext = await collectExecutionContext(contextLogger)

    // 4. Build reaction context for acknowledgment
    const botLogin = process.env["BOT_LOGIN"] ?? null
    reactionCtx = {
      repo: executionContext.repo,
      commentId: executionContext.commentId,
      issueNumber: executionContext.issueNumber,
      issueType: executionContext.issueType,
      botLogin,
    }

    // 5. Acknowledge receipt immediately (eyes reaction + working label)
    const ackLogger = createLogger({phase: "acknowledgment"})
    await acknowledgeReceipt(reactionCtx, ackLogger)

    // 6. Build cache key components and restore cache
    const cacheComponents: CacheKeyComponents = {
      agentIdentity: "github",
      repo: getGitHubRepository(),
      ref: getGitHubRefName(),
      os: getRunnerOS(),
    }

    const cacheLogger = createLogger({phase: "cache"})
    const cacheResult: CacheResult = await restoreCache({
      components: cacheComponents,
      logger: cacheLogger,
      storagePath: getOpenCodeStoragePath(),
      authPath: getOpenCodeAuthPath(),
    })

    const cacheStatus = cacheResult.corrupted ? "corrupted" : cacheResult.hit ? "hit" : "miss"
    logger.info("Cache restore completed", {cacheStatus, key: cacheResult.key})

    // 7. Build agent prompt
    const promptLogger = createLogger({phase: "prompt"})
    const prompt = buildAgentPrompt(
      {
        context: executionContext,
        customPrompt: inputs.prompt,
        cacheStatus,
      },
      promptLogger,
    )

    // 8. Execute OpenCode agent
    const execLogger = createLogger({phase: "execution"})
    const result = await executeOpenCode(prompt, opencodePath, execLogger)

    executionSuccess = result.success

    // 9. Calculate duration and set outputs
    const duration = Date.now() - startTime

    setActionOutputs({
      sessionId: result.sessionId,
      cacheStatus,
      duration,
    })

    if (!result.success) {
      core.setFailed(`Agent execution failed with exit code ${result.exitCode}`)
    } else {
      logger.info("Agent run completed successfully", {durationMs: duration})
    }
  } catch (error) {
    const duration = Date.now() - startTime

    setActionOutputs({
      sessionId: null,
      cacheStatus: "miss",
      duration,
    })

    if (error instanceof Error) {
      bootstrapLogger.error("Agent failed", {error: error.message})
      core.setFailed(error.message)
    } else {
      bootstrapLogger.error("Agent failed with unknown error")
      core.setFailed("An unknown error occurred")
    }
  } finally {
    // Always cleanup: update reactions and save cache
    try {
      // Complete acknowledgment (update reaction, remove label)
      if (reactionCtx != null) {
        const cleanupLogger = createLogger({phase: "cleanup"})
        await completeAcknowledgment(reactionCtx, executionSuccess, cleanupLogger)
      }

      // Save cache
      const cacheComponents: CacheKeyComponents = {
        agentIdentity: "github",
        repo: getGitHubRepository(),
        ref: getGitHubRefName(),
        os: getRunnerOS(),
      }

      const cacheLogger = createLogger({phase: "cache-save"})
      await saveCache({
        components: cacheComponents,
        runId: getGitHubRunId(),
        logger: cacheLogger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
      })
    } catch {
      // Cleanup failures should not mask the original error
    }
  }
}

await run()
```

### 8. Index Exports (`src/lib/execution/index.ts`)

```typescript
// Types
export type {ExecutionContext, ExecutionResult, ReactionContext, PromptOptions, AcknowledgmentState} from "./types.js"

// Context collection
export {collectExecutionContext} from "./context.js"

// Prompt construction
export {buildAgentPrompt} from "./prompt.js"

// OpenCode execution
export {executeOpenCode, verifyOpenCodeAvailable} from "./opencode.js"

// Reactions & labels
export {
  addEyesReaction,
  addWorkingLabel,
  acknowledgeReceipt,
  updateReactionOnSuccess,
  updateReactionOnFailure,
  removeWorkingLabel,
  completeAcknowledgment,
} from "./reactions.js"
```

---

## Acceptance Criteria

### Context Collection

- [ ] Action collects event name, repo, ref, actor, run ID from environment
- [ ] Action extracts comment body, author, and ID when triggered by comment
- [ ] Action detects whether trigger is issue or PR using GitHub API
- [ ] Action retrieves issue/PR title from API
- [ ] Action gets repository default branch for PR base instructions

### Prompt Construction

- [ ] Prompt includes all environment context (repo, branch, event, actor, run ID)
- [ ] Prompt includes issue/PR number and title when applicable
- [ ] Prompt includes triggering comment body when applicable
- [ ] Prompt includes session management instructions (session_search, session_read)
- [ ] Prompt includes gh CLI examples for common operations
- [ ] Prompt includes run summary requirement with template
- [ ] Prompt includes custom user prompt when provided
- [ ] Prompt includes cache status

### Acknowledgment (Reactions & Labels)

- [ ] Eyes reaction added to triggering comment immediately on receipt
- [ ] "agent: working" label added to issue/PR on receipt
- [ ] Label created with correct color and description if it doesn't exist
- [ ] Eyes reaction replaced with hooray (🎉) on successful completion (closest available to peace sign)
- [ ] Eyes reaction replaced with confused on failure
- [ ] "agent: working" label removed on completion (success or failure)
- [ ] All reaction/label operations are non-fatal (failures logged as warnings)

### OpenCode Execution

- [ ] OpenCode CLI executed with constructed prompt
- [ ] `stdbuf -oL -eL` wrapper used on Linux for real-time log streaming
- [ ] Direct execution on macOS/Windows (best-effort streaming)
- [ ] Exit code captured and used to determine success/failure
- [ ] Execution duration tracked

### Main Action Lifecycle

- [ ] Action verifies OpenCode available before proceeding
- [ ] Action acknowledges receipt before any long-running operations
- [ ] Action restores cache before agent execution
- [ ] Action executes agent with constructed prompt
- [ ] Action completes acknowledgment in finally block (always runs)
- [ ] Action saves cache in finally block (always runs)
- [ ] Action sets all outputs even on failure

### Error Handling

- [ ] OpenCode unavailable produces clear error message
- [ ] Execution failures reported via `core.setFailed()`
- [ ] Cleanup runs even when main execution fails
- [ ] Cleanup failures don't mask original errors

---

## Test Cases

### Context Collection

```typescript
describe("collectExecutionContext", () => {
  it("extracts all environment variables", async () => {
    process.env["GITHUB_EVENT_NAME"] = "issue_comment"
    process.env["GITHUB_REPOSITORY"] = "owner/repo"
    process.env["COMMENT_BODY"] = "Hello agent"

    const ctx = await collectExecutionContext(mockLogger)

    expect(ctx.eventName).toBe("issue_comment")
    expect(ctx.repo).toBe("owner/repo")
    expect(ctx.commentBody).toBe("Hello agent")
  })

  it("handles missing optional values gracefully", async () => {
    delete process.env["COMMENT_BODY"]
    delete process.env["ISSUE_NUMBER"]

    const ctx = await collectExecutionContext(mockLogger)

    expect(ctx.commentBody).toBeNull()
    expect(ctx.issueNumber).toBeNull()
  })
})
```

### Prompt Construction

```typescript
describe("buildAgentPrompt", () => {
  it("includes all context sections", () => {
    const prompt = buildAgentPrompt(
      {
        context: mockContext,
        customPrompt: null,
        cacheStatus: "hit",
      },
      mockLogger,
    )

    expect(prompt).toContain("Repository:")
    expect(prompt).toContain("Session Management")
    expect(prompt).toContain("gh CLI")
    expect(prompt).toContain("Run Summary")
  })

  it("includes custom prompt when provided", () => {
    const prompt = buildAgentPrompt(
      {
        context: mockContext,
        customPrompt: "Focus on security",
        cacheStatus: "miss",
      },
      mockLogger,
    )

    expect(prompt).toContain("Custom Instructions")
    expect(prompt).toContain("Focus on security")
  })
})
```

### Reactions

```typescript
describe("acknowledgeReceipt", () => {
  it("adds eyes reaction and working label in parallel", async () => {
    const ghExecCalls: string[][] = []
    // Mock exec.exec to capture calls

    await acknowledgeReceipt(mockReactionCtx, mockLogger)

    expect(ghExecCalls).toContainEqual(expect.arrayContaining(["eyes"]))
    expect(ghExecCalls).toContainEqual(expect.arrayContaining(["agent: working"]))
  })

  it("handles API failures gracefully", async () => {
    // Mock exec.exec to throw
    await expect(acknowledgeReceipt(mockReactionCtx, mockLogger)).resolves.not.toThrow()
  })
})
```

### OpenCode Execution

```typescript
describe("executeOpenCode", () => {
  it("uses stdbuf on Linux", async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", {value: "linux"})

    await executeOpenCode("test prompt", null, mockLogger)

    expect(execCalls[0]).toContain("stdbuf")

    Object.defineProperty(process, "platform", {value: originalPlatform})
  })

  it("executes directly on non-Linux", async () => {
    Object.defineProperty(process, "platform", {value: "darwin"})

    await executeOpenCode("test prompt", null, mockLogger)

    expect(execCalls[0]).not.toContain("stdbuf")
  })
})
```

---

## Security Considerations

1. **Prompt injection**: Custom prompts are included verbatim but sandboxed within the agent's system prompt
2. **Token exposure**: GH_TOKEN is set by setup action, not logged by this action
3. **Reaction API calls**: Use `silent: true` to avoid leaking repo/comment IDs
4. **Bot identity**: Bot login used for reaction cleanup must match authenticated user

---

## Platform Considerations

| Platform              | stdbuf Available    | Log Streaming             |
| --------------------- | ------------------- | ------------------------- |
| Linux (ubuntu-latest) | Yes (GNU coreutils) | Real-time (line-buffered) |
| macOS                 | No (BSD coreutils)  | Buffered (block)          |
| Windows               | No                  | Buffered (block)          |

Real-time streaming is a UX improvement, not a functional requirement. The action works correctly on all platforms.

---

## Integration with Other RFCs

| RFC     | Integration Point                                  |
| ------- | -------------------------------------------------- |
| RFC-001 | Uses logger, types                                 |
| RFC-002 | Restores/saves cache                               |
| RFC-003 | Uses GitHub client for API calls (if needed)       |
| RFC-004 | Session ID from agent run (future integration)     |
| RFC-005 | Event classification determines context collection |
| RFC-006 | Permission check before execution (future)         |
| RFC-007 | Metrics from execution result                      |
| RFC-011 | Consumes setup outputs (opencode-path, bot-login)  |

---

## Environment Variables Consumed

| Variable          | Source       | Purpose                         |
| ----------------- | ------------ | ------------------------------- |
| GITHUB_EVENT_NAME | GitHub       | Event type identification       |
| GITHUB_REPOSITORY | GitHub       | Repository context              |
| GITHUB_REF_NAME   | GitHub       | Branch/ref context              |
| GITHUB_ACTOR      | GitHub       | Triggering user                 |
| GITHUB_RUN_ID     | GitHub       | Run identification              |
| COMMENT_BODY      | Workflow     | Triggering comment content      |
| COMMENT_AUTHOR    | Workflow     | Comment author username         |
| COMMENT_ID        | Workflow     | Comment ID for reactions        |
| ISSUE_NUMBER      | Workflow     | Issue/PR number                 |
| DEFAULT_BRANCH    | Workflow     | Repository default branch       |
| OPENCODE_PATH     | Setup Action | Path to OpenCode binary         |
| BOT_LOGIN         | Setup Action | Authenticated bot username      |
| GH_TOKEN          | Setup Action | GitHub CLI authentication token |

---

## Estimated Effort

- **Development**: 12-16 hours
- **Testing**: 4-6 hours
- **Total**: 16-22 hours

---

## Implementation Notes

1. **Setup action prerequisite**: Main action assumes setup action has run (OpenCode installed, gh authenticated)
2. **Parallel operations**: Acknowledge and cache restore could run in parallel for faster startup
3. **Non-blocking reactions**: All reaction operations are fire-and-forget with warning on failure
4. **Session integration placeholder**: ExecutionResult.sessionId is null until RFC-004 integration
5. **Prompt size**: Monitor prompt length - very long custom prompts could exceed model context
