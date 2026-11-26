# Harness Package — Agent Notes

`@fro.bot/harness` is the patched OpenCode V1 binary, built with orw's LLM-merge integration method, that Fro Bot ran before the Action moved to OpenCode V2 only. The Action no longer uses it, and CI no longer builds or publishes its native binaries (the root build still bundles the workspace package); the package stays until a later cleanup.

## Purpose

The harness embeds [cortexkit/orw](https://github.com/cortexkit/orw)'s integration method: on each deliberately-pinned upstream OpenCode release, it bases an integration branch on the release tag, fetches a configured set of integration refs (stalled/closed upstream PRs, branch URLs), and runs an LLM merge (`opencode run`) to carry those refs onto the release tag — resolving the base drift that `git am`/cherry-pick cannot handle. The produced per-platform binary is the `harness` binary (the patched OpenCode), shipped in the package dist.

Why each carried ref exists, which surface it serves, and what would make it safe to drop are recorded in the [carry ledger](../../docs/reference/carry-ledger.md). Read it before proposing a removal during a base bump — an unmerged upstream PR is not grounds for dropping a carry, and at least one entry has been wrongly proposed for removal twice by audits that checked the type and not the write path.

## CLI Contract

```
harness <opencode-args...>   Pass through to the patched OpenCode binary (drop-in)
harness info                 Print provenance (base version, integration refs, build sha)
harness patches              List configured integration refs
harness doctor               Check the resolved binary is present and runnable
harness --version            Print harness provenance version
harness --help               Print usage
```

**Disambiguation rule:** `info`, `patches`, `doctor`, `integrate` are harness-own subcommands. `--version` and `--help` are harness-own. Everything else passes through to the patched binary with inherited stdio, env, signal forwarding, and exit propagation.

The package ships two bins (`bin` in `package.json`; `package-invariants.test.ts` pins exactly these two):

- `harness` → `dist/cli.mjs` — the contract above.
- `opencode` → `dist/opencode.mjs` — a pure passthrough with **no** reserved subcommands (`upgrade` included), so tools that look `opencode` up by name get the patched build. User-facing detail (install caveats, upgrades, signals, exit codes) lives in [README.md](README.md), which ships to npm.

### Entry-point modules

- `opencode.ts` — the `opencode` entry point; calls `runPassthrough({label: 'opencode', ...})`.
- `run-passthrough.ts` — shared by `opencode.ts` and `cli.ts`: resolves without probing, runs `execBinary`, applies the exit status. Owns `harnessEntryPoints` (the self-reference set) and the 126/127 mapping.
- `exec-binary.ts` — non-detached child with inherited stdio; forwards `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT`/`SIGUSR1`/`SIGUSR2`; reports how the child ended and never exits or re-raises itself (`exitStatusFor` maps the outcome: exit code, re-raise for INT/TERM/HUP/QUIT, `128+n` for other signals, 127/126 for ENOENT/EACCES spawns).
- `resolve-binary.ts` — `resolveBinary` (probes with `--version`; used by `harness doctor`) and `resolveBinaryNoProbe` (stat/realpath/4-byte header read only; used by both passthrough entry points). `resolveBinaryNoProbe` order: `OPENCODE_PATH` (must be native), platform package, then a PATH walk only under `HARNESS_ALLOW_PATH_FALLBACK=1`. It rejects self-references (realpath or `dev:ino` match), non-native binaries (anything but ELF/Mach-O), and non-executables, and never returns a bare command name.
- Why no probe: the OpenCode SDK's start deadline makes a per-invocation `--version` spawn too expensive.
- Dev shadowing: the root `node_modules/.bin/opencode` link points at the workspace shim, so a bare `opencode` under `bun run` is the shim. Code that needs the patched binary must go through the resolver, not spawn `opencode` by name.
- `conflict-resolver.ts` — the bare default `opencodeBin` (`opencode`) resolves through `resolveBinaryNoProbe` (`selectOpenCodeExecutable`) rather than being spawned by name; an explicit `opencode_bin` path is used as given. An unresolvable default fails the model turn with the resolver's remediation message.

## Provenance Model

Provenance = upstream release tag + ordered integration refs (each pinned by upstream commit SHA) + frozen integration commit SHA + build sha. `harness info`/`patches`/`doctor` report this.

Each published release froze its LLM merge as one integration commit, and every platform build pinned to that commit.

## Per-Platform Distribution

The harness ships as a main `@fro.bot/harness` package + per-platform packages:

- `@fro.bot/harness-linux-x64`
- `@fro.bot/harness-linux-arm64`
- `@fro.bot/harness-darwin-x64`
- `@fro.bot/harness-darwin-arm64`

Each per-platform package contains only that platform's native binary. The `postinstall` resolver and the bins' resolver (`resolve-binary.ts` → `platform.ts`) select the host's binary by computed package name (`@fro.bot/harness-<os>-<arch>`). `OPENCODE_PATH` (native binary only) overrides it; a PATH search for a native `opencode` is honored only under `HARNESS_ALLOW_PATH_FALLBACK=1` (dev). `postinstall` is advisory (`|| true`) and is skipped by managers that disable lifecycle scripts, so the bins must not depend on it.

The per-platform packages are **not listed in the source `package.json` `optionalDependencies`** — that keeps the workspace `bun.lock` clean (the packages only exist on npm after a release). Releases injected `optionalDependencies` (pinned to the release version) into the published main package's `package.json` at publish time.

Harness builds target **linux and darwin only** (x64 + arm64); Windows is unsupported.

## Distribution Channels and Versioning

Each release was distributed through **two channels**:

- **npm** — for local `bunx @fro.bot/harness` / `mise` use. Published as a SemVer **prerelease**: `<base>-harness.<short8>` (e.g. `1.17.3-harness.ed359558`), with the `latest` dist-tag set explicitly (prereleases are not `latest` by default).
- **GitHub Release** — the tarballs the Action's V1 setup downloaded. The release tag uses the same SemVer **prerelease** string as npm: `<base>-harness.<short8>` (no `v`), carrying OpenCode-shaped assets `opencode-{linux-x64,linux-arm64}.tar.gz` / `opencode-{darwin-x64,darwin-arm64}.zip` (binary at archive root) plus `SHA256SUMS`.

The tag has no `v` so semantic-release's `^v(.+)` scan ignores harness releases. The `-harness.` prerelease identifier keeps them out of Renovate stable candidates. The binary self-reports the `+harness.<sha>` build-metadata form (`harness --version`).

The harness test suite reads repo-root `src/services/setup/opencode.ts` as source text to keep its local predicate mirror honest, so the suite requires the full monorepo checkout.

## Releases

The release workflows (`harness-integrate.yaml`, `harness-release.yaml`) and the model-credential minter went away when the Action moved to OpenCode V2 only, so this repo can no longer build or publish a harness release. Published versions stay on npm and GitHub Releases. `BOOTSTRAP.md` describes the retired first-publish procedure.

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
bun run --filter @fro.bot/harness build       # type-check + bundle → dist/{cli,opencode,postinstall}.mjs
bun run --filter @fro.bot/harness check-types # tsc --noEmit only
bun run --filter @fro.bot/harness test        # vitest
bun run --filter @fro.bot/harness lint        # eslint
```

The build produces `dist/cli.mjs` (the `harness` bin), `dist/opencode.mjs` (the `opencode` bin), and `dist/postinstall.mjs` (the install-time check); the entries are listed in `tsdown.config.ts`.

## Attribution

This package embeds orw's integration method (MIT, cortexkit/orw) and redistributes a modified OpenCode build (MIT, anomalyco/opencode). See LICENSE for full attribution.
