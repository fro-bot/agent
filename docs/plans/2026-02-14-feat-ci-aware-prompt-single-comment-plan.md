---
title: "feat: CI-Aware Agent Prompt with Single Comment Output"
type: feat
date: 2026-02-14
---

# CI-Aware Agent Prompt with Single Comment Output

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Overview

Update the agent prompt so the agent understands it is running in a non-interactive CI environment (GitHub Actions), limits its assistant message output to diagnostics, and always consolidates its entire response — including the Run Summary — into exactly ONE GitHub comment or review per invocation.

## Problem Statement

**Observed on PR #186:** The agent posted two separate artifacts:

1. A formal GitHub **review** (APPROVED) with detailed code analysis — via `gh pr review`
2. A separate **issue comment** (5 seconds later) containing only the Run Summary — via `gh pr comment`

This fragmentation occurs because:

- The prompt says "Every comment you post MUST include a collapsed details block" but doesn't say "post exactly one artifact"
- The prompt has no instructions about assistant messages being CI-only logs
- The trigger directives for `pull_request` say "post a review using the GitHub review API" but don't mention that the Run Summary should be embedded in the review body
- The GitHub Operations section shows both `gh issue comment` and `gh pr comment` examples, implying multiple comments are acceptable

**Root cause:** The agent has no prompt-level awareness that it's in a non-interactive CI environment, and no explicit single-output contract.

## Proposed Solution

Modify `buildAgentPrompt()` in `src/lib/agent/prompt.ts` to add three new prompt concepts:

1. **CI Environment Awareness** — Tell the agent its assistant messages go to CI job logs only (users won't see them), so output only diagnostic information in assistant messages.
2. **Response Protocol (Single Output Contract)** — Require exactly ONE comment or review per invocation. The Run Summary is always embedded in that same artifact. Never post a separate comment for metadata.
3. **Unified Response Format** — Define a consistent content structure that applies to all channels (issue comments, PR reviews, discussion comments).

**No harness code changes needed.** The agent posts via `gh` CLI tools during execution. The harness (`main.ts`) only posts comments for LLM error cases. The fix is purely prompt-side.

## Technical Considerations

### Architecture: Agent-Side Output Only

The agent is responsible for all successful-run output. The harness (`main.ts`) does NOT post run summary comments. The flow is:

```
Agent executes → uses gh CLI to post comment/review → harness detects via detectArtifacts()
```

Therefore, changing the prompt instructions is sufficient to fix the behavior.

### Reviews vs Comments

GitHub's Review API (`gh pr review --approve --body "..."`) and Comment API (`gh pr comment --body "..."`) are separate endpoints producing separate UI artifacts. The agent must be told to include the Run Summary **inside the review body** when submitting a review, and to **not post a separate comment** afterward.

### BOT_COMMENT_MARKER

The harness uses `<!-- fro-bot-agent -->` (`BOT_COMMENT_MARKER`) to identify and update existing bot comments via `postComment()`. The agent should include this marker in its output so the harness can find/update the comment on subsequent runs. This marker must appear inside the Run Summary block (which it already does in the template).

### Impact on Existing Output Contract

The existing `buildOutputContractSection()` (from the prompt-builder-audit plan) handles PR-specific review action guidance (`approve/request-changes`). The new Response Protocol section is a universal contract that applies to ALL triggers. They complement each other — the Output Contract says what review action to take, the Response Protocol says how to deliver the output.

## Acceptance Criteria

- [ ] Agent prompt includes CI environment awareness section explaining assistant messages are CI-only logs
- [ ] Agent prompt includes single-output contract requiring exactly ONE comment or review
- [ ] Agent prompt includes unified response format template showing content + Run Summary in one artifact
- [ ] Trigger directives for `pull_request` explicitly instruct embedding Run Summary in review body
- [ ] The "GitHub Operations" section no longer implies multiple comments are acceptable
- [ ] The "Run Summary (REQUIRED)" section clarifies the summary goes IN the response, not as a separate comment
- [ ] All existing prompt tests continue to pass
- [ ] New tests verify CI awareness, single-output contract, and response format sections exist
- [ ] `pnpm check-types && pnpm lint && pnpm test && pnpm build` all pass

## Dependencies & Risks

- **Depends on:** Existing prompt-builder-audit plan (Tasks 1-4) being merged or at least the current `buildOutputContractSection()` being present.
- **Risk: Review body length limits.** GitHub review bodies can be very long, so embedding the Run Summary should be fine. No known length limits on review body content.
- **Risk: Agent compliance.** The agent is an LLM — prompt instructions are not guarantees. The wording must be clear and unambiguous. Explicit negative instructions ("NEVER post a separate comment") are more reliable than positive-only.

## Files to Modify

| File | Change |
| --- | --- |
| `src/lib/agent/prompt.ts` | Add CI Environment section, Response Protocol section, update Run Summary section, update GitHub Operations section, update trigger directives |
| `src/lib/agent/prompt.test.ts` | Add tests for new sections, update existing tests as needed |

---

## MVP

### Task 1: Add CI Environment Awareness section to prompt

**Files:**

- Modify: `src/lib/agent/prompt.ts`
- Test: `src/lib/agent/prompt.test.ts`

**Step 1: Write the failing test**

Add a test to `prompt.test.ts` that asserts the prompt includes CI environment instructions:

```ts
it("should include CI environment awareness section", () => {
  const prompt = buildAgentPrompt(defaultOptions, mockLogger)
  expect(prompt).toContain("## Operating Environment")
  expect(prompt).toContain("non-interactive CI environment")
  expect(prompt).toContain("assistant messages are logged to the GitHub Actions job output")
  expect(prompt).toContain("diagnostic information")
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: FAIL

**Step 3: Write minimal implementation**

Add a new section to `buildAgentPrompt()` immediately after the system context header (before the Task section). This section replaces the minimal "You are the Fro Bot Agent running in GitHub Actions." header with a more informative one.

Update the system context header in `buildAgentPrompt()`:

```ts
parts.push(`# Agent Context

You are the Fro Bot Agent running in a non-interactive CI environment (GitHub Actions).

## Operating Environment

- **This is NOT an interactive session.** There is no human reading your assistant messages in real time.
- Your assistant messages are logged to the GitHub Actions job output. Use them only for diagnostic information (e.g., files read, decisions made, errors encountered) that helps troubleshoot issues in CI logs.
- The human who invoked you will ONLY see what you post as a GitHub comment or review. Your assistant messages are invisible to them.
- You MUST post your response using the gh CLI (see Response Protocol below). Do not rely on assistant message output to communicate with the user.
`)
```

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "feat(prompt): add CI environment awareness section"
```

---

### Task 2: Add Response Protocol section (single-output contract)

**Files:**

- Modify: `src/lib/agent/prompt.ts`
- Test: `src/lib/agent/prompt.test.ts`

**Step 1: Write the failing test**

Add tests asserting the prompt includes the Response Protocol:

```ts
it("should include Response Protocol requiring single output", () => {
  const prompt = buildAgentPrompt(defaultOptions, mockLogger)
  expect(prompt).toContain("## Response Protocol (REQUIRED)")
  expect(prompt).toContain("exactly ONE")
  expect(prompt).toContain("NEVER post the Run Summary as a separate comment")
})

it("should include unified response format template", () => {
  const prompt = buildAgentPrompt(defaultOptions, mockLogger)
  expect(prompt).toContain("<!-- fro-bot-agent -->")
  expect(prompt).toContain("Your response content")
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: FAIL

**Step 3: Write minimal implementation**

Add a new `buildResponseProtocolSection()` function in `prompt.ts` and call it from `buildAgentPrompt()`. Place it after the Environment section (or after Output Contract for PR triggers) and before GitHub Operations.

```ts
function buildResponseProtocolSection(context: AgentContext, cacheStatus: string, sessionId: string | null): string {
  const issueNum = context.issueNumber ?? "<number>"
  return `## Response Protocol (REQUIRED)

You MUST post exactly ONE comment or review per invocation. All of your output — your response content AND the Run Summary — goes into that single artifact.

### Rules

1. **One output per run.** Post exactly ONE comment (via \`gh issue comment\` or \`gh pr comment\`) or ONE review (via \`gh pr review\`). Never both. Never multiple comments.
2. **Include the Run Summary.** Append the Run Summary block (see template below) at the end of your response body. It is part of the same comment/review, not a separate post.
3. **NEVER post the Run Summary as a separate comment.** This is the most common mistake. The Run Summary goes INSIDE your response.
4. **Include the bot marker.** Your response must contain \`<!-- fro-bot-agent -->\` (inside the Run Summary block) so the system can identify your comment.
5. **For PR reviews:** When using \`gh pr review --approve\` or \`gh pr review --request-changes\`, put your full response (analysis + Run Summary) in the \`--body\` argument. Do not post a separate PR comment afterward.
6. **For issue/PR comments:** Post a single \`gh issue comment ${issueNum}\` or \`gh pr comment ${issueNum}\` with your full response including Run Summary.

### Unified Response Format

Every response you post — regardless of channel (issue, PR, discussion, review) — MUST follow this structure:

\`\`\`markdown
[Your response content here]

---

<!-- fro-bot-agent -->
<details>
<summary>Run Summary</summary>

| Field | Value |
|-------|-------|
| Event | ${context.eventName} |
| Repository | ${context.repo} |
| Run ID | ${context.runId} |
| Cache | ${cacheStatus} |
| Session | ${sessionId ?? "<your_session_id>"} |

</details>
\`\`\`
`
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "feat(prompt): add single-output Response Protocol section"
```

---

### Task 3: Update trigger directives for single-output compliance

**Files:**

- Modify: `src/lib/agent/prompt.ts`
- Test: `src/lib/agent/prompt.test.ts`

**Step 1: Write the failing test**

Add tests asserting updated trigger directives mention the single-output constraint:

```ts
it("should instruct PR review to include Run Summary in review body", () => {
  const directive = getTriggerDirective(pullRequestContext, null)
  expect(directive.directive).toContain("Include the Run Summary in the review body")
  expect(directive.directive).not.toContain("post a review using the GitHub review API")
})

it("should instruct issue_comment to post a single comment", () => {
  const directive = getTriggerDirective(issueCommentContext, null)
  expect(directive.directive).toContain("Post your response as a single comment")
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: FAIL

**Step 3: Write minimal implementation**

Update `getTriggerDirective()` for each event type:

```ts
case 'issue_comment':
  return {
    directive: 'Respond to the comment above. Post your response as a single comment on this thread.',
    appendMode: true,
  }

case 'discussion_comment':
  return {
    directive: 'Respond to the discussion comment above. Post your response as a single comment.',
    appendMode: true,
  }

case 'pull_request':
  return {
    directive: [
      'Review this pull request for code quality, potential bugs, and improvements.',
      'If you are a requested reviewer, submit a review via `gh pr review` with your full response (including Run Summary) in the --body.',
      'Include the Run Summary in the review body. Do not post a separate comment.',
      'If the author is a collaborator, prioritize actionable feedback over style nits.',
    ].join('\n'),
    appendMode: true,
  }

case 'pull_request_review_comment':
  return {
    directive: buildReviewCommentDirective(context) + '\nPost your response as a single reply.',
    appendMode: true,
  }
```

For `issues` (opened/edited): Update similarly with "Post your response as a single comment."

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "feat(prompt): update trigger directives for single-output compliance"
```

---

### Task 4: Remove old Run Summary section and update GitHub Operations

**Files:**

- Modify: `src/lib/agent/prompt.ts`
- Test: `src/lib/agent/prompt.test.ts`

**Step 1: Write the failing test**

Add tests asserting:

- The old "## Run Summary (REQUIRED)" section is removed (its content now lives in Response Protocol)
- The GitHub Operations section does not suggest posting multiple comments

```ts
it("should not contain the old Run Summary section", () => {
  const prompt = buildAgentPrompt(defaultOptions, mockLogger)
  expect(prompt).not.toContain("## Run Summary (REQUIRED)")
  expect(prompt).not.toContain("Every comment you post MUST include")
})

it("should not show separate issue and PR comment examples", () => {
  const prompt = buildAgentPrompt(defaultOptions, mockLogger)
  // The old section showed both "Comment on issue" and "Comment on PR" examples
  // suggesting multiple comments. Now it should reference the Response Protocol.
  expect(prompt).toContain("## GitHub Operations (Use gh CLI)")
  expect(prompt).not.toContain("# Comment on issue")
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: FAIL

**Step 3: Write minimal implementation**

1. **Remove the old Run Summary section** at the end of `buildAgentPrompt()`. The Run Summary template is now inside `buildResponseProtocolSection()`.

2. **Update the GitHub Operations section** to remove separate commenting examples and instead reference the Response Protocol:

```ts
parts.push(`## GitHub Operations (Use gh CLI)

The \`gh\` CLI is pre-authenticated. Use it for all GitHub operations.

### Posting Your Response

See **Response Protocol** above. Post exactly one comment or review per run.

\`\`\`bash
# Post response as PR comment (use --body-file for long responses)
gh pr comment ${issueNum} --body "Your response with Run Summary"

# Submit PR review with response in body
gh pr review ${issueNum} --approve --body "Your review with Run Summary"
\`\`\`

### Creating PRs
\`\`\`bash
gh pr create --title "feat(scope): description" --body "Details..." --base ${context.defaultBranch} --head feature-branch
\`\`\`

### Pushing Commits
\`\`\`bash
git add .
git commit -m "type(scope): description"
git push origin HEAD
\`\`\`

### API Calls
\`\`\`bash
gh api repos/${context.repo}/issues --jq '.[].title'
gh api repos/${context.repo}/pulls/${issueNum}/files --jq '.[].filename'
\`\`\`
`)
```

**Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/agent/prompt.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts
git commit -m "refactor(prompt): consolidate Run Summary into Response Protocol"
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

## Prompt Section Ordering (After Implementation)

For reference, the final prompt section ordering after this plan + the existing prompt-builder-audit plan:

```
1. # Agent Context (CI environment awareness)
2. ## Operating Environment (diagnostics-only output)
3. [Custom prompt — if no trigger context]
4. ## Task (trigger-specific directive — now with single-output language)
5. ## Output Contract (PR triggers only — review action guidance)
6. ## Environment (repo, branch, event, actor, run ID, cache)
7. ## Issue/PR Context (number, title, type)
8. ## Trigger Comment (comment body, author)
9. ## Prior Session Context (recent sessions, search results)
10. ## Pull Request Diff Summary (changed files)
11. [Hydrated Context — GraphQL issue/PR details]
12. ## Session Management (REQUIRED) (session search/read instructions)
13. ## Response Protocol (REQUIRED) (single-output contract + unified format)
14. ## GitHub Operations (Use gh CLI) (posting, PRs, commits, API)
```

## Notes and Constraints

- No `as any` or `@ts-ignore`.
- Follow strict boolean checks (`value != null`, etc.).
- The old `## Run Summary (REQUIRED)` section is fully replaced by the Response Protocol section. Do not keep both.
- Existing tests for Run Summary content (e.g., `expect(prompt).toContain('Run Summary')`) should be updated to check the new Response Protocol section instead.
- The `generateCommentSummary()` and `appendSummaryToComment()` functions in `run-summary.ts` are still used by the harness for error comments. They remain unchanged.

## References

- PR #186: [Observed behavior — review + separate Run Summary comment](https://github.com/fro-bot/agent/pull/186)
- `src/lib/agent/prompt.ts:106`: `buildAgentPrompt()` — main prompt construction
- `src/lib/agent/prompt.ts:19`: `getTriggerDirective()` — trigger-specific directives
- `src/lib/agent/prompt.ts:354`: `buildOutputContractSection()` — PR review action contract
- `src/lib/observability/run-summary.ts:72`: `generateCommentSummary()` — Run Summary template
- `src/lib/comments/writer.ts:193`: `postComment()` — harness comment posting (error cases only)
- `src/lib/agent/opencode.ts:55`: `detectArtifacts()` — tracks agent-posted comments
- `src/lib/github/types.ts:175`: `BOT_COMMENT_MARKER` — `<!-- fro-bot-agent -->`
- Brainstorm: `docs/brainstorms/2026-02-14-prompt-builder-audit-brainstorm.md`
- Prior plan: `docs/plans/2026-02-14-prompt-builder-audit.md`
