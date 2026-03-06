# TRIGGER ROUTING

**Context**: Centralized event routing and skip-logic gating (RFC-005). Consumes `NormalizedEvent` from `github/context.ts` to determine IF an action should run. Pure logic; no side effects.

## WHERE TO LOOK

| Component | File | Responsibility |
| --- | --- | --- |
| **Router** | `router.ts` | Core `routeEvent()` dispatch (39 L) |
| **Skip (Main)** | `skip-conditions.ts` | Main skip condition orchestrator (41 L) |
| **Skip (Comments)** | `skip-conditions-comment.ts` | Comment-specific skip conditions (68 L) |
| **Skip (PR)** | `skip-conditions-pr.ts` | PR-specific skip conditions (91 L) |
| **Skip (Issues)** | `skip-conditions-issues.ts` | Issue-specific skip conditions (50 L) |
| **Skip (Manual)** | `skip-conditions-manual.ts` | Manual/schedule skip conditions (28 L) |
| **Skip (Types)** | `skip-conditions-types.ts` | Shared skip condition types (10 L) |
| **Context (Main)** | `context-builders.ts` | Main context builder orchestrator (74 L) |
| **Context (Comm)** | `context-builders-comments.ts` | Comment context builders (106 L) |
| **Context (PR/Iss)**| `context-builders-pr-issues.ts`| PR/issue context builders (71 L) |
| **Context (Man)** | `context-builders-manual.ts` | Manual/schedule context builders (67 L) |
| **Context (Types)**| `context-builders-types.ts`| Shared context builder types (11 L) |
| **Utils** | `author-utils.ts` | Author validation utilities (9 L) |
| **Parsing** | `mention-command.ts` | Mention/command parsing (63 L) |
| **Mocking** | `mock.ts` | Synthetic event generation for testing (99 L) |
| **Types** | `types.ts` | `TriggerResult`, `TriggerConfig`, `TriggerContext` (193 L) |],op:

**Context**: Centralized event routing and skip-logic gating (RFC-005). Consumes `NormalizedEvent` from `github/context.ts` to determine IF an action should run. Pure logic; no side effects.

## FILES

- `router.ts`: Core logic (887 lines). Contains `routeEvent`, `checkSkipConditions`, and context builders. Operates on `NormalizedEvent` discriminated union.
- `types.ts`: `TriggerResult` (discriminated union), `TriggerConfig`, `TriggerContext`, `SkipReason` enum.
- `mock.ts`: Synthetic event generation for local testing and CI simulation.
- `__fixtures__/payloads.ts`: Factory-style payload generation using `BASE_*` spread pattern (627 lines).

## KEY EXPORTS

- `routeEvent(context, inputs, config?)`: Main entry. Returns `TriggerResult`.
- `TriggerResult`: Discriminated union. If `shouldProcess: false`, contains `skipReason`.
- `TriggerContext`: Routing context for downstream consumers (prompt builder, agent).
- `SkipReason`: Enum of rejection codes (e.g., `unauthorized_author`, `draft_pr`).
- `DEFAULT_TRIGGER_CONFIG`: Base configuration for routing logic.

## SUPPORTED EVENTS

| Event                         | Supported Actions                   | Prompt Requirement                   |
| :---------------------------- | :---------------------------------- | :----------------------------------- |
| `issue_comment`               | `created`                           | Optional (uses comment body)         |
| `discussion_comment`          | `created`                           | Optional (uses comment body)         |
| `pull_request`                | `opened`, `reopened`, `synchronize` | Optional (reviews code)              |
| `issues`                      | `opened`, `edited`                  | `edited` requires `@fro-bot` mention |
| `schedule`                    | N/A                                 | **Required** (hard fail if empty)    |
| `workflow_dispatch`           | N/A                                 | **Required** (hard fail if empty)    |
| `pull_request_review_comment` | `created`                           | Optional (uses comment body)         |

## SKIP REASONS

- `action_not_created`: Trigger action != `created` (for comments).
- `action_not_supported`: Event action (e.g., `labeled`) is not in the allowlist.
- `draft_pr`: PR is in draft mode (skipped by default).
- `issue_locked`: Target issue or pull request is locked.
- `no_mention`: Missing `@fro-bot` mention in `issues.edited` or required comment events.
- `prompt_required`: `schedule` or `dispatch` events missing prompt input.
- `self_comment`: Bot responding to its own comment (loop protection).
- `unauthorized_author`: Author not `OWNER`, `MEMBER`, or `COLLABORATOR`.

## PATTERNS

- **NormalizedEvent Intake**: Router consumes `NormalizedEvent` from `GitHubContext.event`; never touches raw payloads.
- **Pure Decisioning**: Router MUST NOT call APIs or log triggers. Pure input-to-decision.
- **Discriminated Union**: Narrow `TriggerResult` by `shouldProcess` before accessing `skipReason`.
- **TriggerContext Output**: On `shouldProcess: true`, builds `TriggerContext` consumed by prompt builder.
- **Config Merging**: `routeEvent` applies defaults to partial configurations.
- **Regex Safety**: `hasBotMention` escapes input and uses `\b` boundaries for accuracy.
- **External Classification**: `classifyEventType` resides in `github/context.ts`.
- **Factory Spreads**: `__fixtures__` uses `BASE_*` templates + property overrides.

## ANTI-PATTERNS

- **Side Effects**: Never trigger external actions (API calls, logs) inside router logic.
- **Hardcoded Config**: Always use `TriggerConfig` injection or defaults.
- **Implicit Defaults**: Make skip-logic thresholds and logic explicit.
