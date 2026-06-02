# fro-bot Deploy Stack

Docker Compose v2 stack for the fro-bot gateway. Runs three services:

| Service     | Role                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| `gateway`   | Discord gateway daemon — connects to Discord, handles slash commands and mentions |
| `workspace` | Workspace agent container — sandboxed git + OpenCode execution                    |
| `mitmproxy` | Egress proxy enforcing an allowlist of permitted outbound hosts                   |

## Prerequisites

- Docker 24+ with Compose v2 (`docker compose version`)
- Access to a Discord application (bot token + application ID)
- An S3-compatible object store (bucket, region, optional endpoint)

## Testing-Only Configuration (Discord Plumbing)

If you're just verifying the gateway connects to Discord and responds to slash commands and mentions, you do not need a working S3 bucket. The gateway daemon validates S3 credentials at startup but does not write to S3 in v1.

For testing-only:

- Put any plausible-looking values in `deploy/secrets/s3-bucket` and `deploy/secrets/s3-region` (e.g. `test-bucket` and `us-east-1`). Validation only checks they're non-empty.
- Leave `OBJECT_STORE_HOSTS` unset in `deploy/.env`. The default fail-closed behaviour blocks all S3 traffic — fine for testing, since no S3 calls are made.
- Use a real bucket and `OBJECT_STORE_HOSTS` value once you exercise the workspace executor (repo clone via `/fro-bot add-project` and the OpenCode mention loop), which reaches S3-backed state and external hosts.

## One-Time Setup

### 1. Copy the override example

```bash
cp deploy/compose.override.example.yaml deploy/compose.override.yaml
# Edit compose.override.yaml for your environment (e.g. expose mitmproxy web UI in dev)
```

`compose.override.yaml` is gitignored — never commit it.

### 2. Create secrets

Create one file per secret under `deploy/secrets/`. Files must be readable only by the owner (`chmod 0600`).

```bash
mkdir -p deploy/secrets
echo -n 'YOUR_DISCORD_BOT_TOKEN'      > deploy/secrets/discord-token
echo -n 'YOUR_DISCORD_APP_ID'         > deploy/secrets/discord-application-id
echo -n 'your-s3-bucket-name'         > deploy/secrets/s3-bucket
echo -n 'us-east-1'                   > deploy/secrets/s3-region
# Optional — leave empty for standard AWS S3; set for R2 or other S3-compatible stores.
touch deploy/secrets/s3-endpoint
# echo -n 'https://your-endpoint.r2.dev' > deploy/secrets/s3-endpoint
# Optional — AWS credentials for explicit S3 authentication. Leave empty
# to fall back to the SDK default credential chain (env vars, ~/.aws,
# or EC2/EKS instance role).
```

> **Pair contract:** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` must both be provided or both left empty. `AWS_SESSION_TOKEN` is only used when the pair is present — it is ignored otherwise. With neither pair value set, the AWS SDK default credential chain takes over (env vars, `~/.aws`, EC2/EKS instance role).

> **Rotation:** Static credentials read from `AWS_*_FILE` are loaded at gateway startup. Rotate by writing the new value into the secret file and restarting the gateway container. For refreshable credentials (STS temporary tokens, EC2/EKS instance roles), leave the pair empty and rely on the SDK default credential chain — it refreshes without restart.

```sh
touch deploy/secrets/aws-access-key-id
touch deploy/secrets/aws-secret-access-key
touch deploy/secrets/aws-session-token
# echo -n 'AKIAI...' > deploy/secrets/aws-access-key-id
# echo -n 'wJal...' > deploy/secrets/aws-secret-access-key
# echo -n 'FwoG...' > deploy/secrets/aws-session-token  # only for STS temporary credentials
# Optional — guild-scoped slash command registration (propagates in ~5s vs up to 1h globally).
# Leave the file empty (or omit the echo) to register slash commands globally instead:
touch deploy/secrets/discord-guild-id
# echo -n 'YOUR_GUILD_ID' > deploy/secrets/discord-guild-id
# Optional — opt into Discord privileged intents. Leave the file empty
# to use the non-privileged baseline (Guilds + GuildMessages only). Set
# the contents to a comma-separated list of `MessageContent` and/or
# `GuildMembers` to opt in. Operators rotating intents must restart
# the gateway after writing the new value.
touch deploy/secrets/discord-privileged-intents
# echo -n 'MessageContent,GuildMembers' > deploy/secrets/discord-privileged-intents

# Workspace OpenCode bearer token (required for the OpenCode attach path).
# The workspace proxy validates this token; the gateway presents the same
# value when attaching. Generate a strong shared secret:
openssl rand -hex 32 > deploy/secrets/workspace-opencode-token

# Optional — override the workspace OpenCode proxy URL.
# Default: http://workspace:9200 (internal Docker Compose service name).
# Change only if the workspace container is not on the same Compose network.
touch deploy/secrets/workspace-opencode-url
# echo -n 'http://workspace:9200' > deploy/secrets/workspace-opencode-url

# OpenCode provider credentials for the @fro-bot mention loop (API-key auth.json
# blob). Required for the mention loop; leave empty for clone-only deployments.
# Use a least-privilege, rotatable provider key — the workspace runs cloned repo
# code alongside this credential. Rotate by replacing the file and restarting.
touch deploy/secrets/workspace-opencode-auth
# echo -n '{"anthropic":{"type":"api","key":"sk-..."}}' > deploy/secrets/workspace-opencode-auth

# Optional — Discord role ID that grants trigger authorization.
# If set, only members with this role may @-mention the bot to start an agent run.
# If unset, falls back to guild-level ManageChannels permission.
touch deploy/secrets/gateway-trigger-role-id
# echo -n 'YOUR_ROLE_ID' > deploy/secrets/gateway-trigger-role-id

# GitHub App credentials (required — see "GitHub App" section below)
echo -n 'YOUR_GITHUB_APP_ID'          > deploy/secrets/github-app-id
cp ~/Downloads/your-app.private-key.pem deploy/secrets/github-app-private-key

chmod 0600 deploy/secrets/*
```

> **Important:** All files under `deploy/secrets/` must exist before running `docker compose config`, `up`, or `down`. Compose bind-mounts these paths unconditionally — if a file is missing, Docker creates an empty directory at the mount target and the gateway will fail to read the secret. For optional secrets that you don't want to set (e.g. `discord-guild-id`), create the file empty: `touch deploy/secrets/discord-guild-id`. The gateway treats empty and whitespace-only files as unset.

`deploy/secrets/` is gitignored — never commit secret files.

### 3. Bootstrap the mitmproxy CA

Run once to generate the mitmproxy CA and place it in the shared Docker volume:

```bash
bash deploy/init-certs.sh
```

This is idempotent — safe to run again; skips if the CA already exists.

## Starting the Stack

```bash
docker compose -f deploy/compose.yaml -f deploy/compose.override.yaml up -d
```

Or without an override file:

```bash
docker compose -f deploy/compose.yaml up -d
```

## Viewing Logs

```bash
# Follow gateway logs
docker compose -f deploy/compose.yaml logs -f gateway

# Follow all services
docker compose -f deploy/compose.yaml logs -f
```

## Validating the Stack

After `up -d`, run the smoke-test script:

```bash
bash deploy/validate-stack.sh
```

This checks:

- Compose YAML is valid
- Service status
- Recent log output
- Gateway exit code (fails if gateway crashed in the last cycle)

## Gateway Readiness

The gateway container is considered healthy only after three conditions are all true:

1. The Discord `clientReady` event has fired — the bot is fully connected and ready to receive events. At that point the process writes `/var/run/fro-bot/gateway-ready`.
2. The daemon process (PID 1) is still alive (`kill -0 1`).
3. mitmproxy is reachable via TCP (`nc -z mitmproxy 8080`) — makes mitmproxy loss visible: if mitmproxy crashes but leaves its CA cert file on disk, the gateway shows `unhealthy` in `docker ps` so the problem is immediately apparent.

The flag is cleared at process startup, so a stale `/var/run/fro-bot/gateway-ready` from a prior container run cannot mask a current-run failure. `docker compose up --wait` blocks until the gateway is genuinely connected to Discord before returning.

The healthcheck is baked into `deploy/gateway.Dockerfile` — there is no override in `compose.yaml`. Note that `restart: unless-stopped` only acts on process exit, not healthcheck failure; an `unhealthy` gateway requires operator intervention (restart the stack or investigate logs). Automatic restart on healthcheck failure would require an autoheal sidecar or an in-process probe that exits the gateway — both are out of scope here.

## Upgrading existing deployments

The compose stack bind-mounts each secret file individually with `create_host_path: false`. A missing source file produces a clear `docker compose up` error instead of silently materializing as a directory. This is the fail-fast diagnostic — but it means **every time the compose stack adds a new optional secret, existing deployments must `touch` the new file before their next `docker compose up`**.

Run the full `touch` block from [Create secrets](#2-create-secrets) on every upgrade. It is idempotent: `touch` on an existing file is a no-op, but a missing file gets created empty. Empty files mean "secret not set", which is the same as the file being absent — the gateway treats both as opt-out.

### Current optional secrets

| Secret file | Purpose | When added |
| --- | --- | --- |
| `deploy/secrets/discord-guild-id` | Guild-scoped slash command registration (propagates in ~5 s vs up to 1 h globally) | Initial compose layout |
| `deploy/secrets/discord-privileged-intents` | Discord privileged intents opt-in (`MessageContent`, `GuildMembers`) | Added later; existing deployments must `touch` this on upgrade |
| `deploy/secrets/aws-access-key-id` | AWS access key for explicit S3 authentication | Deploy-contract hardening; existing deployments must `touch` this on upgrade |
| `deploy/secrets/aws-secret-access-key` | AWS secret key for explicit S3 authentication | Deploy-contract hardening; existing deployments must `touch` this on upgrade |
| `deploy/secrets/aws-session-token` | AWS session token for STS temporary credentials | Deploy-contract hardening; existing deployments must `touch` this on upgrade |
| `deploy/secrets/s3-endpoint` | Custom S3-compatible endpoint (e.g. Cloudflare R2) | Deploy-contract hardening; existing deployments must `touch` this on upgrade |
| `deploy/secrets/workspace-opencode-token` | Shared bearer token for the workspace OpenCode reverse proxy (required for the OpenCode attach path) | OpenCode attach; existing deployments must create this file on upgrade |
| `deploy/secrets/workspace-opencode-url` | Base URL of the workspace OpenCode proxy (default: `http://workspace:9200`). Override only when the workspace container is not on the same Compose network. | OpenCode attach; existing deployments must `touch` this on upgrade |
| `deploy/secrets/workspace-opencode-auth` | OpenCode provider credentials as an API-key `auth.json` blob (e.g. `{"anthropic":{"type":"api","key":"sk-..."}}`). Required for the `@fro-bot` mention loop; leave empty for clone-only deployments. | Mention-loop auth; existing deployments must `touch` this on upgrade |
| `deploy/secrets/gateway-trigger-role-id` | Discord role ID that grants trigger authorization. If unset, falls back to guild-level `ManageChannels`. | Mention-loop trigger gate; existing deployments must `touch` this on upgrade |
| `deploy/secrets/github-app-id` | GitHub App ID (required for repository access) | GitHub App auth; existing deployments must create this file on upgrade |
| `deploy/secrets/github-app-private-key` | GitHub App private key PEM (required for repository access) | GitHub App auth; existing deployments must create this file on upgrade |

When a new optional secret is added to `compose.yaml` in the future, add a row here so operators know what to `touch` on their next upgrade.

## GitHub App

The gateway uses a GitHub App to authenticate against repositories. This is required for the `/add-project` command and any feature that reads repository content.

### Creating the App

1. Go to [GitHub → Settings → Developer settings → GitHub Apps](https://github.com/settings/apps) and click **New GitHub App**.
2. Set the App name, homepage URL, and webhook URL (webhook is not used by the gateway — set it to any valid URL).
3. Under **Permissions → Repository permissions**, grant:
   - **Contents**: Read-only (minimum required)
   - Grant only the minimum permissions needed. Over-privileged installations produce a `WARN` log entry at runtime but do not block operation. Under-privileged installations fail fast at `/add-project` time with a clear error message.
4. Disable **Webhook** (the gateway does not receive webhooks from GitHub).
5. Click **Create GitHub App**.
6. Note the **App ID** shown on the App settings page.
7. Scroll to **Private keys** and click **Generate a private key**. Save the downloaded `.pem` file.

### Writing the credential files

```bash
mkdir -p deploy/secrets
echo -n 'YOUR_GITHUB_APP_ID' > deploy/secrets/github-app-id
cp ~/Downloads/your-app.private-key.pem deploy/secrets/github-app-private-key
chmod 0600 deploy/secrets/github-app-id deploy/secrets/github-app-private-key
```

> **Key rotation:** The private key is read at gateway startup. Rotating the key requires writing the new `.pem` file and running `docker compose restart gateway` to pick up the change. Bind-mounted files are not reloaded by the running process.

### Installing the App

Install the App on the repositories you want the gateway to access:

1. Go to `https://github.com/apps/fro-bot/installations/new` (or the URL for your App).
2. Select the account or organization and choose the repositories to grant access to.
3. Click **Install**.

The gateway auto-discovers the installation ID at runtime — you do not need to configure it manually.

### Permission behaviour

- **Under-privileged** (e.g. `contents: none`): the gateway returns an error at `/add-project` time with a message naming the missing permissions and a link to the installation settings page.
- **Over-privileged** (e.g. `contents: write` when only `read` is required): the gateway logs a `WARN` entry listing the over-privileged scopes but does not block the request. Operators should review and reduce permissions to the minimum needed.

## Workspace Port Model

The workspace container exposes two internal ports, both accessible only within the Docker Compose sandbox network:

| Port | Service | Purpose |
| --- | --- | --- |
| 9100 | Workspace agent (`workspace-api`) | Handles repo clone requests from the `/add-project` slash command |
| 9200 | OpenCode reverse proxy | Bearer-authenticated endpoint the gateway uses when attaching to an OpenCode session. Validates `WORKSPACE_OPENCODE_TOKEN` before forwarding to the loopback-bound OpenCode process. |

Neither port is exposed on the host. The egress proxy (`mitmproxy`) permits only outbound traffic to the allowlisted hosts; these ports are inbound-only from the gateway's perspective and not reachable from outside the sandbox network.

The raw OpenCode SDK server binds to loopback (`127.0.0.1:54321`) only and is never reachable on the sandbox network — the gateway always attaches through the bearer-authenticated proxy on 9200.

### Workspace executor image

The workspace image builds the workspace agent and bakes the OpenCode CLI (pinned to match `DEFAULT_OPENCODE_VERSION`), so the container serves repo clones and hosts an OpenCode server. `deploy/secrets/workspace-opencode-token` is required (the bearer proxy and the gateway share it).

Outbound TLS from the workspace flows through `mitmproxy`. The container entrypoint installs the mitmproxy CA into the **system** trust store via `update-ca-certificates` before launching — `git` and the OpenCode binary read the system bundle, not `NODE_EXTRA_CA_CERTS`, so this step is required for cloning and model calls to succeed through the proxy. Set `OBJECT_STORE_HOSTS` and any provider hosts your deployment uses (see [Egress Allowlist](#egress-allowlist)).

#### Model and provider configuration

The mention-loop agent needs a model and a provider to talk to. These mirror the GitHub Action's `model` + `opencode-config` inputs and are supplied at deploy time via two environment variables on the `workspace` service (set them in `deploy/.env`):

- `WORKSPACE_OPENCODE_MODEL` — the `provider/model` string (e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-5.4-mini`).
- `WORKSPACE_OPENCODE_CONFIG` — a JSON object shallow-merged over the baked base config; supply the `provider` block that points OpenCode at your endpoint.

The image bakes no default model — the entrypoint overlays these onto the base config at startup (the Systematic plugin is always preserved; a malformed value fails fast). Provider **credentials** stay in the `workspace-opencode-auth` secret (above); these two are non-secret operator config.

To route Claude/OpenAI through a [cliproxyapi](https://github.com/router-for-me/CLIProxyAPI) proxy (the default in `marcusrbrown/infra`), point the stock `anthropic`/`openai` providers at the proxy's `/v1` base URL and set the model:

```bash
# deploy/.env
WORKSPACE_OPENCODE_MODEL=anthropic/claude-sonnet-4-6
WORKSPACE_OPENCODE_CONFIG={"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}},"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}
```

```bash
# deploy/secrets/workspace-opencode-auth — the cliproxyapi bearer token, keyed per provider
echo -n '{"anthropic":{"type":"api","key":"<cliproxy-token>"},"openai":{"type":"api","key":"<cliproxy-token>"}}' > deploy/secrets/workspace-opencode-auth
```

Add the proxy host to the egress allowlist (`OBJECT_STORE_HOSTS` is S3-only; provider hosts are covered by the static allowlist — add your cliproxyapi host there if it is not already permitted).

Leave both variables unset for a clone-only deployment: the workspace boots and serves `/clone`, but the mention loop has no model until they are configured.

## Stopping the Stack

```bash
docker compose -f deploy/compose.yaml down
```

## mitmproxy CA Cert (Dev Only)

If you want your host browser or tools to trust the mitmproxy CA (useful for inspecting proxied traffic in dev), extract and install it:

```bash
# Extract the cert from the Docker volume
docker run --rm \
  -v fro-bot_mitmproxy-certs:/certs \
  alpine cat /certs/mitmproxy-ca-cert.pem \
  | sudo tee /usr/local/share/ca-certificates/mitmproxy-fro-bot.crt

# Install (Linux)
sudo update-ca-certificates

# Install (macOS)
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  /usr/local/share/ca-certificates/mitmproxy-fro-bot.crt
```

**Do not install the mitmproxy CA on production hosts.** It is only needed on developer machines that want to inspect proxied traffic via the mitmproxy web UI.

## Egress Allowlist

The mitmproxy addon at `deploy/mitmproxy/allowlist.py` enforces a static allowlist of permitted outbound hosts. Changes require restarting the mitmproxy container. The allowlist covers:

- GitHub API + raw content
- npm registry
- Discord API + gateway
- LLM providers (Anthropic, OpenAI, Google)

Any host not on the list receives a 403 and the connection is dropped. Both HTTPS CONNECT tunnels and plain HTTP requests are enforced.

### Object-store bucket scoping

For testing the gateway itself, see [Testing-Only Configuration](#testing-only-configuration-discord-plumbing) — S3 isn't exercised in v1.

The allowlist does **not** include broad S3/R2 wildcards (`*.s3.amazonaws.com`, `*.r2.cloudflarestorage.com`). Instead, set the `OBJECT_STORE_HOSTS` environment variable on the `mitmproxy` service to the exact bucket host(s) your deployment uses:

```
OBJECT_STORE_HOSTS=my-bucket.s3.amazonaws.com,my-account.r2.cloudflarestorage.com
```

If `OBJECT_STORE_HOSTS` is unset or empty, all S3/R2 traffic is blocked (fail-closed default). This prevents workspace processes from exfiltrating data to attacker-controlled buckets in those clouds.

Set the variable in your `.env` file or `compose.override.yaml` (see `compose.override.example.yaml` for an example).
