---
title: A tool-cache install directory was spawned where an executable was expected
date: 2026-09-06
category: integration-issues
module: setup
problem_type: integration_issue
component: tooling
symptoms:
  - "`Systematic plugin install failed` with `error: \"spawn /opt/hostedtoolcache/opencode/1.18.29-harness.88b6b5fb/x64 EACCES\"` and `duration: 4`"
  - "`Skipping tools cache save because Systematic plugin install did not complete` on every run"
  - "Every run logs `Tools cache miss - will install tools` no matter how many times it has run before"
  - "Runs stay green and the agent still works — the plugin install silently falls back to the unbounded server-side path"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - agent-execution
  - dependency-management
tags:
  - opencode
  - tool-cache
  - eacces
  - spawn
  - opencode-path
  - systematic
---

# A tool-cache install directory was spawned where an executable was expected

## Problem

`OpenCodeInstallResult.path` — what `tc.cacheDir` and `tc.find` return — is the tool-cache **directory**, not the binary. Two code paths passed it somewhere it would be spawned. Spawning a directory fails `EACCES`, and because both failures were fail-soft, runs stayed green while the tools cache silently never warmed.

## Symptoms

- `Systematic plugin install failed` with `spawn <install-dir> EACCES`, `duration: 4` — four milliseconds, far too fast to be a registry problem
- `Skipping tools cache save because Systematic plugin install did not complete` immediately after
- `Tools cache miss - will install tools` on every subsequent run, because the save never happened
- No failed step, no red check. The `##[warning]` was the only signal.

The second manifestation had no symptom at all in CI — see *Why This Works*.

## What Didn't Work

**Asserting the path string in a unit test.** The pre-existing test asserted `opencodePath: '/opt/hostedtoolcache/opencode/1.0.300/x64'` and passed, because that *was* the value being passed. Nothing in the assertion encoded that the value was a directory. `execAdapter` is mocked in these suites, so nothing ever spawns — a mocked-exec test can prove a string was threaded through, never that the string is executable. This is why the defect shipped past both the test suite and a code review.

**Reproducing it with `workflow_dispatch`.** The two gate conditions differ only when a tools-cache key misses while the runner's tool cache still holds the binary. On a hosted runner a cache hit restores `/opt/hostedtoolcache/opencode`, so `tc.find` always succeeds and the state is not reachable on demand. The real end-to-end proof came from the fix PR's own CI job: `ci.yaml`'s review job uses `uses: ./`, so it runs the PR's `dist/`, and the tools cache for the new Systematic version was still cold from the failure.

**An `existsSync` guard inside `installSystematicPlugin`.** Attempted, to name the cause rather than the symptom, and reverted. It broke seven existing tests that use synthetic paths, and doing it properly needs a filesystem adapter seam matching the project's `CacheAdapter` / `ExecAdapter` convention. Still worth doing; it is its own change.

## Solution

Derive the binary once, and carry both values to the consumers that actually need them. One resolver owns the on-disk layout, in the file that created it (`src/services/setup/opencode.ts:33`):

```ts
export function opencodeBinaryPath(installDir: string): string {
  const basename = os.platform() === 'win32' ? `${TOOL_NAME}.exe` : TOOL_NAME
  return path.join(installDir, basename)
}
```

Both halves are then carried under names that say which is which, so a caller has to choose:

```ts
// src/services/setup/setup.ts
core.addPath(opencodeResult.path)                              // :286  directory
core.setOutput('opencode-path', opencodeResult.path)           // :335  directory
opencodeBinaryPath: opencodeBinaryPath(opencodeResult.path)    // :297  executable (install call)
opencodeBinaryPath: opencodeBinaryPath(opencodeResult.path)    // :371  executable (SetupResult)
```

```ts
// packages/runtime/src/agent/server.ts
setupAdapter.addToPath(setupResult.opencodePath)               // :435  directory
process.env.OPENCODE_PATH = setupResult.opencodeBinaryPath     // :436  executable
```

The parameter that gets spawned now says so (`src/services/setup/systematic-plugin.ts:17`):

```ts
/** The OpenCode executable, not its install directory — this value is spawned directly. */
readonly opencodeBinaryPath: string
```

## Why This Works

One value was serving two distinct roles under one name. `tc.cacheDir` / `tc.find` produce a directory; `core.addPath()` wants exactly that; `spawn()` wants a file inside it. Nothing in the type system or the tests separated them, so the two roles were one `string` and collapsing them was a one-token mistake.

The second manifestation shows why this class of bug hides. `ensureOpenCodeAvailable` assigned the directory to `process.env.OPENCODE_PATH`, which is read back as an executable in three places:

- its own `verifyOpenCodeAvailable` call eleven lines earlier (`src/services/setup/runtime-setup-adapter.ts:10` spawns it with `--version`)
- `@fro.bot/harness`'s `resolveBinary()` (`packages/harness/src/resolve-binary.ts:118-120`), whose result the wrapper CLI execs — and which the package documents as *"an explicit binary path"*, a published npm contract
- every scrubbed child process, since `filterAgentEnv`'s `ALLOW_PREFIXES` includes `OPENCODE_` (`packages/runtime/src/agent/filter-env.ts:61`)

That produced no CI symptom for one reason: the tool-cache install unpacks the harness release tarball, which carries the binary at archive root, straight onto `PATH`. The real binary never reads `OPENCODE_PATH`. Only the npm wrapper does — so the failure was reserved for mise installs, local runs, and the gateway workspace container.

`EnsureOpenCodeResult.path` was polymorphic for the same reason: an executable on the already-available branch (`existingPath ?? 'opencode'`), the directory on the setup branch. Nothing read it, so nothing broke — it was a trap set for the first caller who needed it.

## Prevention

**Assert that a directory path and an executable path derived from the same install root are never equal.** This is the assertion that bites, because it encodes the distinction rather than the value. It does not prove the executable runs — with a mocked exec adapter nothing can — but it does catch the two collapsing into one:

```ts
// src/services/setup/setup.test.ts:1100
expect(installArgs?.opencodeBinaryPath).not.toBe(addedPath)
expect(installArgs?.opencodeBinaryPath).toBe(join(addedPath ?? '', 'opencode'))
expect(result?.opencodeBinaryPath).not.toBe(result?.opencodePath)
```

```ts
// packages/runtime/src/agent/server.test.ts:720
expect(addToPath).toHaveBeenCalledWith(INSTALL_DIR)
expect(process.env.OPENCODE_PATH).toBe(INSTALL_BINARY)
expect(process.env.OPENCODE_PATH).not.toBe(INSTALL_DIR)
```

Reintroducing either defect fails these; a path-string assertion passes.

**Round-trip a value through its own reader.** `server.test.ts:768` feeds the exported `OPENCODE_PATH` back into `verifyOpenCodeAvailable` and asserts setup is skipped. With the directory, that second call re-ran setup against something that can never report a version.

**Let one function own on-disk layout, including the platform cases.** `opencodeBinaryPath` carries the Windows `.exe` name (`opencode.test.ts:126`) because `getPlatformInfo` still maps `win32`; a helper encoding half the layout invites the next caller to guess the other half.

**Treat a fail-soft warning as a first-class failure signal.** Both defects were designed to degrade rather than fail, which is correct — and which meant the total evidence was one `##[warning]` line in a green run. When a fallback exists, log the value that made the fallback necessary. `server.ts` now logs both `path` and `binaryPath` for exactly this reason.

**Suspect a millisecond-scale failure.** `duration: 4` on an operation that fetches a package from a registry is not a network problem. The number was the diagnosis.

## Related Issues

- [`systematic-plugin-install-stalls-opencode-bootstrap-2026-09-04.md`](systematic-plugin-install-stalls-opencode-bootstrap-2026-09-04.md) — why the setup-time plugin pre-install exists at all (issue #1536). This defect disabled that pre-install, so every run fell back to the 181–370s stall it was built to avoid.
- [`../performance-issues/tool-binary-caching-ephemeral-runners.md`](../performance-issues/tool-binary-caching-ephemeral-runners.md) — the tools-cache design whose save step was being skipped.
- [`../best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md`](../best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md) — the config-declared plugin provisioning pattern this install path implements.
- PRs #1561 (introduced), #1563 (resolver), #1565 (`OPENCODE_PATH` split, naming, tests).
- Released state: broken in `v0.109.1` only (02:40:25 → 03:24:53 UTC), fixed in `v0.109.2`, fully split in `v0.109.3`. Verified from the tagged bundles: `v0.109.0` emitted ``opencodePath:`opencode` ``, `v0.109.1` `opencodePath:b.path`, `v0.109.2` `opencodePath:ao(b.path)`.
