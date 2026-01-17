# Delegated Work Module

**RFC:** RFC-010
**Purpose:** Push commits and open PRs programmatically via GitHub API

## Files

| File              | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `types.ts`        | Type definitions for all delegated operations |
| `branch.ts`       | Branch creation, existence checks, deletion   |
| `commit.ts`       | Atomic multi-file commits via Git Data API    |
| `pull-request.ts` | PR creation, updates, labels, reviewers       |
| `index.ts`        | Public exports                                |

## Usage

```typescript
import {createBranch, createCommit, createPullRequest} from "../delegated/index.js"

// Create branch
const branch = await createBranch(
  octokit,
  {
    owner: "owner",
    repo: "repo",
    branchName: "feature/my-feature",
    baseBranch: "main",
  },
  logger,
)

// Create atomic commit
const commit = await createCommit(
  octokit,
  {
    owner: "owner",
    repo: "repo",
    branch: branch.name,
    message: "feat: add new feature",
    files: [{path: "src/feature.ts", content: "export const feature = 1"}],
  },
  logger,
)

// Create PR
const pr = await createPullRequest(
  octokit,
  {
    owner: "owner",
    repo: "repo",
    title: "feat: add new feature",
    body: "Description of changes",
    head: branch.name,
    base: "main",
  },
  logger,
)
```

## Security

- **Path validation**: Rejects `../`, `.git/`, and secret files (`.env`, `*.key`)
- **File size cap**: 5MB per file
- **No force push**: `updateRef` always uses `force: false`
- **Default author**: Uses `fro-bot[bot]` identity

## API Reference

### Branch Operations

| Function             | Purpose                              |
| -------------------- | ------------------------------------ |
| `createBranch`       | Create branch from base (idempotent) |
| `branchExists`       | Check if branch exists               |
| `deleteBranch`       | Delete a branch                      |
| `generateBranchName` | Generate unique branch name          |

### Commit Operations

| Function              | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `createCommit`        | Atomic multi-file commit via Git Data API |
| `getFileContent`      | Get file content at ref                   |
| `formatCommitMessage` | Format conventional commit message        |
| `validateFilePath`    | Validate path for security                |
| `validateFileSize`    | Validate content size                     |
| `validateFiles`       | Validate all files before commit          |

### PR Operations

| Function            | Purpose                          |
| ------------------- | -------------------------------- |
| `createPullRequest` | Create new PR                    |
| `findPRForBranch`   | Find existing open PR for branch |
| `updatePullRequest` | Update PR title/body             |
| `addPRLabels`       | Add labels to PR                 |
| `requestReviewers`  | Request reviewers                |
| `generatePRBody`    | Generate PR body with context    |
