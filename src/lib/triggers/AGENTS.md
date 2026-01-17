# TRIGGERS MODULE

**Scope:** Centralized event routing and skip-logic gating (RFC-005). Determines IF an action should run based on payload, config, and permissions. Pure logic; no side effects.

## WHERE TO LOOK

| Component    | File                       | Purpose                                                      |
| ------------ | -------------------------- | ------------------------------------------------------------ |
| **Router**   | `router.ts`                | Core logic (`routeEvent`, `checkSkipConditions`). 882 lines. |
| **Types**    | `types.ts`                 | `TriggerResult`, `TriggerConfig`, `SkipReason`               |
| **Mock**     | `mock.ts`                  | Synthetic event generation for local testing                 |
| **Fixtures** | `__fixtures__/payloads.ts` | Test payload factories (660 lines)                           |

## KEY EXPORTS

```typescript
routeEvent(context, inputs, config?)  // Main entry. Returns TriggerResult.
TriggerResult                         // Discriminated union (shouldProcess: boolean)
SkipReason                            // Enum of rejection codes
DEFAULT_TRIGGER_CONFIG                // Base configuration
```

## EVENT TYPES

| Event                         | Supported Actions                   | Constraints                 |
| ----------------------------- | ----------------------------------- | --------------------------- |
| `issue_comment`               | `created`                           | Optional prompt             |
| `discussion_comment`          | `created`                           | Optional prompt             |
| `pull_request`                | `opened`, `reopened`, `synchronize` | Skips drafts (configurable) |
| `issues`                      | `opened`, `edited`                  | `edited` requires mention   |
| `schedule`                    | N/A                                 | **Requires** prompt input   |
| `workflow_dispatch`           | N/A                                 | **Requires** prompt input   |
| `pull_request_review_comment` | `created`                           | —                           |

## SKIP REASONS

| Reason                | Description                                |
| --------------------- | ------------------------------------------ |
| `action_not_created`  | Trigger action != `created` (comments)     |
| `draft_pr`            | PR is in draft mode (default behavior)     |
| `no_mention`          | Missing `@fro-bot` in `issues.edited`      |
| `prompt_required`     | `schedule`/`dispatch` missing input        |
| `self_comment`        | Bot responding to itself (loop protection) |
| `unauthorized_author` | Author not OWNER/MEMBER/COLLABORATOR       |

## PATTERNS

- **Discriminated Union**: Check `shouldProcess` before accessing `skipReason`
- **Config Merging**: `routeEvent` applies defaults to partial configs
- **Regex Safety**: `hasBotMention` escapes input, uses `\b` boundaries
- **External Classification**: Event classification logic in `github/context.ts` (`classifyEventType`)

## ANTI-PATTERNS

| Forbidden         | Reason                                                       |
| ----------------- | ------------------------------------------------------------ |
| Side effects      | Router must NOT call APIs or log triggers (pure decisioning) |
| Hardcoded config  | Always use `TriggerConfig` injection                         |
| Implicit defaults | Rely on `DEFAULT_TRIGGER_CONFIG`, don't reinvent             |
