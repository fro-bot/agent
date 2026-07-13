---
title: An injected permission deny blocked the harness's own response-file delivery path
date: 2026-07-13
category: logic-errors
module: agent-response-delivery
problem_type: logic_error
component: development_workflow
severity: high
symptoms:
  - "Consumer-repo PR reviews fail with 'file-read-failed — ENOENT' on the response file after the agent completes its review"
  - "The model reports its response-file write is blocked at the tool-permission layer (external_directory deny) while OS-level permissions allow the write"
  - "Run fails fail-closed; the review verdict appears in the agent transcript but is never delivered"
root_cause: logic_error
resolution_type: code_fix
tags:
  - security-composition
  - external-directory
  - permission-config
  - response-file
  - runner-temp
  - fail-closed
---

# An injected permission deny blocked the harness's own response-file delivery path

## Problem

Two security features composed into a self-block. First, the response-file delivery convention deliberately places the model's response file outside the checkout — `$RUNNER_TEMP/fro-bot-response/<runId>-<attempt>/<nonce>.md` — so a hostile checkout can never preseed or tamper with it. Second, the CI config builder injects `agent.build.permission.external_directory: 'deny'` (a hardening measure that predates the file convention) into every consumer's OpenCode config. OpenCode's shell-command scanner and write/edit tools raise an `external_directory` permission ask for any external directory a command touches, so the flat deny blocked the model from writing to the exact path the harness later reads back.

First observed live on a consumer repo's PR review run: the model correctly diagnosed the permission-layer block (OS-writable, directory exists, tool-layer deny), recorded an undelivered verdict in its transcript, and finalize failed fail-closed with `file-read-failed` ENOENT.

## What Didn't Work

The failure was invisible in the repo that shipped the change — reviews on the harness's own repo succeeded, because per-repo `opencode-config` secrets differ and permission evaluation outcomes differed with them. CI green plus a passing self-review did not prove the delivery path worked across consumers.

Code review of the delivery feature did not catch the collision: the review evaluated the new feature's security in isolation. Nobody enumerated the existing denies the harness itself injects and checked the new out-of-boundary write requirement against them.

## Solution

The flat deny became a scoped map in the CI config builder (`src/services/setup/ci-config.ts`, `scopeExternalDirectoryPermission`):

```
{ '*': 'deny', '<RUNNER_TEMP>/fro-bot-response/*': 'allow' }
```

Everything external stays denied; only the harness-owned response area is writable. Key mechanics, verified against the vendored OpenCode source:

- A config pattern's `*` compiles to regex `.*` and matches `/`, so a single pattern covers both the shell scanner's directory glob and the write tool's parent-directory glob.
- Permission evaluation is `findLast` — the last matching rule wins — so the `'*'` deny is deliberately inserted *before* the specific allow.
- The `fro-bot-response` path segment is a shared exported constant (`RESPONSE_FILE_DIR_SEGMENT` in `packages/runtime/src/agent/response-file.ts`) used by both the path builder and the config pattern, so the two cannot drift apart.
- If `RUNNER_TEMP` is unset, the builder falls back to the flat deny (fail-safe).

## Why This Works

The trust argument is unchanged: the model still cannot write anywhere external except the nonce-named, run-scoped directory the harness itself created and asserted empty. The workspace-preseed defense is untouched. The fail-closed delivery assertion still catches a missing file.

## Prevention

Security features compose. When a change gives the agent a new required capability across a boundary — here, write access outside the checkout — the review checklist must enumerate every existing deny or restriction the harness itself injects (permission config, env scrub allowlists, egress allowlists, file-system boundaries) and check the new requirement against each one. A feature that passes review in isolation can be dead-on-arrival against the system's own hardening.

A delivery-path change must also be proven on a consumer repo (or a simulated consumer config), not just the home repo — per-repo config secrets make permission outcomes repo-specific.

## Related

- [Treat a model-authored response file as untrusted input and bind posting to the trusted event context](../best-practices/response-file-is-untrusted-input-2026-07-11.md) — the delivery-path trust design this fix preserves.
- [A same-job phase split is not a security boundary](../best-practices/same-job-phase-split-not-a-security-boundary-2026-07-04.md) — a related lesson on where trust boundaries actually live.
