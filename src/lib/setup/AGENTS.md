# SETUP KNOWLEDGE BASE

**Generated:** 2026-01-29
**Location:** `src/lib/setup/`

## OVERVIEW

Environment bootstrap logic: Bun runtime, OpenCode CLI, and oMo plugin installation. Manages authentication state (Git identity, gh CLI) and tool cache persistence.

## STRUCTURE

```
./
├── setup.ts       # Orchestration entry point (runSetup)
├── opencode.ts    # OpenCode CLI resolution & installation
├── bun.ts         # Bun runtime setup (required for oMo)
├── omo.ts         # oh-my-opencode install (graceful fail)
├── gh-auth.ts     # gh CLI auth & Git user identity
├── auth-json.ts   # Temporary auth.json generation
├── project-id.ts  # Deterministic project ID generation
├── types.ts       # Setup-specific types & interfaces
└── index.ts       # Public exports
```

## CODE MAP

| Symbol             | Type     | Location           | Role                          |
| ------------------ | -------- | ------------------ | ----------------------------- |
| `runSetup`         | Function | `setup.ts:124`     | Main orchestration            |
| `installOpenCode`  | Function | `opencode.ts:87`   | CLI install + cache           |
| `installBun`       | Function | `bun.ts:77`        | Runtime setup                 |
| `installOmo`       | Function | `omo.ts:56`        | Plugin setup (graceful fail)  |
| `configureGhAuth`  | Function | `gh-auth.ts:7`     | CLI authentication            |
| `populateAuthJson` | Function | `auth-json.ts:41`  | Secure credentials write      |
| `ensureProjectId`  | Function | `project-id.ts:35` | Deterministic ID for OpenCode |

## PATTERNS

- **Tool Cache**: `tc.downloadTool` → `tc.extract` → `tc.cacheDir`.
- **Platform Map**: `getPlatformInfo()` maps OS/Arch to release assets.
- **Graceful Fail**: Optional components (oMo, Bun) warn on error, don't crash.
- **Dynamic Version**: Resolves 'latest' via GitHub Releases API.
- **Verification**: Validates binaries (`--version`) BEFORE caching.

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
pnpm test src/lib/setup/   # Run setup-specific tests
```
