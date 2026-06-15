---
type: subsystem
last-updated: "2026-06-14"
updated-by: "7065ca0"
sources:
  - src/services/setup/setup.ts
  - src/services/setup/ci-config.ts
  - src/services/setup/systematic-config.ts
  - src/services/setup/opencode.ts
  - src/services/setup/bun.ts
  - src/services/setup/omo.ts
  - src/services/setup/gh-auth.ts
  - src/services/setup/auth-json.ts
  - src/services/setup/tools-cache.ts
  - packages/runtime/src/shared/constants.ts
  - src/shared/constants.ts
  - src/harness/config/inputs.ts
  - action.yaml
  - RFCs/RFC-011-Setup-Action-Environment-Bootstrap.md
  - RFCs/RFC-019-S3-Storage-Backend.md
summary: "Tool installation, configuration assembly, credential management, cache strategy, and oMo opt-in"
---

# Setup and Configuration

The setup module (`src/services/setup/`) bootstraps the CI environment before agent execution can begin. It installs runtime dependencies, configures authentication, assembles the OpenCode configuration, and manages a tools cache to speed up subsequent runs.

## Installation Sequence

The `runSetup()` orchestrator follows a **mode-gated** sequence based on the `enable-omo` input. When oMo is disabled (the default), the setup path is minimal — OpenCode only. When `enable-omo: true`, Bun and oMo are installed alongside OpenCode.

### Disabled Mode (Default, `enable-omo: false`)

1. **Parse credentials** — Validates `auth-json` input early to fail fast on bad credentials. The input is a JSON object mapping LLM provider names to their auth configs (e.g., `{"anthropic": {"apiKey": "..."}}`).

2. **Resolve versions** — Determines target versions for OpenCode and Systematic. The `latest` keyword for OpenCode triggers a GitHub Releases API lookup. oMo and Bun version resolution is skipped.

3. **Restore tools cache** — Checks for a cached bundle of previously installed tools, keyed by version, OS, and mode. A cache hit skips download steps entirely. The disabled-mode cache excludes Bun and `~/.config/opencode` paths to prevent stale oMo config from being restored.

4. **Install OpenCode CLI** — Downloads the platform-appropriate release binary, extracts it, verifies it (`--version`), and registers it in the GitHub Actions tool cache. The platform mapping handles Linux x64/arm64 and macOS x64/arm64. The download source depends on whether the target is a stock OpenCode release or a [harness build](#harness-builds) — harness builds are fetched from `fro-bot/agent` releases and verified against a published `SHA256SUMS` manifest.

5. **Build CI config** — Assembles the `OPENCODE_CONFIG_CONTENT` environment variable, which configures OpenCode for CI operation. This includes disabling auto-updates, injecting the Systematic plugin, and pinning `default_agent` to `"build"`.

6. **Merge user config** — Merges the CI config on top of any user-provided `opencode-config` input. Plugin arrays are deduplicated by package name prefix. In disabled mode, `oh-my-openagent` entries are stripped from both `plugin` and legacy `plugins` keys, and a warning names any rewritten fields. Legacy `plugins` (plural) keys are also stripped — OpenCode only accepts `plugin` (singular).

7. **Save tools cache** — If the tools cache missed, saves the installed binaries for future runs.

8. **Configure authentication** — Sets up `gh` CLI auth, configures Git identity as `{bot}[bot]` for audit trails, and writes the ephemeral `auth.json` with `0o600` permissions.

### Enabled Mode (`enable-omo: true`)

When oMo is enabled, the setup path adds Bun installation and oMo setup after the OpenCode CLI install:

1. Steps 1–4 match disabled mode (credentials, versions, cache restore, OpenCode install).

2. **Install Bun runtime** — Required for running the oMo installer via `bunx`. If Bun installation fails, oMo is skipped but execution continues.

3. **Disable oMo telemetry** — Sets `OMO_SEND_ANONYMOUS_TELEMETRY=0` and `OMO_DISABLE_POSTHOG=1` before any oMo code runs, including the installer itself.

4. **Write optional configs** — If `systematic-config` is provided, writes it before the installer runs.

5. **Install oMo** — Runs the oMo installer via Bun. This is treated as a graceful-fail operation: if it fails, the agent runs without oMo agent workflows. The installer error is captured but doesn't abort the run.

6. **Build CI config** — Assembles `OPENCODE_CONFIG_CONTENT`. Does not pin `default_agent` — oMo-managed config selects Sisyphus as the default when `agent` is unset.

7. **Merge configs** — Merges CI config on top of any existing `opencode.json` (which the oMo installer may have created). Plugin arrays are deduplicated. `oh-my-openagent` plugin entries from the oMo installer are preserved.

8. **Save tools cache** — The enabled-mode cache includes Bun and `~/.config/opencode` paths.

9. **Configure authentication** — Same as disabled mode.

## Pinned Versions

Default versions are defined in `packages/runtime/src/shared/constants.ts` (shared across surfaces) and `src/shared/constants.ts` (action-specific overrides):

| Tool         | Constant                     | Purpose                                  |
| ------------ | ---------------------------- | ---------------------------------------- |
| OpenCode CLI | `DEFAULT_OPENCODE_VERSION`   | The AI coding agent platform             |
| Bun          | `DEFAULT_BUN_VERSION`        | JavaScript runtime for oMo installer     |
| oMo          | `DEFAULT_OMO_VERSION`        | Oh My OpenAgent workflow framework       |
| Systematic   | `DEFAULT_SYSTEMATIC_VERSION` | OpenCode plugin for structured workflows |

These can be overridden per-run via action inputs (`opencode-version`, `omo-version`, `systematic-version`). The pinned defaults are updated via Renovate-managed PRs.

The default `DEFAULT_OPENCODE_VERSION` is a **harness build** (for example `1.17.6+harness.13169873`) rather than a plain upstream OpenCode release. See [Harness Builds](#harness-builds) for what that means and how it changes the install path.

## Harness Builds

OpenCode is consumed in two forms. A _stock_ version is a plain upstream release (for example `1.17.6`) published by the `anomalyco/opencode` project. A _harness_ version carries a `+harness.<sha>` build-metadata suffix (for example `1.17.6+harness.13169873`) and is a `fro-bot/agent` release that bundles the upstream binary together with patches this project carries on top of OpenCode. The action defaults to a harness build so that the carried patches are always present, while still allowing a stock version to be requested explicitly via the `opencode-version` input.

The presence of the `+harness.` marker drives three behavioral differences in `src/services/setup/opencode.ts`:

- **Download source** — Harness versions are routed to the `fro-bot/agent` releases URL instead of the upstream `anomalyco/opencode` releases. Because harness release tags are non-`v`-prefixed and GitHub stores tags URL-encoded, the `+` in the version is percent-encoded as `%2B` when building the download path. Stock versions keep their conventional `v`-prefixed upstream URL.

- **Checksum verification** — Every harness archive is verified against a `SHA256SUMS` manifest published alongside the binary in the same release. Stock downloads have no such manifest and are not checksum-verified by the action. Before any URL is constructed, the version string is validated against a strict semver-ish pattern as a defense-in-depth guard against path traversal or shell metacharacters.

- **Tool-cache identity** — `@actions/tool-cache` runs versions through `semver.clean()` internally, which strips `+harness.<sha>` build-metadata and would collapse a harness build onto a stock cache entry of the same base version. To preserve identity, the `+harness.` marker is rewritten to a `-harness.` prerelease segment (`toolCacheVersion()`) _only_ at tool-cache call sites. Download URLs, checksums, logs, and return values keep the raw `+harness.` form. This guarantees a harness build and a stock build of the same base version never share a cache slot.

If the `latest` resolution path or a non-harness flow needs a fallback, the setup module falls back to a known-good stock version rather than a harness build.

## Configuration Assembly

The CI config built by `buildCIConfig()` ensures OpenCode operates correctly in a headless CI environment:

- **Auto-update disabled** — Prevents OpenCode from trying to update itself mid-run.
- **Systematic plugin injected** — Ensures `@fro.bot/systematic@{version}` is registered as an OpenCode plugin. The version is pinned to prevent drift.

The final config is the result of merging:

- In disabled mode: CI config (with `default_agent: "build"`) + user-provided `opencode-config` input. Existing local `opencode.json` files are ignored to prevent stale oMo config from leaking in.
- In enabled mode: CI config (without `default_agent` pin) + existing `opencode.json` (from oMo installer) + user-provided `opencode-config` input.

User values win on conflicts. In disabled mode, `oh-my-openagent` plugin entries in user config are stripped with a warning.

## Tools Cache

The setup module maintains its own cache (separate from the session cache) for installed binaries. The key is **mode-partitioned**: disabled mode excludes oMo version and restricts cached paths to OpenCode tooling only, preventing stale oMo config from being restored.

Disabled-mode key:

```text
opencode-tools-disabled-{opencodeVersion}-{systematicVersion}-{os}
```

Enabled-mode key:

```text
opencode-tools-enabled-{opencodeVersion}-{omoVersion}-{systematicVersion}-{os}
```

On a cache hit, the module verifies the binary is actually present in the tool cache before trusting it — cache hits where the binary is missing fall through to a fresh install. The lookup uses the tool-cache-safe form of the version (see [Harness Builds](#harness-builds)), so a harness build never reuses a stock binary's cache entry. This cache typically saves 10-20 seconds per run.

## Security

Credentials are handled with care:

- **`auth.json`** is written with `0o600` permissions (owner-only read/write) and is never cached. It's regenerated fresh from secrets on every run.
- **Git identity** is forced to `{bot}[bot]` so commits made by the agent have a clear audit trail.
- **`GH_TOKEN`** is set as an environment variable for the `gh` CLI but never logged.
- **Telemetry** is disabled for oMo before any oMo code executes.

## Action Inputs

The action accepts over 20 inputs defined in `action.yaml`, grouped into core, agent, S3, and configuration categories. The most important ones:

- `github-token` and `auth-json` are required — they provide GitHub API access and LLM provider credentials respectively.
- `prompt` provides a custom instruction for the agent. Required for `schedule` and `workflow_dispatch` events.
- `output-mode` controls the delivery contract for `schedule` and `workflow_dispatch` runs (`auto`, `working-dir`, `branch-pr`; default `auto`). When set to `auto`, the resolver in `src/features/agent/output-mode.ts` scans the prompt text for branch/PR-related phrases (e.g., "pull request", "create a pr", "git push") and selects `branch-pr` if any match, otherwise `working-dir`. This heuristic is frozen — new phrases require a code change. The `output-mode` input has no effect on non-manual event types (issue comments, PRs, etc.), which always return `null`. See [Delivery-mode contract for manual workflow triggers](../solutions/workflow-issues/delivery-mode-contract-for-manual-triggers-2026-04-17.md) for the design rationale.
- `agent` selects the OpenCode agent. When unset, uses OpenCode's built-in `build` agent. Must be a primary agent, not a subagent.
- `enable-omo` enables Oh My OpenAgent (default: `false`). When `true`, oMo installs and configures Sisyphus as the default agent.
- `model` overrides the LLM model in `provider/model` format.
- `timeout` controls the execution timeout (default: 30 minutes, 0 for no limit).
- `s3-backup` / `s3-bucket` / `aws-region` / `s3-endpoint` / `s3-prefix` / `s3-expected-bucket-owner` / `s3-allow-insecure-endpoint` / `s3-sse-encryption` / `s3-sse-kms-key-id` enable and configure the durable S3-compatible object store (see [[Session Persistence]]). Input validation rejects SSRF-vulnerable endpoints (metadata services, private IPs) and enforces HTTPS unless explicitly overridden.
- `session-retention` controls how many sessions to keep before pruning (default: 50).
- `dedup-window` configures the deduplication window in milliseconds (default: 10 minutes).
