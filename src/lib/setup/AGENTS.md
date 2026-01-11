# SETUP MODULE

**Overview**: Environment bootstrap for OpenCode + oMo execution (binaries, auth, cache).

## WHERE TO LOOK

| Component         | File           | Responsibility                              |
| ----------------- | -------------- | ------------------------------------------- |
| **Orchestration** | `setup.ts`     | `runSetup()` coordinates all setup phases   |
| **OpenCode**      | `opencode.ts`  | Download, validate, cache CLI binary        |
| **Bun**           | `bun.ts`       | Install Bun runtime (required for oMo)      |
| **oMo**           | `omo.ts`       | Install oMo plugin via `bunx`               |
| **GitHub Auth**   | `gh-auth.ts`   | `gh auth`, git identity configuration       |
| **Credentials**   | `auth-json.ts` | Populate `auth.json` for OpenCode           |
| **Types**         | `types.ts`     | `SetupResult`, `BunInstallResult`, adapters |

## KEY EXPORTS

```typescript
runSetup(options) // Main orchestration
installOpenCode(options) // CLI installation with version resolution
installBun(options) // Bun runtime setup
installOmo(options) // oMo plugin (graceful failure)
configureGhAuth(token) // gh CLI authentication
populateAuthJson(config) // Write credentials with 0o600 permissions
```

## PATTERNS

- **Tool Cache**: Download → validate → extract → `@actions/tool-cache` for reuse
- **Platform Detection**: `getBunPlatformInfo()` / `getPlatformInfo()` map OS/arch to download URLs
- **Graceful Failure**: oMo install failures are logged but don't fail the action
- **Version Resolution**: `getLatestVersion()` fetches from GitHub releases API
- **Validation**: Downloaded binaries verified with `--version` before caching

## SECURITY

- `auth.json` written with `mode: 0o600` (owner read/write only)
- **NEVER** cache `auth.json` - populated fresh each run from secrets
- Credentials deleted via `deleteAuthJson()` before cache save

## ANTI-PATTERNS

| Pattern                               | Why                                              |
| ------------------------------------- | ------------------------------------------------ |
| Caching auth.json                     | Exposes credentials to fork PRs                  |
| Skipping validation                   | Corrupted downloads cause cryptic failures       |
| Hardcoded versions                    | Use `getLatestVersion()` with fallback           |
| Blocking on oMo                       | It's optional; failures shouldn't stop execution |
| Direct `fetch` without error handling | Always check `response.ok`                       |
