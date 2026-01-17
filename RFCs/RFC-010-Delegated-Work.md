# RFC-010: Delegated Work - Push Commits & Open PRs

**Status:** Completed **Priority:** MUST **Complexity:** High **Phase:** 3

---

## Summary

Implement delegated work capabilities: pushing commits to branches and opening pull requests. This enables the agent to make actual code changes when requested by authorized users.

## Dependencies

- **Builds Upon:** RFC-003 (GitHub Client), RFC-006 (Security), RFC-008 (Comments)
- **Enables:** Complete GitHub agent functionality

## Features Addressed

| Feature ID | Feature Name                  | Priority |
| ---------- | ----------------------------- | -------- |
| F6         | Delegated Work - Push Commits | P0       |
| F7         | Delegated Work - Open PRs     | P0       |

## Technical Specification

### 1. File Structure

```
src/lib/
├── delegated/
│   ├── types.ts          # Delegated work types
│   ├── branch.ts         # Branch operations
│   ├── commit.ts         # Commit operations
│   ├── pull-request.ts   # PR operations
│   └── index.ts          # Public exports
```

### 2. Delegated Work Types (`src/lib/delegated/types.ts`)

```typescript
export interface FileChange {
  readonly path: string
  readonly content: string
  readonly encoding?: "utf-8" | "base64"
}

export interface CommitOptions {
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly message: string
  readonly files: readonly FileChange[]
  readonly author?: {
    readonly name: string
    readonly email: string
  }
}

export interface CommitResult {
  readonly sha: string
  readonly url: string
  readonly message: string
}

export interface CreateBranchOptions {
  readonly owner: string
  readonly repo: string
  readonly branchName: string
  readonly baseBranch: string
}

export interface BranchResult {
  readonly name: string
  readonly sha: string
  readonly created: boolean
}

export interface CreatePROptions {
  readonly owner: string
  readonly repo: string
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
  readonly draft?: boolean
}

export interface PRResult {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly state: string
}

export interface DelegatedWorkSummary {
  readonly branch: BranchResult | null
  readonly commits: readonly CommitResult[]
  readonly pr: PRResult | null
}
```

### 3. Branch Operations (`src/lib/delegated/branch.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {CreateBranchOptions, BranchResult, Logger} from "./types.js"

/**
 * Create a new branch from a base branch.
 */
export async function createBranch(
  octokit: Octokit,
  options: CreateBranchOptions,
  logger: Logger,
): Promise<BranchResult> {
  const {owner, repo, branchName, baseBranch} = options

  logger.info("Creating branch", {branchName, baseBranch})

  // Get the SHA of the base branch
  const {data: baseRef} = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  })

  const baseSha = baseRef.object.sha

  try {
    // Try to create the branch
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    })

    logger.info("Branch created", {branchName, sha: baseSha})

    return {
      name: branchName,
      sha: baseSha,
      created: true,
    }
  } catch (error) {
    // Branch might already exist
    if (error instanceof Error && error.message.includes("Reference already exists")) {
      logger.info("Branch already exists", {branchName})

      const {data: existingRef} = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branchName}`,
      })

      return {
        name: branchName,
        sha: existingRef.object.sha,
        created: false,
      }
    }

    throw error
  }
}

/**
 * Check if a branch exists.
 */
export async function branchExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  logger: Logger,
): Promise<boolean> {
  try {
    await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branchName}`,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Delete a branch.
 */
export async function deleteBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  logger: Logger,
): Promise<void> {
  logger.info("Deleting branch", {branchName})

  await octokit.rest.git.deleteRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
  })
}

/**
 * Generate a unique branch name.
 */
export function generateBranchName(prefix: string, suffix?: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const base = `${prefix}-${timestamp}-${random}`
  return suffix != null ? `${base}-${suffix}` : base
}
```

### 4. Commit Operations (`src/lib/delegated/commit.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {CommitOptions, CommitResult, FileChange, Logger} from "./types.js"

const DEFAULT_AUTHOR = {
  name: "Fro Bot",
  email: "agent@fro.bot",
} as const

/**
 * Create a commit with file changes.
 *
 * Uses the Git Data API for atomic commits.
 */
export async function createCommit(octokit: Octokit, options: CommitOptions, logger: Logger): Promise<CommitResult> {
  const {owner, repo, branch, message, files, author} = options
  const commitAuthor = author ?? DEFAULT_AUTHOR

  logger.info("Creating commit", {
    branch,
    filesChanged: files.length,
    message: message.slice(0, 50),
  })

  // 1. Get the current commit SHA of the branch
  const {data: ref} = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  })
  const currentCommitSha = ref.object.sha

  // 2. Get the tree SHA of the current commit
  const {data: currentCommit} = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: currentCommitSha,
  })
  const baseTreeSha = currentCommit.tree.sha

  // 3. Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async file => {
      const {data: blob} = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: file.encoding ?? "utf-8",
      })

      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      }
    }),
  )

  // 4. Create a new tree
  const {data: newTree} = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  })

  // 5. Create the commit
  const {data: newCommit} = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [currentCommitSha],
    author: {
      name: commitAuthor.name,
      email: commitAuthor.email,
      date: new Date().toISOString(),
    },
  })

  // 6. Update the branch reference
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
    force: false,
  })

  logger.info("Commit created", {sha: newCommit.sha})

  return {
    sha: newCommit.sha,
    url: newCommit.html_url,
    message: newCommit.message,
  }
}

/**
 * Get the content of a file at a specific ref.
 */
export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const {data} = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    })

    if ("content" in data && data.content != null) {
      return Buffer.from(data.content, "base64").toString("utf-8")
    }

    return null
  } catch (error) {
    if ((error as {status?: number}).status === 404) {
      return null
    }
    throw error
  }
}

/**
 * Format a commit message with standard structure.
 */
export function formatCommitMessage(type: string, scope: string | null, description: string, body?: string): string {
  const scopePart = scope != null ? `(${scope})` : ""
  const header = `${type}${scopePart}: ${description}`

  if (body != null && body.length > 0) {
    return `${header}\n\n${body}`
  }

  return header
}
```

### 5. Pull Request Operations (`src/lib/delegated/pull-request.ts`)

```typescript
import type {Octokit} from "../github/types.js"
import type {CreatePROptions, PRResult, Logger} from "./types.js"

/**
 * Create a pull request.
 */
export async function createPullRequest(octokit: Octokit, options: CreatePROptions, logger: Logger): Promise<PRResult> {
  const {owner, repo, title, body, head, base, draft} = options

  logger.info("Creating pull request", {head, base, draft})

  const {data} = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base,
    draft: draft ?? false,
  })

  logger.info("Pull request created", {number: data.number, url: data.html_url})

  return {
    number: data.number,
    url: data.html_url,
    title: data.title,
    state: data.state,
  }
}

/**
 * Find existing PR for a branch.
 */
export async function findPRForBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  logger: Logger,
): Promise<PRResult | null> {
  const {data} = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    state: "open",
  })

  if (data.length === 0) {
    return null
  }

  const pr = data[0]
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state,
  }
}

/**
 * Update an existing PR.
 */
export async function updatePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  options: {title?: string; body?: string},
  logger: Logger,
): Promise<PRResult> {
  logger.info("Updating pull request", {prNumber})

  const {data} = await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    title: options.title,
    body: options.body,
  })

  return {
    number: data.number,
    url: data.html_url,
    title: data.title,
    state: data.state,
  }
}

/**
 * Add labels to a PR.
 */
export async function addPRLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  labels: readonly string[],
  logger: Logger,
): Promise<void> {
  if (labels.length === 0) return

  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: [...labels],
  })

  logger.debug("Labels added to PR", {prNumber, labels})
}

/**
 * Request reviewers for a PR.
 */
export async function requestReviewers(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviewers: readonly string[],
  logger: Logger,
): Promise<void> {
  if (reviewers.length === 0) return

  await octokit.rest.pulls.requestReviewers({
    owner,
    repo,
    pull_number: prNumber,
    reviewers: [...reviewers],
  })

  logger.debug("Reviewers requested", {prNumber, reviewers})
}

/**
 * Generate PR body with context.
 */
export function generatePRBody(options: {
  description: string
  issueNumber?: number
  sessionId?: string
  changes?: readonly string[]
}): string {
  const parts: string[] = []

  parts.push(options.description)

  if (options.changes != null && options.changes.length > 0) {
    parts.push("\n## Changes\n")
    for (const change of options.changes) {
      parts.push(`- ${change}`)
    }
  }

  if (options.issueNumber != null) {
    parts.push(`\n\nCloses #${options.issueNumber}`)
  }

  if (options.sessionId != null) {
    parts.push(`\n\n---\n*Created by Fro Bot Agent (session: \`${options.sessionId}\`)*`)
  }

  return parts.join("\n")
}
```

### 6. Public Exports (`src/lib/delegated/index.ts`)

```typescript
export {createBranch, branchExists, deleteBranch, generateBranchName} from "./branch.js"
export {createCommit, getFileContent, formatCommitMessage} from "./commit.js"
export {
  createPullRequest,
  findPRForBranch,
  updatePullRequest,
  addPRLabels,
  requestReviewers,
  generatePRBody,
} from "./pull-request.js"

export type {
  FileChange,
  CommitOptions,
  CommitResult,
  CreateBranchOptions,
  BranchResult,
  CreatePROptions,
  PRResult,
  DelegatedWorkSummary,
} from "./types.js"
```

## Acceptance Criteria

- [ ] Branches can be created from any base branch
- [ ] Existing branches are handled gracefully
- [ ] Commits can include multiple file changes
- [ ] Commits use Git Data API for atomicity
- [ ] Author information is configurable
- [ ] Pull requests include title, body, and base/head branches
- [ ] Existing PRs for a branch can be found
- [ ] PRs can be updated after creation
- [ ] Labels and reviewers can be added to PRs
- [ ] All operations use elevated credentials when available
- [ ] Branch protection is respected (operations fail appropriately)

## Test Cases

### Branch Tests

```typescript
describe("createBranch", () => {
  it("creates branch from base", async () => {
    const result = await createBranch(
      mockOctokit,
      {
        owner: "owner",
        repo: "repo",
        branchName: "feature/test",
        baseBranch: "main",
      },
      logger,
    )

    expect(result.created).toBe(true)
    expect(result.name).toBe("feature/test")
  })

  it("returns existing branch without error", async () => {
    const result = await createBranch(
      mockOctokit,
      {
        owner: "owner",
        repo: "repo",
        branchName: "existing-branch",
        baseBranch: "main",
      },
      logger,
    )

    expect(result.created).toBe(false)
  })
})

describe("generateBranchName", () => {
  it("generates unique names", () => {
    const name1 = generateBranchName("fro-bot")
    const name2 = generateBranchName("fro-bot")
    expect(name1).not.toBe(name2)
  })

  it("includes suffix when provided", () => {
    const name = generateBranchName("fro-bot", "fix-123")
    expect(name).toContain("fix-123")
  })
})
```

### Commit Tests

```typescript
describe("createCommit", () => {
  it("creates commit with files", async () => {
    const result = await createCommit(
      mockOctokit,
      {
        owner: "owner",
        repo: "repo",
        branch: "feature/test",
        message: "feat: add new feature",
        files: [{path: "src/new.ts", content: "export const x = 1"}],
      },
      logger,
    )

    expect(result.sha).toBeDefined()
    expect(result.sha).toHaveLength(40)
  })

  it("handles multiple files atomically", async () => {
    const result = await createCommit(
      mockOctokit,
      {
        owner: "owner",
        repo: "repo",
        branch: "feature/test",
        message: "feat: multiple files",
        files: [
          {path: "src/a.ts", content: "a"},
          {path: "src/b.ts", content: "b"},
          {path: "src/c.ts", content: "c"},
        ],
      },
      logger,
    )

    expect(result.sha).toBeDefined()
  })
})

describe("formatCommitMessage", () => {
  it("formats with scope", () => {
    const msg = formatCommitMessage("feat", "api", "add endpoint")
    expect(msg).toBe("feat(api): add endpoint")
  })

  it("formats without scope", () => {
    const msg = formatCommitMessage("fix", null, "resolve issue")
    expect(msg).toBe("fix: resolve issue")
  })

  it("includes body when provided", () => {
    const msg = formatCommitMessage("feat", "api", "add endpoint", "Detailed description")
    expect(msg).toContain("Detailed description")
  })
})
```

### PR Tests

```typescript
describe("createPullRequest", () => {
  it("creates PR with title and body", async () => {
    const result = await createPullRequest(
      mockOctokit,
      {
        owner: "owner",
        repo: "repo",
        title: "feat: new feature",
        body: "Description",
        head: "feature/test",
        base: "main",
      },
      logger,
    )

    expect(result.number).toBeGreaterThan(0)
    expect(result.url).toContain("github.com")
  })

  it("creates draft PR when specified", async () => {
    const result = await createPullRequest(
      mockOctokit,
      {
        owner: "owner",
        repo: "repo",
        title: "WIP: feature",
        body: "Work in progress",
        head: "feature/wip",
        base: "main",
        draft: true,
      },
      logger,
    )

    expect(result.state).toBe("open")
  })
})

describe("generatePRBody", () => {
  it("includes issue reference", () => {
    const body = generatePRBody({
      description: "Fix the bug",
      issueNumber: 123,
    })

    expect(body).toContain("Closes #123")
  })

  it("includes changes list", () => {
    const body = generatePRBody({
      description: "Update",
      changes: ["Fixed X", "Added Y"],
    })

    expect(body).toContain("- Fixed X")
    expect(body).toContain("- Added Y")
  })
})
```

## Security Considerations

1. **Elevated credentials**: Always use App token or PAT for push operations
2. **Branch protection**: Operations will fail on protected branches (expected)
3. **Content validation**: No secret detection in this RFC; handled by pre-commit hooks
4. **Force push**: Never use force push; operations are additive only

## Implementation Notes

1. **Git Data API**: More reliable than content API for multi-file commits
2. **Atomic commits**: All file changes in one commit
3. **Existing branches**: Graceful handling enables retry/resume
4. **Rate limits**: Multiple API calls; consider batching

## Estimated Effort

- **Development**: 8-10 hours
- **Testing**: 4-5 hours
- **Total**: 12-15 hours

---

## Completion Notes

**Completed:** 2026-01-17

### Implementation Summary

RFC-010 was implemented as a **library-only** solution. The delegated work functions are fully implemented and tested but are not yet exposed to the agent as invokable tools.

### Files Created

| File                                | Purpose                                                 | Tests |
| ----------------------------------- | ------------------------------------------------------- | ----- |
| `src/lib/delegated/types.ts`        | Type definitions, security constants                    | -     |
| `src/lib/delegated/branch.ts`       | Branch operations (create, exists, delete, generate)    | 10    |
| `src/lib/delegated/commit.ts`       | Git Data API atomic commits with security validation    | 17    |
| `src/lib/delegated/pull-request.ts` | PR operations (create, find, update, labels, reviewers) | 14    |
| `src/lib/delegated/index.ts`        | Public exports                                          | -     |
| `src/lib/delegated/AGENTS.md`       | Module documentation                                    | -     |

**Total: 41 new tests** (all passing)

### Key Implementation Decisions

1. **Git Data API over CLI**: Uses GitHub's REST Git Data API (createBlob → createTree → createCommit → updateRef) for atomic multi-file commits instead of shelling out to `git` CLI.

2. **Security-first design**:
   - Path validation rejects traversal (`../`), `.git/` directories, and secret files (`.env`, `*.key`, `*.pem`, etc.)
   - 5MB per-file size limit
   - `updateRef` always uses `force: false` (never force push)

3. **Idempotent operations**: Branch creation returns existing ref if already exists (no error).

4. **Function-based architecture**: Per RULES.md - no classes, pure exported functions with dependency injection.

### Deferred Work

Agent integration is **out of scope** for this RFC. A future RFC should:

1. Register delegated work functions as MCP tools the agent can invoke
2. Inject authenticated Octokit client and repo context into tools
3. Inherit existing authorization gating (OWNER/MEMBER/COLLABORATOR only)
4. Surface meaningful errors to the agent for retry/escalation

### Verification Results

| Check      | Status                 |
| ---------- | ---------------------- |
| TypeScript | ✅ Passed              |
| Build      | ✅ 3 files, 1479.55 kB |
| Tests      | ✅ 679 passed (41 new) |
| Lint       | ✅ 0 errors            |
