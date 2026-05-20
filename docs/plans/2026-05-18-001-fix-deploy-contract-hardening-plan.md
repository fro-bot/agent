---
title: 'fix: deploy contract hardening for external IaC consumers'
type: fix
status: active
date: 2026-05-18
deepened: 2026-05-18
---

# fix: deploy contract hardening for external IaC consumers

## Overview

Three concrete deploy-contract gaps surfaced during the first external infra-as-code deploy attempt against `fro-bot/agent` v0.44.0. Two are real and block first-deploy from external repos:

1. The S3 adapter constructs `S3Client` without explicit `credentials:`, falling back to the AWS SDK default credential chain (env / `~/.aws` / IMDS) — all of which fail inside the gateway container on self-hosted hosts like DigitalOcean.
2. The gateway container's Dockerfile healthcheck is a literal no-op (`node -e 'process.exit(0)'`) and the compose override only checks for the mitmproxy CA cert in the shared volume. Neither proves the gateway is actually connected to Discord; `docker compose up --wait` returns success even when the daemon has crashed at startup.

Plus two small hardening items that came up while verifying the above:

3. Bind-mounted secret paths that don't exist on the host become directories under default Docker compose behavior; `existsSync()` passes and `readFileSync()` throws a raw `EISDIR` with no actionable message.
4. Compose has no `logging:` block, so the default unbounded `json-file` driver can fill a small droplet's disk before the operator notices.

This work lands as a coordinated patch series in a single PR so external infra repos can pin to one version of fro-bot/agent and have a complete deploy contract.

## Problem Frame

External operators deploying gateway via infra-as-code repositories (Terraform, Pulumi, NixOS, Ansible) need a deploy contract they can wire to without reading source. The contract today omits AWS credentials wiring entirely and ships a healthcheck that lies. First-deploy attempts succeed at `compose up --wait` but fail at runtime, which is the worst kind of contract violation.

The two stale claims in the original handoff brief (`DISCORD_GUILD_ID` plumbing and empty-secret-file handling) were already addressed in PRs #638 and #644 last session. Verified against current `main` (HEAD `b8298bc`, tag `v0.44.0`) before scoping this plan.

## Requirements Trace

- R1. The S3 adapter accepts explicit AWS credentials via secret files when present (including the optional `AWS_SESSION_TOKEN` for STS temporary credentials), falls back to the SDK default credential chain when absent, and fails fast when the access-key / secret-key pair is partially set.
- R2. The deploy compose stack documents and mounts the AWS credential secrets following the same pattern as Discord and S3 secrets (`*_FILE` env vars + bind-mount).
- R3. `docker compose up --wait` only reports the gateway as healthy when the Discord client has emitted the `ready` event and the daemon is alive.
- R4. The configured ready signal is cleared on container start so a stale flag from a previous run cannot mask a current-run failure.
- R5. Bind-mounted secret paths that resolve to directories produce a clear, actionable error message at startup.
- R6. Compose log output is bounded so a small VM cannot run out of disk from gateway log accumulation.
- R7. `deploy/README.md` reflects the new AWS secret files and updated healthcheck behavior without exposing internal session or planning artifacts.

## Scope Boundaries

- Not adding mandatory AWS credentials. They remain optional so the current "Discord-plumbing-only" testing workflow keeps working.
- Not touching the workspace container's missing `NODE_EXTRA_CA_CERTS` / CA cert mount. That's a Unit 7 (workspace agent) concern.
- Not adding resource limits (`mem_limit` / `cpus`). No clear "right" default for a deploy stack consumed by external operators with varying host sizes.
- Not adding an HTTP `/healthz` endpoint. Unit 7 is the right time for that.
- Not redesigning the secrets management approach (Docker Swarm secrets, sops, age). Bind-mount + file is the v1 contract.

### Deferred to Separate Tasks

- Workspace CA cert + `NODE_EXTRA_CA_CERTS` mount: deferred to Unit 7 (workspace agent), `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md`.
- HTTP `/healthz` endpoint: deferred to Unit 7.
- Resource limits and observability defaults: tracked locally as a follow-up todo.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/config.ts:28-58` — `readSecret`/`readOptionalSecret` helpers. The pattern to follow when adding AWS credential reads.
- `packages/gateway/src/config.ts:65-101` — `loadGatewayConfig` assembly. Where new AWS credential fields and the credentials sub-object on `ObjectStoreConfig` get wired.
- `packages/runtime/src/object-store/s3-adapter.ts:90-103` — `createClient` is the only construction site for `S3Client`; both branches (custom endpoint / AWS default) need the new conditional `credentials:` block.
- `packages/runtime/src/object-store/types.ts` — `ObjectStoreConfig` interface. Adds an optional `credentials?: { accessKeyId, secretAccessKey, sessionToken? }` field.
- `packages/gateway/src/main.ts:49-100` — the Effect program that constructs the client and runs the startup sequence. Where the `ready` event handler attaches and `/tmp/gateway-ready` gets touched.
- `packages/gateway/src/discord/client.ts:30-66` — `createDiscordClient`. Existing shard-event handlers show the pattern for one-time event handlers; the `ready` handler attaches in `main.ts` between client creation and `login()`.
- `deploy/compose.yaml:16-51` — gateway service. Pattern to follow when adding AWS file mounts and updating the healthcheck.
- `deploy/gateway.Dockerfile:41-43` — the no-op healthcheck site.
- `packages/gateway/src/config.test.ts:161-184` — existing test pattern for `readOptionalSecret` empty-file behavior. Pattern to extend for new AWS credential cases.

### Institutional Learnings

- PR #644 (commit `a16391a`): testing ergonomics — establishes the "operator creates empty file when omitting an optional secret" pattern. AWS credentials should follow this so external IaC can `touch deploy/secrets/aws-access-key-id` without setting it.
- PR #638 (commit `7234d25`): `OBJECT_STORE_HOSTS` env-var allowlist, fail-closed defaults. The mitmproxy allowlist already validates outbound hosts, so even with broken AWS credentials the egress side is not at risk.
- Memory ID 3155 (this session, prior conversation): when amending a commit with new working-tree fixes, stage explicitly first, then `git commit --amend`. `git reset --soft` discards unstaged working-tree changes.

### External References

- AWS SDK v3 S3Client `credentials` accepts `AwsCredentialIdentity | AwsCredentialIdentityProvider`. The identity shape is `{ accessKeyId, secretAccessKey, sessionToken? }`. Verified in `node_modules/@aws-sdk/client-s3/dist-types/S3Client.d.ts:12,72`. SDK version `3.1045.0` per `package.json`.
- Docker Compose `logging:` driver options: `json-file` with `max-size` and `max-file` is the standard rotation pattern. Both options take size strings like `"10m"` and integer file counts.
- Discord.js v14 emits both `'ready'` (deprecated) and `'clientReady'` (canonical, recommended) when the gateway is fully connected. Verified in `node_modules/discord.js/src/util/Events.js:15,111` and `node_modules/discord.js/src/client/websocket/WebSocketManager.js:375-392`. Use `'clientReady'` as the canonical name; both fire on the same condition in v14.26.4.

## Key Technical Decisions

- **Credentials field on `ObjectStoreConfig`, not env-var promotion.** Explicit constructor injection keeps the credential material out of process env vars where child processes inherit it, and keeps the gateway / workspace `_FILE` contract symmetric with the rest of the secrets. Rejected env-var promotion (set `AWS_ACCESS_KEY_ID` from `*_FILE` at startup) for the same reason.
- **Both-or-neither validation at config layer, not adapter.** If exactly one of `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` is set (the required pair), fail fast in `loadGatewayConfig` with a clear error. `AWS_SESSION_TOKEN` is independent: it can be set without invalidating the config (becomes part of `credentials` when the pair is present) but is ignored when no pair is set. Don't pass a half-constructed credentials object to the adapter.
- **Optional credentials preserve SDK default chain.** When both are absent, do not set `credentials:` on the `S3Client` constructor — the SDK default chain (env, `~/.aws`, IMDS) takes over. This keeps IRSA / EC2-instance-role deployments working without code change.
- **Readiness signal via filesystem flag, not HTTP probe.** `/tmp/gateway-ready` is touched after Discord `'clientReady'` event, cleared at process startup so stale flags from container restarts cannot mask a current-run failure. Healthcheck combines file-exists + PID-1-alive (`test -f /tmp/gateway-ready && kill -0 1`). HTTP probe adds a new port + listener for v1; not worth the surface area. Log-grep approach rejected as brittle.
- **Healthcheck moves from compose to Dockerfile.** Compose currently overrides the Dockerfile healthcheck to check the mitmproxy CA cert in the shared volume — that's the wrong concern (CA-cert presence is gated by `depends_on.mitmproxy.condition: service_healthy` already). The Dockerfile becomes authoritative for gateway readiness; compose drops the override.
- **Secret-path guard: `isFile()` check, not `try/catch`.** `statSync(filePath).isFile()` is cheap and gives a clearer signal than catching `EISDIR` after the fact.
- **Log rotation: `max-size: "10m"`, `max-file: "3"`.** Defaults that keep a small droplet healthy without losing the last few minutes of context during an incident.

## Open Questions

### Resolved During Planning

- **Which Discord event do we hook?** `'clientReady'` is the canonical name in discord.js v14; `'ready'` is deprecated but still emitted on the same condition. Use `'clientReady'` to be forward-compatible with v15 when the deprecated event is removed.
- **Where does the readiness handler attach?** In `main.ts` after `createDiscordClient` returns the client and before `client.login()`. Uses `client.once('clientReady', ...)` so it fires exactly once; reconnects don't re-touch the file (they don't need to — the file is for "this process has been ready at least once").
- **Should the `/tmp` directory be a tmpfs?** No. Default container `/tmp` works. Adding a tmpfs adds another compose surface for external IaC to wire.
- **Should we add `discord-guild-id` to the AWS-style "always-mount-empty-when-omitted" pattern?** Already done in PR #644. No action.

### Deferred to Implementation

- Exact wording of `loadGatewayConfig` error messages for partial AWS credentials. Match the existing `Missing required secret: ...` style.
- Whether to log "Discord ready" at info level when the flag file is touched (probably yes, for operator visibility, but not contract-critical).

## Implementation Units

- [ ] **Unit 1: AWS credential plumbing (config + adapter + tests)**

**Goal:** Read optional AWS credentials from secret files in `loadGatewayConfig`, pass them through `ObjectStoreConfig`, and inject them into the `S3Client` constructor when both are present.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**

- Modify: `packages/runtime/src/object-store/types.ts`
- Modify: `packages/runtime/src/object-store/s3-adapter.ts`
- Modify: `packages/gateway/src/config.ts`
- Test: `packages/gateway/src/config.test.ts`
- Test: `packages/runtime/src/object-store/s3-adapter.test.ts` (create if absent; check whether existing tests already cover construction)

**Approach:**

- Add an `AwsCredentials` type to `types.ts`: `{ readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }`. Then `ObjectStoreConfig.credentials?: AwsCredentials` (optional, read-only).
- In `s3-adapter.ts:90-103`, both `createClient` branches (custom endpoint and AWS default) gain a conditional `...(config.credentials != null ? { credentials: config.credentials } : {})` spread. SDK default chain remains active when absent.
- In `config.ts:65-101`, after the existing S3 reads, add:
  - `const awsAccessKeyId = readOptionalSecret('AWS_ACCESS_KEY_ID')`
  - `const awsSecretAccessKey = readOptionalSecret('AWS_SECRET_ACCESS_KEY')`
  - `const awsSessionToken = readOptionalSecret('AWS_SESSION_TOKEN')`
  - Pair validation: if exactly one of `awsAccessKeyId`/`awsSecretAccessKey` is non-null, throw with `Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (received: <which is set>). Set both, or set neither to use the SDK default credential chain.`
  - Session-token wiring: if the pair is present, build `credentials: { accessKeyId, secretAccessKey, ...(awsSessionToken !== null ? { sessionToken: awsSessionToken } : {}) }`. If the pair is absent and `awsSessionToken` is set, emit a single info-level warning (`AWS_SESSION_TOKEN is set without AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY; ignoring it and falling back to SDK default credential chain.`) and do not set `credentials`.
- Match the existing `?? undefined` / conditional-spread idiom in `loadGatewayConfig` so the assembled object stays clean.

**Patterns to follow:**

- `config.ts:72` — `const s3Endpoint = readOptionalSecret('S3_ENDPOINT') ?? undefined` is the pattern for optional fields.
- `config.ts:89-90` — conditional spread (`...(s3Endpoint === undefined ? {} : {endpoint: s3Endpoint})`) is the pattern for conditional object fields.
- `s3-adapter.ts:94-103` — two-branch client construction. Both branches need the same conditional credentials spread.

**Test scenarios:**

- Happy path: both `AWS_ACCESS_KEY_ID_FILE` and `AWS_SECRET_ACCESS_KEY_FILE` point at non-empty files → `loadGatewayConfig().objectStore.credentials` is `{ accessKeyId, secretAccessKey }` (no `sessionToken`).
- Happy path: all three (`AWS_ACCESS_KEY_ID_FILE`, `AWS_SECRET_ACCESS_KEY_FILE`, `AWS_SESSION_TOKEN_FILE`) set → `objectStore.credentials` is `{ accessKeyId, secretAccessKey, sessionToken }`.
- Happy path: neither access-key nor secret-key env var is set → `objectStore.credentials` is `undefined` (SDK default chain takes over).
- Edge case: empty `AWS_ACCESS_KEY_ID` file (whitespace-only) is treated as absent — consistent with existing `readOptionalSecret` behavior. If both files are empty, `credentials` is `undefined`.
- Edge case: pair present + `AWS_SESSION_TOKEN_FILE` points at an empty file → `sessionToken` is omitted (`readOptionalSecret` already returns null for empty files).
- Error path: only `AWS_ACCESS_KEY_ID_FILE` set, `AWS_SECRET_ACCESS_KEY_FILE` absent → `loadGatewayConfig()` throws with a message naming the missing one.
- Error path: only `AWS_SECRET_ACCESS_KEY_FILE` set → throws with a message naming the missing one.
- Edge case: `AWS_SESSION_TOKEN_FILE` set but pair absent → no throw; `credentials` is `undefined`; a single info-level message is logged about the orphan session token.
- Integration (adapter-level): when `ObjectStoreConfig.credentials` is set, the `S3Client` constructor is called with that exact credentials object. When absent, `S3Client` is called without a `credentials:` key. Verify via spy or `vi.mock` on `@aws-sdk/client-s3`.

**Verification:**

- `pnpm --filter @fro-bot/gateway test` and `pnpm --filter @fro-bot/runtime test` both pass with new tests included.
- `pnpm check-types` clean across the workspace.
- `pnpm lint` clean.

- [ ] **Unit 2: Compose AWS credential mounts + log rotation + secret-path guard**

**Goal:** Wire the new AWS credential `*_FILE` env vars + bind-mounts in `deploy/compose.yaml`. Add bounded `logging:` to gateway, workspace, and mitmproxy. Add the `isFile()` guard to `readOptionalSecret` so directory-as-secret-path fails with a clear error.

**Requirements:** R2, R5, R6

**Dependencies:** Unit 1 (the env-var names and contract come from Unit 1's config schema).

**Files:**

- Modify: `deploy/compose.yaml`
- Modify: `packages/gateway/src/config.ts` (the `readOptionalSecret` guard)
- Test: `packages/gateway/src/config.test.ts`

**Approach:**

- In `deploy/compose.yaml` gateway service `environment:`, add three entries: `AWS_ACCESS_KEY_ID_FILE: /run/secrets/aws_access_key_id`, `AWS_SECRET_ACCESS_KEY_FILE: /run/secrets/aws_secret_access_key`, `AWS_SESSION_TOKEN_FILE: /run/secrets/aws_session_token` (same pattern as existing S3 entries).
- In `deploy/compose.yaml` gateway `volumes:`, add three bind-mounts: `- ./secrets/aws-access-key-id:/run/secrets/aws_access_key_id:ro`, `- ./secrets/aws-secret-access-key:/run/secrets/aws_secret_access_key:ro`, `- ./secrets/aws-session-token:/run/secrets/aws_session_token:ro` with comments noting they're optional and operators should `touch` empty files to omit (matching `discord-guild-id` pattern). The session-token comment should call out it's only used for STS temporary credentials.
- Add `logging:` blocks to gateway, workspace, and mitmproxy services using `driver: json-file` with `options: { max-size: "10m", max-file: "3" }`.
- In `config.ts:43`, change the file-existence check from `if (filePath !== undefined && existsSync(filePath))` to also assert `statSync(filePath).isFile()`. On `existsSync && !isFile`, throw with `Secret path is a directory, not a file: ${filePath} (the bind-mount source likely doesn't exist on the host)`. Note: `statSync` can throw `EACCES` on permission errors and `ENOENT` if the file disappears between `existsSync` and `statSync` (TOCTOU); both should surface as clear startup errors, not be swallowed.

**Patterns to follow:**

- `deploy/compose.yaml:32-40` — existing secret mount pattern.
- `deploy/compose.yaml:37-39` — comment-driven empty-file pattern for optional secrets.
- `deploy/README.md` step-2 block — operator-facing `touch` instructions live here too (see Unit 3).

**Test scenarios:**

- Happy path: file exists at the bind-mount path → reads normally.
- Error path: bind-mount source missing on host → mounts as directory → `readOptionalSecret('AWS_ACCESS_KEY_ID')` throws with the new directory-not-file error.
- Integration: `docker compose -f deploy/compose.yaml config --quiet` exits 0 (validates the merged compose syntax). Note this requires `deploy/secrets/aws-access-key-id` and `deploy/secrets/aws-secret-access-key` to exist (even empty) — `validate-stack.sh` should be updated.

**Verification:**

- `pnpm --filter @fro-bot/gateway test` passes new directory-guard test.
- `docker compose -f deploy/compose.yaml config --quiet` exits 0 after running `touch deploy/secrets/aws-{access-key-id,secret-access-key}`.

- [ ] **Unit 3: Gateway readiness healthcheck + docs**

**Goal:** Replace the no-op Dockerfile healthcheck with a real readiness check backed by a `/tmp/gateway-ready` flag file touched by the Discord `ready` handler. Remove the compose healthcheck override (the Dockerfile's becomes authoritative). Update `deploy/README.md` to reflect AWS credentials + the readiness behavior.

**Requirements:** R3, R4, R7

**Dependencies:** None (independent of Units 1 and 2 — touches the runtime entrypoint and Dockerfile, not config schema or compose secrets).

**Files:**

- Modify: `packages/gateway/src/main.ts`
- Modify: `deploy/gateway.Dockerfile`
- Modify: `deploy/compose.yaml` (remove the gateway healthcheck override block)
- Modify: `deploy/README.md`
- Modify: `deploy/.env.example` (operator-facing doc updates if needed)
- Test: `packages/gateway/src/main.test.ts` (verify; may not exist — add minimal coverage if absent)

**Approach:**

- In `main.ts`, between `createDiscordClient(...)` (step c) and `client.login(...)` (step h): clear `/tmp/gateway-ready` synchronously (best-effort, swallow `ENOENT`); register `client.once('clientReady', ...)` that touches `/tmp/gateway-ready` (the file's mere presence is the signal; content is empty). Log at info level when the file is touched.
- In `gateway.Dockerfile:41-43`, replace the no-op with `HEALTHCHECK --interval=10s --timeout=3s --retries=12 --start-period=45s CMD test -f /tmp/gateway-ready && kill -0 1 || exit 1`. Tighter interval since startup is the critical window. `start_period: 45s` accommodates cold image start + npm cold cache + Discord WebSocket handshake variance on small VMs (oracle and feasibility flagged 30s as slightly tight).
- In `deploy/compose.yaml:47-51`, remove the gateway-service `healthcheck:` override block. The Dockerfile's becomes authoritative.
- In `deploy/README.md`, update the operator setup section to add the AWS credential `touch` instructions (mirroring the `discord-guild-id` and `s3-endpoint` patterns) and replace any text that claims the healthcheck "succeeds when the CA cert is present" with the new readiness semantics.

**Patterns to follow:**

- `main.ts:55-65` — Effect.gen step ordering. The ready-flag setup goes in the same style.
- `deploy/compose.yaml:92-101` — mitmproxy healthcheck shows the `interval`/`timeout`/`retries`/`start_period` knob conventions.
- `deploy/README.md` "step 2 — Create secrets" — existing `touch` + commented `echo` pattern for optional secrets is the template for AWS credentials.

**Test scenarios:**

- Happy path: gateway startup → `/tmp/gateway-ready` cleared → Discord `'clientReady'` event fires → file is created → healthcheck script (`test -f /tmp/gateway-ready && kill -0 1`) exits 0. Verify via mock Discord client emitting `'clientReady'`.
- Edge case: stale `/tmp/gateway-ready` left over from previous process → file is removed at process start → healthcheck reports unhealthy until current Discord client is ready.
- Edge case: `/tmp/gateway-ready` cleanup at startup tolerates `ENOENT` (no such file) without crashing.
- Integration: `docker compose -f deploy/compose.yaml up -d` followed by `docker compose -f deploy/compose.yaml ps --filter health=healthy` shows the gateway as healthy only after Discord ready event. (Manual smoke test; not asserted in unit test.)

**Verification:**

- New healthcheck unit test passes.
- `deploy/README.md` reads naturally and matches the existing voice (first-person, no session leakage).
- Manual smoke: with a real Discord token, `docker compose up --wait` succeeds only after the gateway actually connects.

## System-Wide Impact

- **Interaction graph:** `loadGatewayConfig` ↔ `createS3Adapter` ↔ `S3Client`. The new `credentials` field travels along the existing `ObjectStoreConfig` path. No new modules involved.
- **Error propagation:** Partial AWS credentials throw at config-load (process startup, before Discord login). Empty/missing optional secrets continue to return `null` per existing behavior. Directory-as-secret-path throws at first `readOptionalSecret` call with the new clear message.
- **State lifecycle risks:** The `/tmp/gateway-ready` flag is per-process: cleared on startup, touched on first `ready`. Container restart correctly invalidates the prior process's readiness. The flag has no relation to reconnects — the gateway is considered ready as long as it was ready once and PID 1 is still alive. If Discord disconnects long enough that the client is permanently broken, the healthcheck will still report healthy because PID 1 is alive. This is acceptable for v0.44.x; a real liveness probe is Unit 7 work.
- **API surface parity:** No new public APIs. `ObjectStoreConfig` is an internal interface used only between gateway and runtime; the optional `credentials` field is additive.
- **Integration coverage:** The Dockerfile healthcheck is verified manually (the test would require a running container). Unit tests cover the underlying `ready` handler behavior.
- **Unchanged invariants:** Existing operators with no AWS credentials configured continue to work (SDK default chain takes over). Existing operators using IRSA / EC2-instance-role continue to work. The compose stack's mitmproxy egress allowlist is unchanged. Discord-only "testing plumbing" deploys (per `deploy/README.md`) continue to work without setting AWS credentials.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Healthcheck change surprises existing operators who didn't realize their deploys were succeeding under a no-op check | Mention prominently in PR body + `deploy/README.md` update. The "surprise" is exposing already-broken deployments, not creating new failure. |
| Operators with valid AWS credentials in env vars (not files) lose them | Not applicable — the `_FILE` pattern is additive. Operators using env vars directly continue to work via the SDK default chain. |
| `/tmp/gateway-ready` cleanup race if startup is interrupted between unlink and listener attach | Cleanup is best-effort and tolerates `ENOENT`. Attach the `'clientReady'` listener before `login()` so the listener is guaranteed registered before any chance of the event firing. |
| `statSync` TOCTOU race: file disappears between `existsSync` and `statSync`, or `EACCES` on a permission-restricted secret path | Both surface as startup errors with the file path in the message; let them throw rather than swallow. Operators get a clear signal to check the bind-mount permissions. |
| Log rotation defaults too aggressive for high-traffic operators | `max-size: "10m"` × `max-file: "3"` = 30 MB per container. Conservative for the testing-targeted v0.44.x deploy. Operators with real volume can override via their own `compose.override.yaml`. |
| Workspace container picks up the broken-healthcheck pattern when Unit 7 lands | Document in this PR's body that workspace will need its own readiness story. Tracked in todo 010 (mitmproxy HTTP probe — partial). |

## Documentation / Operational Notes

- **README updates** (Unit 3): AWS credential `touch` block matching `discord-guild-id` pattern. Replace any "CA cert present = healthy" framing.
- **`.env.example`**: review for any references to the old healthcheck behavior; update if needed.
- **CHANGELOG**: Not maintained as a separate file — release notes come from squash-merge commit messages per repo convention. PR body needs to clearly describe the operator-facing changes.
- **Cross-repo coordination**: Marcus runs `marcusrbrown/infra` against this stack. Once this PR is merged and a v0.44.x tag ships, `apps/gateway/upstream.json` in the infra repo bumps to the new version. The PR body should link forward to the eventual infra-side issue/PR.

## Sources & References

- Verified state of current `main` (HEAD `b8298bc`, tag `v0.44.0`) via direct file reads documented in this session's transcript.
- Oracle verification pass — confirmed Gaps 1 and 3 are stale on current main, Gap 2 is real with caveat (gateway daemon does not yet call S3), Gap 4 is real.
- Feasibility verification pass — confirmed `@aws-sdk/client-s3@3.1045.0` accepts `AwsCredentialIdentity | AwsCredentialIdentityProvider` for the `credentials:` field, `sessionToken` is part of the identity shape, and discord.js v14.26.4 emits both `'ready'` (deprecated) and `'clientReady'` (canonical).
- Prior related PRs: #638 (security closeout), #644 (testing ergonomics) — established the `*_FILE` + bind-mount + `touch` pattern.
- Gateway v1 plan: `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md` — Unit 7 carries the deferred items (workspace CA, HTTP healthz).
- AWS SDK v3 `S3Client` credentials: `node_modules/@aws-sdk/client-s3/dist-types/S3Client.d.ts:12,72`.
- discord.js `Events` constants: `node_modules/discord.js/src/util/Events.js:15,111`. `WebSocketManager` ready emit: `node_modules/discord.js/src/client/websocket/WebSocketManager.js:375-392`.
