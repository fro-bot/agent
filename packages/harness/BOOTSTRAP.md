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

The script detects `NODE_AUTH_TOKEN` and writes a temporary `.npmrc` (chmod 600) inside its own temp work directory, passing it to every `npm publish` call via `--userconfig`. This means the `NODE_AUTH_TOKEN` path works on any machine — no pre-existing `.npmrc` or `actions/setup-node` required. The temp `.npmrc` (which contains the token) is inside the work directory and is removed by the script's `EXIT` trap on both success and failure.

If you prefer not to use `NODE_AUTH_TOKEN`, run `npm login` first and omit the export — the script falls back to ambient npm auth.

The script creates a minimal `package.json` stub for each name, publishes `0.0.0`, and cleans up. The revoke reminder prints via the `EXIT` trap regardless of whether the script succeeds or fails mid-loop.

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

## Step 3 — Validate the pipeline with a dry run (no publish credentials needed)

Before doing any real release, validate that the integrate job, native-build matrix, binary verification, and package assembly all work end-to-end. A dry run with no integration refs configured (stock OpenCode, no LLM-merge patch) does not require `HARNESS_OPENCODE_AUTH_JSON`.

```bash
gh workflow run harness-release.yaml \
  --repo fro-bot/agent \
  --field base_version=1.15.13 \
  --field dry_run=true
```

This triggers the `integrate` job (which produces the merged source artifact), then the full build matrix across all four platforms (linux/x64, linux/arm64, darwin/x64, darwin/arm64), runs `verify-binary.ts` on each output, assembles the per-platform packages, and then **skips the npm publish step** (`dry_run=true`). The publish job is also gated by the `npm-publish` GitHub environment (required reviewers), so even without `dry_run=true`, a human must approve before anything reaches npm.

Watch the run:

```bash
gh run watch --repo fro-bot/agent
```

A green dry run means the build infrastructure is solid and the real `1.15.13` publish will work once the trusted publishers are configured.

---

## Dispatching a real patched release

The dry run above uses a stock OpenCode commit with no LLM-merge patch. A real patched release (the actual point of this package) requires the `HARNESS_OPENCODE_AUTH_JSON` secret to be configured in the repository, because the `integrate` job runs an LLM merge via `opencode run` and needs model credentials.

### Required secret: `HARNESS_OPENCODE_AUTH_JSON`

Add this secret to the `fro-bot/agent` repository (Settings → Secrets and variables → Actions → New repository secret):

- **Name:** `HARNESS_OPENCODE_AUTH_JSON`
- **Value:** A JSON object mapping provider name to auth config, e.g.:
  ```json
  {"anthropic":{"type":"api","key":"sk-ant-..."}}
  ```

The integrate job writes this to a 0600 temp file and passes it to OpenCode as a file-based credential. The secret value is never echoed to logs.

### How a patched release works

When `harness-release.yaml` is dispatched, the workflow runs in two stages:

1. **`integrate` job** — runs `harness integrate`, which clones `anomalyco/opencode` at the configured base version tag, fetches the integration refs listed in `harness.config.json`, and runs an LLM merge to carry those refs onto the tag. On success it extracts a clean merged source snapshot (via `git archive`) — no `.git`, no build products — packages it with `provenance.json`, and uploads the result as the `integration-tree` workflow artifact. The integration commit SHA and artifact digest are emitted as job outputs.

2. **`build` matrix** — each platform job downloads the `integration-tree` artifact, verifies its digest against the declared value, extracts the merged source tree, and builds the native binary from that tree using `build-platform.ts --source-tree <extracted>`. No upstream clone happens in the build matrix; all four platforms build from the same frozen merged source snapshot.

The `publish` job runs after the matrix and is gated by the `npm-publish` GitHub environment (required reviewers). It obtains an OIDC token and publishes to npm with automatic provenance — no npm token.

Merged refs come exclusively from the `harness.config.json` carry-policy allowlist. No arbitrary ref can be injected at dispatch time. The `provenance.json` included in the artifact records the exact upstream inputs (base tag + each ref + resolved SHA) and should be reviewed before approving the publish gate.

### Dry run (no publish credentials needed)

A dry run still works without `HARNESS_OPENCODE_AUTH_JSON` **only if no integration refs are configured** (i.e. a stock OpenCode build). For a patched dry run the secret is still required — the integrate job runs the LLM merge regardless of `dry_run`. The `dry_run=true` flag skips the publish step only; integrate and build always run.

```bash
gh workflow run harness-release.yaml \
  --repo fro-bot/agent \
  --field base_version=1.15.13 \
  --field dry_run=true
```

Watch the run:

```bash
gh run watch --repo fro-bot/agent
```

---

## After bootstrap

Every subsequent release is triggered by dispatching `harness-release.yaml` with the appropriate `base_version` (and `dry_run=true` to skip publish). The `integrate` job derives the integration commit from the LLM merge; the `build` matrix consumes the resulting artifact. The `publish` job obtains an OIDC token from GitHub and publishes to npm with automatic provenance — no npm token, no secrets to rotate beyond `HARNESS_OPENCODE_AUTH_JSON`.
