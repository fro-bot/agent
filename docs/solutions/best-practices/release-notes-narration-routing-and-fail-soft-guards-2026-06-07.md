---
title: Release-notes narration — model routing and fail-soft guards
date: 2026-06-07
category: best-practices
module: release-notes
problem_type: best_practice
component: development_workflow
severity: high
last_updated: 2026-07-17
applies_when:
  - release automation dispatches a narration or rewrite workflow
  - model identifiers are routed through a provider proxy
  - release publishing must never be blocked by cosmetic post-processing
related_components:
  - tooling
  - assistant
tags:
  - release-notes
  - model-routing
  - cliproxy
  - fail-soft
  - timeout-guardrail
  - semantic-release
  - response-mode
  - correlation-id
---

# Release-notes narration — model routing and fail-soft guards

## Context

After a release publishes, a `@semantic-release/exec` `successCmd` dispatches a
Fro Bot workflow run that rewrites the GitHub Release body into a `## What's new`
narrative, adds an idempotency marker (`<!-- fro-bot-narration-v1 -->`), and
preserves the raw changelog in a collapsed `<details>` block.

The failure that mattered: the dispatch hardcoded `model=anthropic/claude-haiku-4-5`.
This repo routes all `anthropic/*` models through cliproxy (`cliproxy.fro.bot`).
cliproxy does **not** serve the unversioned alias — it only serves the **dated**
id `anthropic/claude-haiku-4-5-20251001` and returns `502 unknown provider` for
the alias. With an unroutable model, cliproxy accepted the TCP connection but
never returned a first byte, so OpenCode emitted **zero events** and the run
**hung silently**. Because the narration path ran with `timeout: 0`, the hang was
unbounded — it took a manual cancel after ~13 minutes.

The central lesson: **a model can be "listed" by the client and still be
unroutable in production.** The source of truth is the serving layer (the proxy),
not the model catalog. `opencode models --refresh` listing a model id does **not**
prove the cliproxy serving path accepts it.

> A first, wrong diagnosis blamed plugin interference (oMo) and disabled it for
> the narration path. The run still hung identically. The fact that the hang was
> the same with the plugin on **and** off was the tell that the model id — not the
> plugin — was the real cause.

## Guidance

Treat release narration as a **fail-soft, bounded, externally-dispatched side
effect**. Six rules:

1. **Resolve the model from config; never hardcode it.** Source it from a
   repository variable and skip (fail-soft) when unset, so a misconfiguration
   can never dispatch a bad model.

   ```ts
   export function resolveNarrationModel(
     env: Record<string, string | undefined>,
   ): {skip: true} | {skip: false; model: string} {
     const raw = (env.RELEASE_NOTES_MODEL ?? '').trim()
     if (raw === '') return {skip: true} // fail-soft: skip when unset (warn + exit 0)
     return {skip: false, model: raw} // operator must point this at a proxy-served id
   }
   ```

2. **Use a proxy-served (dated) model id.** Prefer ids like
   `anthropic/claude-haiku-4-5-20251001`. Verify against the **serving layer**,
   not the client catalog.

3. **Bound the narration path with a real timeout.** A stalled provider must fail
   fast and be classified as a soft warning — never an unbounded hang.

4. **Make the release-body update idempotent — and anchor the marker structurally.**
   A stable marker (`<!-- fro-bot-narration-v1 -->`) on its own line, immediately
   under the `## What's new` heading, lets a re-run skip instead of double-narrating;
   keep the raw changelog under `<details>`. Match it by structural position, **not**
   by substring: the body embeds a `<details>` changelog whose PR titles are
   user-influenced, so a bare `body.includes(marker)` check lets a forged marker in a
   PR title suppress narration permanently. See
   [`../logic-errors/sentinel-marker-must-be-position-anchored-when-body-contains-untrusted-content-2026-07-17.md`](../logic-errors/sentinel-marker-must-be-position-anchored-when-body-contains-untrusted-content-2026-07-17.md).

5. **Enforce side effects structurally, not by prompt wording.** Do not rely on
   prompt text to suppress unwanted GitHub posts. Dispatch with
   `response-mode: none` so the workflow edits the release body directly and posts
   nothing. (Narration also runs `enable-omo: false` — it needs no orchestration —
   and `output-mode: working-dir`, all gated on the correlation id.) Note the scope
   boundary: `correlation-id` is for **run selection / audit only**. The credential
   scope selector (read-only `GITHUB_TOKEN` vs write-capable `FRO_BOT_PAT`) must be
   keyed on the **operation input** (`release-tag` present vs absent), never on the
   tracing token — see
   [`key-credential-switch-on-operation-input-not-audit-token-2026-07-17.md`](./key-credential-switch-on-operation-input-not-audit-token-2026-07-17.md).

6. **Classify outcomes by precedence — security first, narration soft.**
   - **Auth failure is the only hard fail (exit 1), checked first.**
   - Timeout, non-zero `gh run watch` exit, short body, skipped/action_required →
     soft warn (exit 0).
   - The `gh run watch` exit code is **observation data, not a verdict**.
   - Off-target log-forensics regex is **fake security** (misses `gh api`, `curl`,
     Octokit, quoted tags) — demote it to a best-effort warn. Real prevention is
     the dispatch token's scope plus `response-mode: none`.

## Why This Matters

This is a classic silent-hang trap: everything "looks valid" until the serving
layer refuses the exact model id — no output, no obvious error, no rollback, and a
long, wasteful wait. The fix is not more retries or better prompts; it is a
**serving-valid model id**, a **bounded timeout**, and a **fail-soft release
policy**.

And narration is cosmetic. By the time the `successCmd` runs, the release has
already published. A narration hiccup must never take down the publish path —
which is exactly why the precedence rule treats only genuine auth failures as
hard failures and soft-warns everything else.

## When to Apply

Use this pattern for any post-release or post-commit automation that:

- dispatches a separate workflow or agent;
- depends on a hosted model/router/proxy;
- rewrites release metadata or a published artifact;
- must never block the primary release; or
- can hang silently when the upstream service accepts a connection but never
  produces output.

Also apply it whenever the client catalog and serving layer may diverge, you need
correlated async run selection, or you are tempted to classify failures purely
from watch/poll exit codes.

## Examples

### Bad: hardcoded model + unbounded wait

```ts
const model = 'anthropic/claude-haiku-4-5'
await dispatchNarration({model, timeoutMs: 0})
// model is "listed", but cliproxy returns 502 for the alias;
// OpenCode emits nothing; and timeoutMs: 0 means the run hangs forever.
```

### Good: config-driven dated model + bounded timeout

```ts
const resolved = resolveNarrationModel(process.env)
if (resolved.skip) {
  warn('release-notes narration skipped: RELEASE_NOTES_MODEL unset')
  process.exit(0)
}
await dispatchNarration({
  model: resolved.model, // anthropic/claude-haiku-4-5-20251001 (cliproxy-served)
  timeoutMs: 10 * 60 * 1000,
  responseMode: 'none',
  enableOmo: false,
})
```

### Bad: timeout treated as failure before auth

```ts
if (timedOut) return softWarn() // a timed-out run that ALSO had an auth failure silently passes
if (authFailed) return hardFail()
```

### Good: security invariants hard, narration quality soft

```ts
if (authFailed) return hardFail() // security invariant: the only hard fail
// narration-quality / watch failures never block an already-published release:
if (timedOut || watchFailed || bodyTooShort || skipped || actionRequired) {
  return softWarn()
}
```

### Correlated async dispatch

```ts
import {randomUUID} from 'node:crypto'

const correlationId = randomUUID()
const runName = `Fro Bot · release-notes · ${correlationId}`
// select the run by displayTitle.includes(correlationId) AND createdAt >= dispatchEpoch;
// 0 matches → null (soft warn); >1 → ambiguous sentinel (soft warn); never classify a wrong run.
```

### Release body shape

```md
## What's new

<!-- fro-bot-narration-v1 -->

Short human-readable summary of the release.

### Fixes
- #123 — concise description

<details><summary>Full changelog</summary>

...original semantic-release notes...

</details>
```

## Related

- [`key-credential-switch-on-operation-input-not-audit-token-2026-07-17.md`](./key-credential-switch-on-operation-input-not-audit-token-2026-07-17.md)
  — the two-phase redesign (PR #1239): the credential selector for the read-only
  generate phase keys on the operation input, not the correlation id.
- [`../logic-errors/sentinel-marker-must-be-position-anchored-when-body-contains-untrusted-content-2026-07-17.md`](../logic-errors/sentinel-marker-must-be-position-anchored-when-body-contains-untrusted-content-2026-07-17.md)
  — the position-anchoring requirement behind Rule #4's marker scheme.
- [`workspace-executor-opencode-provisioning-best-practices-2026-06-01.md`](./workspace-executor-opencode-provisioning-best-practices-2026-06-01.md)
  — the cliproxy / model-routing / deploy-time provisioning surface. Same
  "route models through config, distinguish absent vs malformed" axis, but for
  runtime workspace provisioning rather than the release pipeline.
- [`../workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md`](../workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md)
  — adjacent prompt-vs-enforcement example: make the intended action explicit in
  the workflow contract instead of relying on prompt wording.
- [`../workflow-issues/comment-only-review-blocked-approval-2026-06-01.md`](../workflow-issues/comment-only-review-blocked-approval-2026-06-01.md)
  — adjacent example of coupling a platform side-effect to a structural contract
  rather than prompt text.
