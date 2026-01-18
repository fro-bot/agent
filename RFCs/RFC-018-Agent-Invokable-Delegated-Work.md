# RFC-018: Agent-Invokable Delegated Work Tools

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 3

---

## Summary

Expose RFC-010's delegated work library (`src/lib/delegated/`) as OpenCode custom tools the agent can invoke during execution. This enables the agent to create branches, commit files, and open PRs programmatically via the GitHub API instead of shelling out to `git` and `gh` CLI.

## Dependencies

- **Builds Upon:** RFC-010 (Delegated Work Library), RFC-011 (Setup Action), RFC-013 (SDK Execution)
- **Enables:** Complete autonomous agent workflow (investigate → implement → create PR)

## Features Addressed

| Feature ID | Feature Name                          | Priority |
| ---------- | ------------------------------------- | -------- |
| F77        | Agent Tool: create_branch             | P0       |
| F78        | Agent Tool: commit_files              | P0       |
| F79        | Agent Tool: create_pull_request       | P0       |
| F80        | Agent Tool: update_pull_request       | P0       |
| F81        | Delegated Work Plugin Distribution    | P0       |
| F82        | Delegated Work Tool Context Injection | P0       |

## Technical Specification

### 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GitHub Actions Runtime                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  main.ts                                                            │
│  ├── runSetup()                                                     │
│  │   └── installPlugin()  ─────────────────────────────────────┐    │
│  │       └── Copy dist/plugin/*.js → ~/.config/opencode/plugin/ │    │
│  │                                                              │    │
│  └── executeOpenCode()                                          │    │
│      └── SDK spawns OpenCode server                             │    │
│          └── Server loads plugins from ~/.config/opencode/plugin/    │
│              └── fro-bot-agent.js ◄─────────────────────────────┘    │
│                  ├── create_branch tool                              │
│                  ├── commit_files tool                               │
│                  ├── create_pull_request tool                        │
│                  └── update_pull_request tool                        │
│                                                                     │
│  Environment Variables (set by GitHub Actions):                     │
│  ├── GITHUB_TOKEN         → Octokit authentication                 │
│  ├── GITHUB_REPOSITORY    → owner/repo context                     │
│  └── GITHUB_ACTOR         → Author association validation          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2. File Structure

```
src/
├── plugin/
│   ├── fro-bot-agent.ts        # OpenCode plugin with tool definitions
│   └── index.ts                # Plugin exports
├── lib/
│   ├── delegated/              # Existing library (RFC-010)
│   ├── github/
│   │   └── client.ts           # Existing Octokit client factory (reused)
│   └── setup/
│       └── plugin.ts           # Plugin installation during setup
├── utils/
│   └── env.ts                  # Existing env helpers (reused)
dist/
└── plugin/
    └── fro-bot-agent.js        # Bundled plugin (committed)
```

### 3. Plugin Definition (`src/plugin/fro-bot-agent.ts`)

The plugin reuses existing action code since it will be bundled together:

```typescript
import type {Plugin} from "@opencode-ai/plugin"
import {tool} from "@opencode-ai/plugin"

// Reuse existing action code (bundled together)
import {createClient} from "../lib/github/client.js"
import {createLogger} from "../lib/logger.js"
import {getGitHubRepository} from "../utils/env.js"
import {createBranch} from "../lib/delegated/branch.js"
import {createCommit, validateFiles} from "../lib/delegated/commit.js"
import {createPullRequest, updatePullRequest, findPRForBranch} from "../lib/delegated/pull-request.js"

/**
 * Parse repository context from environment.
 * Returns null if GITHUB_REPOSITORY is not set.
 */
function parseRepoContext(): {owner: string; repo: string} | null {
  const repository = getGitHubRepository()
  if (repository === "unknown/unknown") {
    return null
  }

  const [owner, repo] = repository.split("/")
  if (owner == null || repo == null || owner.length === 0 || repo.length === 0) {
    return null
  }

  return {owner, repo}
}

/**
 * Validate that the current actor has write permission.
 */
async function validateAuthorization(
  client: ReturnType<typeof createClient>,
  context: {owner: string; repo: string},
  logger: ReturnType<typeof createLogger>,
): Promise<{authorized: boolean; reason?: string}> {
  const actor = process.env.GITHUB_ACTOR
  if (actor == null || actor.length === 0) {
    return {authorized: false, reason: "No GitHub actor in context"}
  }

  try {
    const {data} = await client.rest.repos.getCollaboratorPermissionLevel({
      owner: context.owner,
      repo: context.repo,
      username: actor,
    })

    const permission = data.permission
    const isAllowed = permission === "admin" || permission === "write"

    if (!isAllowed) {
      logger.warning("Delegated work denied: insufficient permissions", {actor, permission})
      return {
        authorized: false,
        reason: `User '${actor}' has '${permission}' permission, requires 'write' or 'admin'`,
      }
    }

    logger.debug("Delegated work authorized", {actor, permission})
    return {authorized: true}
  } catch (error) {
    logger.error("Authorization check failed", {actor, error})
    return {authorized: false, reason: "Failed to verify permissions"}
  }
}

export const FroBotAgentPlugin: Plugin = async ({project, directory}) => {
  // Create logger for plugin operations
  const logger = createLogger({level: "info", json: true})

  // Parse repository context from environment
  const repoContext = parseRepoContext()
  if (repoContext == null) {
    logger.warning("Repository context not available - delegated work tools disabled")
    return {}
  }

  // Get token from environment
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token == null || token.length === 0) {
    logger.warning("No GitHub token available - delegated work tools disabled")
    return {}
  }

  // Create Octokit client using existing factory
  const client = createClient({token, logger})

  return {
    tool: {
      create_branch: tool({
        description: "Create a feature branch from a base branch. Returns the branch name and SHA.",
        args: {
          branchName: tool.schema.string().describe("Name for the new branch (e.g., 'fix/issue-123')"),
          baseBranch: tool.schema.string().describe("Base branch to create from").default("main"),
        },
        async execute(args) {
          const authResult = await validateAuthorization(client, repoContext, logger)
          if (!authResult.authorized) {
            return {success: false, error: authResult.reason}
          }

          try {
            const result = await createBranch(
              client,
              {
                owner: repoContext.owner,
                repo: repoContext.repo,
                branchName: args.branchName,
                baseBranch: args.baseBranch,
              },
              logger,
            )

            return {
              success: true,
              data: {
                name: result.name,
                sha: result.sha,
                created: result.created,
                message: result.created
                  ? `Created branch '${result.name}' from '${args.baseBranch}'`
                  : `Branch '${result.name}' already exists`,
              },
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Failed to create branch",
            }
          }
        },
      }),

      commit_files: tool({
        description: "Create an atomic commit with multiple file changes. Uses the Git Data API for reliability.",
        args: {
          branch: tool.schema.string().describe("Branch to commit to"),
          message: tool.schema.string().describe("Commit message (conventional commit format preferred)"),
          files: tool.schema
            .array(
              tool.schema.object({
                path: tool.schema.string().describe("File path relative to repo root"),
                content: tool.schema.string().describe("File content"),
                encoding: tool.schema.enum(["utf-8", "base64"]).optional().describe("Content encoding"),
              }),
            )
            .describe("Array of file changes to commit"),
        },
        async execute(args) {
          const authResult = await validateAuthorization(client, repoContext, logger)
          if (!authResult.authorized) {
            return {success: false, error: authResult.reason}
          }

          // Validate each file (security checks happen in library)
          const validation = validateFiles(args.files)
          if (!validation.valid) {
            return {success: false, error: validation.errors.join('; ')}
          }

          try {
            const result = await createCommit(
              client,
              {
                owner: repoContext.owner,
                repo: repoContext.repo,
                branch: args.branch,
                message: args.message,
                files: args.files,
              },
              logger,
            )

            return {
              success: true,
              data: {
                sha: result.sha,
                url: result.url,
                message: result.message,
                filesChanged: args.files.length,
              },
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Failed to create commit",
            }
          }
        },
      }),

      create_pull_request: tool({
        description: "Open a pull request. Returns the PR number and URL.",
        args: {
          title: tool.schema.string().describe("PR title"),
          body: tool.schema.string().describe("PR description (markdown supported)"),
          head: tool.schema.string().describe("Source branch with changes"),
          base: tool.schema.string().describe("Target branch to merge into").default("main"),
          draft: tool.schema.boolean().optional().describe("Create as draft PR"),
        },
        async execute(args) {
          const authResult = await validateAuthorization(client, repoContext, logger)
          if (!authResult.authorized) {
            return {success: false, error: authResult.reason}
          }

          try {
            // Check if PR already exists for this branch
            const existing = await findPRForBranch(client, repoContext.owner, repoContext.repo, args.head, logger)

            if (existing != null) {
              return {
                success: true,
                data: {
                  number: existing.number,
                  url: existing.url,
                  title: existing.title,
                  state: existing.state,
                  message: `PR #${existing.number} already exists for branch '${args.head}'`,
                  existed: true,
                },
              }
            }

            const result = await createPullRequest(
              client,
              {
                owner: repoContext.owner,
                repo: repoContext.repo,
                title: args.title,
                body: args.body,
                head: args.head,
                base: args.base,
                draft: args.draft,
              },
              logger,
            )

            return {
              success: true,
              data: {
                number: result.number,
                url: result.url,
                title: result.title,
                state: result.state,
                message: `Created PR #${result.number}: ${result.title}`,
                existed: false,
              },
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Failed to create PR",
            }
          }
        },
      }),

      update_pull_request: tool({
        description: "Update an existing pull request's title or body.",
        args: {
          prNumber: tool.schema.number().describe("PR number to update"),
          title: tool.schema.string().optional().describe("New PR title"),
          body: tool.schema.string().optional().describe("New PR body"),
        },
        async execute(args) {
          const authResult = await validateAuthorization(client, repoContext, logger)
          if (!authResult.authorized) {
            return {success: false, error: authResult.reason}
          }

          if (args.title == null && args.body == null) {
            return {success: false, error: "Must provide at least one of: title, body"}
          }

          try {
            const result = await updatePullRequest(
              client,
              repoContext.owner,
              repoContext.repo,
              args.prNumber,
              {title: args.title, body: args.body},
              logger,
            )

            return {
              success: true,
              data: {
                number: result.number,
                url: result.url,
                title: result.title,
                state: result.state,
                message: `Updated PR #${result.number}`,
              },
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Failed to update PR",
            }
          }
        },
      }),
    },
  }
}

export default FroBotAgentPlugin
```

### 4. Plugin Installation (`src/lib/setup/plugin.ts`)

```typescript
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import type {Logger} from "../logger.js"

const PLUGIN_DIR = path.join(os.homedir(), ".config", "opencode", "plugin")
const PLUGIN_FILENAME = "fro-bot-agent.js"

/**
 * Install the agent plugin to global OpenCode config.
 */
export async function installAgentPlugin(distDir: string, logger: Logger): Promise<void> {
  const sourcePath = path.join(distDir, "plugin", PLUGIN_FILENAME)
  const targetPath = path.join(PLUGIN_DIR, PLUGIN_FILENAME)

  // Ensure plugin directory exists
  await fs.mkdir(PLUGIN_DIR, {recursive: true})

  // Check if source exists
  try {
    await fs.access(sourcePath)
  } catch {
    logger.warning("Agent plugin not found in dist", {sourcePath})
    return
  }

  // Copy plugin to global config
  await fs.copyFile(sourcePath, targetPath)
  logger.info("Installed agent plugin", {targetPath})
}
```

### 5. Build Configuration Update (`tsdown.config.ts`)

```typescript
// Add plugin entry point
export default defineConfig({
  entry: {
    main: "src/main.ts",
    post: "src/post.ts",
    "plugin/fro-bot-agent": "src/plugin/fro-bot-agent.ts",
  },
  // ... existing config
})
```

## Acceptance Criteria

- [ ] Plugin defined with all four tools (create_branch, commit_files, create_pull_request, update_pull_request)
- [ ] Plugin bundled to `dist/plugin/fro-bot-agent.js`
- [ ] Plugin installed to `~/.config/opencode/plugin/` during setup
- [ ] Tools reuse `createClient()` from `src/lib/github/client.ts`
- [ ] Tools reuse `getGitHubRepository()` from `src/utils/env.ts`
- [ ] Authorization validated at tool invocation (write/admin permission required)
- [ ] Tools return structured success/error responses
- [ ] Security validation from RFC-010 library is enforced (path traversal, secrets, size limits)
- [ ] No tokens or sensitive data in tool responses or logs
- [ ] Agent can complete full workflow: create branch → commit files → open PR

## Test Cases

### Plugin Loading Tests

```typescript
describe("FroBotAgentPlugin", () => {
  it("exports all four tools", async () => {
    const plugin = await FroBotAgentPlugin({project: mockProject, directory: "/tmp"})

    expect(plugin.tool).toBeDefined()
    expect(plugin.tool?.create_branch).toBeDefined()
    expect(plugin.tool?.commit_files).toBeDefined()
    expect(plugin.tool?.create_pull_request).toBeDefined()
    expect(plugin.tool?.update_pull_request).toBeDefined()
  })

  it("returns empty tools when context unavailable", async () => {
    delete process.env.GITHUB_REPOSITORY

    const plugin = await FroBotAgentPlugin({project: mockProject, directory: "/tmp"})

    expect(plugin.tool).toBeUndefined()
  })

  it("returns empty tools when token unavailable", async () => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN

    const plugin = await FroBotAgentPlugin({project: mockProject, directory: "/tmp"})

    expect(plugin.tool).toBeUndefined()
  })
})
```

### Authorization Tests

```typescript
describe("validateAuthorization", () => {
  it("allows users with write permission", async () => {
    mockClient.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: {permission: "write"},
    })

    const result = await validateAuthorization(mockClient, context, logger)

    expect(result.authorized).toBe(true)
  })

  it("denies users with read permission", async () => {
    mockClient.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: {permission: "read"},
    })

    const result = await validateAuthorization(mockClient, context, logger)

    expect(result.authorized).toBe(false)
    expect(result.reason).toContain("requires 'write' or 'admin'")
  })

  it("denies when actor not in context", async () => {
    delete process.env.GITHUB_ACTOR

    const result = await validateAuthorization(mockClient, context, logger)

    expect(result.authorized).toBe(false)
  })
})
```

### Tool Execution Tests

```typescript
describe("create_branch tool", () => {
  it("creates branch and returns result", async () => {
    const plugin = await FroBotAgentPlugin({project: mockProject, directory: "/tmp"})

    const result = await plugin.tool!.create_branch.execute({
      branchName: "fix/issue-123",
      baseBranch: "main",
    })

    expect(result.success).toBe(true)
    expect(result.data.name).toBe("fix/issue-123")
    expect(result.data.created).toBe(true)
  })

  it("returns error when unauthorized", async () => {
    mockClient.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: {permission: "read"},
    })

    const plugin = await FroBotAgentPlugin({project: mockProject, directory: "/tmp"})

    const result = await plugin.tool!.create_branch.execute({
      branchName: "fix/issue-123",
      baseBranch: "main",
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("requires 'write'")
  })
})

describe("commit_files tool", () => {
  it("validates files before committing", async () => {
    const plugin = await FroBotAgentPlugin({project: mockProject, directory: "/tmp"})

    const result = await plugin.tool!.commit_files.execute({
      branch: "fix/issue-123",
      message: "fix: resolve issue",
      files: [{path: "../../../etc/passwd", content: "malicious"}],
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("path traversal")
  })

  it("rejects secret files", async () => {
    const plugin = await FroBotAgentPlugin({project: mockProject, directory: "/tmp"})

    const result = await plugin.tool!.commit_files.execute({
      branch: "fix/issue-123",
      message: "add secrets",
      files: [{path: ".env", content: "SECRET=value"}],
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain("secret")
  })
})
```

### Plugin Installation Tests

```typescript
describe("installAgentPlugin", () => {
  it("copies plugin to global config", async () => {
    await installAgentPlugin("/action/dist", logger)

    expect(fs.copyFile).toHaveBeenCalledWith(
      "/action/dist/plugin/fro-bot-agent.js",
      expect.stringContaining(".config/opencode/plugin/fro-bot-agent.js"),
    )
  })

  it("creates plugin directory if needed", async () => {
    await installAgentPlugin("/action/dist", logger)

    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(".config/opencode/plugin"), {recursive: true})
  })
})
```

## Security Considerations

1. **Authorization at invocation**: Every tool call validates the actor has write/admin permission
2. **Repo scope locked**: Tools only operate on `GITHUB_REPOSITORY` - cannot be tricked into operating on other repos
3. **Token never exposed**: Token read from env, never included in responses or logs
4. **Library security inherited**: File validation (path traversal, .git/, secrets, 5MB) enforced by RFC-010 library
5. **Force push prevention**: `updateRef` uses `force: false` (from RFC-010)

## Implementation Notes

1. **Process boundary**: Plugin runs in OpenCode process, not action process - use env vars for context
2. **Self-contained bundle**: Plugin must include delegated library code (no runtime imports from action)
3. **Idempotent operations**: Tools handle existing branches/PRs gracefully
4. **Structured responses**: Always return `{success, data?, error?}` for agent parsing

## Estimated Effort

- **Plugin implementation**: 6-8 hours
- **Security module**: 2-3 hours
- **Build configuration**: 2 hours
- **Setup integration**: 2-3 hours
- **Testing**: 4-6 hours
- **Total**: 16-22 hours

---

## Related Documents

- [RFC-010: Delegated Work Library](./RFC-010-Delegated-Work.md) - Library implementation (completed)
- [OpenCode Plugins Documentation](https://opencode.ai/docs/plugins/) - Plugin API reference
- [PRD Section A.5](../PRD.md) - Delegated work requirements
