# SETUP MODULE KNOWLEDGE BASE

**Component:** Environment Bootstrap
**Context:** Pre-agent execution

## OVERVIEW

Bootstraps runtime environment (Bun, OpenCode CLI, oMo plugin). Configures authentication (Git identity, gh CLI) and orchestrates installation via tool cache. Handles platform specifics and graceful degradation for optional components.

## WHERE TO LOOK

| Component   | File           | Responsibility                         |
| :---------- | :------------- | :------------------------------------- |
| **Main**    | `setup.ts`     | Orchestration entry point (`runSetup`) |
| **CLI**     | `opencode.ts`  | OpenCode CLI resolution & installation |
| **Runtime** | `bun.ts`       | Bun runtime setup (required for oMo)   |
| **Plugin**  | `omo.ts`       | oh-my-opencode install (graceful fail) |
| **Auth**    | `gh-auth.ts`   | `gh` CLI auth & Git user identity      |
| **Creds**   | `auth-json.ts` | Temporary `auth.json` generation       |
| **API**     | `index.ts`     | Public exports & type definitions      |

## KEY EXPORTS

```typescript
runSetup(options) // Main orchestration
installOpenCode(version) // CLI install + cache
installBun(version) // Runtime setup
installOmo() // Plugin setup
configureGhAuth(token) // CLI authentication
populateAuthJson(conf) // Secure creds write
```

## PATTERNS

- **Tool Cache**: `tc.downloadTool` → `tc.extract` → `tc.cacheDir`
- **Platform Map**: `getPlatformInfo()` maps OS/Arch to release assets
- **Graceful Fail**: Optional components (oMo) warn on error, don't crash
- **Dynamic Version**: Resolves `latest` via GitHub Releases API
- **Verification**: Validates binaries (`--version`) before caching

## SECURITY

- **Permissions**: `auth.json` written with `0o600` (owner-only)
- **Ephemeral**: Credentials never cached; fresh from secrets
- **Identity**: Git user forced to `${bot}[bot]` for audit trails
- **Isolation**: Binaries cached by version/arch to prevent pollution

## ANTI-PATTERNS

- **Hardcoded Versions**: Always use input or dynamic resolution
- **Fatal Optionality**: Crashing on non-critical install failures
- **Global Install**: Polluting system paths (use tool cache)
- **Log Leaks**: Printing `auth.json` content or tokens
