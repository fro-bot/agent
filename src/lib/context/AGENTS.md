# CONTEXT MODULE

**RFC:** RFC-015 GraphQL Context Hydration
**Status:** Completed

## OVERVIEW

Provides rich issue and pull request context to the agent via GraphQL API with REST fallback and budget constraints to prevent prompt bloat.

## ARCHITECTURE

```
TriggerContext → hydrateContext() → hydrateIssueContext() / hydratePullRequestContext()
                      ↓                      ↓                         ↓
             number + issueType     executeIssueQuery()      executePullRequestQuery()
                                           ↓                         ↓
                                    IssueContext           PullRequestContext
                                           ↓                         ↓
                                    fallbackIssueContext()  fallbackPullRequestContext()
                                           ↓                         ↓
                                    formatContextForPrompt() → Markdown string
```

## WHERE TO LOOK

| File               | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `types.ts`         | Type definitions, budget constraints         |
| `graphql.ts`       | GraphQL queries and execution                |
| `issue.ts`         | Issue context hydration via GraphQL          |
| `pull-request.ts`  | PR context hydration via GraphQL             |
| `fallback.ts`      | REST API fallback when GraphQL fails         |
| `budget.ts`        | Truncation, size estimation, prompt format   |
| `index.ts`         | Public exports                               |
| `test-helpers.ts`  | Shared mock utilities for tests              |

## KEY EXPORTS

```typescript
hydrateIssueContext(client, owner, repo, number, budget, logger)
hydratePullRequestContext(client, owner, repo, number, budget, logger)
fallbackIssueContext(client, owner, repo, number, budget, logger)
fallbackPullRequestContext(client, owner, repo, number, budget, logger)
formatContextForPrompt(context) // HydratedContext → Markdown
truncateBody(text, maxBytes) // UTF-8 safe truncation
DEFAULT_CONTEXT_BUDGET // Budget limits per RFC-015
```

## BUDGET CONSTRAINTS

| Limit          | Value   |
| -------------- | ------- |
| maxComments    | 50      |
| maxCommits     | 100     |
| maxFiles       | 100     |
| maxReviews     | 100     |
| maxBodyBytes   | 10 KB   |
| maxTotalBytes  | 100 KB  |

## GRACEFUL DEGRADATION

1. **Primary:** GraphQL API for efficient batched queries
2. **Fallback:** REST API when GraphQL fails
3. **Null:** Returns `null` on all failures (never throws)

## FORK DETECTION

PRs from forks are detected by comparing `baseRepository.owner` vs `headRepository.owner`. Fork PRs are flagged with `isFork: true` for security awareness.

## UTF-8 SAFETY

Body truncation uses byte-level slicing with validation to avoid breaking multi-byte characters. Invalid UTF-8 sequences (0xFFFD replacement chars) are stripped before appending truncation suffix.
