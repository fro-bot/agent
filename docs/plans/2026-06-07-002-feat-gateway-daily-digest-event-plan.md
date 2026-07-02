---
title: "feat: Gateway daily_digest presence event"
type: feat
status: done
date: 2026-06-07
---

> **Status: done.** Both units shipped: the `daily_digest` schema variant (`packages/gateway/src/http/announce-schema.ts`) and its embed rendering (`packages/gateway/src/http/templates.ts`) — verified on `main`.

# Gateway daily_digest presence event

## Overview

Add a third presence event type, `daily_digest`, to the gateway announce pipeline so the control
plane can post the daily oversight report as the Fro Bot user (issue #765). This is the **gateway
side** and the first of three steps: gateway variant here → `marcusrbrown/infra` redeploys → the
`fro-bot/.github` control plane wires and enables the announce step.

The change is additive: extend the closed `AnnouncePayloadSchema` union with a `daily_digest`
variant and add its render template. The HMAC/replay/auth pipeline is untouched.

## Problem Frame

The gateway's `event_type` is a closed `Schema.Union` of exactly `invitation_accepted` and
`survey_completed` (`packages/gateway/src/http/announce-schema.ts`), and the render side
(`templates.ts`) is an equally closed accent record + per-type branch. Any `daily_digest` payload is
rejected as `unknown_event_type` (400) until the gateway learns the variant — so this must ship
before the control plane can emit the event.

## Requirements Trace

- **R1** — A signed `daily_digest` payload with a valid context decodes successfully and is no longer
  rejected as `unknown_event_type`. (#765)
- **R2** — `daily_digest` renders a distinct, in-character embed (a daily reflection that links the
  report), with its own accent color, never falling through to the `survey_completed` template. (#765)
- **R3** — Bogus event types still decode-reject as `unknown_event_type`; malformed `daily_digest`
  bodies reject as `malformed_body`. No change to HMAC/replay/auth.

## Scope Boundaries

- No control-plane changes (signing/POST/detection live in `fro-bot/.github` — separate, later).
- No deployment changes (`marcusrbrown/infra` redeploy is a separate step).
- No `rendered_text` composition in the gateway — v1 control plane sends `rendered_text: null`; the
  gateway renders from the template (the existing `renderEmbed` rendered_text-override path is reused
  unchanged).
- Context shape is exactly `{ repos_tracked, surveys_today, report_url }` — `invitations_accepted_today`
  is omitted in v1 to match the control-plane plan.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/http/announce-schema.ts` — `InvitationAccepted` / `SurveyCompleted`
  `Schema.Struct`s and `AnnouncePayloadSchema = Schema.Union(...)`. `FiredAt` (ISO-8601 pattern) and
  `rendered_text: Schema.NullOr(Schema.String)` are shared. `classifyParseError` already maps an
  all-`event_type` failure → `unknown_event_type`, everything else → `malformed_body` (so the new
  variant gets correct classification for free).
- `packages/gateway/src/http/templates.ts` — `ACCENT` record (`Record<AnnouncePayload['event_type'],
  number>`), per-event `render*` functions, and `renderEmbed` whose `else` currently falls through to
  `renderSurveyCompleted`. The `daily_digest` branch must be added **before** that else. A reserved
  accent already exists in the v2-stub comments: purple `0x9b59b6`.
- `packages/gateway/src/http/announce-schema.test.ts`, `templates.test.ts` — the Vitest suites to mirror.

### Institutional Learnings

- Ownership split: gateway contract + rendering live in `fro-bot/agent`; control-plane detection/POST
  live in `fro-bot/.github`; deployment is pinned in `marcusrbrown/infra`.

## Key Technical Decisions

- **Context shape `{ repos_tracked: Number, surveys_today: Number, report_url: String }`.** All
  required (no optional `invitations_accepted_today` in v1) so the schema stays simple and matches the
  control-plane emitter exactly. `report_url` is plain `Schema.String` — consistent with the codebase
  (only `FiredAt` is pattern-validated); the control plane is responsible for emitting a valid URL.
- **Accent purple `0x9b59b6`** — already reserved in the stub comments; visually distinct from
  blue/green.
- **Reuse the `rendered_text`-override path** in `renderEmbed` unchanged — `daily_digest` with
  `rendered_text: null` falls to `renderDailyDigest`; a non-empty override is honored like the others.

## Implementation Units

- [x] **Unit 1: Add the `daily_digest` schema variant**

**Goal:** Extend `AnnouncePayloadSchema` so a `daily_digest` payload decodes.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/http/announce-schema.ts`
- Test: `packages/gateway/src/http/announce-schema.test.ts`

**Approach:**
- Add a `DailyDigest = Schema.Struct({ v: Literal(1), event_type: Literal('daily_digest'), fired_at:
  FiredAt, context: Schema.Struct({ repos_tracked: Number, surveys_today: Number, report_url: String }),
  rendered_text: NullOr(String) })`, mirroring the other two.
- Extend the union: `Schema.Union(InvitationAccepted, SurveyCompleted, DailyDigest)`. No change to
  `decodeAnnounce` / `classifyParseError` — the new variant rides the existing classification.

**Execution note:** Test-first — add the accepting + rejecting cases before widening the union.

**Patterns to follow:** The `SurveyCompleted` struct and the existing decode tests.

**Test scenarios:**
- Happy path: a valid `daily_digest` payload (`{repos_tracked, surveys_today, report_url}`,
  `rendered_text:null`) decodes to a `Right` with the typed context.
- Error path: a `daily_digest` with a missing/wrong-typed context field (e.g. `repos_tracked: "x"`,
  missing `report_url`) decodes to `Left('malformed_body')`.
- Edge case (regression): an unknown `event_type` still yields `Left('unknown_event_type')`; the two
  existing variants still decode.
- Edge case: `daily_digest` with a bad `fired_at` (non-ISO) → `Left('malformed_body')`.

**Verification:** New + existing schema tests pass; `pnpm --filter @fro-bot/gateway check-types` clean.

- [x] **Unit 2: Render the `daily_digest` embed**

**Goal:** Give `daily_digest` a distinct in-character embed + accent, never falling through to the
survey template.

**Requirements:** R2

**Dependencies:** Unit 1 (the type must exist for `ACCENT` and the context extract)

**Files:**
- Modify: `packages/gateway/src/http/templates.ts`
- Test: `packages/gateway/src/http/templates.test.ts`

**Approach:**
- Add a `DAILY_DIGEST` accent (`0x9b59b6`) and the `daily_digest` entry to the `ACCENT` record (the
  record is keyed by `AnnouncePayload['event_type']`, so the new union member makes this required —
  the compiler will enforce it).
- Add `renderDailyDigest(context)` — an in-character daily reflection (a character beat: what Fro Bot
  noticed/did today), pluralizing `surveys_today` / `repos_tracked` like the existing renderers, and
  linking `report_url`. Read as a character moment, not a status line.
- Add a `payload.event_type === 'daily_digest'` branch to `renderEmbed` **before** the final `else`
  so it cannot be mis-rendered by the `survey_completed` fallthrough.

**Execution note:** Test-first — assert the render output (pluralization, report link present,
character tone) before wiring the branch.

**Patterns to follow:** `renderSurveyCompleted` / `renderInvitationAccepted` pluralization; the
`renderEmbed` branch structure and the `rendered_text`-override precedence.

**Test scenarios:**
- Happy path: `renderDailyDigest` with `surveys_today: 2` produces a string containing the count
  (pluralized), `repos_tracked`, and the `report_url` link; reads as a reflection.
- Edge case: singular (`surveys_today: 1`) vs plural pluralization is correct.
- Integration: `renderEmbed` on a `daily_digest` payload selects the purple accent AND the
  `renderDailyDigest` branch (NOT the survey fallthrough) — assert both the description content and
  `color`.
- Edge case: a `daily_digest` payload with a non-empty `rendered_text` override is used verbatim (the
  override path still wins), and the accent is still purple.

**Verification:** New + existing template tests pass; gateway suite green; `pnpm --filter
@fro-bot/gateway check-types` and `lint` clean; no committed `dist/` for the gateway (gateway dist is
gitignored).

## System-Wide Impact

- **API surface parity:** The `context` shape (`{repos_tracked, surveys_today, report_url}`) is the
  cross-repo contract — the control-plane emitter in `fro-bot/.github` must send exactly this shape, or
  decode fails `malformed_body`. Pinned here as the source of truth.
- **Error propagation:** `classifyParseError` is unchanged; the new variant gets correct
  `unknown_event_type` / `malformed_body` classification automatically.
- **Unchanged invariants:** HMAC verification, replay handling, rate-limiting, and the two existing
  event flows are untouched. The `renderEmbed` `rendered_text`-override and 4096-char truncation paths
  are reused as-is.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Context shape drifts from the control-plane emitter | This plan pins `{repos_tracked, surveys_today, report_url}`; the `fro-bot/.github` plan references the same shape. |
| `daily_digest` mis-rendered by the `survey_completed` else-fallthrough | Add the branch BEFORE the else; integration test asserts the correct branch + accent. |
| Downstream not yet ready (gateway must deploy before control plane emits) | Expected — this is step 1 of 3; the control plane stays dormant until `marcusrbrown/infra` redeploys (tracked in the `fro-bot/.github` plan). |

## Sources & References

- Issue: `fro-bot/agent` #765 (gateway daily_digest), with Fro Bot's triage spec
- Related code: `packages/gateway/src/http/announce-schema.ts`, `packages/gateway/src/http/templates.ts`
- Downstream control-plane plan: `fro-bot/.github` `docs/plans/2026-06-07-001-feat-daily-digest-presence-event-plan.md`
- Origin requirements (control plane): `fro-bot/.github` `docs/brainstorms/2026-06-04-daily-digest-presence-event-requirements.md`
