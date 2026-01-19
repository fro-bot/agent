# TRIGGER ROUTING

**Context**: Centralized event routing and skip-logic gating (RFC-005). Determines IF an action should run based on payload, config, and permissions. Pure logic; no side effects.

## FILES

- `router.ts`: Core logic (882 lines). Contains `routeEvent`, `checkSkipConditions`, and context builders.
- `types.ts`: `TriggerResult` (discriminated union), `TriggerConfig`, `SkipReason` enum.
- `mock.ts`: Synthetic event generation for local testing and CI simulation.
- `__fixtures__/payloads.ts`: Factory-style payload generation using `BASE_*` spread pattern (627 lines).

## KEY EXPORTS

- `routeEvent(context, inputs, config?)`: Main entry. Returns `TriggerResult`.
- `TriggerResult`: Discriminated union. If `shouldProcess: false`, contains `skipReason`.
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
- `draft_pr`: PR is in draft mode (skipped by default).
- `no_mention`: Missing `@fro-bot` mention in `issues.edited` events.
- `prompt_required`: `schedule` or `dispatch` events missing prompt input.
- `self_comment`: Bot responding to its own comment (loop protection).
- `unauthorized_author`: Author not `OWNER`, `MEMBER`, or `COLLABORATOR`.

## PATTERNS

- **Pure Decisioning**: Router MUST NOT call APIs or log triggers. Pure input-to-decision.
- **Discriminated Union**: Narrow `TriggerResult` by `shouldProcess` before accessing `skipReason`.
- **Config Merging**: `routeEvent` applies defaults to partial configurations.
- **Regex Safety**: `hasBotMention` escapes input and uses `\b` boundaries for accuracy.
- **External Classification**: `classifyEventType` resides in `github/context.ts`.
- **Factory Spreads**: `__fixtures__` uses `BASE_*` templates + property overrides.

## ANTI-PATTERNS

- **Side Effects**: Never trigger external actions (API calls, logs) inside router logic.
- **Hardcoded Config**: Always use `TriggerConfig` injection or defaults.
- **Implicit Defaults**: Make skip-logic thresholds and logic explicit.
