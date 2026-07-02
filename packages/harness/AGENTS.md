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

## Per-Platform Distribution

The harness ships as a main `@fro.bot/harness` package + per-platform packages:

- `@fro.bot/harness-linux-x64`
- `@fro.bot/harness-linux-arm64`
- `@fro.bot/harness-darwin-x64`
- `@fro.bot/harness-darwin-arm64`

Each per-platform package contains only that platform's native binary. The main package's `bin` shim + `postinstall` resolver (`resolve-binary.ts` → `platform.ts`) select the host's binary by computed package name (`@fro.bot/harness-<os>-<arch>`) and verify it before exec; `OPENCODE_PATH` and a bare `opencode` on PATH are honored as fallbacks for local/unbuilt use.

The per-platform packages are **not listed in the source `package.json` `optionalDependencies`** — that keeps the workspace `bun.lock` clean (the packages only exist on npm after a release). The release workflow **injects** `optionalDependencies` (pinned to the release version) into the published main package's `package.json` at publish time.

Harness builds target **linux and darwin only** (x64 + arm64); Windows is unsupported.

## Distribution Channels and Versioning

The harness is distributed through **two channels** from one release run:

- **npm** — for local `bunx @fro.bot/harness` / `mise` use. Published as a SemVer **prerelease**: `<base>-harness.<short8>` (e.g. `1.17.3-harness.ed359558`), with the `latest` dist-tag set explicitly (prereleases are not `latest` by default).
- **GitHub Release** — for the Fro Bot action to download (the same way it downloads stock OpenCode). The release is tagged with SemVer **build metadata**: `v<base>+harness.<short8>`, carrying OpenCode-shaped assets `opencode-{linux-x64,linux-arm64}.tar.gz` / `opencode-{darwin-x64,darwin-arm64}.zip` (binary at archive root) plus `SHA256SUMS`.

The `-` (npm) vs `+` (GitHub) asymmetry is forced by npm: npm strips SemVer build metadata on publish, so `+harness.<sha>` would collapse to the bare base version. The binary self-reports the `+harness.<short8>` form (`harness --version`).

## Integrate→Build Bridge

The release workflow connects the LLM merge to the per-platform build matrix via a **pushed git ref**. The merge runs through the Fro Bot workflow (which already installs OpenCode and provisions auth); the merged tree is pushed to a throwaway ref the build matrix fetches.

### `prepare-integrate` job

Resolves the base version (dispatch input or tag) and renders the merge prompt from `packages/harness/prompt.txt` using values from `harness.config.json` (base version, release repo, integration refs). Emits `base_version`, `rendered_prompt`, and `has_refs` as job outputs.

`has_refs` is derived from the **parsed merge list** after the ref-parsing loop — not from the raw `integrationRefs` string. Whitespace-only or malformed-only entries that produce no real merge ref correctly yield `has_refs=false`.

### `integrate` job (merge via Fro Bot)

Skipped when `has_refs == 'false'` (empty carry set). When it runs, `uses: ./.github/workflows/fro-bot.yaml` with `secrets: inherit`, passing `model: ${{ vars.HARNESS_MODEL }}` and the rendered prompt. The Fro Bot agent:

1. Clones `anomalyco/opencode` into a disposable work dir, creates the integration branch at the base version tag, and merges the configured refs.
2. Builds and verifies the host CLI as a correctness gate.
3. Pushes the integrated branch to `refs/harness-integrate/<version>` in this repo using the workflow's inherited push credentials (`GH_TOKEN`, never echoed). It posts nothing to GitHub — the summary is plain text in the job log only.

The merge runs with `output-mode: working-dir` so branch/PR delivery semantics do not apply; the prompt itself owns the push to the throwaway ref.

### `build` matrix (consumer)

Each platform job (`needs: [prepare-integrate, integrate]`) runs when `prepare-integrate` succeeded **and** `integrate` did not fail. This means:

- **Empty carry set** (`has_refs=false`): `integrate` is skipped → `integrate.result == 'skipped'` → build runs. The fetch-integrate step clones the stock release tag directly instead of fetching `refs/harness-integrate/<version>`.
- **Non-empty carry set** (`has_refs=true`): `integrate` runs → if it succeeds, build runs; if it fails or is cancelled, build is blocked.

Each platform job:

1. Fetches `refs/harness-integrate/<version>` (non-empty carry) or clones the stock tag (empty carry) and resolves the tip SHA as the integration commit.
2. Checks out the fetched tree and runs `build-platform.ts --source-tree <tree> --integration-commit <sha>`, which builds from the supplied merged source tree. Each platform job runs its own clean install + build.
3. Emits the resolved `integration_commit` as a job output so `publish` consumes the same commit rather than re-resolving the force-pushed ref.

The `--source-tree` flag is explicit and fail-closed: if the directory is missing or empty, the build fails rather than silently falling back to a clone.

### Supply-chain controls

- Merged refs come **only** from the `harness.config.json` carry-policy allowlist — no arbitrary ref can be injected at dispatch time.
- The release is maintainer-gated `workflow_dispatch`.
- `build` and `publish` are commit-pinned to a single resolved `integration_commit` (resolved once in `build`, consumed by `publish`).

### `AUTH_JSON` secret

Required for any release that runs an LLM merge (i.e. any release with integration refs configured). The integrate job reuses the repository's existing `AUTH_JSON` secret (the same model credential the action uses), so no separate secret is needed:

- **Name:** `AUTH_JSON`
- **Value:** JSON mapping provider to auth config:
  ```json
  {"anthropic":{"type":"api","key":"sk-ant-..."}}
  ```

The integrate job maps it to an internal env var, writes it to a 0600 temp file, and passes it to OpenCode as a file-based credential. The value is never echoed to logs or included in any artifact.

### Dispatching a release

**Dry run** (validate build infrastructure, skip publish):
```bash
gh workflow run harness-release.yaml \
  --repo fro-bot/agent \
  --field base_version=<configured-base-release> \
  --field dry_run=true
```

**Real patched release** (the merge runs through Fro Bot, which uses the inherited `AUTH_JSON` model credential):
```bash
gh workflow run harness-release.yaml \
  --repo fro-bot/agent \
  --field base_version=<configured-base-release>
```

The publish job has no environment/reviewer gate — a non-dry-run dispatch publishes on green builds. Use `--field dry_run=true` to exercise the pipeline without publishing.

## Publishing

The packages are published to npm via **trusted publishing (OIDC)** from the release workflow (`.github/workflows/harness-release.yaml`) — no long-lived npm token. The workflow has `id-token: write` scoped to the `publish` job only; the `integrate` and `build` jobs run with `contents: read` and no `id-token`. The workflow upgrades npm to a trusted-publishing-capable version (npm ≥ 11.5.0; Node 24 ships an older npm), and runs a bare `npm publish` (provenance is automatic under OIDC; `--provenance`/`--access` flags are not needed — access is set via each package's `publishConfig`).

### One-time npmjs.com setup (per package)

Trusted publishing trusts at the **package level**, so each of the five packages (`@fro.bot/harness` + the four `@fro.bot/harness-<os>-<arch>` packages) needs its own trusted-publisher configured once on npmjs.com → the package's Settings → Trusted publishing → GitHub Actions:

- **Organization or user:** `fro-bot`
- **Repository:** `agent`
- **Workflow filename:** `harness-release.yaml`
- **Environment:** (leave blank)

### First-publish bootstrap

npm trusted publishing requires a package to **already exist** before it will accept OIDC publishes — a brand-new, never-published package cannot be trust-published from scratch, and npm has no pending-publisher or pre-registration flow for packages that don't yet exist. So the very first release of these five packages requires a one-time token-authenticated `npm publish` to claim the names; after that, the trusted-publisher config above governs all subsequent releases with no token. See `BOOTSTRAP.md` for the full procedure.

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
bun run --filter @fro.bot/harness build       # type-check + bundle → dist/cli.mjs
bun run --filter @fro.bot/harness check-types # tsc --noEmit only
bun run --filter @fro.bot/harness test        # vitest
bun run --filter @fro.bot/harness lint        # eslint
```

The build produces `dist/cli.mjs` — the `harness` bin entry point.

## Attribution

This package embeds orw's integration method (MIT, cortexkit/orw) and redistributes a modified OpenCode build (MIT, anomalyco/opencode). See LICENSE for full attribution.
