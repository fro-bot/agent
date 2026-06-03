# Harness Package — Agent Notes

`@fro.bot/harness` is the **default OpenCode for Fro Bot**: a published, patched OpenCode binary built via orw's LLM-merge integration method. It replaces the stock OpenCode download in the action setup.

## Purpose

The harness embeds [cortexkit/orw](https://github.com/cortexkit/orw)'s integration method: on each deliberately-pinned upstream OpenCode release, it bases an integration branch on the release tag, fetches a configured set of integration refs (stalled/closed upstream PRs, branch URLs), and runs an LLM merge (`opencode run`) to carry those refs onto the release tag — resolving the base drift that `git am`/cherry-pick cannot handle. The produced per-platform binary is the `harness` binary (the patched OpenCode), shipped in the package dist.

## CLI Contract

```
harness <opencode-args...>   Pass through to the patched OpenCode binary (drop-in)
harness info                 Print provenance (base version, integration refs, build sha)
harness patches              List configured integration refs
harness doctor               Check the resolved binary is present and runnable
harness --version            Print harness provenance version
harness --help               Print usage
```

**Disambiguation rule:** `info`, `patches`, `doctor` are harness-own subcommands. `--version` and `--help` are harness-own. Everything else passes through to the patched binary with inherited stdio, env, and exit code propagation.

## Provenance Model

Provenance = upstream release tag + ordered integration refs (each pinned by upstream commit SHA) + frozen integration commit SHA + build sha. `harness info`/`patches`/`doctor` report this.

The LLM merge runs **once per release bump** in CI, is maintainer-reviewed as the bump PR, and is **frozen** — its SHA is pinned. Per-platform builds pin to the frozen integration commit. The action consumes the published, frozen, pre-built binary; the merge never runs during an action invocation.

## Per-Platform Distribution (Unit 3 target)

The harness ships as a main `@fro.bot/harness` package + per-platform `optionalDependencies`:

- `@fro.bot/harness-linux-x64`
- `@fro.bot/harness-linux-arm64`
- `@fro.bot/harness-darwin-x64`
- `@fro.bot/harness-darwin-arm64`

These packages do not exist yet (Unit 3 builds and publishes them). The `resolve-binary.ts` module will be extended in Unit 3 to select the host-platform binary from the installed optionalDependency package, verify its integrity, and return it. The current scaffold falls back to `opencode` on PATH.

`optionalDependencies` is intentionally **empty** in the scaffold — the per-platform packages don't exist yet and adding them as real deps would break `pnpm install`. Unit 3 adds them once the packages are published.

## Carry Policy

The pipeline is the asset; the patch list stays boring. Target 1–3 carried refs max. Every carried ref records: reason, owner, upstream status, drop condition. Re-gauge every upstream release tag.

A ref qualifies to carry only if it is:
1. Merged-to-dev correctness fix not yet in stable (auto-drops on the next release that includes it).
2. Open/stalled upstream fix for Fro-Bot-critical behavior with a failing fixture or reproducible incident.
3. Perf/DX/agent-quality patch with before/after evidence (numbers required).
4. Stable-lane guardrail — must preserve public behavior unless Fro Bot explicitly owns the divergence.

Drop a carried ref when: upstream stable release includes it; it stops applying cleanly; upstream rejected it and Fro Bot lacks a concrete ongoing need; no recent incident/metric/test justifies the maintenance burden.

## Conventions

- ESM-only, Node 24, `type: "module"`.
- Functions only — no classes.
- Explicit boolean checks — no implicit falsy (`!value`); use `=== null`, `=== undefined`, `.length === 0`.
- `readonly` on all interface properties.
- No `as any`, `@ts-ignore`, `@ts-expect-error`.
- Logger injection where applicable; no `console.log` in library code (CLI entry point is the exception).
- Vitest for tests; BDD comments (`// #given`, `// #when`, `// #then`).

## Build

```bash
pnpm --filter @fro.bot/harness build       # type-check + bundle → dist/cli.mjs
pnpm --filter @fro.bot/harness check-types # tsc --noEmit only
pnpm --filter @fro.bot/harness test        # vitest
pnpm --filter @fro.bot/harness lint        # eslint
```

The build produces `dist/cli.mjs` — the `harness` bin entry point.

## Attribution

This package embeds orw's integration method (MIT, cortexkit/orw) and redistributes a modified OpenCode build (MIT, anomalyco/opencode). See LICENSE for full attribution.
