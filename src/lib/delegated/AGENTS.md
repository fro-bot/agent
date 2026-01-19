# DELEGATED WORK MODULE

**RFC:** RFC-010
**Purpose:** Push commits and open PRs programmatically via GitHub API.

## WHERE TO LOOK

| File              | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `types.ts`        | Type definitions for all delegated operations |
| `branch.ts`       | Branch creation, existence checks, deletion   |
| `commit.ts`       | Atomic multi-file commits via Git Data API    |
| `pull-request.ts` | PR creation, updates, labels, reviewers       |

## KEY EXPORTS

```typescript
// Branch operations
createBranch(octokit, options, logger) // Create branch from base (idempotent)
branchExists(octokit, options, logger) // Check if branch exists
deleteBranch(octokit, options, logger) // Delete a branch
generateBranchName(prefix, description) // Generate unique branch name

// Commit operations
createCommit(octokit, options, logger) // Atomic multi-file commit via Git Data API
getFileContent(octokit, options, logger) // Get file content at ref
validateFilePath(path) // Security validation
validateFiles(files) // Validate all files before commit

// PR operations
createPullRequest(octokit, options, logger) // Create new PR
findPRForBranch(octokit, options, logger) // Find existing open PR
updatePullRequest(octokit, options, logger) // Update PR title/body
addPRLabels(octokit, options, logger) // Add labels to PR
requestReviewers(octokit, options, logger) // Request reviewers
```

## SECURITY

- **Path validation**: Rejects `../`, `.git/`, and secret files (`.env`, `*.key`, `*.pem`)
- **File size cap**: 5MB per file
- **No force push**: `updateRef` always uses `force: false`
- **Default author**: Uses `fro-bot[bot]` identity
- **Forbidden files**: `.env`, `.env.*`, `credentials.json`, `auth.json`
- **Forbidden extensions**: `.key`, `.pem`, `.p12`, `.pfx`

## PATTERNS

- **Atomic Commits**: Uses Git Data API (create blobs → create tree → create commit → update ref)
- **Idempotent Branches**: `createBranch` handles "already exists" gracefully
- **Conventional Commits**: `formatCommitMessage` generates `type(scope): description` format
- **PR Body Generation**: `generatePRBody` includes context section and checklist

## ANTI-PATTERNS

| Forbidden           | Reason                                 |
| ------------------- | -------------------------------------- |
| Force push          | Always `force: false` on ref updates   |
| Direct file writes  | Use Git Data API for atomic operations |
| Skipping validation | Always validate paths before commit    |
| Large commits       | Break into smaller, focused commits    |
