---
title: OpenCode 2.2.7 stopped waiting for plugins in GET /api/agent, so readiness must poll /api/plugin
date: 2026-11-17
category: integration-issues
module: agent-execution
problem_type: integration_issue
component: tooling
symptoms:
  - 'Image smoke test fails with "plugins not active: systematic, fro-bot.opencode-plugin" right after /api/agent returns 200'
  - Real-binary permission gate tests fail with no-agents because GET /api/agent answers 200 with an empty list
  - 'On 2.2.6: "Could not read the effective agent rules: The operation was aborted due to timeout"'
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - opencode
  - opencode-v2
  - plugin-activation
  - readiness
  - api-agent
  - api-plugin
  - permission-gate
  - version-pin
---

# OpenCode 2.2.7 stopped waiting for plugins in GET /api/agent, so readiness must poll /api/plugin

## Problem

Up to OpenCode 2.2.6, `GET /api/agent` blocked while plugins activated and answered 503 after its own 5 s wait. A 200 therefore meant plugins were active. From 2.2.7 the route answers at once (anomalyco/opencode#62796). Code that read a 200 from `/api/agent` as "plugins are ready", or read the agent list for a permission check right after the listening line, broke on the version bump.

## Symptoms

- The image smoke test failed with `plugins not active: systematic, fro-bot.opencode-plugin`. The plugins appeared about half a second later.
- Real-binary permission tests failed, intermittently, with `no-agents`.
- Earlier, on 2.2.6, a run failed at start with `Could not read the effective agent rules: The operation was aborted due to timeout`.

After the listening line on 2.2.7 and 2.3.0, `/api/agent` goes through three states: an empty list, the built-in agents with only their default rules, then the full permission set. `/api/plugin` lists nothing until activation finishes.

## What Didn't Work

- **Treating a 200 from `/api/agent` as "plugins active"** and reading `/api/plugin` once after it. On 2.2.7 that read returns `data: []`.
- **A test helper that retried the agent list only on 503.** The route now answers 200 with an empty or default-rules list.
- **Retrying only until the agent list is non-empty.** The list is non-empty with default rules before the configured rules land, so a permission check still reads the wrong state.
- **A 10 s plugin gate.** On 2.2.6 the 503 loop on `/api/agent` gave activation up to 120 s without anyone noticing. Once that wait was gone, 10 s was the only bound.
- **A 5 s client timeout on `/api/agent`** (2.2.6). It raced the server's own 5 s wait, so a slow but healthy activation failed the run.

## Solution

Treat plugin activation and the agent list as two separate waits.

1. **Poll `GET /api/plugin` until every required plugin id is `active`**, inside a deadline. Match by id, and stop at once if a required id is `failed`. This is the plugin gate in `startOpenCodeV2Server` in `packages/runtime/src/agent/server-v2.ts`; `classifyExpectedPlugins` does the matching.
2. **Give that wait its own bound.** `pluginGateTimeoutMs` defaults to 60 s.
3. **Read the agent list for permissions only after the plugin gate passes.** The permission gate in `src/harness/phases/v2-server.ts` runs second. It retries on HTTP 503 or a client timeout within 30 s, with a 7 s attempt, which covers 2.2.6.
4. **One-shot scripts and test helpers poll too.** `deploy/scripts/v2-image-smoke.mjs` polls `/api/plugin` inside its existing deadline. The `listAgents` helper in `src/services/setup/ci-config-v2.integration.test.ts` waits for active plugins before it accepts an agent list.

```js
await waitFor(
  "/api/plugin (expected plugins active)",
  async () => {
    const result = await get("/api/plugin", authorization)
    inactive = result.status === 200 ? findInactivePlugins(result.body, EXPECTED_PLUGIN_IDS) : EXPECTED_PLUGIN_IDS
    return inactive.length === 0 ? {done: true, value: true} : {done: false, note: `not active: ${inactive.join(", ")}`}
  },
  deadline,
)
```

## Why This Works

The server now has two independent readiness facts: it is listening, and its plugins are active. Only `/api/plugin` reports the second. Polling it by id makes the wait explicit, and ordering the permission read after it means the agent list already carries the configured rules.

Upstream restored the plugin wait only for the model, provider, generate, voice and websearch routes (anomalyco/opencode#63040), and marks that as a temporary exception. Do not rely on any route to wait.

## Prevention

- Any new client, script, test helper or supervisor that talks to a stock OpenCode V2 server waits on `/api/plugin` by id before it trusts plugin-dependent state.
- When a pin bump changes when a route answers, check every place that used the old timing as a readiness signal, including smoke scripts and test helpers. They are not covered by the production gate's tests.
- Bot-authored pin PRs skip the job that runs the Action with a model. Dispatch CI on the branch before merging a V2 pin bump, so that job runs against the new binary.

## Related Issues

- [Systematic plugin install stalls OpenCode bootstrap](./systematic-plugin-install-stalls-opencode-bootstrap-2026-09-04.md): an earlier case of a listening server that was not ready. Its statement that every request queues behind plugin setup describes V1 and V2 up to 2.2.6.
- [Verify behavior, not signal](../workflow-issues/verify-behavior-not-signal-2026-08-23.md): a successful response proves a response, not the state behind it.
- #2174, #2182, #2153, #2197.
