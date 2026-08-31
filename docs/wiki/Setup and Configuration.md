---
type: subsystem
last-updated: "2026-08-30"
updated-by: "schedule-d7190410-33338713321"
sources:
  - src/services/setup/setup.ts
  - src/services/setup/ci-config.ts
  - src/services/setup/systematic-config.ts
  - src/services/setup/opencode.ts
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
summary: "Tool installation, configuration assembly, credential management, cache strategy, and oMo opt-in"
---

# Setup and Configuration

The setup module (`src/services/setup/`) bootstraps the CI environment before agent execution can begin. It installs runtime dependencies, configures authentication, assembles the OpenCode configuration, and manages a tools cache to speed up subsequent runs.

## Installation Sequence

The `runSetup()` orchestrator follows a **mode-gated** sequence. When no orchestration plugin is requested (the default), the setup path is minimal — OpenCode only. When `enable-omo: true`, Bun and oMo are installed alongside OpenCode. A third mutually-exclusive mode, `enable-omo-slim: true`, installs Bun and [OMO Slim](https://github.com/alvinunreal/oh-my-opencode-slim) instead and pins `orchestrator` as the default agent; requesting both oMo and OMO Slim fails fast. The two plugin-enabled modes share the same "enabled" cache partition and bootstrap shape, so the description below contrasts the default OpenCode-only path against the plugin-enabled path.

### Default Mode (no orchestration plugin)

1. **Parse credentials** — Validates `auth-json` input early to fail fast on bad credentials. The input is a JSON object mapping LLM provider names to their auth configs (e.g., `{"anthropic": {"apiKey": "..."}}`).

2. **Resolve versions** — Determines target versions for OpenCode and Systematic. The `latest` keyword for OpenCode triggers a GitHub Releases API lookup. oMo and Bun version resolution is skipped.

3. **Restore tools cache** — Checks for a cached bundle of previously installed tools, keyed by version, OS, and mode. A cache hit skips download steps entirely. The disabled-mode cache excludes Bun and `~/.config/opencode` paths to prevent stale oMo config from being restored.

4. **Install OpenCode CLI** — Downloads the platform-appropriate release binary, extracts it, verifies it (`--version`), and registers it in the GitHub Actions tool cache. The platform mapping handles Linux x64/arm64 and macOS x64/arm64. The download source depends on whether the target is a stock OpenCode release or a [harness build](#harness-builds) — harness builds are fetched from `fro-bot/agent` releases and verified against a published `SHA256SUMS` manifest.

5. **Build CI config** — Assembles the `OPENCODE_CONFIG_CONTENT` environment variable, which configures OpenCode for CI operation. This includes disabling auto-updates, injecting the Systematic plugin, and pinning `default_agent` to `"build"`.

6. **Merge user config** — Merges the CI config on top of any user-provided `opencode-config` input. Plugin arrays are deduplicated by package name prefix. In disabled mode, `oh-my-openagent` entries are stripped from both `plugin` and legacy `plugins` keys, and a warning names any rewritten fields. Legacy `plugins` (plural) keys are also stripped — OpenCode only accepts `plugin` (singular).

7. **Save tools cache** — If the tools cache missed, saves the installed binaries for future runs.

8. **Configure authentication** — Sets up `gh` CLI auth, configures Git identity as `{bot}[bot]` for audit trails, and writes the ephemeral `auth.json` with `0o600` permissions.

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
| Systematic   | `DEFAULT_SYSTEMATIC_VERSION` | OpenCode plugin for structured workflows         |

These can be overridden per-run via action inputs (`opencode-version`, `omo-version`, `systematic-version`). Stock tool pins are updated via Renovate-managed PRs; the OpenCode harness default is advanced by the harness release sync PR after a harness build exists.

Bun plays a dual role: it is both the runtime that runs the oMo / OMO Slim installer in CI _and_ the package manager for this project's own workspace. The repository migrated from pnpm to Bun, which moved workspace configuration into `bunfig.toml`, replaced `pnpm install` with `bun install`, and changed how cache keys and license attribution are derived. Because the project's tooling itself depends on Bun, the Bun version is pinned and is baked into the tools-cache key (see [Tools Cache](#tools-cache)) so a Bun bump cleanly invalidates stale tooling.

The default `DEFAULT_OPENCODE_VERSION` is a **harness build** (currently `1.18.21+harness.22dee0ee`) rather than a plain upstream OpenCode release. See [Harness Builds](#harness-builds) for what that means and how it changes the install path.

## Harness Builds

OpenCode is consumed in two forms. A _stock_ version is a plain upstream release (for example `1.18.21`) published by the `anomalyco/opencode` project. A _harness_ version carries a `harness.<sha>` suffix (for example `1.18.21+harness.22dee0ee`) and is a `fro-bot/agent` release that bundles the upstream binary together with a curated set of upstream integration refs — stalled or closed OpenCode PRs — merged onto the base release. The current build carries twelve such refs on top of the `1.18.21` base, spanning provider/model routing fixes, SQLite lock-timeout retries, SSE backlog bounding, and several memory-leak and stability patches; as the base advanced up the `1.18.x` line to `1.18.21`, superseded and low-value carries were retired so the set stays lean. The exact carry set is defined in the `integrationRefs` list of `packages/harness/harness.config.json`; the action defaults to a harness build so that the carried patches are always present, while still allowing a stock version to be requested explicitly via the `opencode-version` input.

### Two Spellings of the Same Build

A harness build has one identity but two written forms, and understanding why they differ explains most of the surrounding machinery.

The **build-metadata form** — `1.18.21+harness.22dee0ee` — is what the binary self-reports and what the version pin in `packages/runtime/src/shared/constants.ts` records. The `+` segment is SemVer build metadata (§10), which is deliberately excluded from version precedence.

The **prerelease form** — `1.18.21-harness.22dee0ee` — is the published GitHub release tag, the npm package version, and the tool-cache key.

The prerelease form is not cosmetic. Harness releases live in the same tag namespace as the action's own `v0.x` product releases, and that namespace has two adversarial readers. Semantic-release scans tags matching `^v(.+)` to compute the next product version, so harness tags dropped the `v` prefix in mid-2026 to stay invisible to it. But bare-semver tags with build metadata created a second problem: because SemVer strips build metadata for precedence, Renovate's `github-tags` datasource — which discovers candidates from git tags, not release objects — read `1.18.21+harness.22dee0ee` as a _stable_ `1.18.21` that outranked the real `v0.x` action line, quietly breaking grouped update branches in consuming repositories. Marking the GitHub release object as a prerelease does not help, because candidate discovery never looks at release objects.

Moving the tag to a genuine SemVer prerelease identifier fixes it at the level of the spec rather than at the level of a tool's enrichment behavior: prereleases are excluded by Renovate's default `ignoreUnstable` setting. The two constraints are therefore satisfied by different properties of the same tag — the missing `v` hides it from semantic-release, and the prerelease identifier hides it from Renovate. The eighteen legacy `+harness.` releases were migrated by duplication rather than rename (`scripts/harness/duplicate-harness-release-tags.ts`, a completed one-off), because their asset URLs are load-bearing for any pinned run still referencing them.

### How the Marker Changes the Install Path

`src/services/setup/opencode.ts` recognizes either spelling as a harness build, and converts to the release-tag form at the boundaries that need it (`toHarnessReleaseTag()`; `toolCacheVersion()` is a named alias for the same conversion). Three behaviors follow:

- **Download source** — Harness versions are routed to the `fro-bot/agent` releases URL instead of the upstream `anomalyco/opencode` releases, with the tag derived through the prerelease conversion. Percent-encoding of `+` as `%2B` is retained for the migrated legacy tags, since GitHub stores tags URL-encoded and a raw `+` is misread as a space. Stock versions keep their conventional `v`-prefixed upstream URL.

- **Checksum verification** — Every harness archive is verified against a `SHA256SUMS` manifest published alongside the binary in the same release. Stock downloads have no such manifest and are not checksum-verified by the action. Before any URL is constructed, the version string is validated against a strict semver-ish pattern as a defense-in-depth guard against path traversal or shell metacharacters. A harness pin that fails to download or verify is **fail-closed** — the run aborts rather than silently substituting a stock binary; the stock fallback (`FALLBACK_VERSION`, currently `1.18.21`) is reached only on the `latest`-resolution path.

- **Tool-cache identity** — `@actions/tool-cache` runs versions through `semver.clean()` internally, which strips `+harness.<sha>` build metadata and would collapse a harness build onto a stock cache entry of the same base version. The prerelease form survives `semver.clean()` intact, so using it as the cache key guarantees a harness build and a stock build of the same base version never share a cache slot. Logs and the binary's own `--version` output keep the build-metadata form.

If the `latest` resolution path needs a fallback, the setup module falls back to a known-good stock version (`FALLBACK_VERSION`, currently `1.18.21`) rather than a harness build. An explicitly-pinned harness build does not fall back — a failed download or checksum mismatch fails the run.

Because the tag shape is now load-bearing for two external tools and is derived in more than one place — the release workflow, the npm version builder, and the setup module — the test suite carries drift guards that read the repository's source text and fail if one producer is changed without the others. These guards exist because an earlier mirrored copy of the harness-version predicate asserted the opposite of production behavior and still passed, testing its own copy rather than the module.

## Configuration Assembly

The CI config built by `buildCIConfig()` ensures OpenCode operates correctly in a headless CI environment:

- **Auto-update disabled** — Prevents OpenCode from trying to update itself mid-run.
- **Systematic plugin injected** — Ensures `@fro.bot/systematic@{version}` is registered as an OpenCode plugin. The version is pinned to prevent drift.
- **Permission defaults hardened** — The config bakes in deny rules so the run never stalls on an interactive permission prompt it cannot answer. The `doom_loop` native ask defaults to `deny`, secret-shaped file reads (`*.env`, `*.env.*`) are denied while `*.env.example` stays readable, and edits are scoped to the workspace and any designated external directory. These defaults pair with the runtime's ask-answering behavior described in [[Execution Lifecycle]]: an ask that still reaches the agent is denied and logged rather than left to block until the execution deadline.

The final config is the result of merging:

- In default mode: CI config (with `default_agent: "build"`) + user-provided `opencode-config` input. Existing local `opencode.json` files are ignored to prevent a stale orchestration config from leaking in.
- In plugin-enabled mode: CI config (with `default_agent` pinned to `"orchestrator"` for OMO Slim, or left unpinned so oMo selects Sisyphus) + existing `opencode.json` (from the installer) + user-provided `opencode-config` input.

User values win on conflicts. In default mode, `oh-my-openagent` and `oh-my-opencode-slim` plugin entries in user config are stripped with a warning.

## Tools Cache

The setup module maintains its own cache (separate from the session cache) for installed binaries. The key is **mode-partitioned**: disabled mode omits the oMo version and restricts cached paths to OpenCode tooling only, preventing stale oMo config from being restored, while enabled mode additionally caches the Bun binary, the Bun package cache, and the oMo config directory.

Disabled-mode key:

```text
opencode-tools-{os}-disabled-oc-{opencodeVersion}-sys-{systematicVersion}-bun-{bunVersion}
```

Enabled-mode key:

```text
opencode-tools-{os}-enabled-oc-{opencodeVersion}-omo-{omoVersion}-sys-{systematicVersion}-bun-{bunVersion}
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

The GitHub token the agent might use to post is provisioned **conditionally**, driven by the response-delivery decision computed in [[Execution Lifecycle|bootstrap]]. On comment and review flows (`issue_comment`, `pull_request`, `issues`) the credential is **withheld** — `configureGhAuth()` skips setting `GH_TOKEN`, skips writing the `gh` `hosts.yml`, and clears any ambient `GH_CONFIG_DIR` from earlier workflow steps. The rationale is that on those flows the action posts the agent's answer itself (the file-convention delivery path), so the model has no legitimate need to call `gh` — and a credential the model never receives is a credential a prompt-injected model cannot exfiltrate from disk or environment. A preflight check (`git-credential-check.ts`) additionally asserts that no persisted git credential lingers in `.git/config` on these flows, which is why consumers are asked to check out with `persist-credentials: false`. Autonomous flows (`schedule`, `workflow_dispatch`) keep the credential provisioned, because they legitimately create branches, commits, and PRs on their own.

When a same-repo PR comment produces workspace edits, the action still needs a way to land them despite withholding the token — this is what the [[Execution Lifecycle|brokered push]] step provides. It commits on the model's behalf through the action's own Octokit client, so the write is gated by trusted event facts and a path allowlist (`brokered-push-validation.ts`) rather than by handing the agent a credential. Keeping `persist-credentials: false` remains essential: it ensures the withheld token has no residual copy in `.git/config` that a same-user shell inside the agent could read.

### Environment scrubbing at agent spawn

Independently of whether a credential is provisioned, the OpenCode child process is spawned under a **deny-by-default environment filter** (`packages/runtime/src/agent/filter-env.ts`, applied via `with-scrubbed-env.ts`). Only an enumerated allowlist of keys survives — GitHub Actions context, a handful of standard shell and locale variables, proxy/CA-bundle settings, and the `OPENCODE_*`, `RUNNER_*`, `XDG_*`, `LC_*`, and `NODE_*` prefixes. Anything ending in a credential-shaped suffix (`_TOKEN`, `_API_KEY`, `_SECRET`, `_KEY`, and similar), the `AWS_*` and `INPUT_*` prefixes, and `GITHUB_TOKEN`/`GH_TOKEN` by exact name are stripped even if they would otherwise match. The reduction is scoped: the harness restores its own environment immediately after the spawn so it can still reach the S3 backend, and it fails closed — if the scrub cannot complete, the child is never spawned.

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
