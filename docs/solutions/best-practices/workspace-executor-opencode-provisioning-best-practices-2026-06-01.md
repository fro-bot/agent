---
title: Provisioning OpenCode model, provider config, and auth into a workspace container
date: 2026-06-01
category: best-practices
module: workspace-executor
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - provisioning a self-hosted OpenCode server inside a container at deploy time
  - routing a provider (Claude/OpenAI) through a proxy such as cliproxyapi
  - mirroring the GitHub Action's model / opencode-config / auth-json inputs in a container
  - overlaying operator-supplied JSON onto a baked OpenCode config
  - handling LLM provider credentials in a container entrypoint
tags:
  - opencode
  - workspace-executor
  - docker
  - auth-json
  - provider-config
  - model-selection
  - config-overlay
  - cliproxyapi
---

# Provisioning OpenCode model, provider config, and auth into a workspace container

## Context

The workspace executor image bakes the OpenCode CLI and runs `opencode serve`, but a running server is not enough for the `@fro-bot` Discord mention loop to complete a turn — it also needs a **model**, a **provider configuration** (so requests reach the right endpoint), and **credentials**. Baking any of those into the image is wrong: they are deployment-specific and the credential is bearer-grade.

The goal is parity with the GitHub Action's three inputs — `model`, `opencode-config`, `auth-json` — so an operator configures the container with the same shapes they already use for the Action, and can route Claude/OpenAI through a cliproxyapi proxy.

## Guidance

### 1. Redirect a provider with config, not env vars

OpenCode has **no** provider base-URL environment variables — `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `OPENAI_API_BASE` are not read anywhere in the server. The only way to point a provider at a proxy is the config:

```json
{ "provider": { "anthropic": { "options": { "baseURL": "https://cliproxy.fro.bot/v1" } } } }
```

The stock `anthropic` / `openai` provider IDs honor `options.baseURL`, so a proxy needs no custom provider — just the baseURL override.

### 2. Supply credentials as a file, never as env

OpenCode reads provider credentials from `OPENCODE_AUTH_CONTENT` (env) **or** an `auth.json` file at its XDG data path. Prefer the **file**: write it from a mounted secret in the entrypoint, `0600`, and never export it. A file has a strictly smaller introspection surface than an env var — it is not in `/proc/<pid>/environ` and not in `docker inspect` `Config.Env`, so a same-user process (including cloned repo code) cannot read it from process metadata. This mirrors the Action tier's `populateAuthJson`.

```sh
AUTH_SRC="${WORKSPACE_OPENCODE_AUTH_FILE:-/run/secrets/workspace_opencode_auth}"
AUTH_DEST="${XDG_DATA_HOME:-/root/.local/share}/opencode/auth.json"
# validate shape, then: (umask 077; cp "$AUTH_SRC" "$AUTH_DEST"); chmod 600 "$AUTH_DEST"
```

### 3. Bake nothing deployment-specific; overlay at the entrypoint

Bake only a base `opencode.json` (plugin declaration + `autoupdate:false`). Expose two deploy-time knobs and merge them in the entrypoint, mirroring the Action's `model` + `opencode-config`:

- `WORKSPACE_OPENCODE_MODEL` — a `provider/model` string.
- `WORKSPACE_OPENCODE_CONFIG` — a JSON object (the `provider` block) shallow-merged over the base.

### 4. Harden the overlay merge

A naive `{...base, ...overlay}` lets an operator (or a copy-pasted hostile config) **drop the baked plugin** or **re-enable `autoupdate`** and defeat the version pin. After the spread, force the invariants back:

```js
const merged = {...base, ...overlay}
const basePlugins = Array.isArray(base.plugin) ? base.plugin : []
const overlayPlugins = Array.isArray(overlay.plugin) ? overlay.plugin.filter(p => typeof p === "string") : []
merged.plugin = Array.from(new Set([...basePlugins, ...overlayPlugins])) // union, dedup, strings only
merged.autoupdate = false                                                // never let an overlay re-enable
if (model !== "") merged.model = model
```

Validate the auth blob too: require a JSON object with ≥1 provider entry, each `{type:"api", key:<non-empty>}`, and constrain provider IDs to an allowlist regex (`^[A-Za-z0-9._-]+$`) so whitespace/control-character IDs cannot slip through.

### 5. Fail-soft when absent, fail-fast when malformed

The same image serves clone-only deployments, so missing auth/config must **boot** (the mention turn then surfaces OpenCode's own auth error). A *malformed* secret or overlay must **exit at startup** with a clear message, not defer to a cryptic turn-time failure. Emit startup markers so an operator can read the state in `docker logs`: `auth: provisioned` / `auth: absent`, `provider-overlay=applied` / `provider-overlay=none`.

### 6. Mind POSIX `set -eu` in the entrypoint

Under `set -eu`, a **bare function call that returns non-zero exits the whole script** — so a fail-soft "absent" return would kill startup before the next step runs. Wrap fallible calls:

```sh
if provision_auth; then auth_rc=0; else auth_rc=$?; fi
```

Two related traps: a command substitution used as a bare truthiness test (`if [ -z "$(tr ... < "$f")" ]`) masks a read error as "empty/absent" — capture and check the substitution's status explicitly; and a `chmod`/`cp` failure inside an `if`-invoked function (where `set -e` is suppressed) still falls through to `return 0` unless you check it explicitly.

## Why This Matters

- **Credential exposure:** the file channel keeps a bearer-grade key out of `/proc/<pid>/environ` and `docker inspect`. (Same-user cloned-repo code can still read a `0600` file — the real confinement is a non-root user split, tracked separately.)
- **Version-pin integrity:** forcing `autoupdate:false` post-merge means an operator config cannot silently move the sandbox onto unpinned OpenCode.
- **Plugin survival:** the strings-only union guarantees the bundled plugin loads regardless of the overlay.
- **Operational clarity:** fail-soft/fail-fast + log markers give predictable behavior in a `restart: unless-stopped` container instead of a silent half-provisioned state.
- **Parity:** an operator reuses the same `OPENCODE_CONFIG` / `AUTH_JSON` / model values across the Action and the container.

## When to Apply

- Standing up a self-hosted OpenCode server in any container (gateway workspace, CI sidecar, dev box).
- Routing models through a proxy (cliproxyapi, LiteLLM, or any OpenAI/Anthropic-compatible gateway).
- Any time operator-supplied JSON is shallow-merged over a baked config that carries security-relevant invariants (plugin allowlist, autoupdate, pinned versions).

## Examples

### cliproxyapi recipe (the production shape)

```bash
# deploy/.env  — non-secret operator config
WORKSPACE_OPENCODE_MODEL=anthropic/claude-sonnet-4-6
WORKSPACE_OPENCODE_CONFIG={"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}},"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}
```

```bash
# deploy/secrets/workspace-opencode-auth — the cliproxy bearer token, keyed per provider
echo -n '{"anthropic":{"type":"api","key":"<cliproxy-token>"},"openai":{"type":"api","key":"<cliproxy-token>"}}' \
  > deploy/secrets/workspace-opencode-auth
```

### Hostile-overlay test (proves the invariants hold)

Feeding `WORKSPACE_OPENCODE_CONFIG={"autoupdate":true,"plugin":[],"provider":{...}}` must still yield an effective config with `"autoupdate": false` and the baked plugin present. The CI `workspace-smoke` job asserts exactly this:

```sh
docker exec "$cid" sh -c 'grep -q "@fro.bot/systematic" /root/.config/opencode/opencode.json'
docker exec "$cid" sh -c 'grep -q "\"autoupdate\": false" /root/.config/opencode/opencode.json'
```

### Test-harness gotcha (not a product bug)

macOS Docker Desktop silently turns a **single-file** `/tmp` bind mount into a directory, so `[ -f "$mount" ]` is false and auth reports `absent` locally. Verify auth-file paths by baking the blob into a throwaway derived image, or rely on the ubuntu CI smoke where single-file mounts work natively.

## Related

- `docs/solutions/best-practices/gateway-opencode-mention-loop-best-practices-2026-05-30.md` — the runtime attach/SSE side this deploy-time provisioning unblocks.
- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — the config-declared plugin injection pattern; this doc adds the hardened-overlay rules (autoupdate pin, strings-only plugin union) for when operator config is merged over the baked config.
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — the image build-and-boot smoke discipline this change extends.
- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — the sibling `auth-json` surface: this doc is the workspace-container consumer side; that one is the harness-CI producer side that mints an OIDC-brokered short-lived credential.
