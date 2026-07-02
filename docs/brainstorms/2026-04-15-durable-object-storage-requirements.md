---
date: 2026-04-15
topic: durable-object-storage
---

# Durable Object Storage Substrate

## Problem Frame

Fro Bot's persistence is built on GitHub Actions cache — a 7-day TTL, 10GB-capped, branch-scoped, runner-local store. This works for the current reactive GitHub Action but blocks every planned evolution:

- **Gateway/daemon mode** can't use GitHub cache (it runs outside Actions)
- **Discord interface** has no access to Actions cache
- **Cross-runner portability** fails when cache keys don't match
- **Session continuity** breaks on cache eviction after 7 idle days

The storage layer needs to become durable, portable, and provider-agnostic so that sessions, artifacts, and run metadata survive across runtimes, channels, and cache churn.

## Requirements

- R1. S3-compatible object storage is the **canonical source of truth** for all persistent state. GitHub Actions cache becomes an optional read-through accelerator, not the primary backend.
- R2. The storage layer works with any S3-compatible API via custom endpoint configuration: AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi, etc. Uses `@aws-sdk/client-s3` with configurable endpoint.
- R3. Four content types are persisted to object storage in v1:
  - **Sessions + messages** — the SQLite DB or exported session data
  - **Prompt artifacts** — prompt text files currently saved to the log directory
  - **Attachments** — reference files (pr-description.txt, etc.) materialized during prompt building
  - **Run metadata** — token usage, timing, artifact URLs, error logs per run
- R4. In GitHub Action mode, when S3 is configured: restore from GitHub cache first (fast, free). On cache miss, fall back to S3 read. Write-through to both S3 and cache on save. Eliminates cold-start S3 latency on cache hit.
- R5. In non-Action modes (future gateway/Discord), S3 is the only persistence backend. No GitHub cache dependency.
- R6. S3 key structure uses prefix isolation by agent identity and repository: `{prefix}/{agentIdentity}/{sanitizedRepo}/...`
- R7. S3 failures are logged but never fail the run. Degraded persistence is acceptable; crashing is not.
- R8. Credentials are sourced from environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) or IAM roles. Never logged. Action inputs configure bucket, region, prefix, and optional custom endpoint.
- R9. The storage abstraction is a clean adapter interface that the session layer, prompt pipeline, and observability layer can call without knowing the backend. Same interface works for S3 in Action mode, S3 in gateway mode, and potential future backends.

## Success Criteria

- Sessions survive GitHub Actions cache eviction — after 7+ idle days, a new run restores from S3 with no data loss.
- Switching S3 providers (e.g., AWS → R2) requires only endpoint + credential changes, no code changes.
- Non-Action runtimes (future gateway, Discord) can read/write the same session data via S3 without any GitHub dependency.
- Prompt artifacts and run metadata are queryable in S3 for debugging and observability.

## Scope Boundaries

- NOT persisting wiki pages to S3 — they live in git and are already version-controlled.
- NOT implementing a gateway or Discord runtime — this is the storage foundation they'll use.
- NOT removing GitHub Actions cache — it stays as an accelerator when available.
- NOT implementing multi-tenant isolation — single-repo-per-config is sufficient for v1. Multi-tenancy is a gateway concern.
- NOT implementing real-time sync or conflict resolution — write-through is append-mostly; the latest write wins.

## Key Decisions

- **S3 canonical, cache accelerator**: S3 is the source of truth. GitHub cache avoids S3 reads when warm. This inverts RFC-019's "cache primary, S3 backup" model. Rationale: every planned evolution (gateway, Discord, daemon) needs storage that works without GitHub Actions.
- **S3-compatible only**: No multi-protocol abstraction for Azure Blob or GCS. The S3 API is the de facto standard — R2, B2, MinIO, Wasabi, DO Spaces all support it. `@aws-sdk/client-s3` with custom endpoint covers the target surface.
- **Custom endpoint support**: Action input for endpoint URL enables non-AWS providers without code changes.
- **4 content types in v1**: Sessions, prompt artifacts, attachments, run metadata. Wiki stays in git. Scoped to what the current harness produces.
- **Adapter interface**: Storage operations go through a clean interface so the session layer doesn't know whether it's talking to S3, cache, or a future backend.

## Dependencies / Assumptions

- RFC-019 provides the technical foundation — S3 client operations, key structure, sync logic, IAM policy, and test patterns. The implementation should build from RFC-019's spec while inverting the storage hierarchy.
- `@aws-sdk/client-s3` (modular SDK v3) is the only new runtime dependency.
- Action inputs for S3 config already exist in `action.yaml` (`s3-backup`, `s3-bucket`, `s3-region`, `s3-prefix`).
- GitHub Actions cache adapter (`src/services/cache/`) is already abstracted — extending it with S3 fallback is incremental.

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] Should sessions be synced as raw SQLite files or exported as JSON? SQLite files are simpler but not queryable in S3. JSON is queryable but requires serialization logic.
- [Affects R4][Technical] What's the write-through strategy for prompt artifacts and run metadata? Should they be written during execution or batched in the finalize phase?
- [Affects R6][Needs research] Should the S3 key structure match RFC-019 exactly, or evolve to support the 4 content types as separate prefixes (e.g., `sessions/`, `artifacts/`, `metadata/`)?
- [Affects R8][Technical] Should a custom endpoint input be added to `action.yaml` now, or deferred until a non-AWS provider is actually needed?
- [Affects R9][Technical] What does the storage adapter interface look like? Should it expose CRUD operations on typed content, or raw get/put/list on keys?

## Next Steps

→ `/ce:plan` for structured implementation planning
