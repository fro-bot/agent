# TRIGGERS MODULE

**Overview**: Event routing and skip-condition gating for GitHub triggers (RFC-005).

## WHERE TO LOOK

| Component   | File               | Responsibility                                    |
| ----------- | ------------------ | ------------------------------------------------- |
| **Router**  | `router.ts`        | `routeEvent()`, `checkSkipConditions()`, classify |
| **Types**   | `types.ts`         | `TriggerContext`, `TriggerResult`, `SkipReason`   |
| **Issue**   | `issue-comment.ts` | Issue/PR comment handling                         |
| **Mock**    | `mock.ts`          | Local testing with synthetic events               |
| **Exports** | `index.ts`         | Public API surface                                |

## KEY EXPORTS

```typescript
routeEvent(githubContext, logger, config) // Main entry: classify + skip-check
classifyTrigger(eventName) // Map event name to TriggerType
checkSkipConditions(context, config, logger) // Evaluate all skip rules
hasBotMention(text, botLogin) // Detect @mention in comment
extractCommand(text, botLogin) // Parse command after mention
```

## TRIGGER TYPES

| Type                 | GitHub Event         | Notes                        |
| -------------------- | -------------------- | ---------------------------- |
| `issue_comment`      | `issue_comment`      | Issues and PRs               |
| `discussion_comment` | `discussion_comment` | GitHub Discussions           |
| `workflow_dispatch`  | `workflow_dispatch`  | Manual trigger (always runs) |
| `unsupported`        | Everything else      | Skipped immediately          |

## SKIP REASONS

| Reason                | Condition                                       |
| --------------------- | ----------------------------------------------- |
| `action_not_created`  | Comment edited/deleted, not created             |
| `issue_locked`        | Target issue/PR/discussion is locked            |
| `no_mention`          | Bot not @mentioned (when `requireMention=true`) |
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
