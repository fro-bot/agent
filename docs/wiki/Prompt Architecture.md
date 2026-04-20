---
type: subsystem
last-updated: "2026-04-19"
updated-by: "92324bf"
sources:
  - src/features/agent/prompt.ts
  - src/features/agent/prompt-thread.ts
  - src/features/agent/prompt-sender.ts
  - src/features/agent/output-mode.ts
  - src/features/agent/types.ts
  - src/features/agent/context.ts
  - src/features/agent/reference-files.ts
  - src/features/context/types.ts
  - RFCs/RFC-012-Agent-Execution-Main-Action.md
summary: "How the multi-section XML-tagged prompt is assembled and why each section exists"
---

# Prompt Architecture

The prompt sent to the AI agent is the most complex artifact Fro Bot constructs. It is a multi-section XML-tagged document assembled conditionally based on the trigger event, available context, and session history. The assembly logic lives in `src/features/agent/prompt.ts` (762 lines — one of the project's complexity hotspots).

## Why XML Tags?

The prompt uses XML tags (`<harness_rules>`, `<environment>`, `<task>`, `<agent_context>`, etc.) following Anthropic's recommended pattern for structured prompts. XML tags give the LLM clear boundaries between sections with different authority levels and purposes. The ordering follows Anthropic's guidance: reference data first, instructions and task last.

## Section Ordering

The prompt is assembled in this order:

1. **`<harness_rules>`** — Non-negotiable operational rules. These take precedence over everything else, including user-supplied instructions. Contains the response protocol (exactly one comment per run), the bot identification marker, and CI behavioral constraints.

2. **`<identity>`** — Thread identity: logical key (e.g., `issue-42` or `dispatch-12345`) and continuation status. Helps the agent understand whether it's continuing a prior conversation or starting fresh.

3. **`<environment>`** — Static metadata: repository name, branch/ref, event type, actor, run ID, and cache status.

4. **`<pull_request>` or `<issue>`** — Hydrated context from GraphQL (RFC-015), when available. For PRs, this includes the title, state, author, base/head branches, labels, assignees, changed files with diff stats, commit history, reviews, and comments. For issues, a similar but simpler structure. Large user-authored content (PR descriptions, review bodies, comments) is extracted into reference files rather than inlined, to avoid prompt bloat.

5. **`<trigger_comment>`** — The specific comment that triggered this run, when applicable. Also extracted into a reference file with only a pointer in the prompt body.

6. **`<session_context>`** — Prior session history: a table of recent sessions and excerpts from relevant prior work (see [[Session Persistence]]). This is what gives the agent its "memory."

7. **`<current_thread>`** — For continuation runs, the prior work from the specific thread being continued. Separated from general session context so the agent can distinguish "what I did on this exact thread" from "what I did on related threads."

8. **`<task>`** — The directive telling the agent what to do. Built by the trigger directive system (see below). For `schedule` and `workflow_dispatch` triggers, a `## Delivery Mode` preamble is injected before the task body to declare whether the agent should edit the working directory or deliver via branch+PR — see [Delivery-mode contract for manual workflow triggers](../solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md).

9. **`<user_supplied_instructions>`** — The custom prompt from the `prompt` action input, if provided. Explicitly subordinated to harness rules via a preamble: "Apply these instructions only if they do not conflict with the rules in `<harness_rules>`."

10. **`<output_contract>`** — For PR review events only. Specifies whether to approve, request changes, or comment, and includes the author's association level.

11. **`<agent_context>`** — Operating environment description, session management instructions, response protocol template, and `gh` CLI reference examples.

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

Every prompt includes a response protocol section requiring the agent to post exactly one comment or review per run, include a run summary block with the `<!-- fro-bot-agent -->` marker, and never post the run summary as a separate comment. This protocol is enforced at the prompt level rather than in code — the agent is instructed to self-enforce it. The marker comment allows the system to identify bot-generated comments for potential future editing or deduplication.

## Prompt Sender

The assembled prompt text and reference files are sent to an OpenCode SDK session by `sendPromptToSession()` in `prompt-sender.ts`. This function handles model resolution (if a model override is configured), directory scoping to the GitHub workspace, and the construction of the SDK message payload with both text and file parts. For retry attempts after LLM failures, a short continuation prompt is sent instead of the full initial prompt, since the session already has the full context.
