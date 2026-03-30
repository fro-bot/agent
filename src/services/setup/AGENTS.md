# SETUP MODULE

**Location:** `src/services/setup/`

Environment bootstrap logic: Bun runtime, OpenCode CLI, and oMo plugin installation. Manages authentication state (Git identity, gh CLI) and tool cache persistence.

## WHERE TO LOOK

| Component      | File                   | Responsibility                                          |
| -------------- | ---------------------- | ------------------------------------------------------- |
| **Setup**      | `setup.ts`             | Orchestration entry point (runSetup) (209 L)            |
| **CI Config**  | `ci-config.ts`         | CI config assembly + Systematic plugin injection (43 L) |
| **Systematic** | `systematic-config.ts` | Systematic config writer (deep-merge) (36 L)            |
| **Adapters**   | `adapters.ts`          | Exec/tool-cache adapter factories (20 L)                |
| **OpenCode**   | `opencode.ts`          | CLI resolution & installation (169 L)                   |
| **Bun**        | `bun.ts`               | Bun runtime setup (required for oMo) (170 L)            |
| **oMo**        | `omo.ts`               | oh-my-openagent install (graceful fail) (120 L)         |
| **oMo Config** | `omo-config.ts`        | Plugin configuration (97 L)                             |
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
| `installBun`            | Function | `bun.ts:77`               | Runtime setup                 |
| `installOmo`            | Function | `omo.ts:56`               | Plugin setup (graceful fail)  |
| `configureGhAuth`       | Function | `gh-auth.ts:7`            | CLI authentication            |
| `populateAuthJson`      | Function | `auth-json.ts:41`         | Secure credentials write      |
| `ensureProjectId`       | Function | `project-id.ts:35`        | Deterministic ID for OpenCode |

## PATTERNS

- **Tool Cache**: `tc.downloadTool` → `tc.extract` → `tc.cacheDir`.
- **Platform Map**: `getPlatformInfo()` maps OS/Arch to release assets.
- **Graceful Fail**: Optional components (oMo, Bun) warn on error, don't crash.
- **Dynamic Version**: Resolves 'latest' via GitHub Releases API.
- **Verification**: Validates binaries (`--version`) BEFORE caching.
- **Systematic Bundling**: `buildCIConfig()` ensures `@fro.bot/systematic@<version>` exists in OpenCode CI plugins.
- `parseOmoProviders` moved to `src/harness/config/omo-providers.ts`.

## SECURITY

- **Permissions**: `auth.json` written with `0o600` (owner-only).
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
pnpm test src/services/setup/   # Run setup-specific tests
```
