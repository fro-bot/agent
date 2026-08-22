---
title: A relative response-file write silently discarded a completed review
date: 2026-08-21
category: security-issues
module: response-delivery
problem_type: security_issue
component: response-delivery
symptoms:
  - "OpenCode reports successful execution, but finalization fails with ENOENT reading the response file"
  - "The agent's review completed, then the entire review turn was discarded"
  - "Re-running the failed job succeeds, making the defect look like a flake"
root_cause: path_resolution_error
resolution_type: code_fix
severity: high
related_components:
  - agent-execution
  - setup
  - ci-workflows
tags:
  - response-file
  - relative-path
  - silent-failure
  - untrusted-input
  - privilege-boundary
  - enoent
---

## Problem

The harness tells the model to write its response to an absolute, run-scoped path under `RUNNER_TEMP`:

```text
${RUNNER_TEMP}/fro-bot-response/${runId}-${runAttempt}/${nonce}.md
```

OpenCode's Write tool accepts a relative path too. When the model dropped the absolute prefix, OpenCode resolved that path against the session directory instead:

```ts
const filepath = path.isAbsolute(params.filePath)
  ? params.filePath
  : path.join(instance.directory, params.filePath)
```

`src/features/agent/execution.ts` sets that session directory to `GITHUB_WORKSPACE`. The response therefore landed in contributor-writable checkout space while the harness later read the `RUNNER_TEMP` path. The completed review was not delivered.

## Symptoms

This happened intermittently — 1 occurrence in 1,340 CI PR reviews. The agent completed its review, invoked Write, and OpenCode reported:

```text
Completed OpenCode execution, success: true
```

Finalization then failed with:

```text
Failed to deliver the agent's response from <path>: file-read-failed
```

The job was discarded. A rerun usually succeeded, which made this read as an execution flake rather than a deterministic path-resolution failure.

## Why It Mattered Here

The response file is the handoff between untrusted model output and a trusted GitHub mutation. The expected artifact lives outside the checkout specifically so a pull-request author cannot plant or replace the file that determines what Fro Bot posts.

In run `32097721360`, the nonce and the `${runId}-${runAttempt}` segment were character-identical in the expected path and the file found under the workspace. Only the absolute prefix was missing. That rules out transcription corruption: the model reproduced the 32-character nonce exactly while dropping the prefix.

The failure was also silent. OpenCode's `packages/opencode/src/tool/write.ts` uses `fs.writeWithDirs`, which creates missing parent directories, then returns `"Wrote file successfully."` unconditionally. A misdirected write was therefore indistinguishable from a correct write from the tool result alone.

## What Didn't Work

Two plausible explanations were investigated first.

**Permission allowlist.** The external-directory pattern `/home/runner/work/_temp/fro-bot-response/*` looked suspicious because the actual response directory is nested below it. That was not the problem. OpenCode's `packages/opencode/src/util/wildcard.ts` translates `*` to `.*`, so the wildcard matches `/` and covers the nested run-scoped directory.

**Backgrounded writes.** The prompt warns against shell-heredoc writes that can outlive the turn, so a late shell process was also plausible. The failing run used the synchronous Write tool, not a shell redirect. There was no background writer to outlive execution.

Both theories explained a missing file. Neither explained a successful write with matching nonce and run identity in the checkout. The path-resolution behavior did.

## Solution

PR #1450 made the handoff explicit and fail safer. PR #1454 corrected it after the first attempt shipped a defect described below.

1. `packages/runtime/src/agent/response-file.ts` exports `buildResponseFileFallbackRoots(runnerTemp)`, the single definition of where a misresolved write can land: `[basename(runnerTemp), '']`, ordered observed-first. It builds the expected path plus one candidate per root, returning a candidate only when it remains strictly inside `GITHUB_WORKSPACE`; it cannot become a traversal primitive.
2. `src/features/agent/response-post.ts` probes the candidates in order and advances only after a read fails with `ENOENT`. Permission errors, I/O failures, and every other read error retain the previous failure behavior.
3. A response recovered from any fallback can never approve a pull request. An `approve` verdict is downgraded to a non-approving comment because checkout space is contributor-writable on `pull_request` events. Recovering the review body is useful; satisfying a required check from untrusted space is not.
4. `src/services/setup/ci-config.ts` derives its `edit` deny patterns from the same helper, so the guarded paths and the recovered paths cannot disagree. A future relative write fails during the run instead of succeeding silently.
5. `src/harness/phases/bootstrap.ts` checks every candidate before execution, creates the trusted directory, and logs only its directory. The nonce is no longer logged: it is the only value preventing a planted response file, and job logs are readable by anyone with repository read access, including the pull-request author.

### The first fix was inert

#1450 derived the fallback with `path.relative(RUNNER_TEMP, expectedPath)`. On a hosted runner `RUNNER_TEMP` is `/home/runner/work/_temp`, so that strips `_temp` and probed `${GITHUB_WORKSPACE}/fro-bot-response/...`. The model kept `_temp`; the file was at `${GITHUB_WORKSPACE}/_temp/fro-bot-response/...`. The recovery would not have fired on the incident that motivated it.

The deny rule in the same PR guarded the correct path. So the two halves of one defense were built on opposite assumptions about which prefix the model drops, in two files, each internally consistent. Reviewing either file in isolation showed nothing wrong. #1454 replaced both derivations with the shared helper, which is why the correction is a shared definition rather than a corrected string.

## Why This Works

The primary path remains the only trusted delivery path. The fallback is bounded, read only after an `ENOENT`, and explicitly marked as lower trust. Its content can still recover a useful review comment, but it cannot gain the authority to approve a pull request.

The deny rules address the original defect at its source. If OpenCode resolves the model's relative path into a plausible wrong checkout directory, the Write tool is rejected instead of creating directories and reporting success. Recovery is retained for already-produced artifacts and for versions of the path behavior that reach the reader before the deny rules do.

The general lesson is broader than response files: when a tool silently creates parent directories and reports unconditional success, a misdirected write is indistinguishable from a correct one. Any handoff that depends on a model reproducing an absolute path needs either a verification read or a deny rule on the plausible-wrong location.

The second lesson came from the failed correction. When one defense is split across a guard and a recovery, both must derive from a single definition of the thing being guarded. Two independent derivations of the same path will eventually disagree, and the disagreement is invisible in any single-file review: each half reads as correct on its own, and only comparing them across files exposes the contradiction.

## Prevention

- Treat model-supplied paths as untrusted even when the prompt supplies an absolute path. Resolve the path at the tool boundary, then verify the artifact at the path the consumer will read.
- For file handoffs, probe the expected location and make the known wrong location fail loudly. Do not infer correctness from a tool's unconditional success message.
- A recovery path that reads from a less-trusted location must not carry the same authority as the trusted path. Downgrade or withhold privileged outcomes, not just the log message.
- Preserve the distinction between `ENOENT` and other read failures. Missing-file recovery is not permission-error recovery.
- Never log the nonce or the response filename. Diagnostics need directory-level evidence; the nonce is the anti-preseed secret.
- When an intermittent missing artifact contains the expected nonce and run identity, compare absolute prefixes before investigating provider, permission, or concurrency flakes.
- Derive a guard and its matching recovery from one shared definition. If a deny rule and a fallback probe are written independently, review them against each other, not just against their own tests.
- Redact filenames in directory diagnostics, not only in path fields. Listing a directory re-leaks the filename that the surrounding redaction removed.
