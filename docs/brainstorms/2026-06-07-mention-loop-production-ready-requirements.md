---
title: Production-ready @Fro Bot Discord mention loop
date: 2026-06-07
status: ready-for-planning
scope: deep
---

# Production-ready @Fro Bot Discord mention loop

## Problem

The gateway mention loop (`@Fro Bot <message>` in a bound Discord channel) works mechanically —
it opens a thread, runs OpenCode in the workspace, and streams output back — but the UX is bad
enough to block real use. Two concrete failures, observed in Fronomenal:

- **Raw chain-of-thought leaks.** A "create a file" request streamed the model's hedging verbatim:
  *"I'm wondering if we really need a specific skill set for this task. It seems simple…"* The
  gateway never distinguishes OpenCode's `ReasoningPart` from a normal text part, so reasoning is
  streamed as text.
- **Every tool call is dumped.** `🔧 skill: Loaded skill: ce:work`, `🔧 apply_patch: Success…`,
  `🔧 bash: …` followed by a wall of `git ls-files` output. The thread reads like a CI log, not a
  conversation.

Verified root cause (against current source):

- `packages/gateway/src/execute/run-core.ts` streams every text delta with no part-type inspection
  and renders every completed tool as `🔧 <tool>: <title>`.
- `packages/gateway/src/execute/prompt.ts` `buildDiscordPrompt()` is bare — `Repository: owner/repo`
  plus the raw message. No persona, no "be concise," no "you're in chat, don't narrate your process."
  The agent behaves exactly as it would for a GitHub task.

The mention loop should feel like talking to a capable teammate, not watching a job scroll.

## Goals

- Make `@Fro Bot` read as a **clean conversational assistant**: concise answers, reasoning hidden,
  tool noise collapsed, light progress while working.
- Give the agent a **Discord-appropriate prompt** so it *wants* to respond like a chat participant —
  using Fro Bot's established voice, not a generic assistant tone.
- Replace the current "reject concurrent same-channel runs" behavior with a **serial per-channel
  queue** so a busy channel feels responsive, not broken.
- Round out the **core command surface** and the **native approval UX** so the loop feels finished,
  not like a demo.

**Framing refinement (from review):** "clean conversational" means **low-noise, not opaque**. For a
coding agent, developers trust the result partly by seeing what it did. The default is terse —
reasoning hidden, read-only tools hidden, actions collapsed — but the *essential actions remain
visible* (the collapsed one-line summaries of edits/writes/bash are the audit trace), and a missing
action trail is a failure mode, not a feature. The goal is a clean surface that is still inspectable,
not a polished black box. (Whether to go further with an expandable full trace is Open Question 7.)

## Non-goals

- No change to the underlying transport/plumbing — the OpenCode SDK event stream already works
  (subscribe-before-prompt, `message.part.updated`, `session.idle`). This is a formatting + prompt +
  lifecycle effort, not a rewrite.
- **The single v1 user-facing knob is the working-state mode** (live-status-message vs typing-only).
  Verbosity is **fixed** in v1 — the renderer applies one "clean conversational" verbosity (text +
  essential tools; read-only tools hidden) with no user-facing verbosity control. Only the *minimal*
  rendering logic this fixed shape needs is ported from Kimaki — not its full configurable verbosity
  system. A per-channel verbosity setting (Kimaki's `tools_and_text` / `text_only`) is deferred.
- No persistent cross-restart queue — v1 queue is in-memory per the existing Unit 6 R11 boundary.
- No new GitHub-side or control-plane work; this is gateway-only (`fro-bot/agent`).

## Key decisions

| Decision | Choice |
| --- | --- |
| Target experience | Clean conversational assistant (not a worklog) |
| Output rendering | Port Kimaki's `formatPart` / tool-summary / verbosity logic (MIT), adapted to our types |
| Reasoning | Content is suppressed — never streamed. Whether a minimal "thinking" marker remains is open (see Open Question 3) |
| Tool rendering | Collapsed to one-line human summaries; read-only tools (read/grep/glob) hidden by default |
| Working-state UX | One live status message + typing indicator by default; **configurable to typing-only** |
| Persona | Reuse canonical `fro-bot-persona.md` + Discord-mechanical guidance (concise, no process narration, chat formatting) |
| Persona delivery | Deploy-time `GATEWAY_PERSONA_FILE` bind-mount; `fro-bot/.github` stays the source of truth |
| Concurrency | Serial per-channel queue + `/clear-queue` (replaces reject-concurrent) |
| Commands | Add `/sessions`, `/resume`, `/force-release-lock` (alongside existing `ping`, `add-project`) |
| Approvals | Native Discord button/component UX, building on existing `GATEWAY_APPROVAL_MODE` |

## Proposed shape (WHAT, not HOW)

### 1. Output rendering layer (the foundation)

A `formatPart`-equivalent sits between the SDK event stream and the Discord sink. For each renderable
part:

  - **Reasoning** → content suppressed (never streamed). A minimal "thinking" marker may remain or be
    fully hidden — see Open Question 3. **Implementation note:** `run-core.ts` currently branches only
    on text deltas and completed tool parts; suppression requires an explicit
    `part.type === 'reasoning'` branch on `message.part.updated`. (If the configured 1.15.13 model does
    not emit reasoning parts, suppression is a safe no-op, not a claimed capability.)- **Text** → passed through (the answer).
- **Tool (completed/error only)** → a one-line human summary: verb + target + magnitude
  (`◼︎ edit file.ts (+12-3)`, `┣ grep pattern`, `┣ bash <short cmd or description>`). Unknown/MCP
  tool args truncated. Pending/running states do not each post.
- **Verbosity filter (fixed for v1):** show text + *essential* tools (edits, writes, side-effecting
  bash, `todowrite`, subagent tasks, MCP); **hide** read-only tools (read, grep, glob, list).
- **Structural parts** (step-start/finish, snapshot, patch) render nothing.
- Long output is batched to Discord's 2000-char limit, split on safe boundaries (never mid-code-fence),
  with huge output (full diffs/logs) attached as a file rather than inlined.

This layer is the shared dependency for both the streamed final answer and the live status message.

### 2. Working-state UX (configurable)

- **Default:** a single editable status message ("⏳ Working… edited 2 files, ran tests") updated on a
  rate-limit-safe cadence (one edited message, not per-token), plus the Discord typing indicator
  re-pulsed while the session is `busy`. The status message is replaced by the clean final answer.
  **Implementation note:** the current sink (`packages/gateway/src/discord/streaming.ts`) only buffers
  and flushes a final message — it has no edit/update surface. The live-status UX needs a dedicated
  status-message manager that owns one message ID and edits it on cadence, kept separate from
  final-answer flushing. This is a real new component, not a formatting tweak.
- **Configurable to typing-only:** a deploy/channel setting suppresses the status message entirely —
  typing indicator + final answer only (Kimaki's quietest mode).
- The typing indicator starts only on real work (`session.status: busy`), and is cleared on
  idle/abort/approval-wait so it never sticks.

### 3. Discord persona prompt

- The gateway prepends the **canonical `fro-bot-persona.md`** (the same versioned voice used by the
  `@fro-bot` GitHub account — it already defines a "Social (Discord/BlueSky)" tone register:
  *observational, slightly theatrical, trickster energy*) to the agent prompt.
- Layered with **Discord-mechanical guidance**: you're in a Discord thread talking to humans; be
  concise; do not narrate your internal process or reasoning; format for chat (short, markdown, code
  blocks for code); the persona's anti-patterns (no sycophancy, no sign-offs, no apologies) already
  reinforce this.
- The persona reaches the gateway via a deploy-time `GATEWAY_PERSONA_FILE` (bind-mount or env),
  supplied by `marcusrbrown/infra`, pulling the canonical file from `fro-bot/.github`. The gateway
  treats a missing persona file as fail-soft (falls back to the Discord-mechanical guidance alone).

### 4. Serial per-channel queue

- Replace the current behavior (reject a mention while a same-channel run is in flight) with a
  **serial per-channel queue**: a new mention while busy is queued and runs when the current one
  finishes, with a brief acknowledgement so the user knows it's queued.
- `/clear-queue` drops pending queued tasks (the in-flight task runs to completion).
- v1 queue is **in-memory** (per the existing Unit 6 R11 boundary) — tasks pending at gateway restart
  are lost; documented, not solved here.

### 5. Core commands + native approval UX

- Add the core slash commands the Unit 6 reconciliation deferred: `/sessions` (list within-surface
  sessions), `/resume` (resume a prior session), `/force-release-lock` (operational escape hatch for a
  stuck repo lock). Alongside the existing `ping` / `add-project`.
- **Approvals as native components:** risky tool calls gated behind Discord buttons (approve/deny)
  rather than text prompts, building on the existing `GATEWAY_APPROVAL_MODE` (default
  `approval-required`) and the shipped S5 approval registry. Read-only actions are not gated.

## Recommended build order (phasing)

The five areas are not equal-priority. The output-rendering fix is the foundation and the actual
80/20 of the reported pain — it must land first, and the live-status UX depends on it. Recommended
sequence for planning (the user has confirmed all five are in scope; this is order, not exclusion):

1. **Phase 1 — Output rendering + Discord persona prompt.** ✅ Shipped (PR #831). The `formatPart` layer (reasoning
   suppression, tool summarization, verbosity filter) + the persona/Discord-mechanical prompt. This
   alone resolves SC1-SC3 and is the production-ready minimum. Everything else builds on the renderer.
2. **Phase 2 — Working-state UX.** ✅ Shipped (PR #843). The status-message manager + typing indicator (default), then the
   typing-only mode. Depends on Phase 1's summaries for the status content.
3. **Phase 3 — Serial per-channel queue.** ✅ Shipped (PR #850). Replaces reject-concurrent; resolves SC5.
4. **Phase 4 — Remaining command surface + reaction/progress affordances.** Native tool-approval UX
   (S5) already shipped — no longer part of this phase. Remaining scope: `/fro-bot sessions` (list
   within-surface sessions), `/fro-bot resume` (resume a prior session), `/fro-bot force-release-lock`
   (operator escape hatch for stuck repo locks); optionally `/fro-bot review` and `/fro-bot approvals`
   command surface; reactions/R9 progress affordances. Resolves SC6 command gaps. Most separable —
   could ship incrementally without blocking the UX wins already landed.

This is a recommendation for the plan to sequence against, not a re-scoping.

## Success criteria

- **SC1** — A simple mention ("create a file named X") produces a clean conversational response with
  **no chain-of-thought** and **no raw tool dump** — at most collapsed action summaries plus the
  answer.
- **SC2** — A "what files are in this repo" mention answers conversationally without dumping
  `git ls-files` output or the `🔧 bash:` line; long lists are summarized or attached, not inlined.
- **SC3** — The agent's responses read in **Fro Bot's voice** (direct, terse, light trickster energy),
  not a generic assistant tone, because the canonical persona is in the prompt.
- **SC4** — During a longer task the user sees a single updating status message (default) OR just a
  typing indicator (when configured), never a wall of progress posts; the status message is replaced
  by the final answer.
- **SC5** — A second mention in a busy channel is **queued and runs**, not rejected; `/clear-queue`
  drops pending tasks.
- **SC6** — `/sessions`, `/resume`, and `/force-release-lock` are registered and functional; risky
  tools prompt a Discord **button** approval, not a text prompt.
- **SC7** — A missing persona file does not break the loop (fail-soft to mechanical guidance).

## Open questions (for planning)

1. **Status-message config granularity.** Is typing-only a single deploy-wide setting
   (`GATEWAY_STATUS_MODE`-style) or per-channel? v1 leans deploy-wide for simplicity; confirm.
2. **Status-message update cadence + content.** Exact debounce interval and what the status line
   summarizes (count of essential actions? last action?). Resolve against Discord edit rate limits in
   planning.
3. **Reasoning marker — show or fully hide?** Kimaki shows a `┣ thinking` marker. For "clean
   conversational," do we show even that, or fully suppress reasoning? Lean fully suppress for v1;
   confirm.
4. **`/resume` scope.** Within-surface session resume only (the established Unit 6 boundary), or does
   it need the autocomplete session-list source? Defer the autocomplete data-source detail to planning.
5. **Persona + task-prompt composition.** Exact ordering/precedence of persona vs. Discord-mechanical
   guidance vs. the user message — mirror the Action tier's persona-then-task layering. Planning detail.
6. **Footer/turn-terminator.** Kimaki posts a compact footer (duration · model · context%). For a
   coding agent this is a mild trust/accountability signal, not pure noise. In scope as an optional
   minimal footer, or skip for v1? Lean: optional, low-priority.
7. **Auditability depth.** The default is clean-but-inspectable (essential actions visible as collapsed
   summaries). Is that enough, or does v1 also need an *expandable* full action trace (all tools incl.
   read-only, on demand) for developers verifying multi-step work? Lean: collapsed essential summaries
   are enough for v1; full expandable trace deferred. Confirm.

### Interaction states to resolve in planning

Intentionally deferred to the plan, but must be resolved there (not left to implementer guess):

- **Failure/timeout/abort presentation.** How a FAILED/timed-out/aborted run reads conversationally —
  a terse failure note in Fro Bot's voice, not a raw error/tool dump; whether the status message is
  edited into the failure note or followed by a new message.
- **Final-answer transition mechanics.** "Replaced by the final answer" = edit-status-in-place vs
  delete-status-then-post vs post-separate-and-archive-status. Materially different thread UX.
- **Queued-task acknowledgement.** Surface (reply vs reaction vs status edit), copy, whether it updates
  when the queued task starts, how many queued items are visible.
- **Approval-wait thread state.** What stays visible while a button approval is pending (typing pauses;
  status shows the permission prompt), and immediate after-approve vs after-deny behavior.
- **Empty/trivial responses.** Whether a no-op/already-done task emits silence, a reaction, or a tiny
  acknowledgement instead of the current `_(no output)_`.
- **Multi-part / attachment answers.** How a >2000-char or attached answer reads conversationally
  (chunk labeling, which message carries the summary, how an attachment is introduced).

### Implementation constraints to honor (verified against source)

- **Approval mode:** `GATEWAY_APPROVAL_MODE` currently supports only `approval-required`;
  `autonomous-low-risk` is deferred (OpenCode rule-ordering). The button approval UX must live inside
  `approval-required` + the existing permission coordinator / S5 registry path — do not plan on
  mode-switching.
- **Queue ownership:** a per-channel in-memory FIFO in the mention handler; dequeue only after the
  prior run's final cleanup/lock-release completes. Define whether queued items survive approval
  timeout / repo-lock failure; `/clear-queue` drops only pending items (in-flight runs to completion).
- **Status sink:** the live-status UX requires a new status-message manager (own message ID, edit on
  cadence) — the current sink has no edit surface.

## Dependencies

- **OpenCode SDK event model** (already consumed): `message.part.updated` carries the full `Part`
  (discriminated union incl. `ReasoningPart`, `ToolPart` with `ToolState`); `session.status` busy/idle;
  `permission.updated`/`permission.replied` for approvals. The gap is formatting, not plumbing.
- **Canonical persona** `fro-bot/.github` `persona/fro-bot-persona.md` — delivered to the gateway at
  deploy time via `marcusrbrown/infra`.
- **Existing gateway primitives reused:** `GATEWAY_APPROVAL_MODE` + the S5 approval registry; the
  `readSecret`/`_FILE` config pattern; the repo lock / run-state coordination; the workspace
  remote-attach topology.
- **Reference implementation:** Kimaki (`remorses/kimaki`, MIT) — `cli/src/message-formatting.ts`
  (`formatPart`, `getToolSummaryText`), `cli/src/external-opencode-sync.ts` (verbosity), and
  `cli/src/session-handler/thread-session-runtime.ts` (typing keepalive). Port adapted, credit MIT.

## Anti-patterns to avoid (from SotA research)

- Streaming raw chain-of-thought; dumping verbatim tool calls/output.
- Token-by-token message edits (429 storms) — batch on a timed cadence, edit one stable message.
- Splitting code blocks mid-fence at the 2000-char boundary.
- "Typing" with nothing happening, or stuck typing — start only on `busy`, always clear on idle/abort.
- Mutable run-state in message handlers — keep the event stream the single source of truth.
- Pasting long diffs/logs inline — attach or link.

## References

- Source (the bad UX): `packages/gateway/src/execute/run-core.ts`,
  `packages/gateway/src/execute/prompt.ts`, `packages/gateway/src/discord/streaming.ts`,
  `packages/gateway/src/execute/run.ts`
- Deferred Unit 6 items: `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md`
  (Unit 6 reconciliation block, 2026-06-01)
- Persona: `fro-bot/.github` `persona/fro-bot-persona.md` (+ `persona/README.md`)
- Reference bridge: `remorses/kimaki` (MIT) — output-rendering, verbosity, typing patterns
- OpenCode SDK part/event model: `.slim/clonedeps/repos/anomalyco__opencode/packages/sdk/js/src/gen/types.gen.ts`
