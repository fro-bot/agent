# Prompt Builder Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add context-aware, trigger-specific PR review directives and output contracts to the prompt builder, including new context flags for reviewer-requested and collaborator status.

**Architecture:** Extend PR context hydration and trigger context to surface reviewer-request and collaborator signals, then enhance `getTriggerDirective()`/`buildTaskSection()` to emit conditional directives and a per-trigger output contract section. Keep existing prompt section ordering while adding new content in the task/output contract area.

**Tech Stack:** TypeScript (ESM), Vitest, GitHub Actions Octokit (GraphQL + REST), OpenCode prompt builder.

---

### Task 1: Add reviewer-requested + collaborator signals to PR hydrated context

**Files:**

- Modify: `src/lib/context/types.ts`
- Modify: `src/lib/context/graphql.ts`
- Modify: `src/lib/context/pull-request.ts`
- Modify: `src/lib/context/fallback.ts`
- Test: `src/lib/context/pull-request.test.ts`

**Step 1: Write the failing test**

Add assertions to `src/lib/context/pull-request.test.ts` for new fields on `PullRequestContext`:

```ts
// #then
expect(result?.requestedReviewers).toEqual(['reviewer1', 'reviewer2'])
expect(result?.requestedReviewerTeams).toEqual(['team-a'])
expect(result?.authorAssociation).toBe('MEMBER')
```

Use the existing mock response in `returns hydrated PR context on success` and add the new fields to the mock GraphQL response in the test fixture (see Step 3).

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/context/pull-request.test.ts` Expected: FAIL with missing fields on `PullRequestContext` or undefined values.

**Step 3: Write minimal implementation**

1. Update `PullRequestContext` in `src/lib/context/types.ts`:

```ts
export interface PullRequestContext {
  // ...existing fields
  readonly authorAssociation: string
  readonly requestedReviewers: readonly string[]
  readonly requestedReviewerTeams: readonly string[]
}
```

2. Update GraphQL query in `src/lib/context/graphql.ts` to fetch:

- `authorAssociation` on `pullRequest`
- `reviewRequests` with requested users and teams

Add to `PULL_REQUEST_QUERY`:

```graphql
authorAssociation
reviewRequests(first: 20) {
  nodes {
    requestedReviewer {
      ... on User { login }
      ... on Team { name }
    }
  }
}
```

3. Update `hydratePullRequestContext` in `src/lib/context/pull-request.ts` to map:

```ts
const requestedReviewers = pr.reviewRequests.nodes
  .map(r => ('login' in r.requestedReviewer ? r.requestedReviewer.login : null))
  .filter((login): login is string => login != null)

const requestedReviewerTeams = pr.reviewRequests.nodes
  .map(r => ('name' in r.requestedReviewer ? r.requestedReviewer.name : null))
  .filter((name): name is string => name != null)
```

Include `authorAssociation: pr.authorAssociation` in the return object.

4. Update REST fallback in `src/lib/context/fallback.ts` (pull request fallback) to populate:

- `authorAssociation` from `pr.author_association`
- `requestedReviewers` from `client.rest.pulls.listRequestedReviewers`
- `requestedReviewerTeams` from `client.rest.pulls.listRequestedReviewers` response teams

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/context/pull-request.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/context/types.ts src/lib/context/graphql.ts src/lib/context/pull-request.ts src/lib/context/fallback.ts src/lib/context/pull-request.test.ts
git commit -m "feat(context): add reviewer request signals"
```

---

### Task 2: Surface PR signals in prompt inputs and add output contract scaffolding

**Files:**

- Modify: `src/lib/agent/types.ts`
- Modify: `src/lib/agent/context.ts`
- Modify: `src/lib/agent/prompt.ts`
- Test: `src/lib/agent/prompt.test.ts`

**Step 1: Write the failing test**

Add a test case to `src/lib/agent/prompt.test.ts` verifying that PR triggers include a new **Output Contract** section with required fields, and that directives mention reviewer-requested/collaborator when present.

Example expectation snippet:

```ts
expect(prompt).toContain('## Output Contract')
expect(prompt).toContain('Review action: approve/request-changes if confident; otherwise comment-only')
expect(prompt).toContain('Requested reviewer: yes')
expect(prompt).toContain('Author association: MEMBER')
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: FAIL with missing Output Contract content and missing context fields.

**Step 3: Write minimal implementation**

1. Update `AgentContext` in `src/lib/agent/types.ts` to include:

```ts
readonly authorAssociation: string | null
readonly requestedReviewers: readonly string[]
readonly requestedReviewerTeams: readonly string[]
```

2. Update `collectAgentContext` in `src/lib/agent/context.ts` to map these from `hydratedContext` when it is a PR, defaulting to empty arrays and null association when absent.

3. Update `buildAgentPrompt`/`buildTaskSection` in `src/lib/agent/prompt.ts`:

- Add an **Output Contract** section for `pull_request` and `pull_request_review_comment`.
- Add conditional lines:
  - `Requested reviewer: yes|no` based on presence of bot login in `requestedReviewers` (requires passing bot login into prompt options or precomputing boolean in context).
  - `Author association: <value>` if available.

> Note: This step likely requires plumbing bot login into prompt options or adding a computed flag on `AgentContext` (e.g., `isRequestedReviewer`). Pick one and keep it consistent with existing patterns.

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/types.ts src/lib/agent/context.ts src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "feat(prompt): add PR output contract and context flags"
```

---

### Task 3: Extend trigger directive logic for PR events

**Files:**

- Modify: `src/lib/agent/prompt.ts`
- Test: `src/lib/agent/prompt.test.ts`

**Step 1: Write the failing test**

Add tests to `getTriggerDirective`/`buildTaskSection` ensuring PR directives include:

- Clear instruction to post a review when confident, else comment-only.
- Explicit mention of collaborator/reviewer-requested conditions when true.

Example:

```ts
expect(directive.directive).toContain('If you are a requested reviewer, post a review')
expect(directive.directive).toContain('If you are a collaborator, always review')
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: FAIL with directive content missing.

**Step 3: Write minimal implementation**

Update `getTriggerDirective` in `src/lib/agent/prompt.ts`:

- For `pull_request` and `pull_request_review_comment`, append conditional directive lines when context flags indicate requested reviewer/collaborator.
- Ensure wording aligns with decision: explicit review action only when confident.

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "feat(prompt): refine PR review directives"
```

---

### Task 4: Update prompt tests for ordering invariants and output contract placement

**Files:**

- Modify: `src/lib/agent/prompt.test.ts`

**Step 1: Write the failing test**

Add a test that asserts the **Output Contract** appears immediately after the Task section for PR events, preserving existing ordering of environment/context sections.

Example:

```ts
const taskIndex = prompt.indexOf('## Task')
const contractIndex = prompt.indexOf('## Output Contract')
expect(contractIndex).toBeGreaterThan(taskIndex)
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: FAIL if placement not implemented or differs.

**Step 3: Write minimal implementation**

Adjust prompt assembly in `buildAgentPrompt` to insert the Output Contract section immediately after the Task section for PR events.

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/prompt.test.ts src/lib/agent/prompt.ts
git commit -m "test(prompt): assert output contract placement"
```

---

### Task 5: Full verification

**Step 1: Run full test suite**

Run: `pnpm test` Expected: PASS (note any pre-existing failures)

**Step 2: Run typecheck and lint**

Run: `pnpm check-types && pnpm lint` Expected: PASS

**Step 3: Build**

Run: `pnpm build` Expected: PASS and `dist/` updated

**Step 4: Commit build artifacts**

```bash
git add dist
git commit -m "build: update dist"
```

---

## Notes and Constraints

- No `as any` or `@ts-ignore`.
- Follow strict boolean checks (`value != null`, etc.).
- Keep prompt section ordering stable except for the new Output Contract section placed after Task for PR triggers.
- For reviewer-request signals: prefer GraphQL `reviewRequests` and REST `listRequestedReviewers` in fallback.
