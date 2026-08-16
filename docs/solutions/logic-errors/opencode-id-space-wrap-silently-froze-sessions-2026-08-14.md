---
title: OpenCode ID-space wrap silently froze every session with prior history
date: 2026-08-14
category: logic-errors
module: harness-release
problem_type: logic_error
component: assistant
symptoms:
  - "The agent accepts a prompt and never answers, with no error surfaced anywhere"
  - "Logs show `loop step=0` immediately followed by `exiting loop`, with no `stream` line"
  - "Every session created before a fixed instant is affected at once; brand-new sessions work"
root_cause: logic_error
resolution_type: dependency_update
severity: critical
related_components:
  - agent-execution
  - dependency-management
tags:
  - opencode
  - session-continuity
  - silent-failure
  - id-generation
  - harness-base-version
---

## Problem

OpenCode message IDs encode a timestamp in a field too narrow to hold it. The field wrapped on 2026-08-14T11:19:55Z, and every session holding pre-wrap history stopped calling the model — silently, with no error.

## Symptoms

The agent accepts prompts and returns nothing. No exception, no failed request, no provider error. It reads as "the agent just stops answering."

A frozen turn logs:

```
loop step=0
exiting loop
```

A healthy turn logs:

```
loop step=0
process messageID=msg_001ab5d9a001EaEi1geh51PjAK
stream providerID=anthropic modelID=claude-opus-5
```

The absence of the `stream` line is the diagnostic. The model was never invoked.

Locally this affected 12,103 of 12,144 sessions — effectively everything except sessions created after the wrap instant.

## Solution

Bump the harness base to a release that contains the upstream fix. In `packages/harness/harness.config.json`:

```json
"base_version": "1.18.18"
```

Do **not** add the upstream fixes to `integrationRefs`. That list carries upstream work that is *not* in the base; these commits are contained in the 1.18.18 tag, so listing them would ask the integration step to re-merge commits already present. Verify containment rather than assuming it:

```sh
git merge-base --is-ancestor <commit> <tag>
```

No data migration is required. This was verified empirically against an untouched frozen session — 30 pre-wrap messages, `max_user` lexically below `max_assistant`, the exact freeze condition — which replied normally on `1.18.18+harness.417b2b35`.

## Why This Works

`Identifier.create()` builds a monotonic value from the clock and a counter, then serializes only its low six bytes:

```ts
let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)
now = direction === "descending" ? ~now : now

const timeBytes = Buffer.alloc(6)
for (let i = 0; i < 6; i++) {
  timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
}
return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
```

A millisecond timestamp shifted left by 12 bits needs 53 bits. Six bytes hold 48. The high bits are discarded, so the encoded value wraps every 2^36 ms — about 795 days. After a wrap, freshly minted IDs begin near `msg_0004…` while existing history sits at `msg_ffe…`.

The 1.18.14 run loop decided whether a user turn was still outstanding by comparing IDs lexically — roughly `lastUser.id < lastAssistant.id`. That comparison assumes ID order tracks chronological order. Post-wrap it inverts permanently: a new user message sorts *below* an old assistant message, the loop concludes there is nothing to answer, and it exits before dispatching to the provider.

Upstream removed the assumption rather than patching the comparison. The loop now checks conversational structure:

```ts
lastAssistant.parentID === lastUser.id
```

and ordering elsewhere goes through an `isAfter` helper in `session/message-v2.ts` that compares `time.created` first and uses the ID only as a tiebreaker. Neither depends on IDs sorting correctly, so a future wrap cannot reintroduce the freeze. Both changes are in the 1.18.18 tag.

## Prevention

The generative defect is unfixed upstream: `id.ts` still truncates to six bytes, so the field wraps again around 2028-10-17. Ordering no longer depends on it, which downgrades the consequence from "everything freezes" to "IDs are not globally sortable across a wrap" — but code that sorts, compares, or ranges over these IDs is still wrong.

- Never order messages or sessions by ID. Use `time.created` / `time.updated`. This repo's `packages/runtime/src/session/` already does this everywhere — worth keeping that way.
- When a whole class of sessions breaks at once with no error, check for a shared boundary condition before investigating any individual session.
- A silent early return in a loop that should have called a provider is worth an explicit log line. The freeze was diagnosable only because `exiting loop` was logged at all.
- Keep `.slim/clonedeps/` re-pinned when `base_version` moves. See [a stale dependency clone can invalidate an upstream diagnosis](../best-practices/stale-dependency-clone-invalidated-upstream-diagnosis-2026-08-14.md) — that mistake was made during this investigation.

## Related

- [Read-only Actions cache token broke session continuity](../integration-issues/read-only-actions-cache-token-broke-session-continuity-2026-08-11.md) — a different, independent way session continuity fails silently. Both share a failure signature worth internalizing: continuity breaks without an error, and the absence of expected output is the only signal.
