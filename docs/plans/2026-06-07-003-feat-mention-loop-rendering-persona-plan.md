---
title: "feat: Mention-loop clean rendering + Discord persona (Phase 1)"
type: feat
status: completed
date: 2026-06-07
origin: docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md
deepened: 2026-06-07
completed: 2026-06-09
---

# Mention-loop clean rendering + Discord persona (Phase 1)

## Overview

The `@Fro Bot` Discord mention loop streams raw agent reasoning (chain-of-thought) and dumps every
tool call verbatim, and prompts the agent with nothing Discord-specific. This plan implements **Phase 1**
of the production-ready effort (see origin): a `formatPart`-style output-rendering layer that suppresses
reasoning, summarizes tool calls, and hides read-only tools; plus a Discord persona prompt built from
the canonical `fro-bot-persona.md`. This is the foundation the later phases (working-state UX, queue,
commands, approval UX) build on, and it resolves the core pain on its own (SC1-SC3).

## Problem Frame

Verified against source:

- `packages/gateway/src/execute/run-core.ts` streams text deltas with **no part-type filter** — it
  appends any `message.part.delta` / `session.next.text.delta` whose field is `text` (lines ~293-314),
  so OpenCode's `ReasoningPart` content leaks as conversational text. It renders every completed tool
  via `sink.append(...)` with a `🔧 ${tool}: ${title}` line at two sites (the `message.part.updated` tool
  branch ~338 and the legacy `session.next.tool.success` branch ~373; `session.next.tool.called` is
  cache-only correlation, not a render site).
- `packages/gateway/src/execute/prompt.ts` `buildDiscordPrompt()` is bare: `Repository: owner/repo`
  plus the raw message. No persona, no "be concise / don't narrate process / format for chat."

The mention loop should read like a capable teammate — **low-noise but inspectable**: reasoning hidden,
read-only tool noise hidden, essential actions shown as collapsed one-line summaries, in Fro Bot's
established voice (see origin).

## Requirements Trace

- **R1 (SC1)** — A simple mention produces a clean response with **no chain-of-thought** and **no raw
  tool dump** — at most collapsed action summaries plus the answer.
- **R2 (SC2)** — A "what files are in this repo" mention answers conversationally without dumping
  `git ls-files` output or a `🔧 bash:` line; long output is summarized/attached, not inlined.
- **R3 (SC3)** — Responses read in **Fro Bot's voice** because the canonical persona is in the prompt.
- **R4 (SC7)** — A missing persona file does not break the loop (fail-soft to mechanical guidance).
- **R5** — Reasoning is **fully suppressed** (no visible marker) — confirmed decision, not Kimaki's
  `┣ thinking` marker.

## Scope Boundaries

- **Reasoning fully suppressed** — no "thinking" marker (origin OQ3, resolved).
- **Verbosity is fixed** — one "clean conversational" verbosity (text + essential tools; read-only
  tools hidden). No user-facing verbosity config; only the *minimal* rendering logic the fixed shape
  needs is ported from Kimaki, not its configurable verbosity system.
- This plan does not change run lifecycle, locking, or concurrency behavior.

### Deferred to Separate Tasks

- **Working-state UX** (live status-message manager + typing indicator, the typing-only mode):
  brainstorm Phase 2 — separate plan. Note: the current sink has no edit surface; that work is its own
  component.
- **Serial per-channel queue** (Phase 3), **core commands + native approval UX** (Phase 4): separate plans.
- **Footer/turn-terminator** and **expandable full action trace**: origin OQ6/OQ7, deferred.
- **Interaction-state UX** (failure/timeout presentation, final-answer transition mechanics,
  empty-response handling): these become concrete when the working-state UX lands (Phase 2). This plan
  keeps the existing sink flush/transition behavior; it only changes *what content* the sink receives.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/execute/run-core.ts` — the event loop. Text-delta append sites (~293-314) and
  the two tool-render sites (~338 and ~373). The wiring target for the new renderer.
- `packages/gateway/src/discord/streaming.ts` — `createDiscordStreamSink`: `append()` buffers,
  `flush()` writes; 2000-char → file attachment; empty → `_(no output)_`. **Unchanged by this plan** —
  it still receives `append()` calls; we only change what text is appended (filtered/summarized).
- `packages/gateway/src/execute/prompt.ts` — `buildDiscordPrompt()`, the persona injection point.
- `packages/gateway/src/config.ts` — `readSecret` / `readOptionalSecret` (`_FILE` bind-mount support).
  The pattern for `GATEWAY_PERSONA_FILE`.
- Action-tier persona layering — `fro-bot.yaml` passes `PERSONA` to the action; the runtime prepends it.
  Mirror that persona-then-task ordering for the Discord prompt.
- OpenCode SDK part model — `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/gen/types.gen.ts`:
  `Part` discriminated union incl. `ReasoningPart` (`type: 'reasoning'`), `ToolPart` with
  `ToolState` (`pending`/`running`/`completed`/`error`). `message.part.updated` carries the full `Part`.

### External References

- **Kimaki** (`remorses/kimaki`, MIT) — `cli/src/message-formatting.ts` (`formatPart`,
  `getToolSummaryText`), `cli/src/external-opencode-sync.ts` (essential-tool / verbosity filter). The
  rendering logic is ported, adapted to our event-extraction helpers and types. Credit MIT.

### Institutional Learnings

- Gateway uses `message.part.updated` (partType:'tool', state.status:'completed') for tool lifecycle on
  OpenCode 1.15.13; `session.next.tool.*` are inert fallbacks. The renderer must handle the live path
  and keep the legacy branches consistent.

## Key Technical Decisions

- **Port Kimaki's `formatPart`/`getToolSummaryText`/essential-tool filter, adapted to our types.** The
  tool→summary mapping (`edit *file* (+N-M)`, `read *file*`, `grep *pattern*`, bash inline ≤100 chars
  else description, MCP args truncated) is the hard-won part; reuse it.
- **Reasoning fully suppressed via partID correlation.** Verified against the SDK: `EventMessagePartDelta`
  carries `{sessionID, messageID, partID, field, delta}` with **no part kind**, so a reasoning delta is
  indistinguishable from a text delta at the delta site alone. But `ReasoningPart` has `id` and arrives
  via `message.part.updated` (`part.type === 'reasoning'`). Mechanism: track reasoning part IDs as they
  appear on `message.part.updated`; on `message.part.delta`, suppress any delta whose `partID` is a known
  reasoning part. No marker. (The current `message.part.updated` branch only handles `partType === 'tool'`
  — a reasoning-part branch must be added to populate the set.)
- **Verbosity = fixed essential-tools allowlist.** Show: edits, writes, `apply_patch`, side-effecting
  bash, `todowrite`, subagent `task`, MCP tools. Hide: `read`, `grep`, `glob`, `list`, non-side-effect
  bash. A pure-function predicate, not a config surface.
- **Tool summaries replace the `🔧 <tool>: <title>` lines** at the **two** render sites (the
  `message.part.updated` tool branch and the `session.next.tool.success` branch) with a single
  `formatToolPart`-derived one-liner; hidden tools append nothing. (`session.next.tool.called` is
  cache-only correlation, not a render site — left unchanged.)
- **Persona = canonical `fro-bot-persona.md` + Discord-mechanical guidance, fail-soft.** Read via
  `GATEWAY_PERSONA_FILE` (optional secret/file). Compose: persona → Discord-mechanical guidance →
  `Repository: owner/repo` → user message. Missing persona file → mechanical guidance only (no failure).
- **Renderer is a pure module** for *tool* summarization (input: extracted tool shape; output: a string
  or null-to-hide), unit-tested independently. **Reasoning suppression is owned by the wiring layer**
  (Unit 2), not the pure renderer — it requires the partID-correlation state that only the event loop
  sees. The renderer handles text-passthrough and tool-summary; it does not see deltas.
- **SC2 (no wall-of-files) needs the prompt, not just hiding.** Hiding the read-only `git ls-files`
  tool line does not stop the agent from pasting the file list as its text answer. The Discord-mechanical
  guidance (Unit 3) must instruct: summarize/cap long enumerations, attach or link full listings rather
  than inlining. This is an explicit, tested dependency, not an assumption.

## Open Questions

### Resolved During Planning

- **Reasoning marker** → fully suppress, no marker (user-confirmed).
- **Verbosity** → fixed essential-tools allowlist, no config.
- **Persona composition order** → persona → Discord-mechanical guidance → repo context → user message
  (mirrors Action-tier persona-then-task).
- **Kimaki port** → port the rendering logic adapted to our types; MIT credit.
- **Reasoning-detection mechanism** → partID correlation (verified against SDK): track reasoning `part.id`
  from `message.part.updated` (`type === 'reasoning'`), suppress `message.part.delta` whose `partID` is in
  the set. Not a deferral — a concrete mechanism (Unit 2).
- **Render-site count** → two (`message.part.updated` tool branch + `session.next.tool.success`);
  `session.next.tool.called` is cache-only.
- **SC2 resolution** → the Discord-mechanical guidance's long-enumeration response policy (Unit 3), tested
  — not hiding alone.

### Deferred to Implementation

- **Live-stream confirmation:** capture a real 1.15.13 reasoning event during implementation to confirm
  the partID correlation fires as expected for the configured model (the mechanism is correct per the SDK
  types; the live capture validates ordering).
- **Exact Discord-mechanical guidance wording** — drafted during implementation, kept terse, reinforcing
  the persona's existing anti-patterns (no sycophancy, no sign-offs, no process narration).
- **Whether the renderer lives in `discord/` or `execute/`** — placement decided for cleanest import
  graph during implementation.

## Implementation Units

- [x] **Unit 1: Part renderer + essential-tool filter (pure module)**

**Goal:** A pure, tested module that turns an extracted **tool** shape into a clean Discord line: essential
tool → one-line summary; non-essential (read-only) tool → null. (Reasoning suppression and text passthrough
are the wiring layer's job in Unit 2 — this module is tool-only.)

**Requirements:** R1, R2, R5

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/execute/format-part.ts` (name/placement TBD — `formatToolPart`,
  `isEssentialTool`, `summarizeTool`)
- Create: `packages/gateway/src/execute/format-part.test.ts`

**Approach:**
- Port Kimaki's `getToolSummaryText` mapping adapted to our extracted tool shape (`tool`, `state.input`,
  `state.title`), scoped to the tool types actually emitted today: `edit`/`write`/`apply_patch` →
  `*file* (+N-M)` / `*file* (N lines)`; `bash` → inline command if single-line ≤100 chars else its
  description; `skill` → `_name_`; `task` (subagent) → labeled; unknown/MCP → a minimal truncated
  fallback. Status glyph for completed vs error. (Defer rich `todowrite` checklist rendering and elaborate
  MCP arg formatting unless a concrete v1 output needs them — keep the fallback minimal.)
- `isEssentialTool(tool)`: allowlist (edit/write/apply_patch/side-effecting-bash/`task`/MCP) → shown;
  read/grep/glob/list/non-side-effect bash → hidden (return null).

**Mapping-contract note:** before implementing, enumerate each supported part shape and the exact fields
used (`state.input.filePath`, patch text, `state.input.command`, etc.) so a shape mismatch with our
extracted events surfaces as a test failure, not a silent fallback summary.

**Execution note:** Test-first — the tool→summary mapping and the essential-tool predicate are the
load-bearing rules.

**Patterns to follow:** Kimaki `cli/src/message-formatting.ts` `getToolSummaryText`; the existing
title-resolution logic in `run-core.ts` (state.title → input.title → bash command → tool).

**Test scenarios:**
- Happy path: `edit` part with a patch → `*file.ts* (+12-3)`; `write` → `*file.ts* (40 lines)`;
  `read` → null (hidden); `grep` → null; `bash` short cmd → inline; `bash` long → description.
- Edge case: missing title/input falls back to the tool name; MCP tool args truncated to 50 chars.
- Edge case: error-status tool renders with the error glyph, still summarized (not dumped).
- Edge case: unknown tool → generic truncated arg summary, never raw dump.

**Verification:** Module tests pass; `pnpm --filter @fro-bot/gateway check-types` + `lint` clean.

- [x] **Unit 2: Wire the renderer into run-core (reasoning suppression + tool summaries)**

**Goal:** Replace the raw `🔧 <tool>: <title>` appends with the Unit 1 summaries, and suppress reasoning
content so it never reaches the sink.

**Requirements:** R1, R2, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/gateway/src/execute/run-core.ts`
- Test: `packages/gateway/src/execute/run-core.test.ts`

**Approach:**
- **Add a reasoning-part branch** to `message.part.updated`: when `part.type === 'reasoning'`, record
  `part.id` in a per-run `reasoningPartIds` set (render nothing). This is new — the branch currently only
  handles `partType === 'tool'`.
- **At the text-delta sites (~293-314):** suppress a delta when its `partID` is in `reasoningPartIds`;
  otherwise pass the text through unchanged. This is the concrete suppression mechanism (verified: deltas
  carry `partID`; reasoning parts carry `id`).
- **At the two tool-render sites (lines 338 and 373):** replace `sink.append(\`\n🔧 ${tool}: ${title}\n\`)`
  with the Unit 1 summarizer — `isEssentialTool` → append the one-line summary; else append nothing. Leave
  the `session.next.tool.called` cache-only branch unchanged.
- The wiring layer owns reasoning suppression (it holds the `reasoningPartIds` set); the Unit 1 module is
  tool-only.
- No change to `streaming.ts` — it still receives `append()`; only the content changes.

**Execution note:** Test-first — add a regression that a reasoning part produces no sink output and that
a `read` tool produces no `🔧` line, while an `edit` produces a summary.

**Patterns to follow:** The existing event-extraction helpers (`getObjectProperty`, `getStringProperty`,
`getEventSessionID`) and session-ID gating already in `run-core.ts`.

**Test scenarios:**
- Happy path: a tool-completed `edit` event → sink receives the summary line, not `🔧 edit: …`.
- Edge case (R5 regression, the load-bearing one): a `message.part.updated` reasoning part registers its
  `id`; subsequent `message.part.delta` events with that `partID` → sink receives nothing. A reasoning
  part whose deltas arrive interleaved with a separate text part's deltas → only the text deltas pass.
- Edge case: a text delta whose `partID` is NOT a reasoning part → passed through unchanged (the answer
  still streams).
- Edge case: a `read`/`grep` completed tool → sink receives nothing (hidden); an `edit` → summary.
- Integration: the `session.next.tool.success` path and the `message.part.updated` tool path produce
  identical summary output for the same tool.

**Verification:** New + existing run-core tests pass; no `🔧 <tool>: <title>` raw format remains;
gateway suite green; check-types + lint clean.

- [x] **Unit 3: Discord persona config + prompt composition**

**Goal:** The mention prompt prepends the canonical persona + Discord-mechanical guidance, delivered via
`GATEWAY_PERSONA_FILE`, fail-soft when absent.

**Requirements:** R3, R4

**Dependencies:** None (parallel to Units 1-2)

**Files:**
- Modify: `packages/gateway/src/config.ts` (add `GATEWAY_PERSONA_FILE` optional read)
- Modify: `packages/gateway/src/execute/prompt.ts` (`buildDiscordPrompt` composition)
- Test: `packages/gateway/src/execute/prompt.test.ts`
- Test: `packages/gateway/src/config.test.ts` (persona read)

**Approach:**
- Add `persona: string | null` to the gateway config via `readOptionalSecret('GATEWAY_PERSONA_FILE')`
  (env or `_FILE` bind-mount), trimmed; absent/empty/whitespace → null.
- Extend `DiscordPromptParams` with `persona?: string | null` (current params: `messageText`, `owner`,
  `repo`, `botUserId?`) and thread `config.persona` from the call site that invokes `buildDiscordPrompt`.
- `buildDiscordPrompt` composes in order: `[persona]` (if present) → Discord-mechanical guidance →
  `Repository: owner/repo` → the user message.
- **Discord-mechanical guidance (terse) must include the SC2 response policy:** you're in a Discord
  thread talking to humans; be concise; do not narrate your internal process or reasoning; format for chat
  (short, markdown, code blocks for code); **for long enumerations (file lists, search results, logs),
  summarize or attach — never paste a long raw list inline.** (This is what actually resolves SC2 — hiding
  the tool line alone does not.)
- Fail-soft: missing persona → mechanical guidance + repo + message only.

**Execution note:** Test-first — assert composition order and the fail-soft path.

**Patterns to follow:** `config.ts` `readOptionalSecret`/`_FILE` pattern; the Action-tier
persona-then-task layering; the persona's own anti-patterns (no sign-offs/sycophancy) reinforce the
mechanical guidance.

**Test scenarios:**
- Happy path: persona present → prompt is `persona` + mechanical guidance + repo + message, in order.
- Edge case (R4): persona absent/empty/whitespace → mechanical guidance + repo + message, no error.
- Edge case: persona file via `_FILE` mount is read and trimmed.
- Edge case: the user message is preserved verbatim after the prepended sections.
- Happy path (SC2): the composed prompt contains the long-enumeration response policy (summarize/attach,
  no inline raw lists) — assert the guidance string includes it so the agent is actually instructed.

**Verification:** Prompt + config tests pass; check-types + lint clean.

- [x] **Unit 4: Deploy wiring + docs**

**Goal:** Make `GATEWAY_PERSONA_FILE` deployable and document the new rendering + persona behavior.

**Requirements:** R3

**Dependencies:** Unit 3

**Files:**
- Modify: `deploy/compose.yaml` (optional `GATEWAY_PERSONA_FILE` secret/env, following the existing
  optional-secret pattern)
- Modify: `deploy/README.md` and/or `packages/gateway/AGENTS.md` (persona delivery + rendering behavior)

**Approach:**
- Add a **minimal optional** `GATEWAY_PERSONA_FILE` entry to `deploy/compose.yaml` following the existing
  optional-secret pattern (documenting the contract), but the **actual persona file provisioning is owned
  by `marcusrbrown/infra`** (it supplies the canonical `fro-bot-persona.md` from `fro-bot/.github`). Keep
  this repo's change to the config contract + docs; do not assume infra's mount details.
- Document: the clean-rendering behavior (reasoning hidden, read-only tools hidden, tools summarized),
  the persona delivery mechanism, and the fail-soft default.

**Test scenarios:** Test expectation: none — deploy config + docs. Validate compose with the existing
deploy validation; the persona-read behavior is covered by Unit 3 tests.

**Verification:** Compose validates; docs render; no committed gateway `dist/` (gitignored).

## System-Wide Impact

- **Interaction graph:** The renderer sits between the SDK event stream and the existing sink. No change
  to the sink, run lifecycle, locking, or the SDK subscription. `streaming.ts` still receives
  `append()`/`flush()` — only the content changes.
- **Error propagation:** A missing persona file is fail-soft (R4). The renderer must never throw on an
  unexpected part shape — unknown/malformed parts degrade to a safe summary or suppression, never a crash
  that breaks the run.
- **API surface parity:** The legacy `session.next.tool.*` branches must use the same summarizer/filter
  as the `message.part.updated` branch so output is identical regardless of which OpenCode path fires.
- **Unchanged invariants:** The sink's flush/attachment/`_(no output)_` behavior, the run lifecycle,
  approval flow, queue/reject behavior, and the SDK transport are all untouched by this plan.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Reasoning is not distinguishable on the delta path (deltas carry no part kind) | Resolved: correlate by `partID` — track reasoning `part.id` from `message.part.updated`, suppress deltas with that `partID`. Confirm ordering against a live 1.15.13 capture. |
| SC2 (wall-of-files) not actually fixed by hiding the tool | Resolved: the Discord-mechanical guidance carries a long-enumeration response policy (summarize/attach), tested. Hiding the tool line is necessary but not sufficient. |
| Canonical persona is GitHub-flavored; may sound wrong in chat | The persona already defines a "Social (Discord/BlueSky)" register; the Discord-mechanical guidance adds chat-specific constraints. Validate tone against a few mention scenarios during implementation. |
| Over-hiding tools makes the loop feel opaque | Essential-tools allowlist keeps edits/writes/bash/MCP visible (the audit trace); only read-only noise is hidden (origin: clean-but-inspectable). |
| Persona file shape/encoding surprises | Trim + fail-soft; treat any read failure as absent persona. |
| Kimaki port type-mismatch (its Part model differs) | Port the *logic* against our extracted part shape + event helpers, not its types; unit-tested in isolation. |
| Renderer regresses the streamed answer | Text deltas pass through unchanged; explicit test that the answer still streams. |

## Documentation / Operational Notes

- `GATEWAY_PERSONA_FILE` is optional; absent → mechanical guidance only. `marcusrbrown/infra` supplies
  the canonical persona from `fro-bot/.github` `persona/fro-bot-persona.md` (single source of truth).
- This is Phase 1 of the production-ready mention loop; Phases 2-4 (working-state UX, queue,
  commands/approvals) follow as separate plans and build on this renderer.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-07-mention-loop-production-ready-requirements.md`
- Related code: `packages/gateway/src/execute/run-core.ts`, `packages/gateway/src/execute/prompt.ts`,
  `packages/gateway/src/discord/streaming.ts`, `packages/gateway/src/config.ts`
- Persona: `fro-bot/.github` `persona/fro-bot-persona.md`
- Reference impl: `remorses/kimaki` (MIT) — `cli/src/message-formatting.ts`,
  `cli/src/external-opencode-sync.ts`
- OpenCode SDK part model: `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/gen/types.gen.ts`
