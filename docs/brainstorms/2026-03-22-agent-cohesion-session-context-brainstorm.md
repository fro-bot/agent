# Brainstorm: Agent Cohesion, Session Continuity, and Prompt Context

Date: 2026-03-22

## What We're Building

We want Fro Bot to behave like it remembers the work it already did for the same PR, issue, discussion, schedule task, or manual dispatch instead of starting from a vaguely related fresh session each time.

The target is stable continuity: repeated runs on the same logical entity should preferentially continue the same session lineage, with deterministic retrieval as a fallback when the mapped session is missing, stale, or unusable.

This brainstorm also covers prompt quality and observability. Better session continuity is not enough if prompts bury the important context or if non-PR runs do not preserve prompt/log artifacts for later analysis.

## Why This Approach

The current system persists OpenCode storage across runs, but it does not preserve stable session identity.

- `src/features/agent/execution.ts` always calls `client.session.create()`, so every run starts a new OpenCode session with a timestamp-style title.
- `src/harness/phases/session-prep.ts` searches prior work using `issueTitle ?? repo`, which is fuzzy and unstable across repeated runs on the same entity.
- `src/features/agent/prompt.ts` includes prior-session context, but it is not anchored to a deterministic logical thread, so the prompt often has context nearby rather than context that is definitely the right one.

That means we currently have persistence without strong continuity.

## Case Study Findings

### Examined Runs

- `CI` / PR run `23398824784` - has `opencode-logs`
- `CI` / PR run `23397708292` - has `opencode-logs`
- `Fro Bot` / schedule run `23383114696` - no uploaded `opencode-logs` artifact
- `Fro Bot` / issue comment run `23399143120` - no uploaded `opencode-logs` artifact

### What The Runs Show

- PR test runs preserve prompt and OpenCode logs because `ci.yaml` uploads `~/.local/share/opencode/log` as the `opencode-logs` artifact.
- Real `Fro Bot` runs do execute and do write local prompt artifacts, as shown in the job logs, but `fro-bot.yaml` never uploads that log directory.
- OpenCode creates sessions with titles like `New session - 2026-03-22T06:52:13.670Z`, which are useless as stable lookup keys.
- Prompt artifacts for PR runs show a strong structure, but the prompt is long and front-loads generic operating rules before the most important continuity signal.
- Logs include noise that should either be surfaced intentionally or suppressed from the case-study signal:
  - `Blocked 3 postinstalls. Run bun pm untrusted for details.`
  - repeated `tool.registry ... invalid`

### Practical Interpretation

The main problem is not that persistence is absent. The problem is that the system cannot say with confidence: "this run belongs to the same logical conversation as the last run for PR 347".

## Approaches Considered

### 1. Retrieval-First

Keep creating a fresh OpenCode session every run, but introduce deterministic logical keys such as `pr-347`, `issue-123`, `discussion-12`, `schedule-daily-maintenance`, and `dispatch-<slug>`. Use those keys to retrieve exact prior sessions before falling back to broader search.

Pros:
- Lowest implementation risk
- Fits current `client.session.create()` behavior
- Improves relevance immediately

Cons:
- Still fragments work across many sessions
- Cohesion improves, but true continuity does not

Best when: we want a low-risk first pass with minimal behavioral change.

### 2. Continuity-First

Introduce deterministic logical session keys and persist a mapping from logical key to the latest canonical OpenCode session ID. Repeated runs for the same entity try to continue the same session lineage. If the mapped session is unavailable, fall back to deterministic retrieval and create a new session only when needed.

Pros:
- Best alignment with the goal of stronger cohesion and adherence
- Lets future prompts speak in terms of "current thread" rather than "similar past work"
- Makes run summaries and prior context compound over time

Cons:
- Higher integration risk than retrieval-first
- Requires explicit policy for stale, missing, or branched sessions

Best when: continuity is the product goal, not just better search.

### 3. Observability-First

Keep current session behavior, but first make all trigger types preserve prompt and OpenCode logs, then use those artifacts to improve prompts and continuity later.

Pros:
- Fastest path to better diagnosis
- Makes future tuning evidence-driven

Cons:
- Does not materially improve agent cohesion on its own
- Risks becoming instrumentation without behavior change

Best when: the team wants data collection before changing behavior.

## Recommended Direction

Use a balanced continuity-first rollout.

Phase the work around a continuity target, but ship observability and deterministic retrieval at the same time so the behavior is measurable and debuggable.

Recommended shape:

1. Introduce deterministic logical keys for each trigger family.
2. Persist logical key -> canonical session ID so repeated runs prefer the same thread.
3. Fall back to deterministic retrieval by logical key when the canonical session is missing or stale.
4. Upload `opencode-logs` for `fro-bot.yaml`, not just `ci.yaml`.
5. Restructure the prompt so logical thread identity and previous relevant work appear before lower-value generic instructions.

## Prompt Improvements To Carry Forward

- Move logical thread identity near the top of the prompt.
- Distinguish `current thread context` from `related historical context`.
- Reduce prompt bloat by selecting prior-session context from the exact logical key before showing broader repository matches.
- Keep response protocol strict, but avoid burying task-specific context under generic operational rules.
- Surface known runtime warnings deliberately so they are either actionable or clearly ignorable.

## Logging And Artifact Improvements To Carry Forward

- Upload `~/.local/share/opencode/log` in `fro-bot.yaml` the same way `ci.yaml` already does.
- Preserve prompt artifacts for schedule, issue, discussion, and comment triggers.
- Decide whether `Blocked 3 postinstalls` is expected noise or a warning worth escalation.
- Decide whether repeated `tool.registry ... invalid` is benign startup chatter or evidence of a misconfigured tool registry path.

## Key Decisions

- We optimize for stable continuity, not just better fuzzy retrieval.
- Deterministic logical keys should be first-class and trigger-specific.
- Deterministic retrieval remains the fallback when continuity cannot be preserved.
- Universal prompt/log artifact retention is required so non-PR runs are inspectable.
- Prompt context should prioritize the current logical thread before generic history.

## Resolved Questions

- Should the long-term target be stable retrieval or stable continuity? Resolved: stable continuity, with deterministic retrieval fallback.
- Should observability be handled separately from continuity? Resolved: no; artifact retention should ship alongside the continuity work.

## Open Questions

None currently.

## Success Criteria

- Repeated runs on the same PR, issue, discussion, or scheduled task consistently recover the right prior thread.
- Session lookup no longer depends on unstable values like issue title text.
- Prompts show exact prior-thread context before broad historical search context.
- Non-PR `Fro Bot` runs preserve inspectable prompt and OpenCode logs.
- Case-study review after implementation shows less prompt bloat and more relevant prior-session context.
