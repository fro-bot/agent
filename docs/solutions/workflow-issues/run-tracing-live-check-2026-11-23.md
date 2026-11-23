---
title: Check run tracing end to end, locally and on the published Action
date: 2026-11-23
category: workflow-issues
module: setup
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - The tracing plugin or the Action's trace relay changed and a release is planned
  - A local OpenCode session should send its trace to a collector
  - A workflow passes a collector credential to `trace-headers`
symptoms:
  - "A local `opencode run` session exports nothing; the plugin logs `tracing off (headless-host)`"
  - "A local trace check fails at once with `AI.Error.Authentication: Invalid bearer token`"
  - "Tracing turns off with a warning that `trace-headers` is not `Name: value`"
  - "The plugin release workflow reports the tarball is missing `THIRD_PARTY_NOTICES.md` when the listing shows it"
tags:
  - tracing
  - opentelemetry
  - langfuse
  - trace-relay
  - live-check
  - published-install
  - opencode-v2
---

# Check run tracing end to end, locally and on the published Action

## Context

Run tracing has two halves: the Fro Bot OpenCode plugin captures spans, and in the Action a relay forwards them to the operator's collector with the credential. Unit tests and the real-binary suites cover each half against a local stand-in. Only a real model, a real collector and a published install show that a backend can read the trace. Plugin 0.2.0 and Action v0.147.0 were checked this way before tracing was announced.

## Guidance

**Local check, before publishing the plugin**

- Trace a local session through the TUI or a plain `opencode serve`, driven over its HTTP API. `opencode run` starts a private `serve --stdio` when no service is running, and the plugin treats that as a headless host and stays off. It traces only when `run` attaches to a running service.
- Run on the OpenCode profile's own config dir and `HOME`, with the plugin and the tracing settings added on top. When provider credentials are OAuth connections served by auth plugins, those plugins load only from that config, so a bare temporary config sends requests with no valid bearer.
- The settings file is consent for the whole machine. Remove it after the check.
- Read the plugin's own lines: `tracing on, destination host …` at start and `tracing stopped, exported N spans, dropped M` at stop. A session that fails before the model answers still exports its root and the failed request, so a small span count with `dropped 0` usually means the model call failed, not the export. Check the server log for the session's error.

**Published-install check, after the release**

- Run from a throwaway branch in a public repository with no private content. Put the probe in an existing dispatchable workflow file, as in [the published-install learning](published-install-live-check-before-rollout-2026-11-17.md).
- Dispatch three runs: isolated, not isolated, and isolated with a wrong credential. Use `output-mode: working-dir` and `response-mode: none` so the runs post nothing, and pass `github.token` with `contents: read`, because the non-isolated agent can read whatever token it is given.
- The collector token for an Action sender group is delivered as a bare token secret. Build the header in the workflow: `trace-headers: "Authorization: Bearer ${{ secrets.<NAME> }}"`. A bare token in `trace-headers` is refused and tracing turns off.
- Read the relay's lines in each run log:

| Run | `Trace relay stopped` | Other lines |
| --- | --- | --- |
| Isolated | `acknowledged: 6`, `retry: 0`, `dropped: 0`; plugin reported 9 spans | Read-only view probe passed; sandbox stopped and restored |
| Not isolated | same counts | Warning: the agent can read the collector credential and the content of every span |
| Isolated, wrong credential | `acknowledged: 0`, `dropped: 3`; plugin reported 0 spans | The run succeeds |

- Then read the trace in the backend: one Langfuse session per run with its subagent grouped under it, and the prompt, tool inputs and tool results readable. Tempo holds structure only.
- Afterwards delete the branch and the caches it created, revoke the token and delete the secret.

**Release workflow**

A `tar -tzf … | grep -qx …` check under `pipefail` can fail when `grep` exits at its first match before `tar` finishes writing, so the step reported the notices file missing while its own listing showed it (#2312). Read the listing into a variable and match with a here-string, as #2304 did for the image smoke tests.

## Why This Matters

Each half of tracing passed its own tests while the end-to-end path still had four separate ways to send nothing: a headless launch, a missing provider credential, a bare-token secret and a flaky release check. All four look like "tracing is broken" from the outside, and none is a tracing bug. A wrong collector credential, by contrast, must never fail the run; the third live-check row is the evidence that it doesn't.

## When to Apply

- Before publishing a plugin version that changes what is captured or how it is exported.
- Before announcing a release that changes the relay, the tracing inputs or the plugin pin.
- When an operator reports an empty or partial trace.

## Related

- [Prove an Action change on the published install with a real caller](published-install-live-check-before-rollout-2026-11-17.md)
- Issue #2310: the turn's final answer on the root span, not shipped
- Issue #2300: known limits of matching model steps to requests
