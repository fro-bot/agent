# fro-bot Deploy Stack

Docker Compose v2 stack for the fro-bot gateway. Runs three services:

| Service     | Role                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| `gateway`   | Discord gateway daemon — connects to Discord, handles slash commands and mentions |
| `workspace` | Workspace agent container (placeholder in v1; real agent wired in Unit 7)         |
| `mitmproxy` | Egress proxy enforcing an allowlist of permitted outbound hosts                   |

## Prerequisites

- Docker 24+ with Compose v2 (`docker compose version`)
- Access to a Discord application (bot token + application ID)
- An S3-compatible object store (bucket, region, optional endpoint)

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
# Optional — omit for AWS S3; set for R2 or other S3-compatible stores:
echo -n 'https://your-endpoint.r2.dev' > deploy/secrets/s3-endpoint

chmod 0600 deploy/secrets/*
```

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

The allowlist does **not** include broad S3/R2 wildcards (`*.s3.amazonaws.com`, `*.r2.cloudflarestorage.com`). Instead, set the `OBJECT_STORE_HOSTS` environment variable on the `mitmproxy` service to the exact bucket host(s) your deployment uses:

```
OBJECT_STORE_HOSTS=my-bucket.s3.amazonaws.com,my-account.r2.cloudflarestorage.com
```

If `OBJECT_STORE_HOSTS` is unset or empty, all S3/R2 traffic is blocked (fail-closed default). This prevents workspace processes from exfiltrating data to attacker-controlled buckets in those clouds.

Set the variable in your `.env` file or `compose.override.yaml` (see `compose.override.example.yaml` for an example).
