---
title: Systematic plugin install stalls OpenCode bootstrap behind an already-listening server
date: 2026-09-04
category: integration-issues
module: setup
problem_type: integration_issue
component: tooling
symptoms:
  - "Runs log `SDK server bootstrapped successfully`, then sit silent for 181-370 seconds before the first request to the server returns"
  - "Some runs recover after the stall; others fail with `error: \"fetch failed\"` at almost exactly 300.77 seconds"
  - "The server's own log shows nothing between `loading path=.../opencode.jsonc` and `all LSPs are disabled`"
  - "Affects every action version, every repository, and runs with a tools-cache hit as well as a miss"
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
  - bootstrap
  - readiness
  - timeout
  - npm
  - undici
---

# Systematic plugin install stalls OpenCode bootstrap behind an already-listening server

## Problem

The Action injects `@fro.bot/systematic` into the CI OpenCode config but never installed it. The OpenCode server installed it during instance bootstrap — a blocking, unbounded npm install that ran *after* the HTTP listener was already accepting connections. When the npm registry was slow, the server accepted the harness's connection and then answered nothing for minutes, and the harness had no way to tell.

## Symptoms

- `SDK server bootstrapped successfully` logs at the expected time; the next log line is 181–370 seconds later.
- Runs that finish the stall continue normally. Runs that exceed ~300 seconds fail with `error: "fetch failed"` at almost exactly 300.77 seconds, from the first session call (`listSessionsForProject`).
- The server's own log (the `opencode-logs-*` artifact the Action uploads on every run) shows the gap precisely:

  ```text
  05:30:54.124  loading path=/home/runner/.config/opencode/opencode.jsonc
                ← 370 seconds of total silence ←
  05:37:04.268  all LSPs are disabled
  ```

- Cross-repository (four repositories), cross-version (v0.106.0 and v0.107.1), and independent of tools-cache state — three stalled runs had a cache **hit**.
- Wall-clock bounded: every affected run started after 2026-09-04 01:53 UTC; the same commit SHA ran in 6 seconds the day before.

## What Didn't Work

Each of these was a plausible cause, argued from run-log timing correlations, and each was refuted by direct evidence before the server's own log was pulled:

- **A recent action release.** `space-bus` stalled on v0.106.0, three releases behind. The same SHA `eeb3dbd15` ran in 6s on 09-03 and 300.77s on 09-04. Byte-identical code, fast then slow.
- **Tools-cache eviction.** Three of the stalled runs had a tools-cache hit. Cache state correlated with severity in one repository and was refuted as a cause by the others.
- **Repository-specific.** Four repositories, same window, same shape.
- **The Systematic 3.15.0 bump.** Published 08-25; runs stayed fast for nine days after it.
- **The models.dev fetch.** Bounded at 10 seconds in `models-dev.ts:180`; it cannot produce a 300-second stall.
- **The two most recent cache-service changes.** Investigated in depth at the user's insistence. Neither touched the child environment (`with-scrubbed-env.ts` and `filter-env.ts` had empty diffs); the shutdown-quiescence code they added is reached only from cleanup, after agent execution; and a run without either change stalled identically.

The methodological failure sat above all of these: three rounds of hypotheses built on harness-side timing, when the server's own log was already uploaded as a run artifact and answered the question in one fetch.

## Solution

The pinned OpenCode source made the mechanism unambiguous once the log pointed at it. `packages/opencode/src/project/bootstrap.ts` runs instance bootstrap serially, and the HTTP listener is already bound when it starts:

```ts
yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
yield* config.get()          // emits the "loading path=..." lines
// Plugin can mutate config so it has to be initialized before anything else.
yield* plugin.init()         // ← the 370 seconds happen here
yield* Effect.forEach([lsp, shareNext, format, vcs, snapshot, project], ...)
```

`plugin.init()` reaches `Npm.add()` → arborist `reify()` with no timeout of its own (`core/src/npm.ts:80-108`, behind a 300-second flock at `core/src/util/flock.ts:27`). npm's client defaults — `fetch-timeout=300000`, `fetch-retries=2`, backoff from 10s to 60s — turn a slow registry into the observed 181–370 second spread. Every request the harness sends queues behind it.

The fix installs the plugin during setup so the server's `plugin.init()` finds it already present and does no network work (`src/services/setup/systematic-plugin.ts`, `installSystematicPlugin`):

```ts
const args = ['--pure', 'plugin', `@fro.bot/systematic@${systematicVersion}`, '--global']
const execOptions = {
  env: {
    ...filterAgentEnv(process.env),
    OPENCODE_CONFIG_CONTENT: emptyConfig,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  },
  // ...
}
const exitCode = await execWithTimeout(opencodeBinaryPath, args, timeoutMs, execOptions)
```

Five decisions carry the fix, and each one closed a defect found in review:

1. **OpenCode's own CLI, not a hand-derived cache path.** The `plugin` command reaches `resolvePluginTarget` → `Npm.add()` (`plugin/shared.ts:207-213`, `plugin/install.ts`) — the identical function the server calls, so the package lands in the identical directory by construction. Deriving `~/.cache/opencode/packages/<sanitize(pkg)>` ourselves would have created a second copy of OpenCode's layout that has to silently agree with the real one forever; this repository has shipped that exact bug twice before. `--pure` stops the install command from triggering plugin boot itself; `--global` writes OpenCode's own config rather than dirtying the checked-out repository.

2. **Bounded at 420 seconds, sized against the failure, not against a healthy install.** The first draft used 120 seconds — below the 181–370 second stall it was fixing. A slow-but-valid install would have timed out, warned, continued, and then let the server perform the same install unbounded: paying the timeout *and* the original stall. A healthy install takes seconds, so the ceiling costs nothing in the common case.

3. **Environment scrubbed with `filterAgentEnv`, never inherited.** The child runs `npm install` against a package fetched off the network, so it gets the same untrusted-child treatment `withScrubbedEnv` gives `createOpencode`. The filter is deny-by-default: a key survives only if it matches an exact allowlist or one of a few operational prefixes, and the deny-set (`GITHUB_TOKEN`, `*_API_KEY`, `*_SECRET`, `AWS_*`, `INPUT_*`) is a backstop on top of that, not the primary guard — a new secret is dropped because it is not allowlisted, not because its name matches a pattern. The first draft inherited `process.env` wholesale.

4. **The tools cache is saved only when the install completed** (`src/services/setup/setup.ts`):

   ```ts
   if (systematicPluginInstall.status === 'installed') {
     await saveToolsCache({ /* ... */ })
   } else {
     logger.warning('Skipping tools cache save because Systematic plugin install did not complete', { status })
     core.warning('Skipping tools cache save because Systematic plugin install did not complete')
   }
   ```

   The first draft saved unconditionally, and a test pinned that as "non-fatal." Under that design a single slow registry blip would have persisted a plugin-less cache under an immutable key, and every later run would hit it, skip the install, and stall at boot — permanently, until a version bump. The install is still non-fatal: setup continues and the server's own install remains the fallback. It just no longer poisons the cache on the way.

5. **`TOOLS_CACHE_PREFIX` bumped to `opencode-tools-v2`.** Without it, every repository with a warm cache would report `hit === true`, skip the install, and see no behavior change at all — the fix would reach nobody currently failing.

## Why This Works

The stall was a network install sitting on the server's request-serving path. Moving it to setup removes the network from that path entirely: the server's `plugin.init()` becomes a local resolution that completes in milliseconds. A slow registry now shows up as a slow, logged, bounded setup step with a real duration attached — instead of a server that reports itself listening and then says nothing.

Two harness defects made the stall invisible. Neither was fixed by this change, and both have since been closed by [#1536](https://github.com/fro-bot/agent/issues/1536):

- **Readiness was a stdout string match.** `@opencode-ai/sdk`'s `createOpencodeServer` resolves when the child prints `opencode server listening` (`dist/server.js:33`). The listener binds before bootstrap runs, so `DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS` bounded only "time until that string appears." A server that binds, prints, and then blocks for five minutes satisfied the budget in two seconds.
- **The first session call had no timeout.** It inherited undici's default `headersTimeout` of 300,000ms (`undici/lib/dispatcher/client.js:316`). That is why the failures landed at 300.77 seconds and surfaced as a bare `fetch failed` rather than a bootstrap error with a name.

`bootstrapOpenCodeServer` now runs an instance-scoped readiness probe after `createOpencode` resolves — a bounded `client.session.list({query: {directory}})` carrying its own `AbortSignal.timeout(readinessTimeoutMs)` (`packages/runtime/src/agent/server.ts`, `attemptReadinessProbe`). It closes both defects at once: the budget now bounds a completed request rather than a printed line, and the first call is explicitly bounded rather than inheriting undici's default. A probe that answers with an error *body* still counts as ready — that is a server answering, which is the thing being measured.

## Prevention

- **Pull the `opencode-logs-*` artifact first** when a server-side stall is suspected. The Action uploads the server's own log on every run. It shows server-side timing that no amount of harness-log analysis can reconstruct, and here it turned three rounds of refuted hypotheses into a one-fetch answer.
- **Listening is not ready.** A bound port, a printed banner, or a resolved SDK promise proves the process reached one line of code. Readiness means a request completes. Any startup budget that resolves on a signal short of that is bounding the wrong interval.
- **Every first request to a freshly spawned server needs an explicit timeout.** Without one it inherits a library default measured in minutes, and the failure arrives late, generic, and unattributed.
- **When a fix runs conditionally on cache state, ask what run N+1 sees.** A fix that persists its own partial result into an immutable key has one chance to be right per key. Gate the persistence on success, and bump the key so warm entries cannot shadow the new behavior.
- **A bound must clear the tail of the thing it bounds.** Check the number against the measurements that motivated it, not against the healthy case.
- **Never derive a dependency's on-disk layout in a second place.** If the dependency exposes an entry point that produces the layout, call that entry point.

## Related Issues

- [Tool Cache Separation](../performance-issues/tool-binary-caching-ephemeral-runners.md) — the tools cache this install now rides on; its "cache only immutable, successfully produced artifacts" rule is what the save gate enforces.
- [Adding a Config-Declared Plugin to the Versioned Tool Pattern](../best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md) — how the plugin was originally wired as config-declared and server-installed; this doc records why that install moved to setup.
- [The OpenCode server bootstraps from the process working directory](./opencode-server-boots-from-cwd-not-session-directory-2026-08-07.md) — a prior case of server startup semantics differing from what the harness assumed.
- [Fail fast on structured provider authentication failures](./provider-auth-failure-hangs-to-timeout-2026-07-25.md) — the same "actionable failure decays into a generic deadline" shape on a different path.
- [A check reports clean for the part of the world it cannot observe](../workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — the readiness string match is a check whose observed population is one stdout line.
- [Oversized session cache traps bootstrap](https://github.com/fro-bot/agent/issues/1407) — the neighboring bootstrap-time failure with the same immutable-cache-key persistence hazard.
- [A tool-cache install directory was spawned where an executable was expected](./tool-cache-directory-spawned-as-executable-2026-09-06.md) — the install call shown above later received the tool-cache directory instead of the binary, failing `EACCES` and skipping the very cache save gated in decision 4. That defect disabled this fix entirely.
