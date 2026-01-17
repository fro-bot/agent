/**
 * Delegated work types for RFC-010.
 *
 * Defines interfaces for branch, commit, and pull request operations
 * via the GitHub Git Data API.
 */

/**
 * File change for a commit.
 */
export interface FileChange {
  /** Path relative to repo root (validated: no ../, .git/) */
  readonly path: string
  /** File content */
  readonly content: string
  /** Encoding type (default: utf-8) */
  readonly encoding?: 'utf-8' | 'base64'
}

/**
 * Options for creating a commit.
 */
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

/**
 * Result of a commit operation.
 */
export interface CommitResult {
  readonly sha: string
  readonly url: string
  readonly message: string
}

/**
 * Options for creating a branch.
 */
export interface CreateBranchOptions {
  readonly owner: string
  readonly repo: string
  readonly branchName: string
  readonly baseBranch: string
}

/**
 * Result of a branch operation.
 */
export interface BranchResult {
  /** Branch name */
  readonly name: string
  /** Commit SHA the branch points to */
  readonly sha: string
  /** True if branch was newly created, false if already existed */
  readonly created: boolean
}

/**
 * Options for creating a pull request.
 */
export interface CreatePROptions {
  readonly owner: string
  readonly repo: string
  readonly title: string
  readonly body: string
  /** Head branch containing changes */
  readonly head: string
  /** Base branch to merge into */
  readonly base: string
  /** Create as draft PR */
  readonly draft?: boolean
}

/**
 * Result of a PR operation.
 */
export interface PRResult {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly state: string
}

/**
 * Options for updating a pull request.
 */
export interface UpdatePROptions {
  readonly title?: string
  readonly body?: string
}

/**
 * Summary of delegated work performed.
 */
export interface DelegatedWorkSummary {
  readonly branch: BranchResult | null
  readonly commits: readonly CommitResult[]
  readonly pr: PRResult | null
}

/**
 * Options for generating a PR body.
 */
export interface GeneratePRBodyOptions {
  readonly description: string
  readonly issueNumber?: number
  readonly sessionId?: string
  readonly changes?: readonly string[]
}

/**
 * Security constants for file validation.
 */
export const FILE_VALIDATION = {
  /** Maximum file size in bytes (5MB) */
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024,
  /** Forbidden path patterns (path traversal and .git directories) */
  FORBIDDEN_PATTERNS: [
    /\.\.\//, // Path traversal anywhere (covers ../foo and foo/../bar)
    /^\.git\//, // .git directory at start (.git/config)
    /\/\.git\//, // .git directory in path (foo/.git/config)
  ] as readonly RegExp[],
  /** Forbidden file names (secrets) */
  FORBIDDEN_FILES: ['.env', '.env.local', '.env.production', 'credentials.json', 'auth.json'] as const,
  /** Forbidden extensions */
  FORBIDDEN_EXTENSIONS: ['.key', '.pem', '.p12', '.pfx'] as const,
} as const

/**
 * Default author for commits.
 */
export const DEFAULT_AUTHOR = {
  name: 'Fro Bot',
  email: 'fro-bot[bot]@users.noreply.github.com',
} as const
