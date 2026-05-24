# workspace-agent

Small Hono HTTP service that runs **inside** the workspace container. The gateway daemon calls it from outside via the internal compose network (`sandbox-net`).

## Overview

The workspace-agent handles git operations inside the workspace container so the gateway never needs to mount `/var/run/docker.sock` or shell out to docker. It exposes a minimal HTTP API on port **9100** (internal only — no public exposure).

## Endpoints

| Method | Path     | Description                                                |
| ------ | -------- | ---------------------------------------------------------- |
| GET    | /healthz | Liveness probe                                             |
| POST   | /clone   | Clone a GitHub repo into `/workspace/repos/{owner}/{repo}` |

### POST /clone

The caller provides `{owner, repo, token}`. The agent derives the destination path internally — callers never control where the repo is cloned.

```bash
curl -X POST http://workspace:9100/clone \
  -H 'Content-Type: application/json' \
  -d '{"owner":"fro-bot","repo":"agent","token":"ghs_..."}'
```

Success:

```json
{"ok": true, "path": "/workspace/repos/fro-bot/agent", "commit": "abc123..."}
```

If the repo is already cloned, returns **409**:

```json
{"ok": false, "error": "repo-exists"}
```

## Error Codes

| Code                     | HTTP | Description                                         |
| ------------------------ | ---- | --------------------------------------------------- |
| `invalid-owner`          | 400  | Owner failed sanitization                           |
| `invalid-repo`           | 400  | Repo failed sanitization                            |
| `invalid-token-shape`    | 400  | Token missing or wrong prefix                       |
| `malformed-body`         | 400  | Request body is not valid JSON                      |
| `body-too-large`         | 413  | Request body exceeds 4 KB or Content-Length missing |
| `repo-exists`            | 409  | Destination already cloned                          |
| `clone-failed`           | 500  | Generic git clone failure                           |
| `clone-timeout`          | 500  | Clone exceeded timeout (default 60 s)               |
| `clone-aborted`          | 500  | Clone aborted by shutdown signal                    |
| `git-not-available`      | 500  | `git` binary not found                              |
| `enospc`                 | 500  | Disk full (ENOSPC)                                  |
| `disk-full`              | 500  | Disk full (filesystem error)                        |
| `permission-denied`      | 500  | EACCES on workspace directory                       |
| `too-many-files`         | 500  | EMFILE — too many open files                        |
| `head-resolution-failed` | 500  | `git rev-parse HEAD` failed after clone             |
| `path-escaped-workspace` | 500  | Symlink escape detected post-clone                  |
| `overloaded`             | 503  | Too many concurrent clone requests queued           |

## Security

- Token is injected via `GIT_ASKPASS` — never appears in process argv
- Token is passed to the askpass script via `GITHUB_TOKEN` env var — **not embedded in the script body** (script file on disk contains no secret)
- Git trace env vars are suppressed (`GIT_TRACE=0`, etc.)
- Stderr is scrubbed of credential patterns before any error is returned
- Owner/repo are validated against `[A-Za-z0-9._-]+` before path construction; bare `.` and `..` are explicitly rejected
- Post-clone `realpath` check confirms the path is within `/workspace/repos/`
- Clone is atomic: written to a temp dir, renamed to dest on success; partial clones never reach the destination path
- Body size is limited to 4 KB; requests without `Content-Length` are rejected

## Port

**9100** — internal to `sandbox-net`. No `ports:` mapping in compose. The gateway reaches it as `http://workspace:9100`.

## Running in the container

The workspace Dockerfile installs this package and sets the entrypoint to:

```
node /app/apps/workspace-agent/dist/main.mjs
```

Healthcheck (compose):

```yaml
healthcheck:
  test: [CMD, nc, -z, localhost, "9100"]
  interval: 10s
  timeout: 5s
  retries: 3
```

## Development

```bash
pnpm --filter @fro-bot/workspace-agent build
pnpm --filter @fro-bot/workspace-agent test
pnpm --filter @fro-bot/workspace-agent check-types
pnpm --filter @fro-bot/workspace-agent lint
```
