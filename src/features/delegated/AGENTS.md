# DELEGATED WORK MODULE

**RFC:** RFC-010
**Purpose:** Push commits and open PRs programmatically via GitHub API.

## WHERE TO LOOK

| File              | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `index.ts`        | Public API entry point                        |
| `types.ts`        | Type definitions for all delegated operations |
| `branch.ts`       | Branch creation, existence checks, deletion   |
| `commit.ts`       | Atomic multi-file commits via Git Data API    |
| `pull-request.ts` | PR creation, updates, labels, reviewers       |

## KEY EXPORTS

```typescript
// Branch (branch.ts)
createBranch(octokit, options, logger)    // Idempotent branch creation
branchExists(octokit, owner, repo, name) // Check if branch exists
generateBranchName(prefix, suffix?)      // Unique branch name generation

// Commit (commit.ts)
createCommit(octokit, options, logger)    // Atomic multi-file Git Data commit
getFileContent(octokit, owner, repo, ...) // Read file content at specific ref
validateFiles(files)                     // Security and size validation
formatCommitMessage(type, scope, desc)   // Conventional commit formatting

// Pull Request (pull-request.ts)
createPullRequest(octokit, options, ...)  // Open new pull request
findPRForBranch(octokit, owner, repo, ..) // Find open PR for head branch
updatePullRequest(octokit, owner, repo,.) // Update PR title or body
generatePRBody(options)                   // Markdown body with session info
```

## SECURITY

- **Path validation**: Rejects `../`, `.git/`, and secrets (`.env`, `auth.json`, etc.)
- **File size cap**: 5MB per file (enforced in `validateFiles`)
- **No force push**: `updateRef` always uses `force: false`
- **Default author**: Uses `fro-bot[bot]@users.noreply.github.com`

## PATTERNS

- **Atomic Commits**: Uses Git Data API (blob → tree → commit → ref)
- **Conventional Commits**: Enforces `type(scope): description` structure
- **PR Attribution**: Bodies include session ID for auditability

## ANTI-PATTERNS

| Forbidden           | Reason                                    |
| ------------------- | ----------------------------------------- |
| Force push          | Always `force: false` to avoid data loss  |
| Direct file writes  | Use Git Data API for atomic operations    |
| Skipping validation | Always call `validateFiles` before commit |
