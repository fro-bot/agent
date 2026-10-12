---
title: Workspace bins shadow bare command names under bun run; resolve spawns explicitly
date: 2026-10-12
category: best-practices
module: build-tooling
problem_type: best_practice
component: tooling
severity: low
applies_when:
  - Adding a bin to a workspace package that repo code could also spawn by bare name
  - Repo code spawns a bare command name from a process started by bun run
  - Writing a guard or test that assumes a workspace bin stays off PATH because nothing depends on the package
tags:
  - bun-workspaces
  - bun-run
  - bin-shadowing
  - node-modules-bin
  - path-resolution
  - harness-shim
---

# Workspace bins shadow bare command names under bun run; resolve spawns explicitly

## Context

#1800 added an `opencode` bin to `@fro.bot/harness` (`packages/harness/package.json`). The plan assumed Bun links a workspace package's bins only when another workspace package depends on it. Nothing in this repo depends on `@fro.bot/harness`, so the plan treated the shim as unreachable from a checkout and wrote an invariant test, "no workspace package depends on @fro.bot/harness", as the guard. That premise was false and the test guarded nothing. It was removed.

In this repository, a root `bun install` links every workspace package into the root `node_modules`, and that includes `node_modules/@fro.bot/harness -> ../../packages/harness`. It also links each package's bins whose target files exist at install time. No dependent is needed. `bun run` puts `node_modules/.bin` first on PATH, so a bare `opencode` spawned under `bun run` resolves to the workspace shim, not the binary the caller meant.

## Guidance

- Do not treat "no workspace package depends on this" as keeping a bin off PATH. Check what `bun run` actually resolves.
- Repo code that spawns a command by bare name has to assume a workspace bin with the same name can shadow it. Resolve the binary explicitly and spawn the resolved absolute path.
- A shim that ends up running in a context it wasn't meant for should fail closed with a clear message. It must not fall through to some other binary.

The conflict resolver was the only spawn in the repo that used bare `opencode`; its default `opencode_bin` is the literal `'opencode'` (`packages/harness/src/integrate-command.ts`). It now resolves that default before spawning:

```ts
// packages/harness/src/conflict-resolver.ts
let executable = request.opencodeBin
if (options.runModel === undefined) {
  const selected = selectOpenCodeExecutable(request.opencodeBin, options.resolveDefaultOpenCode)
  if (selected.ok === false) return failure(0, selected.error, [])
  executable = selected.path
}
```

`selectOpenCodeExecutable` sends the literal default through `resolveBinaryNoProbe` (`packages/harness/src/resolve-binary.ts`). That resolver tries `OPENCODE_PATH` first, then the platform package binary. It walks PATH only when `HARNESS_ALLOW_PATH_FALLBACK=1` is set, skips harness entry points, and never returns a bare name. An explicit `opencode_bin` value is used exactly as written. When no platform package exists, the shim itself exits 127 with a remediation message telling the user to set `OPENCODE_PATH`.

## Why This Matters

If a shadowing wrapper runs where the native binary was expected, it is a different program. It may fail, or it may run a different build than the caller intended. In this repo nothing broke, because the exposure was confined:

- CI's `harness-integrate` passes `--candidate`, which bypasses the conflict resolver.
- Evals locate the platform binary explicitly.
- The runtime starts OpenCode through the SDK, and tests mock it.
- The images copy only the harness `package.json` and never build its `dist/`, so no bin link is created in them (`deploy/workspace.Dockerfile`, `deploy/gateway.Dockerfile`).

A guard test built on a wrong assumption is worse than no guard. It passes and tells the reader the risk is handled.

## When to Apply

- You add a `bin` to any workspace package, especially one named like a common tool.
- You write code that spawns a command by a bare name that some workspace bin could also provide.
- You write a test about bin linking. Assert what `bun run` resolves in a fresh install. Do not assert on the dependency graph.

## Examples

Verified in a fresh worktree of this repo (Bun 1.4.3, `bun install --frozen-lockfile`):

| Step                                     | `node_modules/.bin/opencode`               |
| ---------------------------------------- | ------------------------------------------ |
| First install, harness `dist/` not built | absent (target missing, link skipped)      |
| Build `packages/harness`, install again  | `-> ../@fro.bot/harness/dist/opencode.mjs` |

A link whose target is missing at install time is skipped, not left dangling. It appears on the next install once `dist/` exists.

Isolated synthetic workspaces have shown different linking behavior from this one, for example linking only into a directory whose manifest declares the dependency. The linking rules depend on workspace layout and Bun version. That is the reason to resolve explicitly rather than reason about the dependency graph.

## Related

- PR #1800 (squash commit `6c64b44c7`): adds the `opencode` bin and the explicit resolution
- `docs/solutions/integration-issues/signal-forwarding-shim-orphans-native-child-2026-10-12.md`: the shim's process supervision
- `docs/solutions/workflow-issues/rebase-without-bun-install-stale-dist-2026-06-26.md`: another Bun install-state trap
