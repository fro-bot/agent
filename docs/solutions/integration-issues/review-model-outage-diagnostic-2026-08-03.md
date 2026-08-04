---
title: Diagnosing a Fro Bot review-model outage (APIError 400 in the required check)
date: 2026-08-03
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: tooling
symptoms:
  - "Test GitHub Action (the Fro Bot review job) failed with Session error: name=APIError; status=400"
  - "Failure occurred ~1s after session start, through the generic grace-period path (graceCycles=3)"
  - "No review verdict was produced; the required check hard-failed and wedged merge"
  - "Re-running reproduced the identical error on the same session id"
root_cause: config_error
resolution_type: config_change
severity: high
tags:
  - review-model
  - anthropic
  - clear-thinking
  - opencode-log
  - cliproxy
  - session-error
  - timeout
---

# Diagnosing a Fro Bot review-model outage (APIError 400 in the required check)

## Problem

The required `Test GitHub Action` check (the Fro Bot PR-review job) failed ~1 second into execution with a generic `Session error: name=APIError; status=400` and produced no verdict, blocking merge on every human-authored PR. The generic action-level error hid a provider-side model-config failure, and the diagnostic instinct to "re-run the flake" was wrong.

## Symptoms

- The review job fails through the generic session-error grace path (`graceCycles=3`), not a distinct error kind.
- The only action-visible detail is `name=APIError; status=400`.
- Re-running reproduces the **identical** error — same message, same session id — minutes apart.
- Every other CI check is green; CodeQL clean.
- Bot/renovate PRs merge fine (they are review-exempt).

## What Didn't Work

- **Re-running as a transient flake.** A flake does not reproduce identically minutes later; identical reproduction (same session id, same error) means a systematic/deterministic cause, not a flake.
- **Blaming the PR's own diff.** Every non-review check passed, and the failing model call is upstream of any repo code — the diff was not the cause.
- **Reading only the GitHub Action failure surface.** The action collapses the provider stream error into a generic `APIError; status=400`; the real cause is not visible there.

## Solution

Pull the run's `opencode.log` artifact — the provider-specific error lives only there:

```bash
gh run download <run-id> -n opencode-logs-<run-id>-<N>   # artifact name is run-suffixed
```

For this outage the log revealed:

```
AI_APICallError: `clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive
providerID=anthropic modelID=claude-opus-4-8
```

Then prove whether it is model-specific with a benign model-override dispatch (the review path is reachable via `fro-bot.yaml`'s `model` input, which overrides `vars.FRO_BOT_MODEL`):

```bash
gh workflow run fro-bot.yaml --ref main \
  -f model='anthropic/claude-sonnet-5' \
  -f prompt='Model connectivity check only. Reply with one line. Take no actions.'
```

Then download that run's `opencode.log` (as above) and check whether the `clear_thinking` error is present.

Three-model result (identical benign prompt, through cliproxy):

| Model                         | Result                           |
| ----------------------------- | -------------------------------- |
| `anthropic/claude-opus-4-8`   | ❌ `clear_thinking_20251015` 400 |
| `anthropic/claude-sonnet-4-6` | ❌ `clear_thinking_20251015` 400 |
| `anthropic/claude-sonnet-5`   | ✅ clean, 0 errors               |

**Interim fix (ops):** set the `FRO_BOT_MODEL` repository variable to `anthropic/claude-sonnet-5`, then re-run the failed `Test GitHub Action` check. **Root fix** is proxy-side and lives in a separate repo (see Related Issues) — the model swap is a stopgap, not the fix.

## Why This Works

The `clear_thinking_20251015` context-management strategy is applied on the **cliproxy / model-catalog** request path, not by fro-bot/agent or the bundled OpenCode harness. Verified against OpenCode's own source: it never sets Anthropic `contextManagement`/`clear_thinking` (it only gates such a strategy for Z.ai/ZhipuAI over openai-compatible) and is otherwise pass-through, reading `providerOptions.anthropic.thinking` only if already present. Model options come from the models.dev catalog plus provider config. So the strategy is injected proxy-side, and older Anthropic models trip the provider's "requires `thinking` enabled or adaptive" enforcement while thinking is off. `claude-sonnet-5` is not affected.

## Prevention

- **On a review-job session failure, download `opencode.log` first.** The action surface only shows `APIError; status=<code>`; the provider stream error (the real cause) is in the log artifact.
- **Identical reproduction = systematic, not flake.** Do not burn re-runs on a deterministic error; the same session id + same error across attempts is the tell.
- **Bot/renovate PRs mask review-model outages.** They are review-exempt, so the review model can be broken for days while bot PRs merge cleanly — the first _human_ PR after a provider/model/proxy change is the real detector. Treat a review-model change as needing a human-PR (or dispatched-canary) check.
- **A model swap is a workaround; the provider/proxy config is the fix.** When the injection point is the proxy/model catalog, file the fix against the infra repo that owns it (cross-repo split) and keep the agent-side impact issue open until the proxy fix lands.
- **Use the `fro-bot.yaml` `model` dispatch input as a canary** to test a specific model through cliproxy without changing the repo default.

## Related Issues

- fro-bot/agent#1314 — agent-side impact record (reopened; tracks the outage until the proxy fix lands).
- marcusrbrown/infra#1036 — the actual fix owner (CLIProxy applies `clear_thinking` with thinking disabled).
- Related but distinct: [Fail fast on structured provider authentication failures](provider-auth-failure-hangs-to-timeout-2026-07-25.md) — that doc classifies provider-auth errors as terminal in-code; this doc is the diagnostic runbook for a review-model config outage.
