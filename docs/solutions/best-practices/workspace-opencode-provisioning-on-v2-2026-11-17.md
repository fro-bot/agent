---
title: How the workspace container gets its OpenCode config, provider key and plugins
date: 2026-11-17
category: best-practices
module: workspace
problem_type: architecture_pattern
component: configuration
severity: medium
applies_when:
  - Changing how the workspace image or entrypoint provisions OpenCode
  - Adding a provider, a model or an operator config overlay to the workspace container
  - Adding or changing a plugin the workspace server loads
  - Reading `docker logs` to see why the mention loop has no model or no credential
tags:
  - opencode-v2
  - workspace
  - provider-keys
  - config-overlay
  - plugins
  - credential-gate
  - entrypoint
---

# How the workspace container gets its OpenCode config, provider key and plugins

## Context

The workspace image runs stock OpenCode V2 only. `deploy/workspace.Dockerfile` has a `version-gate` stage that refuses any version other than the one in `packages/runtime/src/shared/opencode-v2-pin.json`.

A mention turn needs a model with provider config, a provider key and two plugins. The image bakes none of them. Each one takes a different route to the server, and a reader who treats them as one file gets it wrong.

## Guidance

1. **Config is the only thing the entrypoint writes.** Step 5 of `deploy/workspace-entrypoint.sh` runs `deploy/scripts/provision-agent-config.mjs` as uid 10001 through `setpriv`, with `env -i` and an allowlist (model, overlay, `PATH`, `HOME`, `XDG_*`). `mergeConfig` in `deploy/scripts/merge-config.mjs` merges three inputs and `provisionAgentConfig` writes `$XDG_CONFIG_HOME/opencode/opencode.json` (mode 0644, under the 0700 agent home):
   - the base `/usr/local/share/fro-bot/opencode.base.json`, which the Dockerfile bakes as `$schema` plus `"update": "disable"`, with no plugin and no model;
   - `WORKSPACE_OPENCODE_CONFIG`, a JSON object spread over the base;
   - `WORKSPACE_OPENCODE_MODEL`, a `provider/model` string that wins when it is not blank.

   Both variables are non-secret operator config. Set a provider endpoint in the overlay as `provider.<id>.options.baseURL`.

2. **Never write `auth.json`.** V2 reads it only in a legacy import that a fresh per-spawn database skips (`apps/workspace-agent/src/opencode-credentials-v2.ts`). `provisionAgentConfig` removes a stale one and fails the boot if it cannot.

3. **The provider key takes this path:**
   - The operator secret is mounted at `/run/workspace-agent/secrets/workspace_opencode_auth` (`WORKSPACE_OPENCODE_AUTH_FILE`), inside the root-owned 0700 tmpfs `/run/workspace-agent`.
   - The entrypoint, as root, only validates it with `deploy/scripts/validate-auth.mjs`: an object of `{"type":"api","key":"<non-empty>"}` entries with provider ids matching `^[A-Za-z0-9._-]+$`. It writes no copy.
   - `runSupervisedOpencodeV2` in `apps/workspace-agent/src/opencode-server-v2.ts` runs as root. It reads the file with `readOptionalSecretBlob` (`O_NOFOLLOW`, regular file, size cap) and `parseAuthBlob`.
   - After the server is up and the permission gate has passed, `provisionCredentials` sends each key in one `POST /api/credential` to `127.0.0.1:54321` with the per-spawn Basic credential. The response body is discarded unread.
   - The server stores it in that spawn's database under `/var/lib/workspace-agent/opencode-v2-db`. `prepareFreshDatabase` wipes the root-owned 0711 base directory, then creates the spawn directory with `mkdtemp`, chowns it to 10001 and sets 0700. Every spawn therefore stores the keys again.
   - `verifyCredentialGate` reads `GET /api/integration/<provider>` back, which lists connection ids and labels and never the key. The provider is the one of the effective model, read from the merged `opencode.json` by `readSpawnConfigFromFile`. A provider without a credential gives `credential-missing` and the server never goes ready. With no model it checks the providers it provisioned, and with neither it checks nothing.

   The key is never in argv, the child environment, the config content, a log line, an error or `/readyz`. The `:9200` bearer proxy forwards only the gateway's routes and answers 404 for every spelling of `/api/credential`.

4. **State the residual exposure.** The server and every tool it starts run as uid 10001. A tool cannot read `/run/workspace-agent` or the secret file. It can read the spawn database, which holds the key, and the server password (`deploy/README.md`, which names OS-level tool isolation, fro-bot/agent#2041, as the missing control). A key put in `WORKSPACE_OPENCODE_CONFIG` is worse: it sits in the container environment and in the 0644 `opencode.json`. Keep keys out of the overlay. The `{file:/path}` key reference belongs to the Action (`providerKeyFiles` in `src/services/setup/ci-config-v2.ts`), not to the workspace.

5. **Plugins do not come from the config file.** `runSupervisedOpencodeV2` passes `WORKSPACE_V2_PLUGIN_SPECS` to `buildWorkspaceConfigV2` (`packages/runtime/src/agent/workspace-config-v2.ts`), which emits the V2 `plugins` key in `OPENCODE_CONFIG_CONTENT`. `deploy/scripts/install-opencode-v2-plugins.sh` installs both specs at image build, and `deploy/scripts/workspace-v2-image.test.mjs` asserts that the base and managed configs carry no plugin entry and that nothing installs at boot. `startOpenCodeV2Server` refuses a server unless the ids in `WORKSPACE_V2_EXPECTED_PLUGIN_IDS` are active. To change a plugin, change `DEFAULT_SYSTEMATIC_VERSION` or `FRO_BOT_PLUGIN_VERSION` in `packages/runtime/src/shared/constants.ts` and the matching Dockerfile `ARG`. The test keeps the two in step.

6. **Known gap, tracked in fro-bot/agent#2166: the singular `plugin` union guards nothing.** `mergeConfig` still unions a singular `plugin` array and writes `"plugin": []` when there is none. The base has no entry to protect, and the two workspace plugins never pass through this file. OpenCode 2.3.0 does read a singular `plugin` in a config file and normalizes it to `plugins` ([`normalize.ts`](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/config/normalize.ts)), so a string an overlay adds there is not ignored. Do not rely on it to load or protect a workspace plugin. The image caches only the two pinned plugins, so any other spec would not have been installed at build.

7. **The file's update and depth pins are not the authority.** `mergeConfig` forces `autoupdate: false` and `subagent_depth: 1`. OpenCode 2.3.0 maps `autoupdate` to `update` and prefers a native `update` over it, and it omits a top-level `subagent_depth` as unsupported. What holds is set at spawn: `OPENCODE_DISABLE_AUTOUPDATE=1` in `packages/runtime/src/agent/server-v2.ts`, and `update: "disable"` plus `experimental.subagent_depth: 1` from `buildConfigContentV2` in `packages/runtime/src/agent/permission-rules-v2.ts`.

8. **Fail soft when absent, fail fast when malformed.** A missing or whitespace-only secret boots a clone-only workspace and logs `auth: absent`. A malformed secret, a non-JSON or non-object overlay, or a model not in `provider/model` form stops the boot. Read the state in `docker logs`: `auth: present` or `auth: absent`, and `opencode config: model=set|default, provider-overlay=merged-into-config-file|none`. `provider-overlay=merged-into-config-file` says the overlay string was non-empty and was merged. It does not say a provider loaded or has a credential. The credential gate answers that.

9. **Wrap fallible calls in the entrypoint.** It runs under `set -eu`. Step 5 captures the provisioning status with `if provision_output=$(...); then ... else provision_rc=$?; fi`, and tests the secret read with `if ! _auth_compact=$(...)`, so a failure is reported and not swallowed or fatal at the wrong line.

## Why This Matters

- A reader who writes `auth.json` stores a second plaintext key that nothing reads, and the provisioner deletes it at the next start.
- A reader who adds a plugin to the base config or the overlay expects it to load. The server takes the two workspace plugins from the spawn config, and the plugin gate fails without them.
- The key's exposure is bounded and stated: out of the entrypoint, the logs and the proxy, but readable by a same-uid tool until tool isolation exists.
- The log markers tell an operator which of config, key and gate failed without reading the code.

## When to Apply

- When changing `deploy/workspace-entrypoint.sh`, `deploy/workspace.Dockerfile`, `deploy/scripts/merge-config.mjs` or the credential code in `apps/workspace-agent/src/`.
- When routing a model through a proxy, or adding a provider, to the workspace.
- When a change would put a key, a plugin or a pin in the baked or merged config file.

## Examples

A proxy-routed deployment. The overlay holds the endpoint and the secret holds the token:

```bash
# deploy/.env, non-secret operator config
WORKSPACE_OPENCODE_MODEL=anthropic/claude-sonnet-4-6
WORKSPACE_OPENCODE_CONFIG={"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}
WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot

# deploy/secrets/workspace-opencode-auth, keyed per provider
{"anthropic":{"type":"api","key":"<token>"}}
```

What the `workspace-smoke` job in `.github/workflows/ci.yaml` asserts today:

- A hostile overlay `{"autoupdate":true,...}` still leaves `"autoupdate": false` and `"update": "disable"` in the written `opencode.json`, along with the overlaid `model` and `baseURL`. A model-only run writes no `provider` key.
- A valid secret logs `auth: present` and leaves no `auth.json` under the agent home. A whitespace-only secret logs `auth: absent`. A malformed secret exits with `auth secret is present but invalid`, and a non-JSON overlay exits with `WORKSPACE_OPENCODE_CONFIG is not valid JSON`.
- With a fake provider on loopback, the model request carries the provisioned key in `x-api-key`, the key is absent from the logs, and `/readyz` stays down with `credential-missing` when a model is set and no secret exists.

## Related

- [Keep provider API keys out of the agent sandbox with a local key-injecting proxy](./key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md): the Action-side route, where the agent never holds the key. The workspace has no such proxy.
- [Gateway OpenCode mention-loop best practices](./gateway-opencode-mention-loop-best-practices-2026-05-30.md): the runtime attach and stream side that this provisioning feeds.
- [Deploy guide](../../../deploy/README.md): operator setup, the secret layout and the trust model for tool processes.
