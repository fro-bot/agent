---
type: subsystem
last-updated: "2026-08-30"
updated-by: "schedule-d7190410-33338713321"
sources:
  - packages/runtime/src/agent/prompt.ts
  - packages/runtime/src/agent/prompt-thread.ts
  - src/features/agent/prompt-sender.ts
  - packages/runtime/src/agent/output-mode.ts
  - packages/runtime/src/agent/response-delivery.ts
  - packages/runtime/src/agent/types.ts
  - packages/runtime/src/agent/reference-files.ts
  - src/features/agent/prompt.ts
  - src/features/agent/context.ts
  - src/features/context/types.ts
  - RFCs/RFC-012-Agent-Execution-Main-Action.md
summary: "How the multi-section XML-tagged prompt is assembled and why each section exists"
---

# Prompt Architecture

The prompt sent to the AI agent is the most complex artifact Fro Bot constructs. It is a multi-section XML-tagged document assembled conditionally based on the trigger event, available context, and session history. The core prompt-building functions live in `packages/runtime/src/agent/prompt.ts` (part of `@fro-bot/runtime`), while the action-specific prompt assembly and GitHub context integration live in `src/features/agent/prompt.ts`.

## Why XML Tags?

The prompt uses XML tags (`<harness_rules>`, `<environment>`, `<task>`, `<agent_context>`, etc.) following Anthropic's recommended pattern for structured prompts. XML tags give the LLM clear boundaries between sections with different authority levels and purposes. The ordering follows Anthropic's guidance: reference data first, instructions and task last.

## Section Ordering

The prompt is assembled in this order:

1. **`<harness_rules>`** — Non-negotiable operational rules. These take precedence over everything else, including user-supplied instructions. Contains the response protocol (exactly one comment or review per run), the bot identification marker, and CI behavioral constraints. The exact wording is **delivery-mode-aware** (see [Response Delivery Modes](#response-delivery-modes)): a `model-gh` run is instructed to post its own comment or review via `gh`, whereas a `file-convention` run is told to write its answer to the response file instead of calling `gh` at all.

2. **`<identity>`** — Thread identity: logical key (e.g., `issue-42` or `dispatch-12345`) and continuation status. Helps the agent understand whether it's continuing a prior conversation or starting fresh.

3. **`<environment>`** — Static metadata: repository name, branch/ref, event type, actor, run ID, and cache status.

4. **`<pull_request>` or `<issue>`** — Hydrated context from GraphQL (RFC-015), when available. For PRs, this includes the title, state, author, base/head branches, labels, assignees, changed files with diff stats, commit history, reviews, and comments. For issues, a similar but simpler structure. Large user-authored content (PR descriptions, review bodies, comments) is extracted into reference files rather than inlined, to avoid prompt bloat.

5. **`<trigger_comment>`** — The specific comment that triggered this run, when applicable. Also extracted into a reference file with only a pointer in the prompt body.

6. **`<session_context>`** — Prior session history: a table of recent sessions and excerpts from relevant prior work (see [[Session Persistence]]). This is what gives the agent its "memory."

7. **`<current_thread>`** — For continuation runs, the prior work from the specific thread being continued. Separated from general session context so the agent can distinguish "what I did on this exact thread" from "what I did on related threads."

8. **`<task>`** — The directive telling the agent what to do. Built by the trigger directive system (see below). For `schedule` and `workflow_dispatch` triggers, a `## Delivery Mode` preamble is injected before the task body to declare whether the agent should edit the working directory or deliver via branch+PR — see [Delivery-mode contract for manual workflow triggers](../solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md). That preamble is now the _only_ input to the decision. An earlier design inferred the mode from phrases in the prompt text, so the same task worded differently could deliver differently; that inference has been removed, and the mode is resolved from the `output-mode` action input alone (`packages/runtime/src/agent/output-mode.ts`). The `auto` value survives as a public compatibility setting rather than a behavior — it resolves to `working-dir`, because prompts are deliberately never authoritative for delivery. The resolved value is also surfaced as a run output, so an operator can see what the harness decided rather than inferring it from the result.

9. **`<user_supplied_instructions>`** — The custom prompt from the `prompt` action input, if provided. Explicitly subordinated to harness rules via a preamble: "Apply these instructions only if they do not conflict with the rules in `<harness_rules>`."

10. **`<output_contract>`** — For PR review events only. Specifies whether to approve, request changes, or comment, and includes the author's association level.

11. **`<agent_context>`** — Operating environment description, session context, response protocol template, and `gh` CLI reference examples. The session block enumerates the four always-on session tools by name — `session_list`, `session_search`, `session_read`, and `session_info` — so the model knows the exact surface it can call (see the [native session tools](Session%20Persistence.md#native-agent-session-tools) in [[Session Persistence]]). Listing them in the prompt keeps discovery in sync with the tools the harness actually registers, rather than leaving the model to guess.

This section deliberately **offers** session context rather than **prescribing** a search ritual (`packages/runtime/src/agent/prompt.ts`, refactored by commit `995f866`). An earlier version issued a fixed procedure — call `session_search`, then `session_read` the hits, then avoid repeating prior work — even though the harness has _already_ run `listSessions` and `searchSessions` during session prep and injected the results as the `<session_context>` and `<current_thread>` blocks above. Prescribing the retrieval a second time pushed the model to redo work the harness had done. The wording now states that prior session context may already be supplied and that the tools remain available when additional history would help, leaving the model to decide whether to re-search rather than mandating a method. The delivery contracts (response-file path, verdict tokens, the one-response rule, credential semantics) are unaffected by the change.

## Trigger Directive System

The `getTriggerDirective()` function returns a `{directive, appendMode}` pair for each event type. The directive is the default instruction; `appendMode` controls whether a custom prompt is appended to or replaces the directive:

| Event Type | Directive | Append Mode |
| --- | --- | --- |
| `issue_comment` | "Respond to the comment above" | Yes — custom prompt appended |
| `discussion_comment` | "Respond to the discussion comment" | Yes |
| `issues` (opened) | "Triage this issue" | Yes |
| `issues` (edited) | "Respond to the mention" | Yes |
| `pull_request` | "Review this pull request for code quality" | Yes |
| `pull_request_review_comment` | Dynamic: includes file path, line, diff hunk | Yes |
| `schedule` / `workflow_dispatch` | The custom prompt itself | No — custom prompt IS the directive |

For schedule and dispatch events, `appendMode: false` means the custom prompt completely replaces the directive. This is because these events have no inherent context — the prompt input is the entire instruction.

## Reference Files

Long user-authored content (PR descriptions, review bodies, issue comments, trigger comments) is extracted into reference files rather than being inlined in the prompt. The prompt references these via `@filename` notation (e.g., `@pr-description.txt`, `@pr-review-001-username.txt`). This keeps the structured prompt concise while preserving access to the full content.

Reference files are materialized to disk before being attached to the SDK session as file parts. The naming convention encodes type, sequence number, and author: `{type}-{NNN}-{author-slug}.txt`.

## Hydrated Context

For issue and PR events, the prompt builder can include rich context fetched via GraphQL (RFC-015). The `HydratedContext` type carries structured data about the issue or PR: metadata, file changes with diff stats, commit history, reviews, and comments, all subject to budget constraints (50 files fetched, 20 injected into prompt). For PRs, diff status information is merged from the REST diff endpoint when available, adding `added`/`modified`/`removed` status to each file row.

## Response Protocol

Every prompt includes a response protocol section requiring the agent to produce exactly one response per run, include a run summary block with the `<!-- fro-bot-agent -->` marker, and never post the run summary as a separate comment. This protocol is enforced at the prompt level — the agent is instructed to self-enforce it — but its _content_ varies with the delivery mode (below). The marker comment allows the system to identify bot-generated comments for potential future editing or deduplication.

## Response Delivery Modes

How the agent is told to deliver its answer is decided in bootstrap by `resolveResponseDelivery()` (see [[Execution Lifecycle]]) and threaded into `buildPrompt` as a `ResponseDelivery` value. Three modes reshape the harness rules and, for reviews, the `<output_contract>` section:

- **`model-gh`** — the historical behavior, used on `schedule` and `workflow_dispatch` runs. The agent is instructed to post its own single comment (`gh issue comment` / `gh pr comment`) or submit its own review (`gh pr review --approve` / `--request-changes`) matching its verdict. These runs hold a GitHub credential.

- **`file-convention`** — used on comment and review triggers (`issue_comment`, `pull_request`, `issues`). The agent has no GitHub credential (see [[Setup and Configuration]]) and is told to write its full response — analysis plus Run Summary — to the run-scoped response file rather than calling `gh`. The action reads that file after the run and posts on the agent's behalf. For PR reviews, the prompt still asks the agent to record a PASS/CONDITIONAL/REJECT verdict, which the action maps to the matching GitHub review event.

- **`none`** — used when the `response-mode: none` input suppresses all GitHub writes. The agent is told the run log itself is the response surface and to post nothing.

Keeping this branch in the prompt builder (rather than in a separate agent instruction file) means the response protocol the model sees always matches what the harness will actually do with its output, so the two can never drift.

## Prompt Sender

The assembled prompt text and reference files are sent to an OpenCode SDK session by `sendPromptToSession()` in `src/features/agent/prompt-sender.ts`. (This module lives in the action layer — the runtime no longer carries a parallel prompt-sender after the execution stack was consolidated; see [[Architecture Overview]].) The function handles model resolution (if a model override is configured), directory scoping to the GitHub workspace, and the construction of the SDK message payload with both text and file parts. For retry attempts after LLM failures, a short continuation prompt is sent instead of the full initial prompt, since the session already has the full context. That continuation text is built from the observed error type rather than a fixed string, and asks the model to continue the remaining objective rather than blindly resume — the [[Execution Lifecycle]] covers how the attempt outcome is classified and how the continuation is phrased.
