---
type: subsystem
last-updated: "2026-04-26"
updated-by: "ca17d5e"
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
summary: "Tool installation, configuration assembly, credential management, and cache strategy"
---

# Setup and Configuration

The setup module (`src/services/setup/`) bootstraps the CI environment before agent execution can begin. It installs runtime dependencies, configures authentication, assembles the OpenCode configuration, and manages a tools cache to speed up subsequent runs.

## Installation Sequence

The `runSetup()` orchestrator follows this sequence:

1. **Parse credentials** — Validates `auth-json` input early to fail fast on bad credentials. The input is a JSON object mapping LLM provider names to their auth configs (e.g., `{"anthropic": {"apiKey": "..."}}`).

2. **Resolve versions** — Determines the target versions for OpenCode, Bun, oMo, and Systematic. Each has a pinned default in `src/shared/constants.ts` that can be overridden via action inputs. The `latest` keyword for OpenCode triggers a GitHub Releases API lookup.

3. **Restore tools cache** — Checks for a cached bundle of previously installed tools, keyed by version and OS. A cache hit skips the download steps entirely.

4. **Install OpenCode CLI** — Downloads the platform-appropriate release binary, extracts it, verifies it (`--version`), and registers it in the GitHub Actions tool cache. The platform mapping handles Linux x64/arm64 and macOS x64/arm64.

5. **Install Bun runtime** — Required for running the oMo installer via `bunx`. If Bun installation fails, oMo is skipped but execution continues — oMo is optional.

6. **Disable oMo telemetry** — Sets `OMO_SEND_ANONYMOUS_TELEMETRY=0` and `OMO_DISABLE_POSTHOG=1` before any oMo code runs, including the installer itself.

7. **Write optional configs** — If `omo-config` or `systematic-config` inputs are provided, writes them to the oMo config directory before the installer runs so it can observe custom settings.

8. **Install oMo** — Runs the oMo installer via Bun. This is treated as a graceful-fail operation: if it fails, the agent runs without oMo agent workflows. The installer error is captured but doesn't abort the run.

9. **Build CI config** — Assembles the `OPENCODE_CONFIG_CONTENT` environment variable, which configures OpenCode for CI operation. This includes disabling auto-updates and injecting the Systematic plugin at the pinned version.

10. **Merge configs** — Merges the CI config on top of any existing `opencode.json` (which the oMo installer may have created). Plugin arrays are deduplicated by package name prefix. Legacy `plugins` (plural) keys are stripped — OpenCode only accepts `plugin` (singular).

11. **Save tools cache** — If the tools cache missed, saves the installed binaries for future runs.

12. **Configure authentication** — Sets up `gh` CLI auth, configures Git identity as `{bot}[bot]` for audit trails, and writes the ephemeral `auth.json` with `0o600` permissions.

## Pinned Versions

Default versions are defined in `packages/runtime/src/shared/constants.ts` (shared across surfaces) and `src/shared/constants.ts` (action-specific overrides):

| Tool         | Constant                     | Purpose                                  |
| ------------ | ---------------------------- | ---------------------------------------- |
| OpenCode CLI | `DEFAULT_OPENCODE_VERSION`   | The AI coding agent platform             |
| Bun          | `DEFAULT_BUN_VERSION`        | JavaScript runtime for oMo installer     |
| oMo          | `DEFAULT_OMO_VERSION`        | Oh My OpenAgent workflow framework       |
| Systematic   | `DEFAULT_SYSTEMATIC_VERSION` | OpenCode plugin for structured workflows |

These can be overridden per-run via action inputs (`opencode-version`, `omo-version`, `systematic-version`). The pinned defaults are updated via Renovate-managed PRs.

## Configuration Assembly

The CI config built by `buildCIConfig()` ensures OpenCode operates correctly in a headless CI environment:

- **Auto-update disabled** — Prevents OpenCode from trying to update itself mid-run.
- **Systematic plugin injected** — Ensures `@fro.bot/systematic@{version}` is registered as an OpenCode plugin. The version is pinned to prevent drift.

The final config is the result of merging: existing `opencode.json` (from oMo) + CI config overrides + user-provided `opencode-config` input. User values win on conflicts.

## Tools Cache

The setup module maintains its own cache (separate from the session cache) for installed binaries. The key incorporates the OpenCode, oMo, and Systematic versions plus the runner OS:

```text
opencode-tools-{opencodeVersion}-{omoVersion}-{systematicVersion}-{os}
```

On a cache hit, the module verifies the binary is actually present in the tool cache before trusting it — cache hits where the binary is missing fall through to a fresh install. This cache typically saves 10-20 seconds per run.

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
- `agent` selects the OpenCode agent (default: `sisyphus`). Must be a primary agent, not a subagent.
- `model` overrides the LLM model in `provider/model` format.
- `timeout` controls the execution timeout (default: 30 minutes, 0 for no limit).
- `s3-backup` / `s3-bucket` / `aws-region` / `s3-endpoint` / `s3-prefix` / `s3-expected-bucket-owner` / `s3-allow-insecure-endpoint` / `s3-sse-encryption` / `s3-sse-kms-key-id` enable and configure the durable S3-compatible object store (see [[Session Persistence]]). Input validation rejects SSRF-vulnerable endpoints (metadata services, private IPs) and enforces HTTPS unless explicitly overridden.
- `session-retention` controls how many sessions to keep before pruning (default: 50).
- `dedup-window` configures the deduplication window in milliseconds (default: 10 minutes).
