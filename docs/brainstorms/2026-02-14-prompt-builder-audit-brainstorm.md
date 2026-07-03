---
date: 2026-02-14
topic: prompt-builder-audit
---

# Prompt Builder Audit (Trigger Guidance)

## What We’re Building

A documented audit of the current prompt builder (`src/lib/agent/prompt.ts`) and its trigger-specific directives, with a focus on whether ordering and templates provide clear, actionable guidance per event type. The outcome is a findings report that identifies gaps (especially for PR reviews) and proposes what the prompt should instruct (not how to implement it). Emphasis: trigger-aware guidance for `pull_request` and `pull_request_review_comment` events, and explicit conditions for collaborator and review-request scenarios.

## Why This Approach

The existing prompt sections are comprehensive, but the task directive is minimal and not tailored to nuanced workflows (e.g., when to post a review vs. comment, or when to decide approve/request-changes). We’ll preserve the current multi-section structure while strengthening the trigger-specific directives to reduce ambiguity. This is aligned with prompt best practices: clear instructions, separation of context from directives, and trigger-specific success criteria.

## Key Decisions

- **Findings-only deliverable:** No code changes; output is an audit report with actionable gaps and recommended directive language themes.
- **PR review action policy:** Require explicit review action only when the agent is confident; otherwise allow comment-only review.
- **Review-capable triggers:** Focus on `pull_request` and `pull_request_review_comment` for review actions.
- **Explicit condition text:** Prompt should spell out collaborator/reviewer-request cases instead of relying on routing alone.

## Observations from Current Code

- **Directive mapping is centralized** in `getTriggerDirective()` with simple, event-type-only text. No nuanced conditions for review status or requested-reviewer state.
- **Task directive appears early** (after the system header) but before environment/context sections, so the agent receives instruction before context.
- **Hydrated PR context includes reviews** (review states and comments), but the task directive doesn’t leverage it.
- **Router skip logic is strict**, but it doesn’t pass through “requested reviewer” or “collaborator” context, so prompts can’t currently mention those conditions.
- **Prompt tests** confirm section inclusion but not ordering constraints; ordering is implicit by build order in `buildAgentPrompt()`.

## Approaches to Improve Trigger Guidance (Conceptual)

### Approach A — Minimal Directive Expansion (Recommended)

Add explicit trigger-specific directives for PR events that enumerate expected review outputs (approve/request changes when confident; comment-only otherwise). Keep prompt structure unchanged and avoid conditional instructions that require new context plumbing.

**Pros:** Minimal change, aligns with current structure, low risk of confusion. **Cons:** Doesn’t add new context fields; limited to instruction wording.

### Approach B — Context-Aware Directive Templates

Introduce directive templates that vary based on contextual flags (e.g., requested reviewer, collaborator) once those are surfaced in context. The directive would mention the conditions when applicable, otherwise fallback to generic PR review instruction.

**Pros:** More precise guidance; reduces ambiguity. **Cons:** Requires new context plumbing and conditional logic.

### Approach C — Output Contract per Trigger

Define a lightweight “output contract” per trigger (e.g., PR reviews must include: summary, risk, test suggestions, review action if confident). Keep in prompt as a standard section appended to the task.

**Pros:** Consistency of responses; easier to validate. **Cons:** Slightly more verbose; could constrain agent flexibility.

## Open Questions

- What is the most reliable signal for “requested to review” in the current context/hydration pipeline (needs confirmation of availability)?
- Should collaborator status be derived from author association in the payload, or via API lookup? What are acceptable latency/permission impacts?
- Do we want explicit instructions to use review API vs. comment API when the event is `pull_request_review_comment`?

## Next Steps

- Produce the audit findings report referencing specific code locations and gaps.
- If moving to planning: decide whether to pursue Approach A only (wording), or add context plumbing (Approach B/C).

→ `/workflows:plan` for implementation details once an approach is selected.
