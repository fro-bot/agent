# @fro.bot/harness — First-Publish Bootstrap Runbook

This runbook covers the one-time steps required to claim the five `@fro.bot/harness*` package names on npm and wire up OIDC trusted publishing. Once this is done, every subsequent release runs tokenless via GitHub Actions — no npm token ever again. The `@fro.bot` scope already exists (it hosts `@fro.bot/systematic`), so org creation and membership are already handled.

---

## Prerequisites

- npm account is a member of the `@fro.bot` org with publish rights.
- npm CLI >= 11.5.0 installed locally (required for trusted publishing; also used by the bootstrap script for consistency).
- `gh` CLI authenticated to `fro-bot/agent` (needed for Step 3).

---

## Step 1 — Claim the 5 package names with stubs (one-time, token)

npm's trusted publishing (OIDC) requires a package to **already exist** before a trusted publisher can be attached. I publish a throwaway `0.0.0` stub for each of the five names to claim them, then immediately revoke the token. The real workflow overwrites these stubs at `1.15.13`.

### 1a. Generate a granular access token

1. Go to [npmjs.com → Access Tokens → Generate New Token → Granular Access Token](https://www.npmjs.com/settings/~/tokens/granular-access-tokens/new).
2. Set:
   - **Expiration**: 1 day (or the shortest available — this token is revoked immediately after use).
   - **Packages and scopes**: Read and write, scoped to these five packages:
     - `@fro.bot/harness`
     - `@fro.bot/harness-linux-x64`
     - `@fro.bot/harness-linux-arm64`
     - `@fro.bot/harness-darwin-x64`
     - `@fro.bot/harness-darwin-arm64`
   - **Organizations**: `fro-bot` (read-only is fine here).
3. Copy the token.

### 1b. Run the bootstrap script

```bash
export NODE_AUTH_TOKEN=<paste-token-here>
bash packages/harness/scripts/bootstrap-publish.sh
```

The script creates a minimal `package.json` stub for each name, publishes `0.0.0`, and cleans up. It prints a reminder to revoke the token when done.

### 1c. Revoke the token immediately

Back on npmjs.com → Access Tokens, delete the token you just used. It has served its only purpose.

> **Why stubs?** The 4 platform packages (`@fro.bot/harness-linux-*`, `@fro.bot/harness-darwin-*`) are not local directories — the release workflow assembles them at publish time from native binaries built on per-platform CI runners. There is no way to build a linux/arm64 binary locally on a macOS arm64 machine. Publishing `0.0.0` stubs claims the names without needing real binaries. The real workflow publishes `1.15.13` (a higher version) and overwrites them cleanly.

---

## Step 2 — Configure trusted publishing on all 5 packages (one-time, UI)

For **each** of the five packages, configure GitHub Actions as a trusted publisher so the release workflow can publish without a token.

Go to: `https://www.npmjs.com/package/<package-name>` → **Settings** → **Trusted publishing** → **Add a publisher** → **GitHub Actions**

Use these exact values for all five:

| Field                | Value                  |
| -------------------- | ---------------------- |
| Organization or user | `fro-bot`              |
| Repository           | `agent`                |
| Workflow filename    | `harness-release.yaml` |
| Environment          | _(leave blank)_        |

Repeat for each package:

1. `@fro.bot/harness`
2. `@fro.bot/harness-linux-x64`
3. `@fro.bot/harness-linux-arm64`
4. `@fro.bot/harness-darwin-x64`
5. `@fro.bot/harness-darwin-arm64`

> **Note on environment**: The publish job in `harness-release.yaml` uses `environment: npm-publish` (a maintainer-gated GitHub environment). Leave the trusted publisher environment field blank on npm — the OIDC token is issued by GitHub regardless of which environment the job runs in; the environment gate is enforced on the GitHub side.

---

## Step 3 — Validate the pipeline with a dry run (no LLM merge, no token)

Before doing any real release, validate that the native-build matrix, binary verification, and package assembly all work end-to-end. This dry run uses a real upstream OpenCode commit (no LLM-merge patch applied) so `build-platform.ts` can clone it directly from `anomalyco/opencode`.

```bash
gh workflow run harness-release.yaml \
  --repo fro-bot/agent \
  --field integration_commit=385cb694419f98103af0e8fc6187ddcbcbb6eecb \
  --field base_version=1.15.13 \
  --field dry_run=true
```

This triggers the full build matrix across all four platforms (linux/x64, linux/arm64, darwin/x64, darwin/arm64), runs `verify-binary.ts` on each output, assembles the per-platform packages, and then **skips the npm publish step** (`dry_run=true`). The publish job is also gated by the `npm-publish` GitHub environment (required reviewers), so even without `dry_run=true`, a human must approve before anything reaches npm.

Watch the run:

```bash
gh run watch --repo fro-bot/agent
```

A green dry run means the build infrastructure is solid and the real `1.15.13` publish will work once the trusted publishers are configured.

---

## What's still blocked — a real patched release

The dry run above uses a stock OpenCode commit with no LLM-merge patch. A real patched release (the actual point of this package) needs an **integrate→build bridge** that doesn't exist yet:

- `packages/harness/scripts/build-platform.ts` clones `anomalyco/opencode` and checks out the integration commit.
- The LLM-merge integration commit only exists locally after `harness integrate` runs — it is never pushed anywhere `build-platform.ts` can reach.
- The fix is a `fro-bot/opencode` mirror repo wired into the workflow: the integrate runner pushes the frozen integration commit there, and `build-platform.ts` clones from `fro-bot/opencode` instead of `anomalyco/opencode`.

This is separate, larger work. Until that bridge exists, the workflow can build and publish stock OpenCode at any upstream tag, but cannot publish a patched build.

---

## After bootstrap

Every subsequent release is triggered by dispatching `harness-release.yaml` (or pushing a `harness-v*` tag) with the appropriate `integration_commit` and `base_version`. The publish job obtains an OIDC token from GitHub and publishes to npm with automatic provenance — no npm token, no secrets to rotate.
