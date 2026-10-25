# CACHE MODULE

**Location:** `src/services/cache/`

OpenCode state persistence via GitHub Actions cache with corruption detection and S3 backup.

## WHERE TO LOOK

| Component   | File           | Responsibility                                    |
| ----------- | -------------- | ------------------------------------------------- |
| **Restore** | `restore.ts`   | Cache restore with corruption detection (187 L)   |
| **Save**    | `save.ts`      | Cache save with S3 backup support (114 L)         |
| **Key**     | `cache-key.ts` | Deterministic cache key generation                |
| **Types**   | `types.ts`     | `CacheResult`, `CacheOptions`, `S3Options` (38 L) |
| **Dedup**   | `dedup.ts`     | Execution dedup sentinel restore/save (98 L)      |

## KEY EXPORTS

- `restoreCache(options, logger)`: Restores storage from GitHub/S3 cache
- `saveCache(options, logger)`: Persists storage to GitHub/S3 cache
- `buildSaveCacheKey(components, runId, runAttempt, invocationIdentity)`: `{primary}-{runId}-{runAttempt}[-{identity}]`; `saveCache` derives attempt and identity itself (`getInvocationIdentity()`), so the post-hook retry uses the key the main step tried
- `restoreDeduplicationMarker(repo, entity, logger)`: Restores recent dedup sentinel
- `saveDeduplicationMarker(repo, entity, marker, logger)`: Saves dedup sentinel after execution

## PATTERNS

- **Corruption Detection**: Validates `storage-read.ts` compatibility after restore.
- **S3 Backup**: Optional write-through to S3 for long-term persistence (RFC-019).
- **Post-Action Hook**: `saveCache` is typically called from `src/harness/post.ts` (RFC-017). The hook holds no coordination lease, so it passes `objectStorePublish: 'withhold'` and the retry writes the Actions cache only; the object store keeps one shared session object per repo, written by the main step while it holds the lease.
- **Branch Isolation**: Cache keys are scoped by branch to prevent state leakage.
- **Job Isolation**: The save key carries the job (`GITHUB_JOB` + matrix-leg hash) after `{runId}-{runAttempt}`, so sibling jobs of one run never collide. Keep the identity a suffix — restore prefixes must keep matching old entries without it.
- **Collision != Success**: An "already exists" throw from `saveCache` is `cache-rejected` (not-persisted, retried by the post hook), never `persisted`.

## ANTI-PATTERNS

- **Fatal Restore**: A cache miss is a warning, not an error.
- **Blocking Save**: S3 upload should be best-effort in the main step.
- **Unleased Publish**: Never call `saveCache` with `objectStorePublish` omitted or `'publish'` from a caller that does not hold the coordination lease; the upload is an unconditional last-writer-wins write. `runCleanup` publishes only when the run acquired the Action lock (a lock ETag or a lease renewal); a run that returned before `runAcquireLock` (a dedup or routing skip) writes the Actions cache only.
- **Credential Logging**: Never log S3 access keys or session tokens.
