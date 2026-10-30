# @fro.bot/opencode-plugin: First-Publish Bootstrap Runbook

One-time steps to claim the `@fro.bot/opencode-plugin` name on npm and attach GitHub Actions as its trusted publisher. After this, every release runs tokenless from `.github/workflows/opencode-plugin-release.yaml`. The `@fro.bot` scope already exists, so org setup is done. This is the same stub-then-trusted-publisher flow as [`packages/harness/BOOTSTRAP.md`](../harness/BOOTSTRAP.md), for one package.

## Prerequisites

- An npm account in the `@fro.bot` org with publish rights.
- npm CLI 11.5.0 or newer locally.

## Step 1: Claim the name with a stub (one-time, token)

npm needs a package to exist before a trusted publisher can be attached to it.

1. On npmjs.com, generate a granular access token: read and write, scoped to `@fro.bot/opencode-plugin` only, with the shortest expiry available.
2. Publish a throwaway `0.0.0` stub from a scratch directory:

   ```bash
   export NODE_AUTH_TOKEN=<token>
   work="$(mktemp -d)" && cd "$work"
   printf '%s\n' '{"name":"@fro.bot/opencode-plugin","version":"0.0.0","description":"Name claim; the real release is published by CI.","license":"MIT","publishConfig":{"access":"public"}}' > package.json
   printf '%s\n' "//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}" > .npmrc
   npm publish --tag bootstrap
   ```

   `--tag bootstrap` keeps the stub off `latest`.

3. Delete the token on npmjs.com right away. Remove the scratch directory.

## Step 2: Attach the trusted publisher (one-time, UI)

On `https://www.npmjs.com/package/@fro.bot/opencode-plugin` open Settings, then Trusted publishing, then Add a publisher, then GitHub Actions:

| Field                | Value                          |
| -------------------- | ------------------------------ |
| Organization or user | `fro-bot`                      |
| Repository           | `agent`                        |
| Workflow filename    | `opencode-plugin-release.yaml` |
| Environment          | _(leave blank)_                |

The publish job runs without a GitHub `environment:`, so the OIDC `sub` claim carries no environment segment. Leave the field blank on npm.

## Step 3: Validate with a dry run

A dry run runs the gates, build, bundle check and pack, and skips the publish:

```bash
gh workflow run opencode-plugin-release.yaml --repo fro-bot/agent --field version=0.1.0 --field dry_run=true
gh run watch --repo fro-bot/agent
```

## Releasing

Dispatch the workflow with a version and `dry_run=false`:

```bash
gh workflow run opencode-plugin-release.yaml --repo fro-bot/agent --field version=<version> --field dry_run=false
```

A version with a prerelease suffix is published under the `next` dist-tag and never moves `latest`.

After the first real publish, pin that exact version in `packages/runtime/src/shared/constants.ts` (next to `DEFAULT_SYSTEMATIC_VERSION`) so the surfaces install it.
