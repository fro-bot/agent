---
date: 2026-04-07
topic: prompt-xml-architecture
---

# Prompt XML Architecture Overhaul

## Problem Frame

The Fro Bot CI agent prompt is a ~150-line user message sent via OpenCode's SDK. It contains harness rules, reference context, user-supplied instructions, and task directives — all rendered as flat markdown. User-supplied instructions (custom review prompts) contain markdown headings (`## Verdict`, `### Blocking issues`) that are syntactically indistinguishable from the prompt's own structure. There is no explicit authority hierarchy — nothing tells the model which instructions take precedence when they conflict. Anthropic's guidance for Claude models recommends XML tags for semantic boundaries in mixed-content prompts, long-form data positioned before queries, and explicit precedence declarations.

## Requirements

- R1. Wrap all major prompt blocks in descriptive XML tags to create clear semantic boundaries between harness rules, reference context, task directives, user-supplied instructions, and output contracts
- R2. Wrap user-supplied instructions (the `prompt` action input) in `<user_supplied_instructions>` with an explicit precedence line: "Apply these only if they do not conflict with harness rules or the output contract"
- R3. Reorder prompt sections to follow Anthropic's long-context guidance: reference data (environment, PR/issue context, session context) near the top; task, user instructions, and output contract near the end
- R4. Replace the current `## Critical Rules (NON-NEGOTIABLE)` markdown section with a `<harness_rules>` XML block at the top of the prompt, with explicit precedence declaration
- R5. Remove the `## Reminder: Critical Rules` bottom section — single authoritative declaration replaces duplicated reminders
- R6. Keep `@filename.txt` attachment references inline within their XML-tagged context sections (not a separate manifest block)
- R7. Preserve markdown formatting inside XML blocks for readability — hybrid XML/markdown approach, not pure XML
- R8. Keep all section-building functions pure (no I/O) — the refactor is structural, not behavioral

## Success Criteria

- Prompt artifact shows XML-tagged major blocks with correct nesting and no duplicate sections
- User-supplied instructions appear inside `<user_supplied_instructions>` with precedence line
- Section order matches: harness_rules → identity → context/documents → task → user_instructions → output_contract
- All existing tests pass (may need assertion updates for new tag structure)
- Fro Bot review quality does not regress on first 3-5 runs post-merge (qualitative check)

## Scope Boundaries

- NOT changing prompt content/wording — only structure and delimiters
- NOT adding structured output/tool schemas for review format enforcement (future work)
- NOT modifying the system prompt (controlled by OpenCode, not us)
- NOT changing how `buildAgentPrompt()` returns data (`PromptResult` type stays the same)
- NOT touching `execution.ts`, `reference-files.ts`, or the materialization pipeline

## Key Decisions

- **Comprehensive overhaul over targeted fix**: Full XML migration + reorder, not just wrapping user instructions. Aligns with Anthropic guidance and establishes a clean architecture for future prompt evolution.
- **Drop reminder section**: Single authoritative `<harness_rules>` block at top. No bottom duplication — Oracle analysis shows rule duplication with variation creates conflicts, and our prompt is short enough (~150 lines) that recency reinforcement is unnecessary.
- **`<harness_rules>` at top of user message**: We don't control OpenCode's system prompt. Our non-negotiable rules live in a clearly-tagged block at the start of the user message with explicit precedence over `<user_supplied_instructions>`.
- **Inline attachment references**: `@filename.txt` stays inline within XML-tagged context sections. No separate `<documents>` manifest — keeps documents in context where they're referenced.
- **Hybrid XML/markdown**: XML for semantic boundaries between major blocks; markdown inside blocks for readability. Not converting every heading to XML.

## Deferred to Planning

- [Affects R1][Technical] Exact XML tag names for each section — `<environment>`, `<pull_request>`, `<session_context>`, `<task>`, `<output_contract>` are candidates but need validation against the actual section builders
- [Affects R3][Technical] Exact section order — the broad principle is "context first, task last" but the precise ordering of environment vs PR context vs session context needs to be determined during implementation
- [Affects R1][Needs research] Whether XML tags inside a user message interact with OpenCode's own system prompt XML structure — unlikely to conflict but worth a quick check

## Next Steps

→ `/ce:plan` for structured implementation planning
