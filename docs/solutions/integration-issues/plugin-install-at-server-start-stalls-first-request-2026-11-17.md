---
title: A plugin install at OpenCode server start stalls the first request, so the Action installs plugins at setup and gates on activation
date: 2026-11-17
category: integration-issues
module: setup
problem_type: integration_issue
component: tooling
symptoms:
  - "On OpenCode 1.x, runs log `SDK server bootstrapped successfully`, then sit silent for 181-370 seconds before the first request to the server returns"
  - 'On OpenCode 1.x, some runs fail with `error: "fetch failed"` at almost exactly 300.77 seconds'
  - "The server's own log shows nothing between `loading path=.../opencode.jsonc` and `all LSPs are disabled`"
  - "`OpenCode plugin install failed: Installing OpenCode plugin <spec> exceeded 420s` at setup or before the spawn"
  - "`OpenCode V2 server failed to start: Required OpenCode plugin(s) not active: systematic (absent)`"
root_cause: async_timing
resolution_type: environment_setup
severity: high
related_components:
  - agent-execution
  - dependency-management
tags:
  - opencode
  - systematic
  - plugin-install
  - plugin-gate
  - readiness
  - timeout
  - npm
  - tools-cache
---

# A plugin install at OpenCode server start stalls the first request, so the Action installs plugins at setup and gates on activation

## Problem

OpenCode installs any plugin that is not already in its npm cache while the server starts. That install has no timeout of its own, and the HTTP listener is already accepting connections when it runs. On a slow npm registry the server accepts the harness's connection and then answers nothing for minutes, and the harness cannot tell a stall from a slow start.

The Action avoids this by installing both required plugins during setup, each under its own bound, and by treating "listening" and "plugins active" as separate readiness facts.

## Symptoms

The original incident was on OpenCode 1.x, the V1 server, on 2026-09-04.

- `SDK server bootstrapped successfully` logs at the expected time. The next log line is 181 to 370 seconds later.
- Runs that outlast about 300 seconds fail with `error: "fetch failed"` at 300.77 seconds, from the first session call (`listSessionsForProject`).
- The server's own log (the `opencode-logs-*` artifact the Action uploads on every run) shows the gap:

  ```text
  05:30:54.124  loading path=/home/runner/.config/opencode/opencode.jsonc
                ← 370 seconds of total silence ←
  05:37:04.268  all LSPs are disabled
  ```

- It hit four repositories, Action v0.106.0 and v0.107.1, and runs with a tools-cache hit as well as a miss. Every affected run started after 2026-09-04 01:53 UTC. The same commit SHA ran in 6 seconds the day before.

Today the same condition surfaces as a named setup or start failure instead of a silent stall:

- `OpenCode plugin install failed: Installing OpenCode plugin <spec> exceeded 420s`, or `... failed (exit <code>)`, or `... is not in the cache after a successful install`. These come from `installPluginsV2` in `src/services/setup/plugin-install-v2.ts`.
- `OpenCode V2 server failed to start: Required OpenCode plugin(s) not active: <id> (absent)` or `(failed)`. This is the plugin gate in `startOpenCodeV2Server` in `packages/runtime/src/agent/server-v2.ts`.
- `OpenCode V2 plugins did not finish activating within 120000ms (/api/agent: HTTP 503)`. This is the `/api/agent` gate in the same function, and it applies to OpenCode up to 2.2.6.

## What Didn't Work

Each of these was a plausible cause argued from run-log timing, and each was refuted by direct evidence before the server's own log was pulled:

- **A recent Action release.** One repository stalled on v0.106.0, three releases behind. The same SHA ran in 6 seconds on 09-03 and 300.77 seconds on 09-04. Byte-identical code, fast then slow.
- **Tools-cache eviction.** Three stalled runs had a tools-cache hit.
- **A repository-specific cause.** Four repositories showed the same shape in the same window.
- **The Systematic 3.15.0 bump.** It was published 08-25, and runs stayed fast for nine days after it.
- **The models.dev fetch.** It is bounded at 10 seconds, so it cannot produce a 300-second stall.
- **The two most recent cache-service changes.** Neither touched the child environment. The shutdown-quiescence code they added runs only from cleanup, after agent execution. A run without either change stalled identically.

The methodological failure sat above all of these. Three rounds of hypotheses were built on harness-side timing, while the server's own log was already uploaded as a run artifact and answered the question in one fetch.

## Solution

### The mechanism on the V1 server

In the OpenCode 1.19 source, `packages/opencode/src/project/bootstrap.ts` runs instance bootstrap serially, after the listener is bound. It reads config (`config.get()` prints the `loading path=...` lines), then calls `plugin.init()`. That reaches `Npm.add()` and arborist `reify()` in `packages/core/src/npm.ts` with no timeout of its own. npm's client defaults (`fetch-timeout=300000`, `fetch-retries=2`, backoff from 10 s to 60 s) turn a slow registry into the observed 181 to 370 second spread. On V1, every request the harness sent queued behind it.

Whether requests queue behind plugin activation depends on the OpenCode version. [OpenCode 2.2.7 stopped waiting for plugins in GET /api/agent](./opencode-api-agent-no-longer-waits-for-plugins-2026-11-17.md) covers which routes wait on which version, and why readiness must poll `/api/plugin`.

### The current design

The Action runs only stock OpenCode V2, pinned in `packages/runtime/src/shared/opencode-v2-pin.json`. Nothing in it calls the V1 `bootstrapOpenCodeServer` or its `attemptReadinessProbe` in `packages/runtime/src/agent/server.ts`. The code is still exported, but no production caller reaches it.

**1. Install at setup, under a bound.** `src/services/setup/setup.ts` resolves the exact plugin specs with `resolvePluginSpecsV2` and calls `arePluginsCachedV2`. That helper checks for a non-empty `<XDG_CACHE_HOME>/opencode/npm/<spec>` directory for every spec. If both are present, setup logs it and does no install work. Otherwise setup calls `installPluginsV2`, which runs `opencode plugin add <spec>` once per spec:

- The bound is `PLUGIN_INSTALL_TIMEOUT_MS`, 420 000 ms, per install. A healthy install takes seconds, so the ceiling costs nothing in the common case.
- Specs must be exact `x.y.z`. `latest` resolves to `DEFAULT_SYSTEMATIC_VERSION`, and a range or tag is refused (`invalid-version`).
- The child environment is `filterAgentEnv(env)`, never inherited wholesale. The filter is deny-by-default: a key survives only if it matches an exact allowlist or an operational prefix, and the deny set (tokens, `*_API_KEY`, `*_SECRET`, `AWS_*`, `INPUT_*`) is a backstop. `OPENCODE_PURE` is also denied, because it would make the server skip every external plugin.
- The install gets a throwaway root for everything it may write besides the npm cache: its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `OPENCODE_DB`, plus an empty `OPENCODE_CONFIG_CONTENT` and `OPENCODE_DISABLE_PROJECT_CONFIG=1`. `XDG_CACHE_HOME` is the real cache home the server will read. The root is removed afterwards, so the global config that `plugin add` writes never survives.
- `--pure` is not passed. The source comment says it is a V1 flag and V2 `plugin add` was never probed with it.
- After a zero exit, `installPluginsV2` asserts the spec's cache directory is non-empty (`cache-empty`). A zero exit that left nothing behind would hand the same install to the server at boot, unbounded.
- Any failure (`install-failed`, `install-timeout`, `invalid-version`, `cache-empty`) fails setup with a named error.

**2. Install again before every spawn if anything is missing.** `startActionOpenCodeV2` in `src/harness/phases/v2-server.ts` repeats the `arePluginsCachedV2` check before it starts the server, whatever setup or the tools cache did. A cache that holds both specs costs two directory reads. Anything else gets the same bounded installer. The reason is that a missing plugin would otherwise install during server readiness, whose deadlines are shorter than the 181 to 370 second tail.

**3. Save the tools cache only for a good result.** In `src/services/setup/setup.ts`, `saveToolsCache` runs only when `installedNow || toolsCacheResult.hit === false`. A failed install calls `core.setFailed` and returns before that line, so a plugin-less cache is never saved. The cache key built in `src/services/setup/tools-cache.ts` starts with `TOOLS_CACHE_PREFIX` (`opencode-tools-v2`, in `packages/runtime/src/shared/constants.ts`) and carries the OpenCode digest id, the Systematic version and the fro.bot plugin version. A version change therefore misses instead of reusing stale plugins. The cached paths include `<cacheHome>/opencode`, which is where the plugins live.

**4. Gate on activation, not on listening.** `startOpenCodeV2Server` in `packages/runtime/src/agent/server-v2.ts` waits in this order, each wait with its own bound (`DEFAULT_OPENCODE_V2_TIMEOUTS`):

1. The `{url}` line on stdout, 30 s (`listenTimeoutMs`).
2. `GET /api/info` answering 200, 15 s (`infoTimeoutMs`).
3. `GET /api/agent` no longer answering 503, 120 s (`agentReadyTimeoutMs`). This only matters up to 2.2.6.
4. The plugin gate: poll `GET /api/plugin` until every id in `expectedPluginIds` is `active`, 60 s (`pluginGateTimeoutMs`). The action passes `systematic` and `fro-bot.opencode-plugin`. A listed `failed` id ends the gate at once, and the error names ids and statuses only, never the plugin's error text.

Every request in these gates goes through `boundedRequest`, which caps it at `requestTimeoutMs` (10 s). No request inherits a library default. After the gates pass, the permission gate in `src/harness/phases/v2-server.ts` (`readAgentList`) reads `/api/agent`, so the list it checks already carries the configured rules.

## Why This Works

The stall was a network install on the server's request-serving path. Moving it to setup takes the network off that path. When the server starts, the plugins resolve from the local cache in milliseconds. A slow registry now shows up as a slow, logged, bounded setup step with a real duration, or as a named failure. It no longer shows up as a server that reports itself listening and then says nothing.

The gates close the two defects that made the original stall invisible:

- **Readiness was a string match.** On V1, the SDK resolved when the child printed that it was listening, and the listener binds before bootstrap runs. A server that bound, printed and then blocked for five minutes satisfied a two-second budget. The V2 gates measure completed requests and plugin ids, not a printed line.
- **The first call had no timeout.** On V1 it inherited undici's default `headersTimeout` of 300 000 ms, which is why the failures landed at 300.77 seconds as a bare `fetch failed`. Every V2 gate request carries its own bound.

## Prevention

- **Pull the `opencode-logs-*` artifact first** when a server-side stall is suspected. It shows server-side timing that no amount of harness-log analysis can reconstruct.
- **Listening is not ready.** A bound port, a printed banner or a resolved promise proves the process reached one line of code. Readiness means the thing the run needs is verified: a request completed, or the required plugin ids are active.
- **Give every wait an explicit bound.** Without one it inherits a library default measured in minutes, and the failure arrives late, generic and unattributed.
- **A bound must clear the tail of the thing it bounds.** Check the number against the measurements that motivated it, not against the healthy case. 420 s clears the 181 to 370 s measured tail. A 120 s bound would have timed out on a slow but valid install, then let the server run the same install unbounded, paying the timeout and the stall.
- **When a fix runs conditionally on cache state, ask what run N+1 sees.** Save only a good result, and key the cache on every version that decides its contents. A cache that persists its own partial result under an immutable key has one chance to be right per key.
- **Never derive a dependency's on-disk layout in a second place without pinning it to the real one.** `pluginCacheDir` in `src/services/setup/plugin-install-v2.ts` builds `<cacheHome>/opencode/npm/<spec>`, and the post-install non-empty check is what keeps that path honest against what the server reads.
- **Pass the executable, not its directory.** `installPluginsV2` takes `opencodeBinaryPath`, the OpenCode executable. A tool-cache install directory there fails with `EACCES`.

## Related Issues

- [OpenCode 2.2.7 stopped waiting for plugins in GET /api/agent](./opencode-api-agent-no-longer-waits-for-plugins-2026-11-17.md): which routes wait for plugin activation on which version, and why the gate polls `/api/plugin`.
- [Tool cache separation](../performance-issues/tool-binary-caching-ephemeral-runners.md): the tools cache the plugin install rides on, and its rule to cache only immutable, successfully produced artifacts.
- [A tool-cache install directory was spawned where an executable was expected](./tool-cache-directory-spawned-as-executable-2026-09-06.md): the same fail-soft shape, where the install call received a directory and the tools cache never warmed.
- [The OpenCode server bootstraps from the process working directory](./opencode-server-boots-from-cwd-not-session-directory-2026-08-07.md): another case of server startup semantics differing from what the harness assumed.
- [Fail fast on structured provider authentication failures](./provider-auth-failure-hangs-to-timeout-2026-07-25.md): the same shape of an actionable failure decaying into a generic deadline.
- [A check reports clean for the part of the world it cannot observe](../workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md): the V1 readiness string match was a check whose observed population was one stdout line.
- [Verify behavior, not signal](../workflow-issues/verify-behavior-not-signal-2026-08-23.md): a successful response proves a response, not the state behind it.
