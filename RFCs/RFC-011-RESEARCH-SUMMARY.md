# RFC-011 Research Summary

**Date:** 2025-01-04
**Status:** Research Complete
**Purpose:** Document findings, gaps, and spikes from RFC-011 review

---

## Executive Summary

RFC-011 (Setup Action & Environment Bootstrap) is **largely correct** but requires updates to address gaps discovered through research into the oMo Sisyphus workflow, OpenCode SDK, and RFC dependencies.

### Key Decision: RESOLVED

**RFC-003 already provides `createAppClient()` for GitHub App authentication.**

The function at `src/lib/github/client.ts:63-93` implements:

- Takes `appId`, `privateKey`, `installationId?`
- Dynamic imports `@octokit/auth-app` (avoids bundling when not needed)
- Returns `Octokit | null` (null on failure or missing credentials)
- Proper error handling with logging

**Decision:** RFC-011 uses RFC-003's `createAppClient()` directly. `GITHUB_TOKEN` fallback remains for graceful degradation when:

1. App credentials not provided (optional configuration)
2. App authentication fails (network/permission issues)
3. Read-only operations (commenting doesn't require elevated permissions)

---

## Research Sources

| Source | Method | Key Findings |
| --- | --- | --- |
| oMo Sisyphus Workflow | GitHub fetch via librarian | Version fallback, download validation, stdbuf, provider config |
| OpenCode SDK | Official docs + source | `@opencode-ai/sdk` provides programmatic control, still spawns CLI |
| oh-my-opencode package.json | GitHub fetch | Bun-targeted, cannot be direct dependency, use npx/bunx |
| Existing codebase | explore agent | Uses Result<T,E> pattern, function-based, Logger with redaction |
| RFC dependencies | Full RFC read | 7 conflicts identified, phase ordering issues |

---

## Gaps in RFC-011

### Critical Gaps (Must Fix Before Implementation)

| Gap | Current State | Required Change |
| --- | --- | --- |
| **Version fallback** | Single version attempt | Add fallback: latest → pinned version on failure |
| **Download validation** | None | Add `file` command check for corruption |
| ~~**App token generation**~~ | ~~Placeholder returns `""`~~ | ~~Implement or defer to RFC-006~~ **RESOLVED: Use RFC-003's `createAppClient()`** |
| **stdbuf documentation** | Mentioned but not specified | Document exact command: `stdbuf -oL -eL opencode run "$PROMPT"` |

### Medium Priority Gaps

| Gap                       | Current State   | Required Change                                            |
| ------------------------- | --------------- | ---------------------------------------------------------- |
| Provider config injection | Not covered     | Add optional `opencode.json` custom provider config        |
| oMo config injection      | Not covered     | Add optional `oh-my-opencode.json` `prompt_append` support |
| oMo failure handling      | Silent continue | Fail setup or document that agent will fail at runtime     |
| Event context extraction  | Returns nulls   | Move to main action (RFC-005), not setup                   |

### Low Priority Gaps

| Gap                   | Current State | Required Change                                         |
| --------------------- | ------------- | ------------------------------------------------------- |
| Bun vs Node runtime   | RFC uses Node | Document that oh-my-opencode works with npx in Node env |
| Local plugin override | Not covered   | Not needed for production (only dev workflow)           |

---

## Conflicts Between RFCs

### Conflict 1: Dual auth.json Handling

**Problem:** Both RFC-006 and RFC-011 write auth.json with identical logic.

**Files affected:**

- RFC-006: `writeAuthJson()` (lines 406-454)
- RFC-011: `populateAuthJson()` (lines 436-449)

**Resolution:** RFC-011 should call RFC-006's function when available, or RFC-006 should import from RFC-011.

**Recommendation:** Since RFC-011 is Phase 1 and RFC-006 is Phase 2, RFC-011 owns auth.json writing. RFC-006 should import from RFC-011.

### Conflict 2: Phase Ordering - RESOLVED

**Original Problem:** RFC-011 needs App token generation but RFC-006 is Phase 2.

**Resolution:** RFC-003 (Phase 1) already provides `createAppClient()` at `src/lib/github/client.ts`. RFC-011 imports and uses it directly. No phase reordering needed.

### Conflict 3: Session Tools Assumed Before RFC-004

**Problem:** RFC-011 agent prompt includes session tool instructions:

```
Use `session_search` to find relevant prior sessions
Use `session_read` to review prior work
```

But RFC-004 (Session Management) is Phase 2.

**Resolution:** These instructions document oMo plugin capabilities, not our implementation. The oMo plugin provides these tools when installed. RFC-011 is correct but should clarify this dependency.

---

## SDK vs CLI Decision

### OpenCode SDK (`@opencode-ai/sdk`)

**Advantages:**

- Type-safe API
- Structured session management (`session.create()`, `session.list()`, etc.)
- Persistent server (start once, reuse)
- SSE streaming for real-time output

**Disadvantages:**

- Still spawns CLI binary internally (`opencode serve`)
- More setup code (server lifecycle)
- Additional dependency

### CLI (`opencode run`)

**Advantages:**

- Simpler integration
- Each run is isolated
- Proven in Sisyphus workflow

**Disadvantages:**

- Process overhead per invocation
- Output parsing required
- Less type safety

### Recommendation

**Use CLI for v1.** The Sisyphus workflow proves CLI works. SDK benefits (type safety, persistent server) are valuable but not critical for initial release. Consider SDK for v2 when session management (RFC-004) needs tighter integration.

---

## oh-my-opencode Integration

### Key Finding: Cannot Be Direct Dependency

From package.json analysis:

- **Build target:** Bun (`--target bun`), not Node.js
- **Native bindings:** `@ast-grep/napi` requires platform-specific compilation
- **License:** SUL-1.0 (non-standard)
- **Heavy deps:** MCP SDK, Hono, Zod v4

### Correct Integration

RFC-011's current approach is correct:

```typescript
await exec.exec("npx", ["oh-my-opencode", "install"])
```

This runs oMo as a CLI tool, not as an imported library. No changes needed.

---

## Sisyphus Workflow Patterns to Adopt

### 1. Version Fallback

```bash
# From Sisyphus workflow
if ! bash /tmp/opencode-install.sh 2>&1; then
  echo "Default installer failed, trying with pinned version..."
  bash /tmp/opencode-install.sh --version 1.0.204
fi
```

**RFC-011 change:** Update `installOpenCode()` to accept fallback version:

```typescript
export async function installOpenCode(
  version: string,
  fallbackVersion: string,
  logger: Logger,
): Promise<OpenCodeInstallResult>
```

### 2. Download Validation

```bash
# From Sisyphus workflow
if file /tmp/opencode-install.sh | grep -q "shell script\|text"; then
  # proceed
else
  echo "Download corrupted..."
fi
```

**RFC-011 change:** Add validation after download:

```typescript
async function validateDownload(path: string): Promise<boolean>
```

### 3. stdbuf Execution

```bash
# From Sisyphus workflow
stdbuf -oL -eL bun run dist/cli/index.js run "$PROMPT"
```

**RFC-011 change:** Document in "Real-time Log Streaming Requirement" section that the main action (not setup) must use this pattern.

### 4. Non-Fatal GitHub Operations

```bash
# From Sisyphus workflow
gh api .../reactions -X POST -f content="eyes" || true
```

**Already documented:** RFC-011 Appendix shows `try/catch` with warning logs.

---

## Implementation Spikes

### Spike 1: OpenCode Tool Cache Integration

**Question:** Does `@actions/tool-cache` work for OpenCode binary caching across runs?

**Investigation needed:**

- Verify download URL format matches `tc.downloadTool` expectations
- Test extraction of `.tar.gz` and `.zip` formats
- Confirm cache key includes version and arch

**Estimated effort:** 2 hours

### Spike 2: oMo Plugin Installation Verification

**Question:** How to verify oMo plugin installed successfully?

**Investigation needed:**

- Check if `opencode --list-plugins` or similar exists
- Check if config file is written on success
- Define fallback if verification not possible

**Estimated effort:** 1 hour

### Spike 3: GitHub App Token Generation - RESOLVED

**Resolution:** RFC-003's `createAppClient()` already implements this using `@octokit/auth-app` with dynamic import. RFC-011 uses it directly.

No spike needed.

---

## Recommended RFC-011 Updates

### Section Updates

| Section                    | Change                                                   |
| -------------------------- | -------------------------------------------------------- |
| 4. OpenCode Installation   | Add fallback version parameter, add download validation  |
| 5. oMo Plugin Installation | Add installation verification, document failure behavior |
| 9. Setup Entry Point       | Handle optional App token gracefully, add error states   |
| Real-time Log Streaming    | Add explicit command example with stdbuf                 |
| Dependencies               | Add note about RFC-006 optional dependency for App token |

### New Acceptance Criteria

Add to existing criteria:

- [ ] OpenCode installation has fallback to pinned version
- [ ] Downloaded archives are validated before extraction
- [ ] Setup continues if oMo install fails (with warning)
- [ ] Setup works without GitHub App credentials (fallback to GITHUB_TOKEN)
- [ ] stdbuf command documented with exact syntax

---

## Updated Phase Assignment Recommendation

### Current (from RFCS.md)

| Phase | RFCs                               |
| ----- | ---------------------------------- |
| 1     | RFC-001, RFC-002, RFC-003, RFC-011 |
| 2     | RFC-004, RFC-005, RFC-006, RFC-007 |
| 3     | RFC-008, RFC-009, RFC-010          |

### Recommended (no change needed)

The current phase assignment works if:

1. RFC-011 ships without mandatory GitHub App support
2. App support is added when RFC-006 lands in Phase 2

No RFCS.md update required.

---

## Next Steps

1. **Apply RFC-011 updates** based on this research
2. **Update AGENTS.md** to reflect RFC-011 research status
3. **Create implementation tickets** for spikes
4. **Begin TDD implementation** of RFC-011 after updates

---

## Appendix: Research Agent Results

### oMo Sisyphus Workflow (bg_0dc179a3)

- Environment variables and secrets mapped
- CLI flags documented
- Setup sequence identified
- Fallback patterns extracted

### OpenCode SDK (bg_0adda3c2)

- SDK methods for session management documented
- Prompt passing approach clarified
- SDK vs CLI tradeoffs analyzed

### oh-my-opencode Package (bg_b688d583)

- Dependency structure analyzed
- Runtime compatibility assessed
- Integration strategy confirmed (npx, not import)

### Existing Codebase Patterns (bg_48ed5e51)

- Architecture mapped
- Shared component inventory created
- Build configuration analyzed

### RFC Dependencies (bg_58b62cc6)

- All 11 RFCs read and cross-referenced
- 7 conflicts/gaps identified
- Phase ordering validated
