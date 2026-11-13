---
type: subsystem
last-updated: "2026-11-08"
updated-by: "f7c20f94"
sources:
  - packages/runtime/src/agent/workspace-config-v2.ts
  - deploy/gateway.Dockerfile
  - tsdown.config.ts
  - src/services/setup/ci-config-v2.ts
  - src/services/setup/mcp-servers-v2.ts
  - src/services/setup/credential-files-v2.ts
  - src/services/setup/plugin-install-v2.ts
  - src/harness/phases/v2-server.ts
  - src/harness/phases/repo-skills.ts
  - src/services/setup/repo-skills.ts
  - src/features/agent/repo-skills-trust.ts
  - packages/runtime/src/agent/server-v2.ts
  - packages/runtime/src/agent/permission-rules-v2.ts
  - packages/runtime/src/agent/permission-gate-v2.ts
  - packages/runtime/src/agent/bundled-skills-dir.ts
  - packages/runtime/src/shared/opencode-v2-pin.json
  - apps/workspace-agent/src/opencode-server-v2.ts
  - apps/workspace-agent/src/opencode-credentials-v2.ts
  - apps/workspace-agent/src/opencode-proxy-v2.ts
  - packages/opencode-plugin/src/index.ts
  - src/harness/config/outputs.ts
  - packages/runtime/src/agent/attachment-dir.ts
  - deploy/scripts/merge-config.mjs
  - deploy/workspace.Dockerfile
  - deploy/workspace-entrypoint.sh
  - deploy/compose.yaml
  - src/services/setup/setup.ts
  - src/services/setup/systematic-config.ts
  - src/services/setup/adapters.ts
  - src/services/setup/opencode.ts
  - src/services/setup/types.ts
  - packages/harness/src/platform.ts
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
  - packages/runtime/src/shared/constants.ts
  - packages/runtime/src/object-store/settings.ts
  - packages/runtime/src/object-store/encryption.ts
  - packages/gateway/src/object-store-config.ts
  - packages/gateway/src/secrets.ts
  - src/shared/constants.ts
  - src/harness/config/inputs.ts
  - src/features/delegated/brokered-push-validation.ts
  - action.yaml
  - RFCs/RFC-011-Setup-Action-Environment-Bootstrap.md
  - RFCs/RFC-019-S3-Storage-Backend.md
  - ARCHITECTURE.md
summary: "Generation-aware tool installation, permission gates, provider credentials, plugins, and tools caching"
---

# Setup and Configuration

The setup module (`src/services/setup/`) bootstraps the CI environment before agent execution can begin. It installs runtime dependencies, configures authentication, assembles the OpenCode configuration, and manages a tools cache to speed up subsequent runs.

Setup runs on every invocation. `ensureOpenCodeAvailable()` in `packages/runtime/src/agent/server.ts` has no shortcut for a binary that is already on the runner, even one that reports the pinned version (a self-hosted runner, or an earlier fro-bot step in the same job, whose `addPath` persists): setup also carries the per-invocation work no existing binary can supply — gh CLI auth, git identity, the Systematic config and the provider keys. A warm runner stays cheap because setup restores the binary from the tools cache with its digest checked. The Action then runs the binary setup provides and exports it as `OPENCODE_PATH`; an operator-set `OPENCODE_PATH` that names something else is replaced, with a warning.

## Installation Sequence

Setup installs OpenCode V2 only: the Action runs the pinned stock release and rejects a V1 `opencode-version` at input parsing. V2's config, plugin installation, and provider-auth steps are described under [OpenCode V2 setup](#opencode-v2-setup). Oh My OpenAgent and oMo Slim inputs and installers have been removed.

The `runSetup()` orchestrator installs OpenCode and the Systematic plugin, assembles the CI configuration, and configures authentication. It installs no other agent framework and no JavaScript runtime.

1. **Parse credentials** — Validates `auth-json` input early to fail fast on bad credentials. The input is a JSON object mapping LLM provider names to their auth configs (e.g., `{"anthropic": {"type": "api", "key": "..."}}`). OpenCode V2, the default, accepts only `type: "api"` entries with a non-empty `key`; anything else fails setup.

2. **Resolve versions** — Determines target versions for OpenCode and Systematic. The `latest` keyword for OpenCode resolves to the recorded stock V2 pin (`resolveRequestedVersion()`) with no network lookup, so it never follows upstream's `releases/latest`.

3. **Restore tools cache** — Checks for a cached bundle of previously installed tools, keyed by OS and the OpenCode and Systematic versions. A cache hit skips download steps entirely. The cache holds only the OpenCode tool-cache and cache directories, never `~/.config/opencode`, so a stale config is never restored.

4. **Install OpenCode CLI** — Downloads the platform-appropriate release binary, extracts it, verifies it (`--version`), and registers it in the GitHub Actions tool cache. The supported matrix is Linux and macOS on x64 or arm64; anything else is rejected by name before a URL is built (see [Platform Support](#platform-support)). The download source depends on whether the target is a stock OpenCode release or a [harness build](#harness-builds) — harness builds are fetched from `fro-bot/agent` releases and verified against a published `SHA256SUMS` manifest.

5. **Build CI config** — Builds the V2 config when the server spawns (`buildCIConfigV2`) and exports no `OPENCODE_CONFIG_CONTENT`; it strips `permission`, `tools`, `autoupdate` and `subagent_depth` from `opencode-config`.

6. **Merge user config** — The operator's `opencode-config` is merged into the V2 config at spawn time, so nothing is written to the checkout or the global config. V2 retains its native plural `plugins` key.

7. **Install plugins** — Runs plugin preparation before caching, gated on either a fresh OpenCode install _or_ a tools-cache miss (see [When the Plugin Install Runs](#when-the-plugin-install-runs)). On V1, a failed Systematic install warns and skips saving the tools cache. On V2, preparing both Systematic and the Fro Bot plugin is required; failure stops setup.

8. **Save tools cache** — If the plugin install ran and succeeded, saves the installed binaries for future runs.

9. **Configure authentication** — Sets up `gh` CLI auth and configures Git identity as `{bot}[bot]` for audit trails. The provider keys are provisioned as external key files at server startup; `auth.json` is never written.

## Pinned Versions

Default versions are defined in `packages/runtime/src/shared/constants.ts` (shared across surfaces) and `src/shared/constants.ts` (action-specific overrides):

| Tool         | Constant                     | Purpose                                  |
| ------------ | ---------------------------- | ---------------------------------------- |
| OpenCode CLI | `DEFAULT_OPENCODE_VERSION`   | The AI coding agent platform             |
| Systematic   | `DEFAULT_SYSTEMATIC_VERSION` | OpenCode plugin for structured workflows |

`systematic-version` can be overridden per run. `opencode-version` accepts only the recorded V2 pin (unset, `latest`, or the exact pin with or without a `v`): any other value fails input parsing, so a binary of another version already on the runner is never used. Stock tool pins are updated via Renovate-managed PRs. The OpenCode default is the stock V2 pin in `opencode-v2-pin.json`: Renovate bumps its `version` and a post-upgrade task regenerates the per-asset digests. A harness release does not change the Action default.

The bundled Systematic default is currently `3.32.0`, shared by V1 and V2. Its pin participates in the tools-cache key, so advancing it triggers a fresh plugin installation even when the OpenCode binary itself is already cached.

Bun is the package manager for this project's own workspace, not a tool the Action installs. Every workflow in this repository gets its Bun from the root `package.json` `packageManager` field through `.github/actions/setup`, which fails the job if the installed Bun differs from it.

`DEFAULT_OPENCODE_VERSION` is the **stock OpenCode V2 pin** (currently `2.2.6`), read from `packages/runtime/src/shared/opencode-v2-pin.json`, which records the version and each release asset's SHA-256. Installation requires both the recorded digest and the release's `SHA256SUMS` line to match. The build checks that the version and digests survive bundling (`tsdown.config.ts`). `latest` selects this same recorded pin without an upstream lookup.

The Action no longer runs V1. A V1 `opencode-version` (a stock 1.x version or a `+harness.`/`-harness.` build) fails input parsing with an error that names the input and the value, and so does any V2 version other than the pin. To keep running V1, pin the Action to its last pre-cut release, `fro-bot/agent@v0.137.0`, and set `opencode-version` to the final V1 harness build `1.19.5+harness.bf7f7dfe`. A V1 run cannot see sessions created on V2, and a later V2 run keeps its own copy; nothing reconciles the two. The gateway and the workspace image are V2-only too; to roll back past the cut, redeploy the previous image pair from GHCR.

## OpenCode V2 setup

### Binary and plugin preparation

`src/services/setup/opencode.ts` verifies stock V2 archives against the asset digests recorded in `packages/runtime/src/shared/opencode-v2-pin.json`. An unrecorded V2 version or missing digest fails closed, as does a mismatched download; V2 does not silently fall back to a V1 binary. Linux uses tar archives and macOS uses zip archives; the workspace image selects the matching Linux musl asset.

V2 installs both Systematic and `@fro.bot/opencode-plugin` (`0.1.0`). The latter supplies the four session-history tools and the subagent-session reuse guard. `plugin-install-v2.ts` performs bounded preparation outside the real session database. `src/harness/phases/v2-server.ts` checks both exact plugin specs before every spawn, even when a preinstalled matching binary skipped setup. A warm plugin cache makes this a cheap check; a missing plugin uses the bounded installer before the shorter server-readiness deadline begins. Unlike V1's advisory Systematic install, failed V2 preparation or an inactive required plugin prevents execution.

### Provider credentials and restored state

The Action narrows `auth-json` to supported API-key entries and writes each key to its own owner-only file outside cached paths (`credential-files-v2.ts`). Configuration refers to those files through `{file:...}` rather than embedding key bytes. The provided file reference wins over an inline operator key for the same provider while preserving its other settings. Stale `auth.json` is removed before spawn so V2's legacy migration cannot import provider secrets into the database that will later be cached.

Held execution claims from a killed invocation are cleared in the restored database before the server starts. After spawn, a provider credential gate checks the effective model's provider, or the supplied providers when no model selects one. It accepts configured authentication references or a reported connection without reading secret values. Startup then waits for V1 history import to complete before any prompt; [[Session Persistence]] explains that migration barrier.

### Effective configuration and permissions

The Action also denies the native `websearch` action on V2; the workspace policy does not add that CI-specific deny. These tool rules steer the model's available actions, not the filesystem or network security boundary: an allowed shell can exercise the permissions and egress the process actually has.

V2 uses `plugins`, an ordered top-level `permissions` list, `update: disable`, and `experimental.subagent_depth: 1` (`permission-rules-v2.ts`). These are generation-specific spellings, not the V1 config shape. The Action strips operator permission/tool overrides from top-level and agent maps before assembling the harness rules, and disables project-config loading at spawn.

Outside-checkout access defaults to deny in CI. Exceptions name the run-attempt response and attachment directories, an eligible integration work directory, and the installed Systematic skills directory. Secret-shaped reads and edits are denied while `.env.example` remains accessible. `question`, session moves, and worktree creation are denied. The post-spawn permission gate inspects effective per-agent rules, so writing an intended config alone cannot establish readiness.

The bundled-skills exception fixes a precedence problem shared with V1: a catch-all outside-directory deny could shadow OpenCode's own skill grant, leaving a loaded skill unable to read its references or execute its scripts. The resolver admits only the exact installed version's `@fro.bot/systematic/skills` directory, including the newest installed V2 generation directory. It grants neither the entire package cache nor arbitrary symlink destinations. Edit tools are denied there, but this is not filesystem read-only protection: shell commands can still write within an allowed external directory. A missing resolution warns and adds no grant.

### Caller MCP servers

On credential-withheld triggers, `buildCIConfigV2` rejects `{env:...}` references anywhere in the operator configuration before MCP filtering. Upstream substitutes environment values into config text before parsing, so even an allowlisted but attacker-influenced environment value could otherwise add JSON structure after the harness checked it. This whole-config rejection is distinct from the non-fatal per-server filtering below.

`opencode-config` `mcp` reaches V2 through `mcp-servers-v2.ts`, which `buildCIConfigV2` calls before it builds the permission rules. V2 2.2.5 reads two spellings, the legacy `mcp.<name>` map and the native `mcp.servers.<name>` map; both parse into one typed list (`local` with `command`/`cwd`/`environment`, `remote` with `url`/`headers`/`oauth`), and a bad shape fails setup with an error that names the server and field but never a value. The config is not rewritten into one spelling, because the native server schema (`disabled`, a `timeout` object, snake_case `oauth`) is not something the harness can read from the pinned source; entries pass through as authored. A server literally named `servers` or `timeout` is a server only when its value has `type`, the same rule upstream applies.

The Action adds no permission rule for a configured server. On stock 2.2.5 the `build`, `general`, `plan` and `compaction` agents already allow `*`, so a server's tools run without an ask for them; `explore`, `title` and `summary` deny `*` and stay without those tools, which keeps `explore` read-only. Configured `permissions` apply to every agent, so an allow rule could not have been scoped to one agent. Upstream names each tool `<server>_<tool>` with every character outside `[a-zA-Z0-9_-]` replaced by `_` (`tool/mcp.ts`); `mcpToolNamespace` mirrors that, a test pins it, and the parse rejects two servers that sanitize to one name. With Code Mode on (the default), the tools reach the model through the `execute` tool as `tools.<server>.<tool>(...)`.

On a credential-withheld trigger (`resolveResponseDelivery`, the `pull_request`, `issue_comment` and `issues` events) untrusted text drives the model, so only static local MCP servers run. `applyOperatorMcpV2` filters `mcp` server by server, in both spellings, and keeps a server only when its `type` is the literal `local` and no `{file:` or `{env:` opening appears anywhere in its original definition: the server name, every known field and every nested or unknown key or string. Everything else is dropped: all `remote` servers, any server with a reference, any malformed entry, a non-literal `type`, and servers whose names sanitize to one tool prefix. A kept server is passed through as authored, in the spelling it was written in, and a literal `environment` is allowed. A literal `mcp.timeout` block stays when a server is kept. When no server is kept, the `mcp` key is removed. The helper logs the kept servers (info) and the dropped servers (warning) by sanitized, bounded name and never a value. A block whose layout cannot be read is removed whole, and the withheld path never fails setup. The filter exists because OpenCode substitutes `{file:...}` and `{env:...}` in `OPENCODE_CONFIG_CONTENT` as text before it parses it (`core/src/config/variable.ts`), so a header value, a query string, a `mcp.timeout` block with a substituted `type` or a name can resolve to something the harness never inspected, and the default agent allows every MCP tool. For the same reason a top-level operator key whose own name carries a `{file:}` reference is removed on those runs, since it could resolve to `mcp`; that check is on the top-level key names only, not recursive. A kept server is trusted operator code, not a sandbox: its command comes from the workflow config and its definition reaches a process the checkout controls, so operators must not put secrets in the command, its arguments or a literal `environment`. The child environment is unchanged (`filterAgentEnv(process.env)` plus the server keys), and fork pull requests remain the caller's restriction. The substituted file content is JSON-escaped (`variable.ts`, `JSON.stringify(...).slice(1, -1)`), so a `{file:}` reference inside a string cannot add structure. The `{env:}` pass is different: it splices the raw value first and escapes only when that fails to parse (`variable.ts:27-37`), so an attacker-influenced allowlisted value (a branch name in `GITHUB_HEAD_REF`, say) could inject JSON after the Action's strips. So on a withheld run `buildCIConfigV2` fails setup, before anything else, if the operator's `opencode-config` contains `{env:` in a key, a value or a nested string (checked on the serialized object, case-sensitively, as upstream matches it); the error names the rule and the trigger and echoes no value. This check runs first, so a server with `{env:` fails setup instead of being dropped; the server-by-server drop of `{env:` applies to the helper only. The check reads only the operator's input; the Action's own generated config uses `{file:}` references alone. Provisioned runs are unchanged.

On a provisioned run `mcp` passes through after validation. The parser checks what the 2.2.5 source shows: the legacy server schema in full, `mcp.timeout` as a positive integer or an object of positive integers, and for native entries the fields both spellings share. Native-only fields (`protocol`, the snake_case `oauth` keys) pass through because the native schema is not in the readable source. A string field that holds a `{env:}` or `{file:}` reference also passes without a format check, because the server substitutes it before it reads the config: a whole-value `url` reference is accepted, a literal `url` still needs to be http(s), and a referenced `type` parses as a server of unresolved kind whose launch fields are not checked. Structure (`command` an array, `environment` and `headers` maps) is still checked as written. The credential disposition comes from `cache-restore.ts` to `startActionOpenCodeV2` to `buildCIConfigV2` as a required input. The V1 path is unchanged: it passes `mcp` through without validation or trigger rules.

### Server and workspace boundary

V2 workspace provisioning does not create `auth.json` and removes a stale one. Credentials are supplied through the authenticated per-spawn API instead, avoiding an unused secret-bearing file in the agent's home. `workspace-config-v2.ts` sets the per-location idle timeout to ten minutes rather than upstream's sixty, releasing idle location memory without changing the gateway's completion gate.

The runtime images separate tool needs as well. `deploy/gateway.Dockerfile` removes npm, Yarn, and Corepack because the daemon needs no package manager. `deploy/workspace.Dockerfile` supplies the verified Bun binary and npm/npx `12.2.2` for agent tasks, replacing the base image's npm tree and removing Yarn and Corepack. This image provisioning is separate from Action setup, which installs no JavaScript runtime.

`packages/runtime/src/agent/server-v2.ts` runs `serve --stdio` with held stdin, an explicit loopback port, a per-spawn Basic credential, and a scrubbed child environment. Readiness includes the agent endpoint and an active-plugin check, followed by the surface's permission and credential gates. Shutdown interrupts remaining sessions, closes stdin, and confirms process exit; [[Background Subagents and Ownership]] explains the directory-release check that precedes it.

A V2 workspace uses a fresh database for every spawn rather than restoring Action memory. Its supervisor provisions API keys over authenticated loopback `POST /api/credential`, then verifies the required provider before reporting ready (`apps/workspace-agent/src/opencode-credentials-v2.ts`). A fresh database skips the legacy auth import, so merely writing `auth.json` would leave it unauthenticated. Keys are not put in argv, environment, or config content on this path.

The workspace proxy translates the gateway bearer to the current spawn's Basic credential and forwards only `V2_GATEWAY_ROUTES`; credential enumeration never reaches the gateway-facing surface. Between spawns it returns unavailable instead of reusing a stale password. The image's baked `WORKSPACE_IMAGE_OPENCODE_VERSION` is reported on readiness and selects the gateway's matching loop. Plugins are baked at image-build time, and the supervisor preserves the unprivileged process identity described below.

## Harness Builds

The Action no longer installs patched harness builds. OpenCode is consumed only as the stock upstream V2 release recorded in `opencode-v2-pin.json`. Historical harness releases (`<base>-harness.<sha>` tags in the `fro-bot/agent` release namespace, final build `1.19.5+harness.bf7f7dfe`) stay published, and the `+harness` tag filters in the release tooling stay in place so product-version discovery keeps ignoring them. A harness or stock V1 `opencode-version` fails input parsing (`parseOpenCodeVersion`); there is no download attempt.

## Platform Support

The action runs on Linux and macOS, on x64 or arm64 — four combinations, and no others. `getPlatformInfo()` in `src/services/setup/opencode.ts` now asserts that matrix up front and throws a message naming the offending `platform/arch` pair, rather than mapping unknown values onto plausible-looking defaults.

The earlier shape used lookup tables with fallbacks: an unrecognized platform silently became `linux`, an unrecognized architecture silently became `x64`. That was survivable while the default OpenCode version was a stock upstream release, because upstream publishes a broader asset matrix. It stopped being survivable once the default became a [harness build](#harness-builds), which publishes only `linux`/`darwin` × `x64`/`arm64` (`packages/harness/src/platform.ts`). On Windows the fallback produced a request for an asset that is never published, and the run failed several layers down with a 404 that said nothing about the platform. On an unsupported architecture the failure was worse than opaque — the arch fallback resolved to the x64 asset, so the download _succeeded_ and the binary failed to execute later, at a point far removed from the cause.

Gating both halves in one place means the error names the real problem at the moment it is knowable. It also removed the Windows-shaped branches that existed downstream: archive-extension selection no longer special-cases `.zip` for Windows, and download validation no longer skips the `file(1)` check on a platform that can no longer be reached.

## The Install Directory and the Executable

Two different strings describe an OpenCode install, and conflating them caused a cluster of `EACCES` failures worth understanding as one story.

`installOpenCode()` returns a **directory** — that is what `@actions/tool-cache`'s `cacheDir`/`find` return, and it is what `core.addPath()` expects to receive. But several consumers need an **executable path** to hand to a child process: the Systematic plugin install spawns OpenCode directly, `@fro.bot/harness`'s `resolveBinary()` reads `OPENCODE_PATH` as a binary, and every child that inherits the environment sees `OPENCODE_PATH` too (the deny-by-default env filter lets the `OPENCODE_` prefix through). Passing the directory to any of those spawns it, which fails with `EACCES` because a directory is not executable.

The fix is a single helper, `opencodeBinaryPath()`, that owns the on-disk layout and is the only place allowed to turn an install directory into an executable path. `SetupResult` now carries both values as separately documented fields — `opencodePath` (the directory, consumed by `addPath` and reported as the `opencode-path` output) and `opencodeBinaryPath` (the executable, used by anything that spawns). `ensureOpenCodeAvailable()` in `packages/runtime/src/agent/server.ts` deliberately takes different halves for different purposes and logs both, on the reasoning that the entire failure mode was "which of these two strings got exported", so a recurrence should be diagnosable from the run log alone.

## When the Plugin Install Runs

The plugin install (`installPluginsV2`) runs unless `arePluginsCachedV2` finds both exact-version plugins already in the cache home. The tools cache is saved after the install, and also on a tools-cache miss. A tools-cache hit whose binary has gone missing falls through to a fresh OpenCode install, so the plugins are checked again. A failed or timed-out plugin install fails startup with a named error: the server would otherwise install the plugins at boot with no bound, or skip one that failed to load.

## Configuration Assembly

`buildCIConfigV2` (`src/services/setup/ci-config-v2.ts`) builds the server config when the server spawns. It is passed to the server at start and never written to disk. The ordered permissions, effective-rule verification, `update: disable` and `experimental.subagent_depth: 1` are described under [OpenCode V2 setup](#opencode-v2-setup). The operator's `opencode-config` is merged in, with `permission`, `tools`, `autoupdate` and `subagent_depth` stripped with a warning. Existing local `opencode.json` files are ignored.

### Workspace identity and control API

The deployed workspace splits authority between the service and the model-driven process. The workspace-agent retains the privileges needed for protected clone staging, journals, and network fetches; the OpenCode process and its tools run as an unprivileged account. On startup the entrypoint migrates existing root-owned checkouts through a symlink-aware filesystem handoff, while protected secrets and state remain under root-owned paths (`deploy/workspace-entrypoint.sh`, `deploy/compose.yaml`). Fresh clones are handed off before agent execution. This keeps the checkout writable by the agent without giving it ownership of the credential and maintenance directories.

The same bearer used by the gateway to attach to the OpenCode proxy on port 9200 also protects the workspace control API on port 9100. Clone, inspect, update, recovery, and backup routes check it before parsing request bodies; only health and readiness are unauthenticated (`apps/workspace-agent/src/server.ts`). Without that boundary, an agent tool running inside the container could call the loopback control API to mutate its own checkout outside the gateway's admission path. [[Architecture Overview]] describes how the gateway and workspace divide checkout preparation.

### Server-start task-reuse guard

The `@fro.bot/opencode-plugin` guard rejects a `subagent` call that carries a `sessionID`, so each background job has its own child session, on the Action and on the workspace (loaded from the config content the workspace agent passes at spawn).

## Tools Cache

The setup module maintains its own cache (separate from the session cache) for installed binaries. It restricts cached paths to OpenCode tooling (the tool-cache directory and the OpenCode cache directory), so no stale configuration is restored.

The key:

```text
opencode-tools-v2-{os}-oc-{opencodeVersion}-sys-{systematicVersion}
```

Advancing either version produces a new key and a fresh install. V2 also qualifies the tools key with the recorded binary digest identity and Fro Bot plugin version, preventing reuse of an older verified asset or guard/session-tools bundle.

On a cache hit, the module verifies the binary is actually present in the tool cache before trusting it — cache hits where the binary is missing fall through to a fresh install. The lookup uses the tool-cache-safe form of the version (see [Harness Builds](#harness-builds)), so a harness build never reuses a stock binary's cache entry. This cache typically saves 10-20 seconds per run.

A denied tools-cache write is now surfaced as a failure rather than swallowed. When the cache backend rejects a save — for example because the run holds a read-only cache token — the module reports it instead of pretending the save succeeded, so a silently non-persisting tools cache cannot masquerade as a healthy one. The same read-only-token discipline applies to the session cache; see [[Session Persistence]].

## Security

Credentials are handled with care:

- **Provider authentication** uses owner-only key files referenced by config on the Action, and loopback credential provisioning on the workspace. Credentials are regenerated from secrets, outside the session transport.
- **Git identity** is forced to `{bot}[bot]` so commits made by the agent have a clear audit trail.

### GitHub credential disposition

The GitHub token the agent might use to post is provisioned **conditionally**, driven by the response-delivery decision computed in [[Execution Lifecycle|bootstrap]]. On comment and review flows (`issue_comment`, `pull_request`, `issues`) the credential is **withheld** — `configureGhAuth()` skips setting `GH_TOKEN`, skips writing the `gh` `hosts.yml`, and clears any ambient `GH_CONFIG_DIR` from earlier workflow steps. The rationale is that on those flows the action posts the agent's answer itself (the file-convention delivery path), so the model has no legitimate need to call `gh`, and the credential is kept out of the agent's environment, `gh` config and prompt. A preflight check (`git-credential-check.ts`) additionally asserts that no persisted git credential is present in the _effective_ git config for the workspace — local, global, system, worktree-scoped, or anything pulled in via `include`/`includeIf` — plus the `origin` remote URL, on these flows, which is why consumers are asked to check out with `persist-credentials: false`. Because the check reads global and system scope too, a credential planted anywhere on the runner (not just this checkout) is caught — but on a reused, non-ephemeral runner that also means a global/system config planted by an earlier job stays visible to every later job until the runner is recycled. The check has two narrow fail-open exceptions — no git binary, and a workspace that is not a git repository at all — and both are compatibility exemptions, not proof a credential is absent: they mean part of the check could not run, not that it ran and found nothing. Autonomous flows (`schedule`, `workflow_dispatch`) keep the credential provisioned, because they legitimately create branches, commits, and PRs on their own.

When a same-repo PR comment produces workspace edits, the action still needs a way to land them despite withholding the token — this is what the [[Execution Lifecycle|brokered push]] step provides. It commits on the model's behalf through the action's own Octokit client, so the write is gated by trusted event facts and a path allowlist (`brokered-push-validation.ts`) rather than by handing the agent a credential. Keeping `persist-credentials: false` remains essential: it ensures the withheld token has no residual copy in `.git/config` that a same-user shell inside the agent could read.

### Withholding is not an OS boundary

Withholding stops accidental exposure and casual authenticated use. On its own it does not stop deliberate extraction. The action's own process receives `github-token` as `INPUT_GITHUB-TOKEN`, and the agent runs as the same user on the same machine. On GitHub-hosted Linux runners, a process the agent starts can read that token from the action process's `/proc/<pid>/environ`. Deleting the variable in Node does not remove it from the process's initial environment, and the runner's `ptrace_scope` does not block the read ([#2135](https://github.com/fro-bot/agent/issues/2135)). The same applies on every trigger, and very likely to `ACTIONS_RUNTIME_TOKEN`.

#### `isolate-agent`: run the agent as its own user

> Supported setup: a published `fro-bot/agent@<ref>` on a GitHub-hosted Linux runner, nothing else. A run from a real published install has been checked end to end; the integration job covers the boundary itself on every PR.

Set `isolate-agent: true` (default `false`) and the Action runs the OpenCode server, and everything it starts, as a throwaway local user on the runner. The Action creates the account, hands it only the paths it needs (the checkout, the response directory, the provider key files, the session storage and the `gh` config directory when the trigger provisions one), launches the server through `sudo` and `setpriv` with no supplementary groups, no capabilities and `no_new_privs`, and removes the account at the end.

The checkout must not carry persisted credentials: `actions/checkout` must run with `persist-credentials: false`, because the agent user can read `.git/config`. The Action checks this on every trigger when the input is on and fails the run before setup if it finds one.

Only a published install is supported: `fro-bot/agent@<ref>`, which GitHub downloads to `<work>/_actions/<owner>/<repo>/<ref>/` (a ref may contain `/`). The runner reloads `action.yaml` and opens `dist/post.js` by path at post time, as itself, so the whole install must be immutable to the agent. The preflight therefore requires, before anything is set up, that the path the runner started the Action from (`GITHUB_ACTION_PATH`, the script path) lies under `_actions/<owner>/<repo>/<ref>` of the runner's work directory (taken from `RUNNER_TEMP`, not assumed), that every component from the work directory down to `dist/` is a real directory with no symlink (checked with `lstat`, one component at a time), that the manifest and `dist/main.js` and `dist/post.js` are regular files, and that the running bundle is the one the runner started. `GITHUB_ACTION_REPOSITORY` must also be set, as provenance only. A local `uses: ./`, an alias to an install, a directory named `..action`, or a symlink anywhere on the way all fail the run with `use a published fro-bot/agent@<ref>`. If it cannot tell how the Action was started, it fails closed. `_actions` is also a reserved subtree: handoff refuses any grant (checkout, XDG directories, temp, response and key directories, skills) that equals it, contains it or lies under it.

Writable checkout content stays untrusted for later steps of the same workflow job: anything the agent wrote there (scripts, a `.github` directory, hooks) can still be run by a step that trusts it. Take-back makes the files the runner's own; it does not make them safe to execute. Provisioned credentials (the `gh` config in provision mode) and the provider key stay readable by the model.

Setup time: on a cold hosted runner the first `useradd` can sit in uninterruptible disk wait for a long time (99 s was measured; later calls take about a second), so an isolated run can spend up to about 2 minutes on account setup. The account-creation step is allowed 180 s, logs at info when it takes more than 10 s, and, if it does time out, leaves the account in place and ends the run `unsafe` instead of removing it.

Requirements: a GitHub-hosted Linux runner, not running as root or in a container job, passwordless `sudo`, `setpriv`/`setfacl`/`useradd`/`userdel`/`pkill`/`pgrep`/`find` present, and `fs.protected_hardlinks`/`fs.protected_symlinks` on. Any miss fails the run before setup with the failed check named. Self-hosted runners are unsupported even if they report a hosted environment, and so are two isolated steps in one job at the same time.

Blocked from the agent's shell: the Action's `/proc/<pid>/environ` and its ancestors' (which hold `INPUT_GITHUB-TOKEN`), `$GITHUB_ENV` and `$GITHUB_OUTPUT`, private directories under `RUNNER_TEMP`, the runner's home (default-deny, with only the granted paths opened), `sudo` and the Docker socket.

Still visible to the agent, by design: the provider key file and `OPENCODE_PASSWORD` (the server and its tools share one user), the checkout and prompt data, credentials the trigger provisions on purpose (the `gh` config in provision mode, and any token a checkout step left in `.git/config` with `persist-credentials`), world-readable system files, and unrestricted network egress. A separate tool user that hides the provider key and server password is a later phase.

After the agent stops, the Action kills every process of the sandbox user and verifies none remain, then takes ownership of everything the sandbox wrote and restores the checkout's `.git/config`, `config.worktree`, `hooks/` and `info/` from a pre-agent copy. Runner-side git then runs with `core.fsmonitor` and hooks disabled and a replaced environment. Reads of the response file, session data and logs refuse symlinks and non-regular files. A `.git` that is not a plain directory, or any `.git/commondir` (which would redirect git's config and objects somewhere the restore does not reach), is refused at handoff and at take-back; at take-back it makes the release unsafe, and no runner-side git runs. The pre-run metadata the restore trusts (`config`, `config.worktree`, `hooks/`, `info/`) must contain no symlink or special file, and its config may hold only the keys `actions/checkout` writes: `core.{repositoryformatversion,filemode,bare,logallrefupdates,ignorecase,precomposeunicode,symlinks}`, `extensions.worktreeConfig`, `remote.<n>.{url,fetch,promisor,partialclonefilter}` (a `url` naming a transport helper such as `ext::` is refused), `branch.<n>.{remote,merge}`, `gc.auto`, `safe.directory`, `lfs.repositoryformatversion` (written once git-lfs is installed system-wide, as on the hosted images) and the sparse-checkout booleans `core.sparsecheckout`, `core.sparsecheckoutcone` and `index.sparse` (left in `config.worktree` by `git sparse-checkout disable`). Git itself parses the copy (`git config --file <copy> --list --null --no-includes`); any other key, including `include`, `includeIf`, filters, diff and merge drivers, aliases, `core.hooksPath`, `core.attributesFile`, `core.excludesFile`, `core.fsmonitor`, credential and `http.*` settings and submodules, fails the handoff and is named. A checkout that needs other keys is outside the supported baseline; that includes `actions/checkout` with `lfs: true`, which installs the LFS filter and hooks into the local config. If the stop cannot be confirmed or the take-back is unsafe, the run fails, publishes nothing and saves no session state, and the post hook never retries the save. Every privileged command runs under a deadline (take-back gets 120 seconds in total) and is killed when it overruns, which also ends as unsafe. On `SIGINT` or `SIGTERM` the Action stops the sandbox and attempts the take-back, within about ten seconds, before exiting. After an unsafe release, or when the main step died before it finished the teardown, nothing in the sandbox-writable log directory is read or uploaded: the Action records the teardown state (`pending` before the account exists, `restored` only after a confirmed stop and take-back, `unsafe` otherwise) and the post hook uploads logs, artifacts included, only for `restored`. A signal that arrives during account creation or handoff waits for that step, then tears down what was really built.

Without `isolate-agent`, keep write credentials out of the job that runs the agent:

- Give the agent job a read-only token, minimal `permissions:`, and `persist-credentials: false` on checkout.
- Set `response-mode: none` so the agent job never tries to post with the read-only token. With the default `github`, comment, issue and PR runs still publish the response and fail when the token can't write.
- Have the agent write its output (a patch, a PR or issue request, a comment body) to files and upload them as an artifact. Use `output-mode: working-dir` for code changes.
- Publish from a separate job on a fresh runner. That job mints the write token, runs only trusted default-branch code, validates the handoff (paths, size, target repository and branch, no force updates) and never executes model output.

Treat everything the agent produces as untrusted, including restored session state.

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
- `isolate-agent` (default `false`) runs the OpenCode server and its tools as a separate local user on GitHub-hosted Linux runners with passwordless `sudo`, from a published `fro-bot/agent@<ref>`; any other runner or install fails the run before setup. See [Withholding is not an OS boundary](#withholding-is-not-an-os-boundary).
- `repo-skills` (default `false`, OpenCode V2 only) loads the repository's `.agents/skills` on trusted runs while project config stays disabled. Trust is an allow list, not the credential disposition: `schedule` and `workflow_dispatch`, or `pull_request`, `issue_comment` and `issues` from an `OWNER`, `MEMBER` or `COLLABORATOR`, with PR-scoped events also requiring the head repository to equal the run's repository (a maintainer commenting on a fork PR is denied, as is anything with missing facts). Every eligible run reads the default branch, fetched fresh from the base repository into a throwaway repository and written to disk as raw stored blobs with `git cat-file --batch` (never `git archive`, which would apply committed `.gitattributes` such as `export-subst` and expand a blob past the budget); the checkout, a dispatched branch and a PR head are never a source, and no ref or config in the checkout is read. The fetched tree is listed from raw `-z` bytes with a strict UTF-8 decode and refused if any path is invalid UTF-8, duplicated (case- and normalization-folded), or both a file and a directory; symlinks are never written to disk (a skill that contains one is rejected by id at admission). It is then checked against a budget (1000 entries, 5 MiB, 6 directories deep, no submodules) before anything is extracted. An admission filter copies only real `<id>/SKILL.md` directories into a run-scoped directory under `RUNNER_TEMP`, publishing each skill by rename only once its copy is complete: symlinks reject the skill, size and file count are bounded, and a skill whose directory name collides with a bundled Systematic skill or an OpenCode built-in is skipped (OpenCode keys skills by directory name; the frontmatter `name` is display text). The copy is named in `skills.paths`, gets the bundled-skills `external_directory` allow and `edit` deny, and is removed when the run ends. See `src/services/setup/repo-skills.ts` and `src/features/agent/repo-skills-trust.ts`.
- `model` overrides the LLM model in `provider/model` format.
- `timeout` controls the execution timeout (default: 30 minutes, 0 for no limit).
- `s3-backup` / `s3-bucket` / `aws-region` / `s3-endpoint` / `s3-prefix` / `s3-expected-bucket-owner` / `s3-allow-insecure-endpoint` / `s3-sse-encryption` / `s3-sse-kms-key-id` enable and configure the durable S3-compatible object store (see [[Session Persistence]]). Input validation always rejects these metadata targets: `169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`, their IPv4-mapped and translated forms, and `metadata.google.internal`. It also rejects loopback, private, link-local, unspecified, CGNAT, and documentation addresses unless `s3-allow-insecure-endpoint` is `true`. It enforces HTTPS unless that flag is set. Known limits: hostnames are not DNS-resolved, and NAT64, IPv4-compatible IPv6, the benchmarking range `198.18.0.0/15`, `.internal` and `.local` names, and the bare single-label name `metadata` are not classified.
- `session-retention` controls how many sessions to keep before pruning (default: 50).
- `dedup-window` configures the deduplication window in milliseconds (default: 10 minutes).

## Action Outputs

| Output | Description |
| --- | --- |
| `cache-status` | Cache restore status (`hit`, `miss`, `corrupted`) |
| `cache-save-result` | Cache save outcome (`durable`, `store-only`, `skipped`, `declined-for-safety`, `not-persisted`); set from the main step — the post-action retry reports only to the job summary |
| `invocation-outcome` | The run's final verified outcome (`succeeded`, `incomplete`, `failed`, `skipped`). `incomplete` means a useful result may exist but this invocation could not certify completion, so no dedup marker was written and no success reaction was posted (see [[Execution Lifecycle]]). Main step only |

See the full outputs table in the repository [README](../../README.md#outputs).

## Shared Object-Store Settings

The Action maps its `s3-*` inputs into `parseObjectStoreSettings` (`packages/runtime/src/object-store/settings.ts`), the same pure parser the gateway and binding backfill use. Values are trimmed, blank values count as unset, prefixes are normalized, and validation errors name the setting source rather than echoing its value. Enabled stores require a bucket; the Action leaves region optional for SDK resolution, while gateway configuration requires a region and accepts `AWS_REGION` as a fallback to `S3_REGION`.

Expected bucket owners must contain exactly 12 decimal digits. A KMS key is accepted only when effective encryption is `aws:kms`; AWS endpoints default to that mode, while custom endpoints default to `AES256`. An invalid explicit SSE mode is rejected even when the store is disabled. Endpoint and metadata-address restrictions remain those described under Action Inputs and [[Session Persistence]].

The gateway reads environment and `_FILE` settings before calling the parser (`packages/gateway/src/object-store-config.ts`, `secrets.ts`). A blank S3 setting file falls back to the corresponding environment variable; this is specific to S3 settings, not the general secret convention. Credentials are read separately and never enter the shared settings parser.

## Implementation Reference

Symbol-level reference for mechanisms that [ARCHITECTURE.md](../../ARCHITECTURE.md) summarizes under Cross-Cutting Concerns.

### OpenCode Question Tool Disabled (Action)

Nobody can answer an interactive `question` in a CI run, and a pending question has no server-side timeout, so a model that called the tool held the run until the execution deadline (#1756). The Action denies the native `question` action in its effective V2 permissions (`buildPermissionRulesV2`) and cancels any form request that still reaches the CI stream; the gateway retains its human-answerable form flow.

### Workspace UID Isolation (Service vs. Agent)

The workspace container runs two identities. The workspace-agent **service** (`apps/workspace-agent/src/main.ts`) stays root (uid 0) because it hands checkouts to the agent and supervises its processes, but `deploy/compose.yaml` drops every capability except `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`, sets `no-new-privileges`, and disables core dumps. **OpenCode and everything it spawns** run as the unprivileged `opencode` account (`AGENT_UID`/`AGENT_GID` `10001`). `apps/workspace-agent/src/identity.ts` is the single source of truth for the uid/gid, the agent home and XDG tree (`/home/opencode`), the separate `SERVICE_HOME` (`/var/lib/workspace-agent/home`), the root-owned state/staging directory names, and the absolute `OPENCODE_EXECUTABLE_PATH`; `deploy/workspace.Dockerfile` creates the account and directories with the same values, so change both together.

- **OpenCode launch.** The spawn goes through `startOpenCodeV2Server` (`apps/workspace-agent/src/opencode-server-v2.ts`): absolute executable path (never resolved through `PATH`), agent uid/gid, and an environment _constructed_ from an allowlist by `buildOpencodeV2Env` — agent home/XDG/`TMPDIR`, a fixed `PATH`, proxy, CA bundle, locale, and `OPENCODE_*` flags only. `WORKSPACE_*` settings, secret-file paths, tokens, and `GIT_*`/loader overrides cannot reach the child by construction, not by filtering. The service binds its control ports before OpenCode starts so the agent cannot race it for them.
- **Clone and handoff.** `executeClone` (`apps/workspace-agent/src/clone.ts`) clones into root-owned staging (`/workspace/repos/.workspace-agent/staging/`, `0700`, on the same volume), resolves and validates HEAD while the tree is still root's, hands every entry to the agent via `handOffToAgent` (`apps/workspace-agent/src/handoff.ts` — `lstat`/`lchown` only, never follows a symlink, never crosses `st_dev`, fails the clone on a hardlink, bounded by deadline and entry cap), then publishes with a single `rename`. Staging is emptied on every failure path. Clone runs under the shared per-repo mutex (`apps/workspace-agent/src/repo-mutex.ts`) and refuses with `journal-in-progress` (409) before touching anything when `apps/workspace-agent/src/journal.ts` reports an outstanding journal for the repo — found or `malformed`, never treated as absent. The only git that runs as root with credentials is the clone itself, in staging; the `repo-exists` check and post-rename race-check run as the agent through `apps/workspace-agent/src/git-safety.ts`.
- **Control-API auth.** `/clone` and `/inspect` on `:9100` require `Authorization: Bearer <WORKSPACE_OPENCODE_TOKEN>` — the same root-only secret the `:9200` OpenCode proxy uses — so the agent uid cannot call the control API over loopback. `createApp` (`apps/workspace-agent/src/server.ts`) takes a required `auth` discriminated union with no default; the check runs before body parsing, compares constant-time (length-guarded `timingSafeEqual`), and returns a fixed 401. The gateway sends the bearer from `createWorkspaceClient` (`packages/gateway/src/workspace-api/client.ts`); roll the gateway and workspace images together, since a token mismatch rejects every clone.
- **Checkout-update primitives.** Credentialed fetches run only against a root-owned bare mirror under the state directory's `fetch/` store (`FETCH_STORE_DIR_NAME` in `apps/workspace-agent/src/identity.ts`); objects cross into the agent-owned checkout only as a `pack-objects --stdout | index-pack --stdin --strict` stream (`runPackStream`, `apps/workspace-agent/src/git-stream.ts`), never by local fetch or alternates. Admission checks against an existing checkout — config inventory, layout, temp-index cleanliness, path-obstruction preflight — live in `apps/workspace-agent/src/checkout-profile.ts` and run as the agent through the network/local-update git profiles in `apps/workspace-agent/src/git-safety.ts`. The egress proxy and CA bundle `/update`'s network half needs are read once at startup (`readUpdateNetworkConfig`, `apps/workspace-agent/src/config.ts`), never re-read per call. Adversarial real-git fixtures live in `apps/workspace-agent/src/update-fixtures/`.
- **Per-repo mutex and maintenance hold.** `apps/workspace-agent/src/repo-mutex.ts` serializes every mutating operation on a repository — clone, update, recovery, backup delete — through one in-process `withRepoLock`; different repositories never contend. When a subprocess's termination cannot be confirmed within its reap-grace window (SIGKILL sent, exit never observed), `markRepoHeld` sets a sticky, in-process maintenance hold on that repository: every later mutating call refuses with `maintenance-hold` rather than risk two operations touching the same on-disk state. The hold clears ONLY on a workspace restart — never a timer, never a later successful operation — because the workspace is always exactly one container (a documented precondition of the #1661 migration, enforced by `deploy/validate-stack.sh`'s `workspace.deploy.replicas` check) and a restart is the only event that can actually guarantee a leaked subprocess is gone.
- **Journals and startup reconciliation.** Every in-flight update or recovery mutation is journaled root-owned under the state directory's `journals/` store (`JOURNAL_DIR_NAME`, `apps/workspace-agent/src/journal.ts`), one file per repository, written temp-file-and-rename — never inside `.git/`, where the agent could forge one. A read that finds a file but cannot parse it reports `malformed`, never `absent`. `main.ts` reconciles every outstanding journal on service start (bounded by `JOURNAL_RECONCILE_TIMEOUT_MS`), and `/update`/`/recover` reconcile again at the top of each operation before anything else: an update journal stuck at `applying` marks the checkout needs-recovery; a recovery journal is resolved forward from wherever it stopped, never by deleting the quarantined original or cloning into the empty path.
- **Recovery and backups.** `POST /recover/preview` (`previewRecovery`) is stateless — no server-side operation id — and returns a `fingerprint` digesting HEAD SHA, dirty counts, and checkout size/entry count; `POST /recover` (`executeRecovery`) recomputes the fingerprint under the repo lock and refuses with `checkout-changed` if it differs. A confirmed recovery preserves the WHOLE existing checkout by `rename` into a root-owned quarantine envelope `<quarantine>/<owner>__<repo>/<id>/{checkout/, metadata.json}` (`QUARANTINE_DIR_NAME`, `apps/workspace-agent/src/backups.ts`) — never stash, commit, or discard — then installs a fresh checkout built entirely as root in root-owned staging (`git init`, pack import, `read-tree --reset -u`, `update-ref`, canonical origin config) before handoff and rename; `read-tree --reset` never runs against an agent-owned checkout. Retention is capped at 5 generations and 10 GiB per repository (`RETENTION_MAX_GENERATIONS`/`RETENTION_MAX_BYTES`, `apps/workspace-agent/src/recover.ts`) with no automatic eviction — at the cap, recovery refuses before moving anything. `GET`/`DELETE /backups/:owner/:repo[/:id]` (`listBackups`/`deleteBackup`, `apps/workspace-agent/src/backups.ts`) list and remove one generation at a time; there is no export and no bulk delete.
- **Agent-uid size walker.** `runAgentWalk` (`apps/workspace-agent/src/agent-walk.ts`) measures a checkout or quarantine generation's size and entry count as the agent uid via a spawned child; when that plain walk is incomplete or fails, `measureSealedTree`/`measureSealedTreeFromFd` fall back to measuring the same sealed tree through a root-opened file descriptor, so the service never has to traverse an agent-owned directory by path.
- **Private-repo auth.** The installation token reaches git only through a `GIT_ASKPASS` helper that exact-matches git's literal `https://github.com` prompts and exits non-zero otherwise, with global/system git config sealed and `GIT_ALLOW_PROTOCOL=https`.
- **Directory ownership.** `/workspace/repos` and each owner directory stay root-owned, so the agent can edit a checkout but cannot replace where it lives. Secrets and the raw mitmproxy CA mount under the root-only `/run/workspace-agent/` tmpfs; only the installed public trust bundle is readable by both identities.
- **Entrypoint.** `deploy/workspace-entrypoint.sh` creates the protected state directory (`deploy/scripts/ensure-protected-dir.mjs`), migrates legacy root-owned checkouts to the agent uid (`deploy/scripts/migrate-repo-ownership.mjs` — filesystem-only, symlink/hardlink-safe, per-checkout completion markers, bounded by `WORKSPACE_MIGRATION_DEADLINE_MS`, refuses to start on timeout, never deletes), and writes OpenCode's merged config (and, on V1 images only, its `auth.json`; a V2 image writes none and removes a stale one) from a process already running as the agent, fed via stdin (`deploy/scripts/provision-agent-config.mjs`) — root never writes into an agent-owned directory, where a planted symlink would turn into a privileged write.
- **Verification.** Kernel permission boundaries cannot be proven by unit tests: `deploy/tests/isolation-harness.sh` starts the image exactly as compose does and pairs each attempted violation as the agent (reading service home/secrets/env/memory, replacing a checkout parent, taking a control port) with the same operation succeeding as root. `deploy/validate-stack.sh` requires the service identity, the exact capability set, `no-new-privileges`, and the protected mount locations; `deploy/egress-smoke.sh` and the CI image smoke run with production's user, capabilities, and mount layout. CI also builds the `workspace-test` target of `deploy/workspace.Dockerfile` and runs the workspace-agent suite inside it, so the git fixtures exercise the image's own Alpine git.

### Systematic Plugin Install (Setup-Time, Not Server-Boot)

`installPluginsV2` (`src/services/setup/plugin-install-v2.ts`) installs `@fro.bot/systematic` and `@fro.bot/opencode-plugin` at exact versions during setup, before the server starts and before the tools cache is saved, each under its own time bound. This keeps the install out of the server's boot path and into the on-disk cache directory the server reads.
