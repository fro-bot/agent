# TRIGGERS MODULE

**Overview**: Event routing and skip-condition gating for GitHub triggers (RFC-005).

## WHERE TO LOOK

| Component   | File               | Responsibility                                       |
| ----------- | ------------------ | ---------------------------------------------------- |
| **Router**  | `router.ts`        | `routeEvent()`, `checkSkipConditions()`, skip checks |
| **Types**   | `types.ts`         | `TriggerContext`, `TriggerResult`, `SkipReason`      |
| **Issue**   | `issue-comment.ts` | Issue/PR comment handling                            |
| **Mock**    | `mock.ts`          | Local testing with synthetic events                  |
| **Exports** | `index.ts`         | Public API surface                                   |

## KEY EXPORTS

```typescript
routeEvent(githubContext, logger, config) // Main entry: route event + skip-check
checkSkipConditions(context, config, logger) // Evaluate all skip rules
hasBotMention(text, botLogin) // Detect @mention in comment
extractCommand(text, botLogin) // Parse command after mention
```

> **Note**: Event type classification (`classifyEventType`) is now in `github/context.ts`.

## EVENT TYPES

Uses `EventType` from `github/types.ts`:

| Type                          | GitHub Event                 | Notes                        |
| ----------------------------- | ---------------------------- | ---------------------------- |
| `issue_comment`               | `issue_comment`              | Issues and PRs               |
| `discussion_comment`          | `discussion`, `discussion_comment` | GitHub Discussions     |
| `issues`                      | `issues`                     | Issue opened/edited          |
| `pull_request`                | `pull_request`               | PR opened/sync/reopen        |
| `pull_request_review_comment` | `pull_request_review_comment`| Review comments on PRs       |
| `schedule`                    | `schedule`                   | Cron-triggered runs          |
| `workflow_dispatch`           | `workflow_dispatch`          | Manual trigger               |
| `unsupported`                 | Everything else              | Skipped immediately          |

## SKIP REASONS

| Reason                | Condition                                       |
| --------------------- | ----------------------------------------------- |
| `action_not_created`  | Comment edited/deleted, not created             |
| `action_not_supported`| Issues/PR action not in supported list          |
| `draft_pr`            | PR is a draft (when `skipDraftPRs=true`)        |
| `issue_locked`        | Target issue/PR/discussion is locked            |
| `no_mention`          | Bot not @mentioned (when `requireMention=true`) |
| `prompt_required`     | Schedule/dispatch missing prompt input          |
| `self_comment`        | Comment from bot itself (anti-loop)             |
| `unauthorized_author` | Author not in `ALLOWED_ASSOCIATIONS`            |
| `unsupported_event`   | Event type not handled                          |

## PATTERNS

- **Discriminated Union**: `TriggerResult` is `{shouldProcess: true}` or `{shouldProcess: false, skipReason, skipMessage}`
- **Config Merging**: `routeEvent()` merges partial config with `DEFAULT_TRIGGER_CONFIG`
- **Regex Escaping**: `hasBotMention()` escapes special chars in bot login
- **Word Boundary**: Mention pattern uses `(?:$|[^\w])` to avoid partial matches

## ANTI-PATTERNS

| Pattern                    | Why                                               |
| -------------------------- | ------------------------------------------------- |
| Hardcoding bot name        | Use `config.login` (actor from event context)     |
| Checking `payload.action`  | Use `checkSkipConditions()` for consistent gating |
| Ignoring `TriggerResult`   | Always check `shouldProcess` before proceeding    |
| Direct association compare | Use `ALLOWED_ASSOCIATIONS` constant               |
