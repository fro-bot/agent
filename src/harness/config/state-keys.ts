/**
 * State keys for main <-> post action handoff.
 *
 * These keys are used with core.saveState() in main action
 * and core.getState() in post action. State is persisted to a file
 * by GitHub Actions and made available as STATE_* environment variables.
 */
export const STATE_KEYS = {
  /** Whether the main action processed an event (vs skipped) */
  SHOULD_SAVE_CACHE: 'shouldSaveCache',
  /**
   * `'true'` when the run used `isolate-agent`, set at bootstrap from the input so a run whose sandbox never started
   * still counts. The post hook never retries a session save for such a run (the sandbox user wrote that state, and only
   * the main step can confirm it stopped and was restored), and it never reads the shared log directory for one.
   */
  ISOLATED_RUN: 'isolatedRun',
  /**
   * The sandbox teardown state (`pending`, `restored` or `unsafe`), written by the sandbox lifecycle: `pending` before
   * the account exists, `restored` only after a confirmed stop and take-back. On an isolated run the post hook reads and
   * uploads nothing from the sandbox-writable log directory unless this is `restored`: missing, `pending` and `unsafe`
   * all mean the main step did not finish the teardown.
   */
  SANDBOX_STATE: 'sandboxState',
  /**
   * The runner-owned copy of the OpenCode log directory this invocation took at its confirmed sandbox take-back (a
   * directory under `RUNNER_TEMP`). The shared log directory is re-handed to every later isolated step's sandbox, so on an
   * isolated run cleanup and the post hook read logs only from here. Absent: the run took none (its sandbox never started,
   * or the copy was discarded), and no logs are published.
   */
  LOG_SNAPSHOT_DIR: 'logSnapshotDir',
  /** Session ID used in this run (for logging) */
  SESSION_ID: 'sessionId',
  /** Whether main action already saved cache successfully */
  CACHE_SAVED: 'cacheSaved',
  /** Whether main action already uploaded log artifacts */
  ARTIFACT_UPLOADED: 'artifactUploaded',
  /**
   * Whether cleanup.ts already wrote the rich run metadata (token usage, timing, session
   * ids, PRs/commits, errors) to the object store this run. Distinguishes "cleanup ran and
   * its metadata upload succeeded" from "cleanup never ran at all" -- CACHE_SAVED's
   * `not-persisted` value is ambiguous between those two cases, since run.ts seeds that
   * same value before cleanup ever executes. Set unconditionally (independent of
   * CACHE_SAVED) so post.ts can skip re-writing metadata with its thin
   * `cleanupSkipped: true` placeholder and clobbering the rich payload.
   */
  CLEANUP_METADATA_WRITTEN: 'cleanupMetadataWritten',
  /**
   * Holder id of the Action coordination lock this run acquired. Set right after acquisition and cleared after a
   * successful release; if still set in the post hook, the main step died while holding the lock.
   */
  LOCK_HOLDER_ID: 'lockHolderId',
  /** `holder_job` of that lock (the job identity); absent when the run had none. Cleared together with the id. */
  LOCK_HOLDER_JOB: 'lockHolderJob',
  /** `acquisition_token` of that lock; the post hook releases only while the record still carries it. */
  LOCK_ACQUISITION_TOKEN: 'lockAcquisitionToken',
  S3_ENABLED: 'storeConfig.enabled',
  S3_BUCKET: 'storeConfig.bucket',
  S3_REGION: 'storeConfig.region',
  S3_PREFIX: 'storeConfig.prefix',
  S3_ENDPOINT: 'storeConfig.endpoint',
  S3_EXPECTED_BUCKET_OWNER: 'storeConfig.expectedBucketOwner',
  S3_ALLOW_INSECURE_ENDPOINT: 'storeConfig.allowInsecureEndpoint',
  S3_SSE_ENCRYPTION: 'storeConfig.sseEncryption',
  S3_SSE_KMS_KEY_ID: 'storeConfig.sseKmsKeyId',
} as const

export type StateKey = (typeof STATE_KEYS)[keyof typeof STATE_KEYS]
