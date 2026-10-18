---
type: subsystem
last-updated: "2026-10-18"
updated-by: "1dcd6a296d36057a6680ca347bf01a6987d78ec9"
sources:
  - src/harness/config/outputs.ts
  - packages/runtime/src/agent/attachment-dir.ts
  - deploy/scripts/merge-config.mjs
  - deploy/workspace.Dockerfile
  - deploy/workspace-entrypoint.sh
  - deploy/compose.yaml
  - src/services/setup/setup.ts
  - src/services/setup/ci-config.ts
  - src/services/setup/systematic-config.ts
  - src/services/setup/systematic-plugin.ts
  - src/services/setup/adapters.ts
  - src/services/setup/opencode.ts
  - src/services/setup/types.ts
  - packages/runtime/src/agent/server.ts
  - src/features/agent/server-adapter.ts
  - src/services/setup/no-task-reuse-config.ts
  - deploy/plugins/no-task-reuse.mjs
  - packages/harness/src/platform.ts
  - src/services/setup/bun.ts
  - src/services/setup/omo.ts
  - src/services/setup/gh-auth.ts
  - src/services/setup/git-credential-check.ts
  - src/services/setup/auth-json.ts
  - src/services/setup/tools-cache.ts
  - packages/runtime/src/agent/filter-env.ts
  - packages/runtime/src/agent/with-scrubbed-env.ts
  - packages/runtime/src/agent/response-delivery.ts
  - packages/harness/harness.config.json
  - packages/harness/src/version.ts
  - scripts/harness/duplicate-harness-release-tags.ts
  - .github/workflows/harness-release.yaml
  - packages/runtime/src/shared/constants.ts
  - src/shared/constants.ts
  - src/harness/config/inputs.ts
  - src/features/delegated/brokered-push-validation.ts
  - action.yaml
  - RFCs/RFC-011-Setup-Action-Environment-Bootstrap.md
  - RFCs/RFC-019-S3-Storage-Backend.md
  - ARCHITECTURE.md
summary: "Tool installation, configuration assembly, credentials, caching, and oMo/OMO Slim version gating"
---

# Setup and Configuration

The setup module (`src/services/setup/`) bootstraps the CI environment before agent execution can begin. It installs runtime dependencies, configures authentication, assembles the OpenCode configuration, and manages a tools cache to speed up subsequent runs.

Before setup is skipped, `ensureOpenCodeAvailable()` in `packages/runtime/src/agent/server.ts` compares the available executable's reported version with the requested pin, including the harness suffix. A single leading `v` and the equivalent `-harness.`/`+harness.` spellings are normalized; a different stock release, harness build, or provenance-reporting shim triggers auto-setup instead of displacing the pinned download. An explicit `OPENCODE_PATH` mismatch emits a warning because setup is replacing an operator-selected executable.

## Installation Sequence

The `runSetup()` orchestrator follows a **mode-gated** sequence. When no orchestration plugin is requested (the default), the setup path is minimal — OpenCode only. When `enable-omo: true`, Bun and oMo are installed alongside OpenCode. A third mutually-exclusive mode, `enable-omo-slim: true`, installs Bun and [OMO Slim](https://github.com/alvinunreal/oh-my-opencode-slim) instead and pins `orchestrator` as the default agent; requesting both oMo and OMO Slim fails fast. The two plugin-enabled modes share the same "enabled" cache partition and bootstrap shape, so the description below contrasts the default OpenCode-only path against the plugin-enabled path.

### Default Mode (no orchestration plugin)

1. **Parse credentials** — Validates `auth-json` input early to fail fast on bad credentials. The input is a JSON object mapping LLM provider names to their auth configs (e.g., `{"anthropic": {"apiKey": "..."}}`).

2. **Resolve versions** — Determines target versions for OpenCode and Systematic. The `latest` keyword for OpenCode triggers a GitHub Releases API lookup. oMo and Bun version resolution is skipped.

3. **Restore tools cache** — Checks for a cached bundle of previously installed tools, keyed by version, OS, and mode. A cache hit skips download steps entirely. The disabled-mode cache excludes Bun and `~/.config/opencode` paths to prevent stale oMo config from being restored.

4. **Install OpenCode CLI** — Downloads the platform-appropriate release binary, extracts it, verifies it (`--version`), and registers it in the GitHub Actions tool cache. The supported matrix is Linux and macOS on x64 or arm64; anything else is rejected by name before a URL is built (see [Platform Support](#platform-support)). The download source depends on whether the target is a stock OpenCode release or a [harness build](#harness-builds) — harness builds are fetched from `fro-bot/agent` releases and verified against a published `SHA256SUMS` manifest.

5. **Build CI config** — Assembles the `OPENCODE_CONFIG_CONTENT` environment variable, which configures OpenCode for CI operation. This includes disabling auto-updates, injecting the Systematic plugin, and pinning `default_agent` to `"build"`.

6. **Merge user config** — Merges the CI config on top of any user-provided `opencode-config` input. Plugin arrays are deduplicated by package name prefix. In disabled mode, `oh-my-openagent` entries are stripped from both `plugin` and legacy `plugins` keys, and a warning names any rewritten fields. Legacy `plugins` (plural) keys are also stripped — OpenCode only accepts `plugin` (singular).

7. **Install Systematic plugin** — Runs the OpenCode CLI's plugin install before caching, gated on either a fresh OpenCode install _or_ a tools-cache miss (see [When the Plugin Install Runs](#when-the-plugin-install-runs)). If the install times out or fails, setup continues but skips saving the tools cache so an incomplete install is not persisted.

8. **Save tools cache** — If the plugin install ran and succeeded, saves the installed binaries for future runs.

9. **Configure authentication** — Sets up `gh` CLI auth, configures Git identity as `{bot}[bot]` for audit trails, and writes the ephemeral `auth.json` with `0o600` permissions.

### Plugin-Enabled Mode (`enable-omo` or `enable-omo-slim`)

When a plugin orchestrator is enabled, the setup path adds Bun installation and plugin setup after the OpenCode CLI install:

1. Steps 1–4 match the default mode (credentials, versions, cache restore, OpenCode install).

2. **Install Bun runtime** — Required for running the oMo / OMO Slim installer via `bunx`. If Bun installation fails, the plugin is skipped but execution continues.

3. **Disable oMo telemetry** — Sets `OMO_SEND_ANONYMOUS_TELEMETRY=0` and `OMO_DISABLE_POSTHOG=1` before any oMo code runs, including the installer itself.

4. **Write optional configs** — If `systematic-config` is provided, writes it before the installer runs.

5. **Install the plugin** — Runs the oMo or OMO Slim installer via Bun. This is treated as a graceful-fail operation: if it fails, the agent runs without the plugin's agent workflows. The installer error is captured but doesn't abort the run. OMO Slim additionally validates its preset (`openai` or `opencode-go`) against an allowlist before installing.

6. **Build CI config** — Assembles `OPENCODE_CONFIG_CONTENT`. For oMo it does not pin `default_agent` — oMo-managed config selects Sisyphus as the default when `agent` is unset; for OMO Slim it pins `default_agent` to `"orchestrator"`.

7. **Merge configs** — Merges CI config on top of any existing `opencode.json` (which the installer may have created). Plugin arrays are deduplicated. The active plugin's entries (`oh-my-openagent` or `oh-my-opencode-slim`) are preserved.

8. **Save tools cache** — The enabled-mode cache includes Bun, the Bun package cache, and `~/.config/opencode` paths.

9. **Configure authentication** — Same as the default mode.

## Pinned Versions

Default versions are defined in `packages/runtime/src/shared/constants.ts` (shared across surfaces) and `src/shared/constants.ts` (action-specific overrides):

| Tool         | Constant                     | Purpose                                          |
| ------------ | ---------------------------- | ------------------------------------------------ |
| OpenCode CLI | `DEFAULT_OPENCODE_VERSION`   | The AI coding agent platform                     |
| Bun          | `DEFAULT_BUN_VERSION`        | JavaScript runtime and workspace package manager |
| oMo          | `DEFAULT_OMO_VERSION`        | Oh My OpenAgent workflow framework               |
| OMO Slim     | `DEFAULT_OMO_SLIM_VERSION`   | Lightweight alternative orchestration plugin     |
| Systematic   | `DEFAULT_SYSTEMATIC_VERSION` | OpenCode plugin for structured workflows         |

These can be overridden per-run via action inputs (`opencode-version`, `omo-version`, `omo-slim-version`, `systematic-version`). Stock tool pins are updated via Renovate-managed PRs; the OpenCode harness default is advanced by the harness release sync PR after a harness build exists.

The OMO Slim default is currently `2.2.25`, on the stable release line tracked in `packages/runtime/src/shared/constants.ts`. That pin is separate from the compatibility gate in `src/services/setup/ci-config.ts`: its verified-version list currently contains only `1.1.1`. When Slim mode is enabled, `src/services/setup/setup.ts` rejects an unverified version before installing Bun or the plugin, and configuration assembly independently checks the same list before selecting `orchestrator`. Thus enabling Slim with the current default fails setup; the version bump alone does not certify orchestrator registration. The default OpenCode-only mode does not enter this gate. This distinction helps explain setup failures discussed in [[Troubleshooting]].

Bun plays a dual role: it is both the runtime that runs the oMo / OMO Slim installer in CI _and_ the package manager for this project's own workspace. The repository migrated from pnpm to Bun, which moved workspace configuration into `bunfig.toml`, replaced `pnpm install` with `bun install`, and changed how cache keys and license attribution are derived. Because the project's tooling itself depends on Bun, the Bun version is pinned and is baked into the tools-cache key (see [Tools Cache](#tools-cache)) so a Bun bump cleanly invalidates stale tooling.

The default `DEFAULT_OPENCODE_VERSION` is a **harness build** (currently `1.19.0+harness.caa47272`) rather than a plain upstream OpenCode release. See [Harness Builds](#harness-builds) for what that means and how it changes the install path.

## Harness Builds

OpenCode is consumed in two forms. A _stock_ version is a plain upstream release (for example `1.19.0`) published by the `anomalyco/opencode` project. A _harness_ version carries a `harness.<sha>` suffix (for example `1.19.0+harness.caa47272`) and is a `fro-bot/agent` release that bundles the upstream binary together with a curated set of upstream integration refs — stalled or closed OpenCode PRs — merged onto the base release. The carry set spans provider/model routing fixes, SQLite lock-timeout retries, SSE backlog bounding, several memory-leak and stability patches, a bound on the plugin npm install, and OpenAI-family prompt-cache and version-gate corrections. The current base is `1.19.0`; each rebase re-evaluates which carries remain necessary. The exact carry set is defined in the `integrationRefs` list of `packages/harness/harness.config.json`; the action defaults to a harness build so that the carried patches are always present, while still allowing a stock version to be requested explicitly via the `opencode-version` input.

### Two Spellings of the Same Build

A harness build has one identity but two written forms, and understanding why they differ explains most of the surrounding machinery.

The **build-metadata form** — `1.19.0+harness.caa47272` — is what the binary self-reports and what the version pin in `packages/runtime/src/shared/constants.ts` records. The `+` segment is SemVer build metadata (§10), which is deliberately excluded from version precedence.

The **prerelease form** — `1.19.0-harness.caa47272` — is the published GitHub release tag, the npm package version, and the tool-cache key.

The prerelease form is not cosmetic. Harness releases live in the same tag namespace as the action's own `v0.x` product releases, and that namespace has two adversarial readers. Semantic-release scans tags matching `^v(.+)` to compute the next product version, so harness tags dropped the `v` prefix in mid-2026 to stay invisible to it. But bare-semver tags with build metadata created a second problem: because SemVer strips build metadata for precedence, Renovate's `github-tags` datasource — which discovers candidates from git tags, not release objects — read `1.18.21+harness.22dee0ee` as a _stable_ `1.18.21` that outranked the real `v0.x` action line, quietly breaking grouped update branches in consuming repositories. Marking the GitHub release object as a prerelease does not help, because candidate discovery never looks at release objects.

Moving the tag to a genuine SemVer prerelease identifier fixes it at the level of the spec rather than at the level of a tool's enrichment behavior: prereleases are excluded by Renovate's default `ignoreUnstable` setting. The two constraints are therefore satisfied by different properties of the same tag — the missing `v` hides it from semantic-release, and the prerelease identifier hides it from Renovate. The eighteen legacy `+harness.` releases were migrated by duplication rather than rename (`scripts/harness/duplicate-harness-release-tags.ts`, a completed one-off), because their asset URLs are load-bearing for any pinned run still referencing them.

### How the Marker Changes the Install Path

`src/services/setup/opencode.ts` recognizes either spelling as a harness build, and converts to the release-tag form at the boundaries that need it (`toHarnessReleaseTag()`; `toolCacheVersion()` is a named alias for the same conversion). Three behaviors follow:

- **Download source** — Harness versions are routed to the `fro-bot/agent` releases URL instead of the upstream `anomalyco/opencode` releases, with the tag derived through the prerelease conversion. Percent-encoding of `+` as `%2B` is retained for the migrated legacy tags, since GitHub stores tags URL-encoded and a raw `+` is misread as a space. Stock versions keep their conventional `v`-prefixed upstream URL.

- **Checksum verification** — Every harness archive is verified against a `SHA256SUMS` manifest published alongside the binary in the same release. Stock downloads have no such manifest and are not checksum-verified by the action. Before any URL is constructed, the version string is validated against a strict semver-ish pattern as a defense-in-depth guard against path traversal or shell metacharacters. A harness pin that fails to download or verify is **fail-closed** — the run aborts rather than silently substituting a stock binary. Stock-version installation failures can retry the stock fallback (`FALLBACK_VERSION`, currently `1.19.0`); that version is also used when `latest` resolution fails.

- **Tool-cache identity** — `@actions/tool-cache` runs versions through `semver.clean()` internally, which strips `+harness.<sha>` build metadata and would collapse a harness build onto a stock cache entry of the same base version. The prerelease form survives `semver.clean()` intact, so using it as the cache key guarantees a harness build and a stock build of the same base version never share a cache slot. Logs and the binary's own `--version` output keep the build-metadata form.

If the `latest` resolution path needs a fallback, the setup module falls back to a known-good stock version (`FALLBACK_VERSION`, currently `1.19.0`) rather than a harness build. An explicitly-pinned harness build does not fall back — a failed download or checksum mismatch fails the run.

Because the tag shape is now load-bearing for two external tools and is derived in more than one place — the release workflow, the npm version builder, and the setup module — the test suite carries drift guards that read the repository's source text and fail if one producer is changed without the others. These guards exist because an earlier mirrored copy of the harness-version predicate asserted the opposite of production behavior and still passed, testing its own copy rather than the module.

## Platform Support

The action runs on Linux and macOS, on x64 or arm64 — four combinations, and no others. `getPlatformInfo()` in `src/services/setup/opencode.ts` now asserts that matrix up front and throws a message naming the offending `platform/arch` pair, rather than mapping unknown values onto plausible-looking defaults.

The earlier shape used lookup tables with fallbacks: an unrecognized platform silently became `linux`, an unrecognized architecture silently became `x64`. That was survivable while the default OpenCode version was a stock upstream release, because upstream publishes a broader asset matrix. It stopped being survivable once the default became a [harness build](#harness-builds), which publishes only `linux`/`darwin` × `x64`/`arm64` (`packages/harness/src/platform.ts`). On Windows the fallback produced a request for an asset that is never published, and the run failed several layers down with a 404 that said nothing about the platform. On an unsupported architecture the failure was worse than opaque — the arch fallback resolved to the x64 asset, so the download _succeeded_ and the binary failed to execute later, at a point far removed from the cause.

Gating both halves in one place means the error names the real problem at the moment it is knowable. It also removed the Windows-shaped branches that existed downstream: archive-extension selection no longer special-cases `.zip` for Windows, and download validation no longer skips the `file(1)` check on a platform that can no longer be reached.

## The Install Directory and the Executable

Two different strings describe an OpenCode install, and conflating them caused a cluster of `EACCES` failures worth understanding as one story.

`installOpenCode()` returns a **directory** — that is what `@actions/tool-cache`'s `cacheDir`/`find` return, and it is what `core.addPath()` expects to receive. But several consumers need an **executable path** to hand to a child process: the Systematic plugin install spawns OpenCode directly, `@fro.bot/harness`'s `resolveBinary()` reads `OPENCODE_PATH` as a binary, and every child that inherits the environment sees `OPENCODE_PATH` too (the deny-by-default env filter lets the `OPENCODE_` prefix through). Passing the directory to any of those spawns it, which fails with `EACCES` because a directory is not executable.

The fix is a single helper, `opencodeBinaryPath()`, that owns the on-disk layout and is the only place allowed to turn an install directory into an executable path. `SetupResult` now carries both values as separately documented fields — `opencodePath` (the directory, consumed by `addPath` and reported as the `opencode-path` output) and `opencodeBinaryPath` (the executable, used by anything that spawns). `ensureOpenCodeAvailable()` in `packages/runtime/src/agent/server.ts` deliberately takes different halves for different purposes and logs both, on the reasoning that the entire failure mode was "which of these two strings got exported", so a recurrence should be diagnosable from the run log alone.

## When the Plugin Install Runs

The Systematic plugin install is gated on **either** a fresh OpenCode install **or** a tools-cache miss. The two conditions are independent, not nested, and the earlier code that checked only the tools-cache flag left two real gaps: a tools-cache hit whose binary had gone missing falls through to a fresh OpenCode install that still needs its plugin installed and its cache re-saved; and `installOpenCode()` reports a cache hit from the runner's own tool cache alone, so a tools-cache key miss — from a bumped Systematic version, or an earlier invocation that skipped its save — must still install and save even on a warm tool cache.

When the install fails, two diagnostics now accompany the warning. If the parent environment carries `NPM_CONFIG_*` variables, the warning names those keys (names only, never values) and notes that the install child deliberately does not inherit them — the scrub exists so a network-fetched package's lifecycle scripts cannot see registry or proxy overrides, and naming the likely cause is preferable to either silently failing or proposing an allowlist that would defeat the scrub. Separately, when the failure is a spawn error (`ENOENT` or `EACCES`), `diagnoseBinaryPath()` inspects the path and reports what it actually found: absent, a dangling symlink, a directory rather than an executable, present but not executable by the current user, or a parent directory listing when the path itself is gone. That routine runs inside a catch block, so every filesystem call it makes is individually guarded — a failed diagnosis degrades to a short fallback string rather than masking the original error.

## Configuration Assembly

The CI config built by `buildCIConfig()` ensures OpenCode operates correctly in a headless CI environment:

- **Auto-update disabled** — Prevents OpenCode from trying to update itself mid-run.
- **Systematic plugin injected** — Ensures `@fro.bot/systematic@{version}` is registered as an OpenCode plugin. The version is pinned to prevent drift.
- **Permission defaults hardened** — The config bakes in deny rules so the run never stalls on an interactive permission prompt it cannot answer. The `doom_loop` native ask defaults to `deny`, secret-shaped file reads (`*.env`, `*.env.*`) are denied while `*.env.example` stays readable, and edits are scoped to the workspace and any designated external directory. These defaults pair with the runtime's ask-answering behavior described in [[Execution Lifecycle]]: an ask that still reaches the agent is denied and logged rather than left to block until the execution deadline.
- **Subagent depth pinned to one** — Set unconditionally in every mode, overriding any operator value with a logged warning. This is the project's one deliberate exception to "an explicit operator value wins," and the reason is structural rather than stylistic: upstream cancellation walks only _running_ jobs, so at depth greater than one a completed child linking the root to a still-running grandchild is never walked, and the grandchild can outlive a cancellation meant to stop it. Depth one makes that path unreachable instead of requiring the harness to build a session-tree traversal of its own. The workspace container applies the same pin through its own config merge (`deploy/scripts/merge-config.mjs`), so both surfaces agree.
- **Attachment directory granted** — A permission entry admits reads and writes under this run attempt's attachment directory. It is applied at the _top-level global_ permission key, not only on the `build` agent, because a dispatched subagent inherits its parent session's resolved rules and would otherwise be unable to reach materialized files; the `build` agent's own block re-asserts the same pattern, since its catch-all deny would shadow the global grant under upstream's flattened evaluation. The grant names the specific run-attempt directory rather than the shared parent segment — a wildcard compiles to a pattern that matches path separators, so a segment-wide grant would let a sibling run on a persistent or self-hosted runner read this run's attachments and plant symlinks there.

Two experimental OpenCode behaviors are set through the environment at server spawn (`packages/runtime/src/agent/server.ts`) rather than through config, because there is no config-file equivalent for either. Background subagent dispatch is enabled — the single switch that makes detached `task` dispatch reachable at all, and the reason the drain phase exists (see [[Background Subagents and Ownership]]). The file watcher is disabled, because nothing in this project consumes file-change events; both surfaces read only message and tool lifecycle events, so the watcher is pure overhead. The accepted tradeoff is that OpenCode caches the VCS branch and refreshes that cache from watcher events, so the cached branch can go stale after a checkout — more visible on the long-lived workspace container than in short-lived CI.

Both flags follow the same defaulting convention: set the default only when the variable is **unset or empty**, so an operator who set it explicitly — including to `false` — always wins. Treating empty as unset is not pedantry here. GitHub Actions materializes an unset `env:` input as an empty string rather than an absent key, and OpenCode's boolean parsing does not read an empty string as true, so a presence-only check would silently leave the old behavior in place. The workspace image bakes the same two flags as container `ENV` values, overridable per deployment, and a CI smoke test asserts they survive in the built image — nothing else would catch their removal.

The final config is the result of merging:

- In default mode: CI config (with `default_agent: "build"`) + user-provided `opencode-config` input. Existing local `opencode.json` files are ignored to prevent a stale orchestration config from leaking in.
- In plugin-enabled mode: CI config (with `default_agent` pinned to `"orchestrator"` for OMO Slim, or left unpinned so oMo selects Sisyphus) + existing `opencode.json` (from the installer) + user-provided `opencode-config` input.

User values win on conflicts. In default mode, `oh-my-openagent` and `oh-my-opencode-slim` plugin entries in user config are stripped with a warning.

### Workspace identity and control API

The deployed workspace splits authority between the service and the model-driven process. The workspace-agent retains the privileges needed for protected clone staging, journals, and network fetches; the OpenCode process and its tools run as an unprivileged account. On startup the entrypoint migrates existing root-owned checkouts through a symlink-aware filesystem handoff, while protected secrets and state remain under root-owned paths (`deploy/workspace-entrypoint.sh`, `deploy/compose.yaml`). Fresh clones are handed off before agent execution. This keeps the checkout writable by the agent without giving it ownership of the credential and maintenance directories.

The same bearer used by the gateway to attach to the OpenCode proxy on port 9200 also protects the workspace control API on port 9100. Clone, inspect, update, recovery, and backup routes check it before parsing request bodies; only health and readiness are unauthenticated (`apps/workspace-agent/src/server.ts`). Without that boundary, an agent tool running inside the container could call the loopback control API to mutate its own checkout outside the gateway's admission path. [[Architecture Overview]] describes how the gateway and workspace divide checkout preparation.

### Server-start task-reuse guard

The Action's server adapter (`src/features/agent/server-adapter.ts`) installs a separate local plugin before every server start, including runs that skipped tool installation because OpenCode was already present. `src/services/setup/no-task-reuse-config.ts` copies the bundled guard derived from `deploy/plugins/no-task-reuse.mjs` and supplies its absolute `file://` URL through the SDK's server config layer. A write failure prevents the server from starting. The guard rejects subagent session reuse before execution, preserving the one-child-session-per-background-job assumption described in [[Background Subagents and Ownership]]. It does not depend on the Systematic plugin or on the tools-cache install path.

## Tools Cache

The setup module maintains its own cache (separate from the session cache) for installed binaries. The key is **mode-partitioned**: disabled mode omits the oMo version and restricts cached paths to OpenCode tooling only, preventing stale oMo config from being restored, while enabled mode additionally caches the Bun binary, the Bun package cache, and the oMo config directory.

Disabled-mode key:

```text
opencode-tools-v2-{os}-disabled-oc-{opencodeVersion}-sys-{systematicVersion}-bun-{bunVersion}
```

Enabled-mode key:

```text
opencode-tools-v2-{os}-enabled-oc-{opencodeVersion}-omo-{omoVersion}-sys-{systematicVersion}-bun-{bunVersion}
```

The Bun version is part of both keys even in disabled mode. The project's own tooling runs on Bun, so a Bun bump must invalidate the aggregate tools cache to avoid restoring a stale runtime; baking the Bun version into the key makes that automatic.

On a cache hit, the module verifies the binary is actually present in the tool cache before trusting it — cache hits where the binary is missing fall through to a fresh install. The lookup uses the tool-cache-safe form of the version (see [Harness Builds](#harness-builds)), so a harness build never reuses a stock binary's cache entry. This cache typically saves 10-20 seconds per run.

A denied tools-cache write is now surfaced as a failure rather than swallowed. When the cache backend rejects a save — for example because the run holds a read-only cache token — the module reports it instead of pretending the save succeeded, so a silently non-persisting tools cache cannot masquerade as a healthy one. The same read-only-token discipline applies to the session cache; see [[Session Persistence]].

## Security

Credentials are handled with care:

- **`auth.json`** is written with `0o600` permissions (owner-only read/write) and is never cached. It's regenerated fresh from secrets on every run.
- **Git identity** is forced to `{bot}[bot]` so commits made by the agent have a clear audit trail.
- **Telemetry** is disabled for oMo before any oMo code executes.

### GitHub credential disposition

The GitHub token the agent might use to post is provisioned **conditionally**, driven by the response-delivery decision computed in [[Execution Lifecycle|bootstrap]]. On comment and review flows (`issue_comment`, `pull_request`, `issues`) the credential is **withheld** — `configureGhAuth()` skips setting `GH_TOKEN`, skips writing the `gh` `hosts.yml`, and clears any ambient `GH_CONFIG_DIR` from earlier workflow steps. The rationale is that on those flows the action posts the agent's answer itself (the file-convention delivery path), so the model has no legitimate need to call `gh` — and a credential the model never receives is a credential a prompt-injected model cannot exfiltrate from disk or environment. A preflight check (`git-credential-check.ts`) additionally asserts that no persisted git credential is present in the _effective_ git config for the workspace — local, global, system, worktree-scoped, or anything pulled in via `include`/`includeIf` — plus the `origin` remote URL, on these flows, which is why consumers are asked to check out with `persist-credentials: false`. Because the check reads global and system scope too, a credential planted anywhere on the runner (not just this checkout) is caught — but on a reused, non-ephemeral runner that also means a global/system config planted by an earlier job stays visible to every later job until the runner is recycled. The check has two narrow fail-open exceptions — no git binary, and a workspace that is not a git repository at all — and both are compatibility exemptions, not proof a credential is absent: they mean part of the check could not run, not that it ran and found nothing. Autonomous flows (`schedule`, `workflow_dispatch`) keep the credential provisioned, because they legitimately create branches, commits, and PRs on their own.

When a same-repo PR comment produces workspace edits, the action still needs a way to land them despite withholding the token — this is what the [[Execution Lifecycle|brokered push]] step provides. It commits on the model's behalf through the action's own Octokit client, so the write is gated by trusted event facts and a path allowlist (`brokered-push-validation.ts`) rather than by handing the agent a credential. Keeping `persist-credentials: false` remains essential: it ensures the withheld token has no residual copy in `.git/config` that a same-user shell inside the agent could read.

### Environment scrubbing at agent spawn

Independently of whether a credential is provisioned, the OpenCode child process is spawned under a **deny-by-default environment filter** (`packages/runtime/src/agent/filter-env.ts`, applied via `with-scrubbed-env.ts`). Only an enumerated allowlist of keys survives — GitHub Actions context, a handful of standard shell and locale variables, proxy/CA-bundle settings (including `NODE_EXTRA_CA_CERTS`, admitted by exact name), and the `OPENCODE_*`, `RUNNER_*`, `XDG_*`, and `LC_*` prefixes. No other `NODE_*` key is admitted. Anything ending in a credential-shaped suffix (`_TOKEN`, `_API_KEY`, `_SECRET`, `_KEY`, and similar), the `AWS_*` and `INPUT_*` prefixes, and `GITHUB_TOKEN`, `GH_TOKEN`, `OPENCODE_PURE`, and `NODE_OPTIONS` by exact name are stripped even if they would otherwise match. The reduction is scoped: the harness restores its own environment immediately after the spawn so it can still reach the S3 backend, and it fails closed — if the scrub cannot complete, the child is never spawned.

## Action Inputs

The action accepts over 20 inputs defined in `action.yaml`, grouped into core, agent, S3, and configuration categories. The most important ones:

- `github-token` and `auth-json` are required — they provide GitHub API access and LLM provider credentials respectively.
- `trusted-head-sha` carries a same-repository pull-request head SHA captured before agent execution (empty when unavailable). It is the trust anchor for the [[Execution Lifecycle|brokered push]] step: the harness diffs the workspace against this SHA and re-checks the live PR head against it immediately before committing, so a moved head aborts the push. Consumers wire it from `github.event.pull_request.head.sha` (or the equivalent event field) in the workflow; it has no effect on flows that are not same-repo PR comments.
- `prompt` provides a custom instruction for the agent. Required for `schedule` and `workflow_dispatch` events.
- `output-mode` controls the delivery contract for `schedule` and `workflow_dispatch` runs (`auto`, `working-dir`, `branch-pr`; default `auto`). The compatibility value `auto` deterministically resolves to `working-dir`; use `branch-pr` explicitly when branch/PR delivery is required. The `output-mode` input has no effect on non-manual event types (issue comments, PRs, etc.), which always return `null`. See [Delivery-mode contract for manual workflow triggers](../solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md) for the historical design rationale.
- `agent` selects the OpenCode agent. When unset, uses OpenCode's built-in `build` agent. Must be a primary agent, not a subagent.
- `review-skip-label` (default `skip-agent-review`) names a PR label that suppresses the automatic review on `pull_request` events when present (case-insensitive). Setting it empty disables the opt-out. The label is a passive suppressor, not a hard block: an authorized `@fro-bot` mention in the PR body still runs on opened/synchronize/reopened/edited actions, and an explicit review request naming the bot both admits the event and beats the label. The suppression is evaluated in the routing phase (see [[Execution Lifecycle]]).
- `enable-omo` enables Oh My OpenAgent (default: `false`). When `true`, oMo installs and configures Sisyphus as the default agent.
- `enable-omo-slim` enables OMO Slim (default: `false`), mutually exclusive with `enable-omo`. When `true`, OMO Slim installs with the chosen `omo-slim-preset` (`openai` or `opencode-go`, default `openai`) and pins `orchestrator` as the default agent.
- `model` overrides the LLM model in `provider/model` format.
- `timeout` controls the execution timeout (default: 30 minutes, 0 for no limit).
- `s3-backup` / `s3-bucket` / `aws-region` / `s3-endpoint` / `s3-prefix` / `s3-expected-bucket-owner` / `s3-allow-insecure-endpoint` / `s3-sse-encryption` / `s3-sse-kms-key-id` enable and configure the durable S3-compatible object store (see [[Session Persistence]]). Input validation rejects SSRF-vulnerable endpoints (metadata services, private IPs) and enforces HTTPS unless explicitly overridden.
- `session-retention` controls how many sessions to keep before pruning (default: 50).
- `dedup-window` configures the deduplication window in milliseconds (default: 10 minutes).

## Action Outputs

| Output | Description |
| --- | --- |
| `cache-status` | Cache restore status (`hit`, `miss`, `corrupted`) |
| `cache-save-result` | Cache save outcome (`durable`, `store-only`, `skipped`, `declined-for-safety`, `not-persisted`); set from the main step — the post-action retry reports only to the job summary |
| `invocation-outcome` | The run's final verified outcome (`succeeded`, `incomplete`, `failed`, `skipped`). `incomplete` means a useful result may exist but this invocation could not certify completion, so no dedup marker was written and no success reaction was posted (see [[Execution Lifecycle]]). Main step only |

See the full outputs table in the repository [README](../../README.md#outputs).

## Implementation Reference

Symbol-level reference for mechanisms that [ARCHITECTURE.md](../../ARCHITECTURE.md) summarizes under Cross-Cutting Concerns.

### OpenCode Question Tool Disabled (Action)

Nobody can answer an interactive `question` in a CI run, and a pending question has no server-side timeout, so a model that called the tool held the run until the execution deadline (#1756). Upstream registers the tool only when `flags.client` is `app`/`cli`/`desktop` or `OPENCODE_ENABLE_QUESTION_TOOL` is set (`tool/registry.ts:207`), and `client` defaults to `cli` (`effect/runtime-flags.ts:56`). `bootstrapOpenCodeServer` (`packages/runtime/src/agent/server.ts`, `pinQuestionToolOff`) therefore pins `OPENCODE_CLIENT=fro-bot-action` (`NON_INTERACTIVE_OPENCODE_CLIENT`) and deletes `OPENCODE_ENABLE_QUESTION_TOOL` before spawn; both survive the `OPENCODE_`-prefix allowlist in `filterAgentEnv`. The tool is then absent from the registry, so the model is never offered it and the stream needs no `question.*` handling. Unlike the file-watcher default (see OpenCode File Watcher Disabled By Default in [ARCHITECTURE.md](../../ARCHITECTURE.md)), an operator value does **not** win — it is overridden with a warning, the same stance as the `subagent_depth` pin in `buildCIConfig`.

A config-level `permission.question: 'deny'` was rejected as the mechanism: the top-level `permission` block is merged into each agent _before_ that agent's own `permission` (`agent/agent.ts:138-150`, `:293`; last matching rule wins), so any agent that ships `permission.question: 'allow'` re-enables the tool — oMo's Sisyphus and Prometheus agents do. The only other upstream readers of the client value are telemetry-shaped (models.dev user agent, OTLP `opencode.client` attribute, the `x-opencode-client` header sent to `opencode*` providers) plus the experimental `plan` tool, which is off. The gateway does not go through this bootstrap and keeps the tool: it answers questions through Discord.

### Workspace UID Isolation (Service vs. Agent)

The workspace container runs two identities. The workspace-agent **service** (`apps/workspace-agent/src/main.ts`) stays root (uid 0) because it hands checkouts to the agent and supervises its processes, but `deploy/compose.yaml` drops every capability except `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`, sets `no-new-privileges`, and disables core dumps. **OpenCode and everything it spawns** run as the unprivileged `opencode` account (`AGENT_UID`/`AGENT_GID` `10001`). `apps/workspace-agent/src/identity.ts` is the single source of truth for the uid/gid, the agent home and XDG tree (`/home/opencode`), the separate `SERVICE_HOME` (`/var/lib/workspace-agent/home`), the root-owned state/staging directory names, and the absolute `OPENCODE_EXECUTABLE_PATH`; `deploy/workspace.Dockerfile` creates the account and directories with the same values, so change both together.

- **OpenCode launch.** Every spawn site goes through `buildOpencodeLaunchSpec` (`apps/workspace-agent/src/opencode-server.ts`): absolute executable path (never resolved through `PATH`), agent uid/gid, and an environment _constructed_ from an allowlist by `buildOpencodeEnv` — agent home/XDG/`TMPDIR`, a fixed `PATH`, proxy, CA bundle, locale, and `OPENCODE_*` flags only. `WORKSPACE_*` settings, secret-file paths, tokens, and `GIT_*`/loader overrides cannot reach the child by construction, not by filtering. The service binds its control ports before OpenCode starts so the agent cannot race it for them.
- **Clone and handoff.** `executeClone` (`apps/workspace-agent/src/clone.ts`) clones into root-owned staging (`/workspace/repos/.workspace-agent/staging/`, `0700`, on the same volume), resolves and validates HEAD while the tree is still root's, hands every entry to the agent via `handOffToAgent` (`apps/workspace-agent/src/handoff.ts` — `lstat`/`lchown` only, never follows a symlink, never crosses `st_dev`, fails the clone on a hardlink, bounded by deadline and entry cap), then publishes with a single `rename`. Staging is emptied on every failure path. Clone runs under the shared per-repo mutex (`apps/workspace-agent/src/repo-mutex.ts`) and refuses with `journal-in-progress` (409) before touching anything when `apps/workspace-agent/src/journal.ts` reports an outstanding journal for the repo — found or `malformed`, never treated as absent. The only git that runs as root with credentials is the clone itself, in staging; the `repo-exists` check and post-rename race-check run as the agent through `apps/workspace-agent/src/git-safety.ts`.
- **Control-API auth.** `/clone` and `/inspect` on `:9100` require `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>` — the same root-only secret the `:9200` OpenCode proxy uses — so the agent uid cannot call the control API over loopback. `createApp` (`apps/workspace-agent/src/server.ts`) takes a required `auth` discriminated union with no default; the check runs before body parsing, compares constant-time (length-guarded `timingSafeEqual`), and returns a fixed 401. The gateway sends the bearer from `createWorkspaceClient` (`packages/gateway/src/workspace-api/client.ts`); roll the gateway and workspace images together, since a token mismatch rejects every clone.
- **Checkout-update primitives.** Credentialed fetches run only against a root-owned bare mirror under the state directory's `fetch/` store (`FETCH_STORE_DIR_NAME` in `apps/workspace-agent/src/identity.ts`); objects cross into the agent-owned checkout only as a `pack-objects --stdout | index-pack --stdin --strict` stream (`runPackStream`, `apps/workspace-agent/src/git-stream.ts`), never by local fetch or alternates. Admission checks against an existing checkout — config inventory, layout, temp-index cleanliness, path-obstruction preflight — live in `apps/workspace-agent/src/checkout-profile.ts` and run as the agent through the network/local-update git profiles in `apps/workspace-agent/src/git-safety.ts`. The egress proxy and CA bundle `/update`'s network half needs are read once at startup (`readUpdateNetworkConfig`, `apps/workspace-agent/src/config.ts`), never re-read per call. Adversarial real-git fixtures live in `apps/workspace-agent/src/update-fixtures/`.
- **Per-repo mutex and maintenance hold.** `apps/workspace-agent/src/repo-mutex.ts` serializes every mutating operation on a repository — clone, update, recovery, backup delete — through one in-process `withRepoLock`; different repositories never contend. When a subprocess's termination cannot be confirmed within its reap-grace window (SIGKILL sent, exit never observed), `markRepoHeld` sets a sticky, in-process maintenance hold on that repository: every later mutating call refuses with `maintenance-hold` rather than risk two operations touching the same on-disk state. The hold clears ONLY on a workspace restart — never a timer, never a later successful operation — because the workspace is always exactly one container (a documented precondition of the #1661 migration, enforced by `deploy/validate-stack.sh`'s `workspace.deploy.replicas` check) and a restart is the only event that can actually guarantee a leaked subprocess is gone.
- **Journals and startup reconciliation.** Every in-flight update or recovery mutation is journaled root-owned under the state directory's `journals/` store (`JOURNAL_DIR_NAME`, `apps/workspace-agent/src/journal.ts`), one file per repository, written temp-file-and-rename — never inside `.git/`, where the agent could forge one. A read that finds a file but cannot parse it reports `malformed`, never `absent`. `main.ts` reconciles every outstanding journal on service start (bounded by `JOURNAL_RECONCILE_TIMEOUT_MS`), and `/update`/`/recover` reconcile again at the top of each operation before anything else: an update journal stuck at `applying` marks the checkout needs-recovery; a recovery journal is resolved forward from wherever it stopped, never by deleting the quarantined original or cloning into the empty path.
- **Recovery and backups.** `POST /recover/preview` (`previewRecovery`) is stateless — no server-side operation id — and returns a `fingerprint` digesting HEAD SHA, dirty counts, and checkout size/entry count; `POST /recover` (`executeRecovery`) recomputes the fingerprint under the repo lock and refuses with `checkout-changed` if it differs. A confirmed recovery preserves the WHOLE existing checkout by `rename` into a root-owned quarantine envelope `<quarantine>/<owner>__<repo>/<id>/{checkout/, metadata.json}` (`QUARANTINE_DIR_NAME`, `apps/workspace-agent/src/backups.ts`) — never stash, commit, or discard — then installs a fresh checkout built entirely as root in root-owned staging (`git init`, pack import, `read-tree --reset -u`, `update-ref`, canonical origin config) before handoff and rename; `read-tree --reset` never runs against an agent-owned checkout. Retention is capped at 5 generations and 10 GiB per repository (`RETENTION_MAX_GENERATIONS`/`RETENTION_MAX_BYTES`, `apps/workspace-agent/src/recover.ts`) with no automatic eviction — at the cap, recovery refuses before moving anything. `GET`/`DELETE /backups/:owner/:repo[/:id]` (`listBackups`/`deleteBackup`, `apps/workspace-agent/src/backups.ts`) list and remove one generation at a time; there is no export and no bulk delete.
- **Agent-uid size walker.** `runAgentWalk` (`apps/workspace-agent/src/agent-walk.ts`) measures a checkout or quarantine generation's size and entry count as the agent uid via a spawned child; when that plain walk is incomplete or fails, `measureSealedTree`/`measureSealedTreeFromFd` fall back to measuring the same sealed tree through a root-opened file descriptor, so the service never has to traverse an agent-owned directory by path.
- **Private-repo auth.** The installation token reaches git only through a `GIT_ASKPASS` helper that exact-matches git's literal `https://github.com` prompts and exits non-zero otherwise, with global/system git config sealed and `GIT_ALLOW_PROTOCOL=https`.
- **Directory ownership.** `/workspace/repos` and each owner directory stay root-owned, so the agent can edit a checkout but cannot replace where it lives. Secrets and the raw mitmproxy CA mount under the root-only `/run/workspace-agent/` tmpfs; only the installed public trust bundle is readable by both identities.
- **Entrypoint.** `deploy/workspace-entrypoint.sh` creates the protected state directory (`deploy/scripts/ensure-protected-dir.mjs`), migrates legacy root-owned checkouts to the agent uid (`deploy/scripts/migrate-repo-ownership.mjs` — filesystem-only, symlink/hardlink-safe, per-checkout completion markers, bounded by `WORKSPACE_MIGRATION_DEADLINE_MS`, refuses to start on timeout, never deletes), and writes OpenCode's auth and merged config from a process already running as the agent, fed via stdin (`deploy/scripts/provision-agent-config.mjs`) — root never writes into an agent-owned directory, where a planted symlink would turn into a privileged write.
- **Verification.** Kernel permission boundaries cannot be proven by unit tests: `deploy/tests/isolation-harness.sh` starts the image exactly as compose does and pairs each attempted violation as the agent (reading service home/secrets/env/memory, replacing a checkout parent, taking a control port) with the same operation succeeding as root. `deploy/validate-stack.sh` requires the service identity, the exact capability set, `no-new-privileges`, and the protected mount locations; `deploy/egress-smoke.sh` and the CI image smoke run with production's user, capabilities, and mount layout. CI also builds the `workspace-test` target of `deploy/workspace.Dockerfile` and runs the workspace-agent suite inside it, so the git fixtures exercise the image's own Alpine git.

### Systematic Plugin Install (Setup-Time, Not Server-Boot)

`src/services/setup/systematic-plugin.ts` (`installSystematicPlugin`) runs the OpenCode CLI's `plugin` command (`opencode --pure plugin @fro.bot/systematic@<version> --global`) during the setup phase, on a tools-cache miss, before `saveToolsCache` — moving the same `Npm.add()` install the server would otherwise perform out of the server's boot path and into the same on-disk cache directory the server reads (deriving that path independently would have created a second copy of OpenCode's layout that must silently agree with the real one forever). Left alone, the server runs `config.get()` then `plugin.init()` serially before any service init, with no timeout of its own; a degraded npm registry turns that into 181–370s of a server whose SDK-level readiness signal — a stdout string match (`"opencode server listening"`) — is satisfied long before this per-directory instance bootstrap has run (issue #1536). `bootstrapOpenCodeServer` now closes that gap with its own instance-scoped readiness probe (a bounded `client.session.list({query: {directory}})` call) after `createOpencode` resolves, so a stall like this one now fails fast, by name, instead of surfacing 181–370s later as a bare "fetch failed" once undici's 300s `headersTimeout` on the harness's first real request finally gives up. The install is bounded (SIGTERM then SIGKILL) at 420s — sized against that measured stall tail, not against a healthy install (seconds) — and is non-fatal: on timeout or failure it warns and lets the server's own install serve as the fallback it always was, and setup skips `saveToolsCache` entirely, so an incomplete install is never persisted into an immutable cache key. The child's environment is `filterAgentEnv`-scrubbed, never inherited wholesale — this subprocess runs `npm install` against a package fetched off the network, so it gets the same untrusted-child treatment `withScrubbedEnv` gives `createOpencode` (issue #1147), never `GITHUB_TOKEN`, `*_API_KEY`, `*_SECRET`, `AWS_*`, or `INPUT_*`. It runs with `--pure` (skip plugin boot on install) and `--global` (write OpenCode's own config, not the checked-out repository).

Booting OpenCode for this install initializes the real session database (`~/.local/share/opencode/opencode.db`), enables WAL mode, and leaves an `opencode.db-wal` sidecar beside it — and this install runs on every tools-cache miss, before the session-storage cache is restored, on every harness release. `DB_TRANSPORTABLE_BASENAMES` (`packages/runtime/src/session/version.ts`) deliberately transports only the main database file, so a WAL this install created survived next to a database it was never opened against once the Actions-cache restore overwrote `opencode.db`; `checkpointDatabase` then silently merged that stale WAL into the freshly restored database, discarding the sessions the restore had just written back (production evidence: run `34448454976` restored 97 sessions from a 19 MB restore reported as "Cache restored successfully"; run `34449598839`, fifteen minutes later against the same restore key and an equally successful-looking restore, came up with 0 — and the saved cache entry itself had collapsed from 20,231,832 bytes to 801,442). `installSystematicPlugin` now points the child at `OPENCODE_DB`, a throwaway database file inside a per-install `mkdtemp()` directory, rather than cleaning up the stray WAL after the fact — a cleanup pass risks deleting committed session data on a cache miss or on a persistent runner. `OPENCODE_DB` is read directly by OpenCode's database path resolution and accepts an absolute path; the underlying sqlite drivers derive the `-wal`/`-shm` sidecar paths from that same main file path, so redirecting it relocates its sidecars too. The temp directory is removed in a `finally` block on every exit path — success, failure, and timeout — with cleanup failures logged but never surfaced as an install failure. `OPENCODE_DB` matches the existing `OPENCODE_` allowlist prefix in `filterAgentEnv`, so it reaches the child alongside the other `OPENCODE_*` overrides (see OpenCode File Watcher Disabled By Default and OpenCode Question Tool Disabled in [ARCHITECTURE.md](../../ARCHITECTURE.md)) while the deny-set and allowlist stay unchanged. Verified fixed on #1587's own review job (run `34463783992`): a genuine tools-cache miss — the same condition that triggers the bug — restored 97 sessions with no checkpoint-merge log line anywhere in the run.
