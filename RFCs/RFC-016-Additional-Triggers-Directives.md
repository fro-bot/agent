# RFC-016: Additional Triggers & Directives

**Status:** Pending
**Priority:** MUST
**Complexity:** Medium
**Phase:** 2

---

## Summary

Extend GitHub event handling to support additional triggers (`issues`, `pull_request`, `pull_request_review_comment`, `schedule`) and implement trigger-specific prompt directives via `getTriggerDirective()`. This RFC expands RFC-005's trigger infrastructure to cover all v1.2 P0 trigger requirements.

## Dependencies

- **Builds Upon:** RFC-005 (GitHub Triggers & Event Handling), RFC-013 (SDK Execution Mode), RFC-003 (GitHub API Client)
- **Enables:** RFC-008 (GitHub Comment Interactions), RFC-009 (PR Review Features)

## Features Addressed

| Feature ID | Feature Name                        | Priority |
| ---------- | ----------------------------------- | -------- |
| F69        | Trigger-Specific Prompt Directives  | P0       |
| F70        | Issues Event Trigger                | P0       |
| F71        | Pull Request Event Trigger          | P0       |
| F72        | Schedule Event Trigger              | P0       |
| F73        | Pull Request Review Comment Trigger | P0       |
| F75        | Prompt Input Required Validation    | P0       |
| F76        | Draft PR Skip                       | P0       |

## Technical Specification

### 1. Extended Trigger Types (`src/lib/triggers/types.ts`)

```typescript
/**
 * Extended trigger types for v1.2.
 * Adds issues, pull_request, pull_request_review_comment, and schedule.
 */
export const TRIGGER_TYPES = [
  "issue_comment",
  "discussion_comment",
  "workflow_dispatch",
  "issues",
  "pull_request",
  "pull_request_review_comment",
  "schedule",
  "unsupported",
] as const

export type TriggerType = (typeof TRIGGER_TYPES)[number]

/**
 * Extended skip reasons for v1.2.
 */
export const SKIP_REASONS = [
  "action_not_created",
  "action_not_supported",
  "draft_pr",
  "issue_locked",
  "no_mention",
  "prompt_required",
  "self_comment",
  "unauthorized_author",
  "unsupported_event",
] as const

export type SkipReason = (typeof SKIP_REASONS)[number]

/**
 * Extended trigger target for PR review comments.
 */
export interface TriggerTarget {
  readonly kind: "discussion" | "issue" | "manual" | "pr" | "review_comment"
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly locked: boolean
  /** For PR review comments: file path */
  readonly path?: string
  /** For PR review comments: line number */
  readonly line?: number
  /** For PR review comments: diff hunk */
  readonly diffHunk?: string
  /** For PR review comments: commit ID */
  readonly commitId?: string
  /** For PRs: whether it's a draft */
  readonly isDraft?: boolean
}

/**
 * Extended trigger configuration.
 */
export interface TriggerConfig {
  readonly botLogin: string | null
  readonly requireMention: boolean
  readonly allowedAssociations: readonly string[]
  /** Skip draft PRs by default */
  readonly skipDraftPRs: boolean
  /** Custom prompt input (for schedule/workflow_dispatch) */
  readonly promptInput: string | null
}

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  botLogin: null,
  requireMention: true,
  allowedAssociations: ALLOWED_ASSOCIATIONS,
  skipDraftPRs: true,
  promptInput: null,
} as const
```

### 2. Extended Event Router (`src/lib/triggers/router.ts`)

```typescript
/**
 * Classify event name to trigger type.
 * Extended for v1.2 triggers.
 */
export function classifyTrigger(eventName: string): TriggerType {
  switch (eventName) {
    case "issue_comment":
      return "issue_comment"
    case "discussion":
    case "discussion_comment":
      return "discussion_comment"
    case "workflow_dispatch":
      return "workflow_dispatch"
    case "issues":
      return "issues"
    case "pull_request":
      return "pull_request"
    case "pull_request_review_comment":
      return "pull_request_review_comment"
    case "schedule":
      return "schedule"
    default:
      return "unsupported"
  }
}

/**
 * Build context for issues events.
 */
function buildIssuesContextData(payload: IssuesPayload, botLogin: string | null): IssuesContextData {
  const issue = payload.issue
  const action = payload.action

  const author: AuthorInfo = {
    login: issue.user.login,
    association: issue.author_association,
    isBot: issue.user.login.endsWith("[bot]"),
  }

  const target: TriggerTarget = {
    kind: "issue",
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    locked: issue.locked,
  }

  // For 'edited' action, check for @mention in body
  const hasMention = action === "edited" && botLogin != null ? hasBotMention(issue.body ?? "", botLogin) : false

  return {
    author,
    target,
    commentBody: issue.body ?? null,
    commentId: null,
    hasMention,
    command: null,
    action,
  }
}

/**
 * Build context for pull_request events.
 */
function buildPullRequestContextData(payload: PullRequestPayload): PullRequestContextData {
  const pr = payload.pull_request
  const action = payload.action

  const author: AuthorInfo = {
    login: pr.user.login,
    association: pr.author_association,
    isBot: pr.user.login.endsWith("[bot]"),
  }

  const target: TriggerTarget = {
    kind: "pr",
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    locked: pr.locked,
    isDraft: pr.draft,
  }

  return {
    author,
    target,
    commentBody: pr.body ?? null,
    commentId: null,
    hasMention: false,
    command: null,
    action,
    isDraft: pr.draft,
  }
}

/**
 * Build context for pull_request_review_comment events.
 */
function buildPRReviewCommentContextData(
  payload: PRReviewCommentPayload,
  botLogin: string | null,
): PRReviewCommentContextData {
  const comment = payload.comment
  const pr = payload.pull_request

  const author: AuthorInfo = {
    login: comment.user.login,
    association: comment.author_association,
    isBot: comment.user.login.endsWith("[bot]"),
  }

  const target: TriggerTarget = {
    kind: "review_comment",
    number: pr.number,
    title: pr.title,
    body: comment.body,
    locked: pr.locked,
    path: comment.path,
    line: comment.line ?? comment.original_line,
    diffHunk: comment.diff_hunk,
    commitId: comment.commit_id,
  }

  const hasMention = botLogin != null ? hasBotMention(comment.body, botLogin) : false
  const command = hasMention ? extractCommand(comment.body, botLogin!) : null

  return {
    author,
    target,
    commentBody: comment.body,
    commentId: comment.id,
    hasMention,
    command,
  }
}

/**
 * Build context for schedule events.
 */
function buildScheduleContextData(
  payload: SchedulePayload,
  actor: string,
  promptInput: string | null,
): ScheduleContextData {
  const target: TriggerTarget = {
    kind: "manual",
    number: 0,
    title: "Scheduled workflow",
    body: promptInput,
    locked: false,
  }

  const author: AuthorInfo = {
    login: actor,
    association: "OWNER",
    isBot: false,
  }

  return {
    author,
    target,
    commentBody: promptInput,
    commentId: null,
    hasMention: false,
    command: null,
  }
}
```

### 3. Extended Skip Conditions

```typescript
/**
 * Check skip conditions for issues events.
 */
function checkIssuesSkipConditions(context: TriggerContext, config: TriggerConfig, logger: Logger): SkipCheckResult {
  const payload = context.raw.payload as IssuesPayload
  const action = payload.action

  // Only support 'opened' and 'edited' actions
  if (action !== "opened" && action !== "edited") {
    logger.debug("Skipping unsupported issues action", {action})
    return {
      shouldSkip: true,
      reason: "action_not_supported",
      message: `Issues action '${action}' is not supported (only 'opened' and 'edited')`,
    }
  }

  // For 'edited', require @mention
  if (action === "edited" && !context.hasMention) {
    logger.debug("Skipping issues.edited without bot mention")
    return {
      shouldSkip: true,
      reason: "no_mention",
      message: "Issue edit does not mention the bot",
    }
  }

  return {shouldSkip: false}
}

/**
 * Check skip conditions for pull_request events.
 */
function checkPullRequestSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
): SkipCheckResult {
  const payload = context.raw.payload as PullRequestPayload
  const action = payload.action

  // Only support 'opened', 'synchronize', 'reopened' actions
  const supportedActions = ["opened", "synchronize", "reopened"]
  if (!supportedActions.includes(action)) {
    logger.debug("Skipping unsupported pull_request action", {action})
    return {
      shouldSkip: true,
      reason: "action_not_supported",
      message: `Pull request action '${action}' is not supported`,
    }
  }

  // Skip draft PRs if configured
  if (config.skipDraftPRs && payload.pull_request.draft) {
    logger.debug("Skipping draft pull request")
    return {
      shouldSkip: true,
      reason: "draft_pr",
      message: "Pull request is a draft",
    }
  }

  return {shouldSkip: false}
}

/**
 * Check skip conditions for schedule/workflow_dispatch.
 * Hard fail if prompt input is empty.
 */
function checkPromptRequiredSkipConditions(
  context: TriggerContext,
  config: TriggerConfig,
  logger: Logger,
): SkipCheckResult {
  const promptInput = config.promptInput

  if (promptInput == null || promptInput.trim().length === 0) {
    logger.error("Prompt input required for scheduled/manual triggers")
    return {
      shouldSkip: true,
      reason: "prompt_required",
      message: "Prompt input is required for schedule/workflow_dispatch triggers",
    }
  }

  return {shouldSkip: false}
}

/**
 * Extended checkSkipConditions for all trigger types.
 */
export function checkSkipConditions(context: TriggerContext, config: TriggerConfig, logger: Logger): SkipCheckResult {
  if (context.triggerType === "unsupported") {
    logger.debug("Skipping unsupported event", {eventName: context.eventName})
    return {
      shouldSkip: true,
      reason: "unsupported_event",
      message: `Unsupported event type: ${context.eventName}`,
    }
  }

  switch (context.triggerType) {
    case "issue_comment":
      return checkIssueCommentSkipConditions(context, config, logger)

    case "discussion_comment":
      return checkDiscussionCommentSkipConditions(context, config, logger)

    case "workflow_dispatch":
      return checkPromptRequiredSkipConditions(context, config, logger)

    case "issues":
      return checkIssuesSkipConditions(context, config, logger)

    case "pull_request":
      return checkPullRequestSkipConditions(context, config, logger)

    case "pull_request_review_comment":
      return checkCommentSkipConditions(context, config, logger, {
        targetLabel: "Pull Request",
        actionLabel: "Review comment",
      })

    case "schedule":
      return checkPromptRequiredSkipConditions(context, config, logger)

    default:
      return {shouldSkip: false}
  }
}
```

### 4. Trigger Directives (`src/lib/agent/prompt.ts`)

````typescript
import type {TriggerContext} from "../triggers/types.js"
import type {ActionInputs} from "../types.js"

/**
 * Trigger directive configuration.
 */
interface TriggerDirective {
  /** Default task instruction for this trigger */
  readonly directive: string
  /** Whether custom prompt appends (true) or replaces (false) */
  readonly appendMode: boolean
}

/**
 * Get trigger-specific directive for the agent prompt.
 *
 * Each trigger type has a default task directive that instructs the agent
 * on what to do. Custom prompt input can either append to or replace the
 * default directive depending on the trigger type.
 *
 * @param context - Trigger context from event routing
 * @param inputs - Action inputs including custom prompt
 * @returns Trigger directive with instruction text
 */
export function getTriggerDirective(context: TriggerContext, inputs: ActionInputs): TriggerDirective {
  const customPrompt = inputs.prompt?.trim() ?? ""

  switch (context.triggerType) {
    case "issue_comment":
      return {
        directive: "Respond to the comment above.",
        appendMode: true,
      }

    case "discussion_comment":
      return {
        directive: "Respond to the discussion comment above.",
        appendMode: true,
      }

    case "pull_request_review_comment":
      return {
        directive: buildReviewCommentDirective(context),
        appendMode: true,
      }

    case "issues": {
      const action = (context.raw.payload as {action?: string}).action
      if (action === "opened") {
        return {
          directive: "Triage this issue: summarize, reproduce if possible, propose next steps.",
          appendMode: true,
        }
      }
      return {
        directive: "Respond to the mention in this issue.",
        appendMode: true,
      }
    }

    case "pull_request":
      return {
        directive: "Review this pull request for code quality, potential bugs, and improvements.",
        appendMode: true,
      }

    case "schedule":
    case "workflow_dispatch":
      // No default directive - prompt input is required and replaces
      return {
        directive: customPrompt,
        appendMode: false,
      }

    default:
      return {
        directive: "Execute the requested operation.",
        appendMode: true,
      }
  }
}

/**
 * Build directive for PR review comments with file/line context.
 */
function buildReviewCommentDirective(context: TriggerContext): string {
  const target = context.target
  if (target == null) {
    return "Respond to the review comment with file and code context."
  }

  const lines: string[] = ["Respond to the review comment with the following context:"]
  lines.push("")
  lines.push("<review_comment_context>")

  if (target.path != null) {
    lines.push(`File: ${target.path}`)
  }
  if (target.line != null) {
    lines.push(`Line: ${target.line}`)
  }
  if (target.commitId != null) {
    lines.push(`Commit: ${target.commitId}`)
  }
  if (target.diffHunk != null) {
    lines.push("")
    lines.push("Diff hunk:")
    lines.push("```diff")
    lines.push(target.diffHunk)
    lines.push("```")
  }

  lines.push("</review_comment_context>")

  return lines.join("\n")
}

/**
 * Build the final task section with directive and custom prompt.
 */
export function buildTaskSection(context: TriggerContext, inputs: ActionInputs): string {
  const {directive, appendMode} = getTriggerDirective(context, inputs)
  const customPrompt = inputs.prompt?.trim() ?? ""

  const lines: string[] = ["## Task", ""]

  if (appendMode) {
    lines.push(directive)
    if (customPrompt.length > 0) {
      lines.push("")
      lines.push("### Additional Instructions")
      lines.push("")
      lines.push(customPrompt)
    }
  } else {
    // Replace mode (schedule/workflow_dispatch)
    lines.push(directive)
  }

  lines.push("")
  lines.push("Follow all instructions and requirements listed in this prompt.")

  return lines.join("\n")
}
````

### 5. Integration with `buildAgentPrompt`

Update `buildAgentPrompt()` to use the new task section builder:

```typescript
export function buildAgentPrompt(options: PromptOptions, logger: Logger): string {
  const {context, customPrompt, cacheStatus, sessionContext, triggerContext, inputs} = options
  const parts: string[] = []

  // ... existing sections (Agent Context, Issue/PR Context, Trigger Comment, etc.)

  // Replace hardcoded task section with directive-based one
  if (triggerContext != null && inputs != null) {
    parts.push(buildTaskSection(triggerContext, inputs))
  } else {
    // Fallback for backward compatibility
    if (context.commentBody == null) {
      parts.push(`## Task

Execute the requested operation for repository ${context.repo}. Follow all instructions and requirements listed in this prompt.
`)
    } else {
      parts.push(`## Task

Respond to the trigger comment above. Follow all instructions and requirements listed in this prompt.
`)
    }
  }

  const prompt = parts.join("\n")
  logger.debug("Built agent prompt", {
    length: prompt.length,
    hasCustom: customPrompt != null,
    hasSessionContext: sessionContext != null,
    hasTriggerDirective: triggerContext != null,
  })
  return prompt
}
```

### 6. Payload Type Definitions

Add to `src/lib/github/types.ts`:

```typescript
/**
 * Issues event payload.
 */
export interface IssuesPayload {
  action: "opened" | "edited" | "closed" | "reopened" | "assigned" | string
  issue: {
    number: number
    title: string
    body: string | null
    user: {login: string}
    author_association: string
    locked: boolean
    labels: Array<{name: string}>
  }
}

/**
 * Pull request event payload.
 */
export interface PullRequestPayload {
  action: "opened" | "synchronize" | "reopened" | "closed" | string
  pull_request: {
    number: number
    title: string
    body: string | null
    user: {login: string}
    author_association: string
    locked: boolean
    draft: boolean
    base: {ref: string; repo: {full_name: string}}
    head: {ref: string; sha: string; repo: {full_name: string}}
  }
}

/**
 * Pull request review comment event payload.
 */
export interface PRReviewCommentPayload {
  action: "created" | "edited" | "deleted"
  comment: {
    id: number
    body: string
    user: {login: string}
    author_association: string
    path: string
    line: number | null
    original_line: number | null
    diff_hunk: string
    commit_id: string
  }
  pull_request: {
    number: number
    title: string
    locked: boolean
  }
}

/**
 * Schedule event payload.
 */
export interface SchedulePayload {
  schedule: string
}
```

## Acceptance Criteria

### Trigger Support

- [ ] `issues` event supported with `opened` action (auto-triage behavior)
- [ ] `issues.edited` triggers only when `@fro-bot` mentioned in body
- [ ] `pull_request` event supported with `opened`, `synchronize`, `reopened` actions
- [ ] `pull_request` skips draft PRs by default (configurable via `skipDraftPRs`)
- [ ] `pull_request_review_comment` event supported with `created` action
- [ ] `schedule` event supported with required `prompt` input
- [ ] `workflow_dispatch` hard fails if `prompt` input is empty

### Trigger Directives

- [ ] `getTriggerDirective()` returns appropriate directive for each trigger type
- [ ] `issue_comment` directive: "Respond to the comment above"
- [ ] `discussion_comment` directive: "Respond to the discussion comment above"
- [ ] `issues.opened` directive: "Triage this issue: summarize, reproduce if possible, propose next steps"
- [ ] `issues.edited` directive: "Respond to the mention in this issue"
- [ ] `pull_request` directive: "Review this pull request for code quality, potential bugs, and improvements"
- [ ] `pull_request_review_comment` directive includes file path, line number, diff hunk, commit ID
- [ ] Custom `prompt` input **appends** to directive for comment-based triggers
- [ ] Custom `prompt` input **replaces** directive for `schedule`/`workflow_dispatch`

### Skip Conditions

- [ ] Draft PRs skipped with `draft_pr` reason
- [ ] Empty prompt input fails with `prompt_required` reason for schedule/dispatch
- [ ] Unsupported actions fail with `action_not_supported` reason
- [ ] All existing skip conditions (anti-loop, authorization) still work

## Test Cases

### Trigger Classification Tests

```typescript
describe("classifyTrigger (extended)", () => {
  it("classifies issues event", () => {
    expect(classifyTrigger("issues")).toBe("issues")
  })

  it("classifies pull_request event", () => {
    expect(classifyTrigger("pull_request")).toBe("pull_request")
  })

  it("classifies pull_request_review_comment event", () => {
    expect(classifyTrigger("pull_request_review_comment")).toBe("pull_request_review_comment")
  })

  it("classifies schedule event", () => {
    expect(classifyTrigger("schedule")).toBe("schedule")
  })
})
```

### Skip Condition Tests

```typescript
describe("checkPullRequestSkipConditions", () => {
  it("skips draft PRs by default", () => {
    const context = buildMockPRContext({draft: true})
    const result = checkSkipConditions(context, DEFAULT_TRIGGER_CONFIG, logger)
    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe("draft_pr")
  })

  it("allows draft PRs when skipDraftPRs is false", () => {
    const context = buildMockPRContext({draft: true})
    const config = {...DEFAULT_TRIGGER_CONFIG, skipDraftPRs: false}
    const result = checkSkipConditions(context, config, logger)
    expect(result.shouldSkip).toBe(false)
  })

  it("skips unsupported actions", () => {
    const context = buildMockPRContext({action: "closed"})
    const result = checkSkipConditions(context, DEFAULT_TRIGGER_CONFIG, logger)
    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe("action_not_supported")
  })
})

describe("checkIssuesSkipConditions", () => {
  it("allows opened action", () => {
    const context = buildMockIssuesContext({action: "opened"})
    const result = checkSkipConditions(context, DEFAULT_TRIGGER_CONFIG, logger)
    expect(result.shouldSkip).toBe(false)
  })

  it("requires mention for edited action", () => {
    const context = buildMockIssuesContext({action: "edited", hasMention: false})
    const result = checkSkipConditions(context, DEFAULT_TRIGGER_CONFIG, logger)
    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe("no_mention")
  })

  it("allows edited action with mention", () => {
    const context = buildMockIssuesContext({action: "edited", hasMention: true})
    const result = checkSkipConditions(context, DEFAULT_TRIGGER_CONFIG, logger)
    expect(result.shouldSkip).toBe(false)
  })
})

describe("checkPromptRequiredSkipConditions", () => {
  it("fails when prompt is empty for schedule", () => {
    const context = buildMockScheduleContext()
    const config = {...DEFAULT_TRIGGER_CONFIG, promptInput: ""}
    const result = checkSkipConditions(context, config, logger)
    expect(result.shouldSkip).toBe(true)
    expect(result.reason).toBe("prompt_required")
  })

  it("allows when prompt is provided", () => {
    const context = buildMockScheduleContext()
    const config = {...DEFAULT_TRIGGER_CONFIG, promptInput: "Run daily maintenance"}
    const result = checkSkipConditions(context, config, logger)
    expect(result.shouldSkip).toBe(false)
  })
})
```

### Trigger Directive Tests

```typescript
describe("getTriggerDirective", () => {
  it("returns triage directive for issues.opened", () => {
    const context = buildMockTriggerContext("issues", {action: "opened"})
    const inputs = {prompt: ""}
    const result = getTriggerDirective(context, inputs)
    expect(result.directive).toContain("Triage this issue")
    expect(result.appendMode).toBe(true)
  })

  it("returns review directive for pull_request", () => {
    const context = buildMockTriggerContext("pull_request", {})
    const inputs = {prompt: ""}
    const result = getTriggerDirective(context, inputs)
    expect(result.directive).toContain("Review this pull request")
    expect(result.appendMode).toBe(true)
  })

  it("returns custom prompt for schedule (replace mode)", () => {
    const context = buildMockTriggerContext("schedule", {})
    const inputs = {prompt: "Run daily cleanup"}
    const result = getTriggerDirective(context, inputs)
    expect(result.directive).toBe("Run daily cleanup")
    expect(result.appendMode).toBe(false)
  })

  it("includes file context for review_comment", () => {
    const context = buildMockTriggerContext("pull_request_review_comment", {
      path: "src/main.ts",
      line: 42,
      diffHunk: "@@ -10,3 +10,5 @@\n+new code",
    })
    const inputs = {prompt: ""}
    const result = getTriggerDirective(context, inputs)
    expect(result.directive).toContain("src/main.ts")
    expect(result.directive).toContain("Line: 42")
    expect(result.directive).toContain("new code")
  })
})
```

## Implementation Notes

1. **Backward Compatibility**: Existing `issue_comment`, `discussion_comment`, and `workflow_dispatch` behavior must remain unchanged
2. **Payload Typing**: GitHub payloads are complex; types cover common fields but may need runtime validation
3. **Mention Matching**: Reuse existing `hasBotMention()` function from RFC-005
4. **Context Builder Pattern**: Follow existing pattern of separate context builders per event type
5. **Type Alignment**: Update `EventType` in `src/lib/github/types.ts` to include new event names

## Compatibility with Dependencies

- **RFC-005**: Extends, does not contradict. Adds new trigger types and skip reasons to existing infrastructure.
- **RFC-013**: Uses existing prompt construction patterns. Adds `triggerContext` to `PromptOptions`.
- **RFC-003**: Uses existing GitHub client. Adds new payload type definitions.

---

## Estimated Effort

- **Development**: 8-12 hours
- **Testing**: 4-6 hours
- **Total**: 12-18 hours
