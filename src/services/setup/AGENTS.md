# SETUP MODULE

**Location:** `src/services/setup/`

Environment bootstrap logic: OpenCode CLI and Systematic plugin installation. Manages authentication state (Git identity, gh CLI) and tool cache persistence.

## WHERE TO LOOK

| Component      | File                   | Responsibility                                          |
| -------------- | ---------------------- | ------------------------------------------------------- |
| **Setup**      | `setup.ts`             | Orchestration entry point (runSetup) (209 L)            |
| **CI Config**  | `ci-config.ts`         | CI config assembly + Systematic plugin injection (43 L) |
| **Systematic** | `systematic-config.ts` | Systematic config writer (deep-merge) (36 L)            |
| **Reuse guard**| `no-task-reuse-config.ts` | Writes the task-reuse guard plugin; builds its `file://` spec and the server config that carries it |
| **Adapters**   | `adapters.ts`          | Exec/tool-cache adapter factories (20 L)                |
| **OpenCode**   | `opencode.ts`          | CLI resolution & installation (169 L)                   |
| **Deep merge** | `deep-merge.ts`        | Plain-object deep merge used for Systematic config      |
| **GH Auth**    | `gh-auth.ts`           | gh CLI auth & Git user identity (101 L)                 |
| **Auth JSON**  | `auth-json.ts`         | Temporary auth.json generation (70 L)                   |
| **Project ID** | `project-id.ts`        | Deterministic project ID generation (121 L)             |
| **Cache**      | `tools-cache.ts`       | Low-level tool cache operations (142 L)                 |
| **Types**      | `types.ts`             | Setup-specific types & interfaces (152 L)               |

## CODE MAP

| Symbol                  | Type     | Location                  | Role                          |
| ----------------------- | -------- | ------------------------- | ----------------------------- |
| `runSetup`              | Function | `setup.ts:22`             | Main orchestration            |
| `buildCIConfig`         | Function | `ci-config.ts:8`          | Build OPENCODE_CONFIG_CONTENT |
| `writeSystematicConfig` | Function | `systematic-config.ts:12` | Write merged systematic.json  |
| `installOpenCode`       | Function | `opencode.ts:87`          | CLI install + cache           |
| `configureGhAuth`       | Function | `gh-auth.ts:7`            | CLI authentication            |
| `populateAuthJson`      | Function | `auth-json.ts:41`         | Secure credentials write      |
| `ensureProjectId`       | Function | `project-id.ts:35`        | Deterministic ID for OpenCode |

## PATTERNS

- **Tool Cache**: `tc.downloadTool` → `tc.extract` → `tc.cacheDir`.
- **Platform Gate**: `getPlatformInfo()` maps OS/Arch to release assets, and rejects anything outside linux/darwin × x64/arm64 by name. It is the first thing `installOpenCode` calls, before the tool-cache lookup and outside the stock-fallback `try`, so an unsupported platform fails as itself rather than as a download 404 or a binary that cannot execute.
- **Graceful Fail**: Optional components (Systematic config) warn on error, don't crash.
- **Dynamic Version**: Resolves 'latest' via GitHub Releases API.
- **Verification**: Validates binaries (`--version`) BEFORE caching.
- **Systematic Bundling**: `buildCIConfig()` ensures `@fro.bot/systematic@<version>` exists in OpenCode CI plugins.
- **Task-reuse guard (fail-closed)**: `writeNoTaskReuseFile` copies `dist/no-task-reuse.js` (built from `deploy/plugins/no-task-reuse.mjs`, the same file the gateway image bakes) to `<configDir>/fro-bot/no-task-reuse.mjs`, and `taskReuseGuardServerConfig` builds `{plugin: [file:// URL]}`. Both are used by the Action's server-start choke point (`bootstrapOpenCodeServer`, `src/features/agent/server-adapter.ts`), NOT by setup or `buildCIConfig`: the guard rides the SDK's `OPENCODE_CONFIG_CONTENT` layer, which loads after every user/project/global file and cannot be dropped by them, so no user config file is read or edited and setup never lists the guard (one channel; a preinstalled OpenCode that skips setup is guarded too). It rejects any `task` call with a truthy `task_id`, so a background dispatch can never reuse a settled child session (#1757). If the file cannot be written, no server starts. Keep the file out of `<configDir>/plugin(s)/` (OpenCode auto-scans those). `<configDir>` is `$XDG_CONFIG_HOME/opencode` (else `~/.config/opencode`), the directory the server reads. Boundary on model behavior, not a sandbox: earlier-layer plugins still load before it, and `OPENCODE_PURE` would skip it (denied by `filterAgentEnv`; setup warns).

## SECURITY

- **Permissions**: `auth.json` written with `0o600` (owner-only).
- **Bundled skills directory (#2009)**: the build agent's `external_directory` is `'*': deny` plus the response and attachment dirs, which shadows the allow OpenCode adds for each skill directory (last matching rule wins). Setup re-allows exactly the installed `@fro.bot/systematic@<version>/node_modules/@fro.bot/systematic/skills/*` after the deny, in the build block and the global block (`ci-config.ts`; V1 resolves it after the Systematic install, from `XDG_CACHE_HOME` else `~/.cache`; V2 resolves the newest generation directory in `opencode/npm/<spec>/`, `v2-server.ts`). Not the package, not the cache, not another version, and nothing for `@fro.bot/opencode-plugin` (it ships no skills). Unresolved: warn and add nothing. `external_directory` is **not read-only**: the agent can also write inside that directory during its run. The `edit` permission is denied for it (V1: an anchored `*/opencode/packages/<spec>/…/skills/*` pattern, because edit, write and apply_patch ask with a worktree-relative path; V2: the absolute path), but `bash` is not an `edit` request, so a shell write still lands. On a hosted runner the tools cache is saved during setup, before the agent runs, so that write does not persist; a persistent or self-hosted runner keeps it. A `systematic` plugin entry in the operator's `opencode-config` at a version other than `systematic-version` gets no allow.
- **Plugin switches**: `OPENCODE_PURE` makes OpenCode skip every external plugin (the reuse guard and Systematic). `filterAgentEnv` denies it for the server child and setup warns when it is set; keep it in the deny-set.
- **Ephemeral**: Credentials never cached; fresh from secrets each run.
- **Identity**: Git user forced to `${bot}[bot]` for audit trails.
- **Isolation**: Binaries cached by version/arch to prevent pollution.

## ANTI-PATTERNS

- **Hardcoded versions**: Always use input or dynamic resolution.
- **Fatal optionality**: Don't crash on non-critical failures.
- **Global install**: Pollutes system paths; use tool-cache.
- **Log leaks**: Never print `auth.json` or tokens.

## COMMANDS

```bash
bun run test src/services/setup/   # Run setup-specific tests
```
