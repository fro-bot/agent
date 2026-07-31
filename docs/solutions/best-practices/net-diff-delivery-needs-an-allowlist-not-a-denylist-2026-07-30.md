---
title: A mechanism that can deliver any tracked change needs a path allowlist, not a denylist
date: 2026-07-30
category: best-practices
module: delegated
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - A mechanism can deliver arbitrary tracked file changes from a working tree
  - You need to bound which files a trusted run may write on a user's behalf
  - The change source is a net diff rather than a curated, model-chosen set
tags:
  - allowlist
  - denylist
  - delivery-surface
  - execution-surface
  - brokered-push
  - prompt-injection
---

# A mechanism that can deliver any tracked change needs a path allowlist, not a denylist

## Context

Brokered push reconstructs the _net diff_ of the whole working tree against a trusted base and writes it to a branch. That means the delivery surface is "anything tracked in the workspace," and a prompt-injected model could steer a change onto any file. The first instinct was a denylist (`.github/**`, manifests, lockfiles). The problem: when the input is the entire working tree, a denylist has to enumerate _every_ executable or config surface, and it never can.

## Guidance

When a mechanism can carry any file in the tree, constrain it with a small **allowlist** of intended surfaces and deny everything else by default:

```ts
const BROKERED_PUSH_ALLOWED_PATHS = [/^src\//, /^packages\/[^/]+\/src\//, /^docs\//]
const BROKERED_PUSH_ALLOWED_ROOT_FILES = new Set(["README.md", "ARCHITECTURE.md", "STRUCTURE.md"])
// everything else is denied
```

A denylist for the same feature would have to remember all of: `.github/**`, `scripts/**`, `.husky/**`, `deploy/**`, `Dockerfile*`, `Makefile`, `*.sh`, `.npmrc`, `.yarnrc*`, `.bunfig.toml`, `.mise.toml`, `.tool-versions`, `.devcontainer/**`, `lefthook.yml`, `renovate.json`, release configs, `package.json`, every lockfile, every `tsconfig*`… and would still miss the next one added to the repo.

## Why This Matters

An allowlist fails safe: a surface nobody thought about is denied until explicitly added. A denylist fails open: a surface nobody thought about is permitted until someone notices. For a capability that writes to the repo under the bot's identity, driven by input that may be adversarial, fail-open is a persistent-compromise vector (a poisoned `Makefile`/`*.sh`/CI file executes on the next run). The allowlist trades some convenience — the bot can't push a config or script fix in v1 — for closing the entire execution-surface class in one rule.

## When to Apply

- Any delivery/apply path whose input is "everything in the working tree" rather than a curated set.
- Any write capability driven by model- or contributor-influenceable content.
- Whenever you catch yourself extending a denylist to cover "one more" dangerous path — that is the signal the posture is inverted.

## Examples

**Wrong** — denylist over a net-diff surface:

```ts
const FORBIDDEN = [/^\.github\//, /^package\.json$/, /^bun\.lock$/]
// Makefile, Dockerfile, scripts/**, .husky/**, .npmrc, .mise.toml, deploy/** all slip through
```

**Right** — allowlist product/docs/test surfaces, deny the rest, and keep the size/sensitive-path checks on top:

```ts
if (isAllowedBrokeredPushPath(path) === false) return reject(path, "path not in brokered-push allowlist")
// then existing validateFiles: traversal, sensitive files, size cap
```

## Related

- [An injected permission deny blocked the harness's own delivery path](../logic-errors/injected-deny-blocks-own-delivery-path-2026-07-13.md) — a related "security controls compose" lesson; there a deny broke delivery, here the posture choice bounds it.
- [A same-job phase split is not a security boundary](same-job-phase-split-not-a-security-boundary-2026-07-04.md) — where the real trust boundary for model-influenced work lives.
- [Reconstructing from git diff drops untracked files](../logic-errors/untracked-files-dropped-by-git-diff-reconstruction-2026-07-30.md) — the net-diff source this allowlist gates.
- Shipped with brokered push for trusted mention runs (#1297 / PR #1304).
