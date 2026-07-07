---
title: harden-runner allowed-endpoints as a YAML literal scalar silently drops all but the first endpoint
date: 2026-07-07
category: workflow-issues
module: .github/workflows/harness-integrate.yaml
problem_type: workflow_issue
component: tooling
severity: high
symptoms:
  - actions/checkout fails 3 retries with "Failed to connect to github.com port 443 after 1 ms"
  - harden-runner logs "domain not allowed: github.com" for a domain that IS in allowed-endpoints
  - harden-runner drops the connection to its sinkhole IP 54.185.253.63
  - the agent parsed-config log shows only the first endpoint in the allow map
root_cause: config_error
resolution_type: config_change
related_components:
  - development_workflow
  - github-actions
tags:
  - harden-runner
  - allowed-endpoints
  - yaml
  - block-scalar
  - egress
  - github-actions
  - step-security
---

# harden-runner allowed-endpoints as a YAML literal scalar silently drops all but the first endpoint

## Problem

`.github/workflows/harness-integrate.yaml` (the reusable workflow that runs an autonomous LLM merge of untrusted upstream OpenCode PRs) gained a `step-security/harden-runner` egress block in PR #1108. That broke the harness release: `actions/checkout` could no longer reach `github.com`, **even though `github.com:443` was listed in `allowed-endpoints`**. The OpenCode 1.17.14 harness release failed across three dispatch attempts; nothing published (build/publish/release all fail-closed skipped).

## Symptoms

- `actions/checkout` (`git-remote-http`), 3 retries: `fatal: unable to access 'https://github.com/fro-bot/agent/': Failed to connect to github.com port 443 after 1 ms: Couldn't connect to server` → exit `128`.
- harden-runner monitor log: `domain not allowed: github.com.` and `ip address dropped: 54.185.253.63`. `54.185.253.63` is harden-runner's fixed **sinkhole** IP — the same IP was logged for `github.com` and for `hosted-compute-*.githubapp.com`, the tell that it's a decoy, not a real edge IP.
- The smoking gun — the agent's own runtime parsed-config log: `Allowed domains:map[api.github.com.:[{api.github.com. 0}] productionresultssa8.blob.core.windows.net.:[...443}]]`. **Only `api.github.com`** out of the 11-entry allowlist parsed — and even it has a malformed `port: 0`.
- Deterministic: 3/3 dispatches failed identically.

## What Didn't Work

1. **Treating the first failure as a flake and re-dispatching.** Two identical failures with the *same* sinkhole IP is systematic, not transient. The `after 1 ms` in the git error is the tell: an immediate iptables `REJECT` from harden-runner, not a network timeout. A real flake looks like a timeout, intermittent success, or a varying failure shape — not a byte-identical repeat.

2. **Reordering `actions/checkout` to run before the harden-runner step** (PR #1137, later reverted). The premise — "checkout runs before harden-runner installs its iptables rules" — is wrong. harden-runner defines a `pre:` entrypoint in its `action.yml`, so a `Pre Harden runner egress` step runs before *every* regular step regardless of `steps:` position. Evidence: the executed step list showed `Pre Harden runner egress` at position 2, before `Checkout repository` at position 3 — and checkout still failed identically. See the companion doc on the pre-hook (Related, below).

## Solution

harden-runner's agent tokenizes `allowed-endpoints` by splitting on **spaces only** (confirmed in harden-runner v2.19.4 — it appends its own cache host with a leading space). The workflow wrote the allowlist as a YAML **literal** block scalar (`|`), which **preserves newlines**. So the 11 newline-separated endpoints collapsed into one unparseable token and only the first (`api.github.com`) survived.

Fix: change the block scalar from literal `|` to **folded `>-`**, which replaces interior newlines with single spaces:

```yaml
# BEFORE (broken — literal | preserves newlines; the space-split parser sees ONE token):
          allowed-endpoints: |
            api.github.com:443
            github.com:443
            broker.fro.bot:443
            ...

# AFTER (fixed — folded >- collapses newlines to spaces; the parser sees all 11 tokens):
          allowed-endpoints: >-
            api.github.com:443
            github.com:443
            broker.fro.bot:443
            ...
```

Verified: the agent then parsed all 11 endpoints (`github.com`, `broker.fro.bot`, `cliproxy.fro.bot`, `registry.npmjs.org`, …), and the release ran end-to-end — checkout → broker mint → 10-carry LLM merge → build → publish `@fro.bot/harness@1.17.14+harness.e98fbc0f`. (PR #1139.)

## Why This Works

YAML `|` (literal) keeps interior newlines; `>-` (folded, strip) replaces interior newlines with single spaces and strips the trailing newline. Because harden-runner tokenizes on spaces, the folded form yields 11 discrete `host:port` tokens; the literal form yielded one `"a\nb\nc…"` blob that failed to parse past the first entry. It's a mismatch between how the YAML *looks* to a human (a clean list) and how the consuming tool *parses* the scalar's string value.

## Prevention

- **For any action input that is a space/whitespace-delimited LIST written as a YAML block, use folded `>-`, not literal `|`** — unless you have confirmed the consumer splits on all whitespace (newlines included). harden-runner does not.
- **Verify the consumer's parse, not the YAML's appearance.** Read the tool's runtime "parsed config" / "allowed domains" log and assert every intended entry is present. One look at `Allowed domains:map[api.github.com. …]` here would have shown only one endpoint.
- **Recognize the harden-runner failure signature:** `domain not allowed: <a domain that is already in your allowlist>` + drop to `54.185.253.63` (its sinkhole) + `… after 1 ms` in the client error = an allowlist parse/correlation miss, **not** a network problem. Do not re-run; inspect the parsed-config log.
- **A manual-dispatch-only workflow (like harness-release) is never exercised by PR CI**, so a config bug in it ships latent and only surfaces on the first real dispatch. Consider a lint/dry-run gate for such workflows.
- harden-runner enforces from a pre-job hook — never rely on step ordering to escape or delay its egress policy (see the companion doc).

## Related

- [harden-runner enforces egress via a pre-job hook, so reordering its step is ineffective](harden-runner-pre-hook-renders-step-order-irrelevant-2026-07-07.md) — the companion lesson from the same incident (the reverted PR #1137 attempt).
- [Isolate a CI credential from an autonomous agent via an OIDC broker](isolate-ci-credential-via-oidc-broker-2026-07-01.md) — the broker mint on this same `harness-integrate.yaml` workflow; that doc noted egress containment was deferred, and this harden-runner block (PR #1108) is that containment.
- PR #1108 (added the egress block), #1137 (reverted reorder attempt), #1139 (the folded-scalar fix).
