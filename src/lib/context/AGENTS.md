# CONTEXT MODULE

**RFC:** RFC-015 GraphQL Context Hydration
**Status:** Completed

## OVERVIEW

Provides rich issue and pull request context to the agent via GraphQL API with REST fallback and budget constraints to prevent prompt bloat.

## ARCHITECTURE

```
hydrateIssueContext() / hydratePullRequestContext()
          ↓                         ↓
 executeIssueQuery()      executePullRequestQuery()
          ↓                         ↓
   IssueContext             PullRequestContext
          ↓                         ↓
 fallbackIssueContext()   fallbackPullRequestContext()
          ↓                         ↓
 formatContextForPrompt() → Markdown string
```

## WHERE TO LOOK

| File              | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `types.ts`        | Type definitions, budget constraints       |
| `graphql.ts`      | GraphQL queries and execution (batched)    |
| `issue.ts`        | Issue context hydration logic              |
| `pull-request.ts` | PR context hydration logic                 |
| `fallback.ts`     | REST API fallback when GraphQL fails       |
| `budget.ts`       | Truncation, size estimation, prompt format |
| `index.ts`        | Public exports                             |
| `test-helpers.ts` | Shared mock utilities for tests            |

## KEY EXPORTS

- `hydrateIssueContext(...)`: Primary entry for issues (GraphQL)
- `hydratePullRequestContext(...)`: Primary entry for PRs (GraphQL)
- `fallbackIssueContext(...)`: REST fallback for issues
- `fallbackPullRequestContext(...)`: REST fallback for PRs
- `formatContextForPrompt(context)`: Converts hydrated context to Markdown
- `truncateBody(text, maxBytes)`: UTF-8 safe byte-level truncation
- `DEFAULT_CONTEXT_BUDGET`: Budget limits per RFC-015

## BUDGET CONSTRAINTS

| Limit         | Value  | Description                      |
| ------------- | ------ | -------------------------------- |
| maxComments   | 50     | Max comments to fetch            |
| maxCommits    | 100    | Max commits (PR only)            |
| maxFiles      | 100    | Max files (PR only)              |
| maxReviews    | 100    | Max reviews (PR only)            |
| maxBodyBytes  | 10 KB  | Individual body truncation limit |
| maxTotalBytes | 100 KB | Overall prompt context limit     |

## GRACEFUL DEGRADATION

1. **Primary:** GraphQL API for efficient batched queries.
2. **Fallback:** REST API (via Octokit) when GraphQL fails or is unavailable.
3. **Null-Safe:** Returns `null` on terminal failures rather than throwing.

## FORK DETECTION

PRs from forks are detected by comparing `baseRepository.owner` vs `headRepository.owner`. Fork PRs are flagged with `isFork: true` for security awareness in the prompt.

## UTF-8 SAFETY

Body truncation uses byte-level slicing with `TextEncoder`/`TextDecoder`. Invalid UTF-8 sequences (0xFFFD) at truncation boundaries are stripped to ensure the resulting Markdown is valid and safe for LLM consumption.
