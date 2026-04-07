---
title: "refactor: Migrate prompt structure to XML-tagged architecture"
type: refactor
status: completed
date: 2026-04-07
origin: docs/brainstorms/2026-04-07-prompt-xml-architecture-requirements.md
deepened: 2026-04-07
---

# Migrate Prompt Structure to XML-Tagged Architecture

## Overview

Refactor the Fro Bot CI agent prompt from flat markdown sections to XML-tagged semantic blocks with explicit authority hierarchy and Anthropic-recommended section ordering. User-supplied instructions get a clearly-delimited, lower-authority block. Reference context moves before task/instructions per long-context guidance.

## Problem Frame

The prompt is a ~150-line user message sent via OpenCode's SDK. All content — harness rules, reference context, user instructions, task directives — renders as flat markdown with `##` headers. User-supplied prompts contain headings (`## Verdict`, `### Blocking issues`) syntactically identical to our structure. No explicit authority hierarchy tells the model which instructions take precedence. Anthropic guidance recommends XML tags for semantic boundaries in mixed-content prompts (see origin: `docs/brainstorms/2026-04-07-prompt-xml-architecture-requirements.md`).

## Requirements Trace

- R1. Wrap all major prompt blocks in descriptive XML tags
- R2. Wrap user-supplied instructions in `<user_supplied_instructions>` with precedence line
- R3. Reorder: reference data near top, task/instructions/contract near end
- R4. Replace `## Critical Rules` with `<harness_rules>` XML block at top
- R5. Remove `## Reminder: Critical Rules` bottom section
- R6. Keep `@filename.txt` references inline within XML-tagged sections
- R7. Preserve markdown inside XML blocks (hybrid approach)
- R8. Keep all section-building functions pure (no I/O)

## Scope Boundaries

- NOT changing existing section prose — structural changes (XML tags, precedence lines, section removal/replacement) are in scope per R2/R4/R5
- NOT adding structured output/tool schemas for review format enforcement
- NOT modifying the system prompt (controlled by OpenCode)
- NOT changing `PromptResult` return type or `execution.ts`/`reference-files.ts`

## Context & Research

### Relevant Code and Patterns

- `src/features/agent/prompt.ts` — `buildAgentPrompt()` orchestrates 15 section builders/inline blocks. Pure function returning `PromptResult`.
- `src/features/agent/prompt.test.ts` — 50+ tests covering section ordering, content, attachments, sessions
- `src/shared/format.ts` — `cleanMarkdownBody()` for external content sanitization
- `src/features/agent/context.ts` — `collectAgentContext()` assembles `AgentContext`

### Current Section Order (lines 130-283 of prompt.ts)

```
1.  buildNonNegotiableRulesSection()        → ## Critical Rules (NON-NEGOTIABLE)
2.  buildThreadIdentitySection()            → ## Thread Identity
3.  inline                                  → ## Environment
4.  buildHydratedContextSection()           → ## Pull Request #N / ## Issue #N
    OR buildDiffOnlyPullRequestSection()
    OR inline basic issue/PR header
5.  buildHistoricalSessionContext()          → ## Prior Session Context / ## Related Historical Context
6.  inline (conditional)                    → ## Trigger Comment
7.  buildTaskSection()                      → ## Task
8.  buildCurrentThreadContextSection()      → ## Current Thread Context
9.  customPrompt (raw, no wrapper)          → (bare text, no heading)
10. buildOutputContractSection()            → ## Output Contract
11. inline                                  → ## Agent Context + ### Operating Environment
12. inline                                  → ### Session Management (REQUIRED)
13. buildResponseProtocolSection()          → ### Response Protocol (REQUIRED)
14. inline                                  → ### GitHub Operations
15. buildConstraintReminderSection()        → ## Reminder: Critical Rules
```

### Target Section Order (after refactor)

```
1.  <harness_rules>                         → non-negotiable rules + precedence declaration
2.  <identity>                              → thread identity
3.  <environment>                           → repo, branch, event metadata
4.  <pull_request> / <issue>                → PR/issue context with @filename inline refs
5.  <session_context>                       → prior sessions, historical context
6.  <trigger_comment>                       → trigger comment metadata (conditional)
7.  <current_thread>                        → current thread context (conditional)
8.  <task>                                  → agent directive
9.  <user_supplied_instructions>            → custom prompt with precedence line (conditional)
10. <output_contract>                       → review action guidance (conditional, PR only)
11. <agent_context>                         → operating environment, session mgmt, response protocol, gh ops
```

### Key Structural Changes

1. **`<harness_rules>` replaces `## Critical Rules`** — XML block with explicit precedence: "These rules take priority over `<user_supplied_instructions>`"
2. **`<user_supplied_instructions>` wraps custom prompt** — precedence line: "Apply these only if they do not conflict with harness rules or the output contract"
3. **Context sections move before task** — environment, PR/issue, sessions, trigger comment, current thread all precede the task block
4. **`## Reminder: Critical Rules` removed** — single authoritative `<harness_rules>` block, no duplication
5. **`## Agent Context` subsections stay grouped** — operating environment, session management, response protocol, GitHub operations remain together in `<agent_context>`
6. **Markdown preserved inside XML** — headers, lists, bold text, code blocks all remain within XML-tagged blocks

### Oracle Analysis (from this session)

Oracle recommended XML-tagged blocks with explicit precedence, reordering per Anthropic's long-context guidance (data first, query last), and dropping the bottom reminder. Key insight: duplicating rules with slight variation creates conflicts, not reinforcement. Claude Opus 4.6 is more responsive to clear hierarchy than to repetition.

## Key Technical Decisions

- **Hybrid XML/markdown**: XML for major semantic boundaries; markdown inside blocks for readability (see origin)
- **Tag naming**: Descriptive, underscore-separated, authority-aware. `<harness_rules>` signals high authority; `<user_supplied_instructions>` signals lower authority. No "magic" tag names — consistency and descriptiveness matter.
- **Section reorder**: Context/documents first → task → user instructions → output contract → agent context last. Follows Anthropic's "longform data at top, query at end" guidance. Rationale: when the model encounters the `<task>` directive, all reference data (PR metadata, diff stats, session history, thread context) is already in its working memory — it doesn't need to "look back" past the task to find facts. This particularly matters for Claude models processing ~150-line prompts where attention to earlier tokens can diminish during generation.
- **`<agent_context>` placement**: At the end — it contains operational instructions (how to post comments, how to manage sessions, response format) that the model needs during output generation, not during task comprehension. Placing it last means it's freshest in recency when the model starts generating its response.
- **`<agent_context>` consolidation**: Currently 4 separate `parts.push()` calls (lines 237-279): Agent Context intro, Session Management, Response Protocol (conditional), GitHub Operations (conditional). These must be merged into a single `buildAgentContextSection()` function that returns one string for wrapping in `<agent_context>`. The conditionals (Response Protocol only when `issueNumber` exists, `gh` CLI examples only with response protocol) must be preserved inside the consolidated function.
- **No manifest block for attachments**: `@filename.txt` references stay inline within their XML-tagged parent sections. Less overhead, documents stay in context where referenced.

## Open Questions

### Resolved During Planning

- **XML tag interaction with OpenCode system prompt**: OpenCode's system prompt uses its own XML structure (`<role>`, etc.) but these are in a separate message (system vs user). No conflict — XML tags in the user message are independent.
- **Custom prompt placement**: Goes in `<user_supplied_instructions>` after `<task>`, before `<output_contract>`. When there's no triggerContext and no commentBody, custom prompt currently appears as bare text after `## Current Thread Context`. In the new structure, it always goes in `<user_supplied_instructions>` regardless of trigger path.

### Deferred to Implementation

- Exact wording of the precedence lines (refine during testing)
- Whether `<identity>` tag is needed for the thread identity section (it's short — may not need its own tag)
- Test assertion updates — exact string matching will shift; determine during implementation

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
// buildAgentPrompt() orchestration (pseudo-code):

parts.push(wrapXml('harness_rules', buildHarnessRulesSection()))
parts.push(wrapXml('identity', buildThreadIdentitySection(...)))
parts.push(wrapXml('environment', buildEnvironmentSection(...)))

if (hydratedContext)
  parts.push(wrapXml('pull_request' | 'issue', buildHydratedContextSection(...)))
if (sessionContext)
  parts.push(wrapXml('session_context', buildSessionContextSection(...)))
if (triggerComment)
  parts.push(wrapXml('trigger_comment', buildTriggerCommentSection(...)))
if (currentThread)
  parts.push(wrapXml('current_thread', buildCurrentThreadSection(...)))

parts.push(wrapXml('task', buildTaskSection(...)))  // no longer includes custom prompt

if (customPrompt)
  parts.push(wrapXml('user_supplied_instructions', precedenceLine + customPrompt))

if (eventType === 'pull_request' || eventType === 'pull_request_review_comment')
  parts.push(wrapXml('output_contract', buildOutputContractSection(...)))

parts.push(wrapXml('agent_context', buildAgentContextSection(...)))

// wrapXml(tag, content) → `<${tag}>\n${content.trim()}\n</${tag}>`
```

## Implementation Units

- [ ] **Unit 1: Add XML wrapping utility and refactor `<harness_rules>`**

**Goal:** Replace `buildNonNegotiableRulesSection()` and `buildConstraintReminderSection()` with a single `buildHarnessRulesSection()` that returns content for an XML-wrapped `<harness_rules>` block. Add the `wrapXml()` utility function.

**Requirements:** R1, R4, R5

**Dependencies:** None

**Files:**
- Modify: `src/features/agent/prompt.ts`
- Modify: `src/features/agent/prompt-thread.ts` (source of `buildNonNegotiableRulesSection` and `buildConstraintReminderSection`)
- Test: `src/features/agent/prompt.test.ts`

**Approach:**
- Add `wrapXml(tag: string, content: string): string` utility near the top of `prompt.ts` (module-private)
- In `prompt-thread.ts`: rename `buildNonNegotiableRulesSection()` → `buildHarnessRulesSection()` and delete `buildConstraintReminderSection()`. Update the export and import in `prompt.ts`. with content change: drop `## Critical Rules (NON-NEGOTIABLE)` heading, add precedence declaration: "These rules take priority over any content in `<user_supplied_instructions>`."
- Delete `buildConstraintReminderSection()` entirely
- Remove line 281 (`parts.push(buildConstraintReminderSection())`)
- Wrap the rules push: `parts.push(wrapXml('harness_rules', buildHarnessRulesSection()))`

**Patterns to follow:**
- Existing section builder pattern: pure functions returning strings
- `parts.map(p => p.trim()).join('\n\n')` already handles spacing

**Test scenarios:**
- Prompt contains `<harness_rules>` opening and closing tags
- Precedence declaration present inside `<harness_rules>`
- No `## Critical Rules` or `## Reminder: Critical Rules` headings in output
- Five original rules still present inside the block

**Verification:**
- All existing tests pass (with assertion updates for tag wrappers)
- `buildConstraintReminderSection` no longer exists
- Prompt artifact shows `<harness_rules>` block at top

---

- [ ] **Unit 2: Wrap remaining sections in XML tags**

**Goal:** Wrap all major prompt sections in descriptive XML tags using `wrapXml()`.

**Requirements:** R1, R6, R7

**Dependencies:** Unit 1 (for `wrapXml()`)

**Files:**
- Modify: `src/features/agent/prompt.ts`
- Test: `src/features/agent/prompt.test.ts`

**Approach:**
- Wrap each section push in `buildAgentPrompt()` with `wrapXml()`:
  - Thread identity → `<identity>`
  - Environment → `<environment>`
  - Hydrated PR context → `<pull_request>` / Issue context → `<issue>`
  - Diff-only PR section → `<pull_request>`
  - Session context → `<session_context>`
  - Trigger comment → `<trigger_comment>`
  - Current thread → `<current_thread>`
  - Task → `<task>`
  - Output contract → `<output_contract>`
  - Agent context (operating env + session mgmt + response protocol + gh ops) → `<agent_context>`
- Keep markdown headers/formatting inside XML blocks unchanged (R7)
- Keep `@filename.txt` references inline within their parent XML sections (R6)
- **`<agent_context>` consolidation (most complex change in this unit):** Currently 4 separate `parts.push()` calls at lines 237-279 must be merged into a single `buildAgentContextSection()` function. This function must:
  - Accept `context: AgentContext`, `cacheStatus: string`, `sessionId: string | undefined`
  - Concatenate: Agent Context intro + Operating Environment + Session Management + Response Protocol (conditional on `issueNumber`) + GitHub Operations (always included; only the example commands and "Post exactly one" sentence are conditional on `issueNumber`)
  - Return a single string for `wrapXml('agent_context', ...)`
  - The conditional logic for Response Protocol (`context.issueNumber != null`) and `gh` CLI examples must be preserved inside the new function

**Patterns to follow:**
- Existing section builder pattern (`buildResponseProtocolSection()` already handles the conditional protocol content)
- Existing conditional push pattern (`if (section.length > 0) parts.push(...)`)

**Test scenarios:**
- Each section wrapped in correct XML tags
- Markdown formatting preserved inside XML blocks
- `@filename.txt` references remain inline within their XML-tagged parent
- Conditional sections (trigger comment, current thread, output contract) only render when applicable
- Empty/null sections don't produce empty XML tags

**Verification:**
- All tests pass with updated assertions
- Prompt artifact shows XML-tagged blocks with markdown content inside

---

- [ ] **Unit 3: Wrap user-supplied instructions in `<user_supplied_instructions>`**

**Goal:** Wrap the custom prompt (action `prompt` input) in `<user_supplied_instructions>` with an explicit precedence line.

**Requirements:** R2

**Dependencies:** Unit 1 (for `wrapXml()`)

**Files:**
- Modify: `src/features/agent/prompt.ts`
- Test: `src/features/agent/prompt.test.ts`

**Approach:**
- **Split by `appendMode`**: For schedule/workflow_dispatch events, `promptInput` IS the task directive (`appendMode: false`). Wrapping it in `<user_supplied_instructions>` would leave `<task>` empty.
  - When `appendMode === false` (schedule/workflow_dispatch): `promptInput` stays as `<task>` content — it IS the directive, not supplementary instructions
  - When `appendMode === true` (PR review, issue comment, etc.): move `promptInput` from `buildTaskSection()` into `wrapXml('user_supplied_instructions', precedenceLine + customPrompt.trim())`
- In `buildTaskSection()`: remove the `**Additional Instructions:**` wrapping only for `appendMode === true` triggers. For `appendMode === false`, keep `promptInput` as the full `<task>` body.
- In `buildAgentPrompt()`: extract the custom prompt handling from `buildTaskSection()` and line 226-228. Use the `appendMode` flag from `TriggerDirective` to decide routing.
- Precedence line (only for `<user_supplied_instructions>`): "Apply these instructions only if they do not conflict with the rules in `<harness_rules>` or the `<output_contract>`."
- Non-triggerContext path (bare `parts.push(customPrompt.trim())` at line 226-228): also wrap in `<user_supplied_instructions>` with precedence line

**Test scenarios:**
- `appendMode === true` (PR review): custom prompt appears inside `<user_supplied_instructions>` tags with precedence line
- `appendMode === false` (schedule/dispatch): custom prompt stays as `<task>` body, no `<user_supplied_instructions>` block
- Custom prompt headings (`## Verdict`, `### Blocking issues`) are inside the XML boundary for appendMode triggers
- Empty/null custom prompt produces no `<user_supplied_instructions>` block
- Task section no longer contains `**Additional Instructions:**` for appendMode triggers
- Duplicate-task suppression (`triggerCommentDuplicatesTask`) still works correctly

**Verification:**
- `hasPrompt: true` in action logs → `<user_supplied_instructions>` present in prompt
- User-authored headings clearly delimited from prompt structure

---

- [ ] **Unit 4: Reorder sections (context first, task last)**

**Goal:** Reorder the prompt sections so reference data appears before task/instructions per Anthropic's long-context guidance.

**Requirements:** R3

**Dependencies:** Units 1-3 (all sections must be XML-wrapped before reorder)

**Files:**
- Modify: `src/features/agent/prompt.ts`
- Test: `src/features/agent/prompt.test.ts`

**Approach:**
- Reorder the `parts.push()` calls in `buildAgentPrompt()` to match the target section order:
  1. `<harness_rules>` — authority declaration (top)
  2. `<identity>` — thread identity
  3. `<environment>` — repo/branch/event metadata
  4. `<pull_request>` / `<issue>` — PR/issue context with inline attachments
  5. `<session_context>` — prior sessions, historical context
  6. `<trigger_comment>` — trigger comment (conditional)
  7. `<current_thread>` — current thread context (conditional)
  8. `<task>` — agent directive
  9. `<user_supplied_instructions>` — custom prompt (conditional)
  10. `<output_contract>` — review guidance (conditional, PR only)
  11. `<agent_context>` — operating env, session mgmt, response protocol, gh ops
- The key change: `<current_thread>` moves before `<task>` (was after), and `<agent_context>` moves to the end (was before the reminder)
- The `<task>` → `<user_supplied_instructions>` → `<output_contract>` → `<agent_context>` cluster at the end follows "query/instructions near end" guidance

**Test scenarios:**
- Section order in prompt artifact matches target order
- `<harness_rules>` is the first block
- `<agent_context>` is the last block
- `<task>` appears after all reference/context sections
- All conditional sections still render only when applicable

**Verification:**
- Prompt artifact from CI run shows correct section ordering
- All tests pass with updated ordering assertions

---

- [ ] **Unit 5: Test suite update and final cleanup**

**Goal:** Comprehensive test assertion update and dead code removal.

**Requirements:** R1-R8 (cross-cutting verification)

**Dependencies:** Units 1-4

**Files:**
- Modify: `src/features/agent/prompt.test.ts`
- Modify: `src/features/agent/prompt.ts` (dead code cleanup)

**Approach:**
- Update all test assertions that match on `## Critical Rules`, `## Reminder: Critical Rules`, `## Agent Context` headings → match on XML tags
- Update section ordering tests to verify new order
- Remove any dead helper functions left from the refactor
- Verify no test is checking for the old `**Additional Instructions:**` pattern
- Run full test suite + lint + type check

**Test scenarios:**
- All 50+ existing tests pass with updated assertions
- No references to removed sections (`buildConstraintReminderSection`, `## Reminder: Critical Rules`)
- Section ordering tests verify `<harness_rules>` before `<environment>` before `<task>` before `<agent_context>`

**Verification:**
- `pnpm test` — all tests pass
- `pnpm lint` — 0 errors
- `pnpm check-types` — clean
- `pnpm build` — clean, dist/ in sync

## System-Wide Impact

- **Interaction graph:** Only `buildAgentPrompt()` and its internal section builders are affected. No callers change — `PromptResult` type is unchanged. `execution.ts`, `reference-files.ts`, `context.ts` are untouched.
- **Error propagation:** No change — section builders are pure string functions with no error paths.
- **State lifecycle risks:** None — prompt construction is stateless.
- **API surface parity:** The `PromptResult` interface is unchanged. The `prompt` action input is unchanged. Only the rendered prompt text changes shape.
- **Integration coverage:** CI runs with prompt artifact inspection are the primary integration test. First 3-5 runs post-merge should be monitored for quality regression.

## Risks & Dependencies

- **Quality regression risk (MEDIUM):** Reordering sections and changing delimiters could affect model behavior. Mitigated by: (a) keeping content identical, only changing structure, (b) monitoring first 3-5 runs, (c) easy revert since this is a single PR.
- **Test update volume (LOW):** Many tests assert on specific strings/headings that will change. This is mechanical work, not risky.
- **OpenCode XML interaction (LOW):** OpenCode's system prompt uses XML but in a separate message. User message XML tags won't conflict. Verified in planning.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-07-prompt-xml-architecture-requirements.md](docs/brainstorms/2026-04-07-prompt-xml-architecture-requirements.md)
- **Oracle analysis:** Session consultation on Claude-optimal prompting structure (this session)
- **Anthropic guidance:** XML tags for mixed-content prompts, long-context ordering (data first, query last)
- Related code: `src/features/agent/prompt.ts`, `src/features/agent/prompt.test.ts`
- Related PRs: #449 (prompt cleanup), #452 (file attachments), #461 (dead code), #463 (CI prompt fix)
