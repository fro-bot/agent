---
title: A failed run reported success because it had no delivery surface
date: 2026-08-07
category: logic-errors
module: response-delivery
problem_type: logic_error
component: development_workflow
symptoms:
  - "A CI job reports success while producing no work product at all"
  - 'The log contains "Cannot post error comment: missing target context" next to a recoverable LLM error'
  - "Downstream jobs fail on a misleading symptom instead of the real cause"
  - "The agent step finishes far faster than a real run (seconds instead of minutes)"
  - "The failing job uploads no artifacts, so the underlying provider error is unrecoverable"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - exit-code
  - fail-closed
  - silent-failure
  - diagnosability
  - artifact-upload
---

# A failed run reported success because it had no delivery surface

## Problem

An agent run died early with a provider error, merged nothing, and pushed nothing — and the job reported **success**. Six downstream build jobs then failed on a missing artifact, pointing every diagnostic effort at the wrong place. The run was invisible for two compounding reasons: the exit code lied, and the job that most needed logs uploaded none.

## Symptoms

- The job is green but produced no work product.
- The log pairs a recoverable LLM error with `Cannot post error comment: missing target context`.
- The agent step's duration is wildly short compared to a healthy run (here: 51 seconds against a normal ~15 minutes) — a strong tell that the session died at startup rather than doing the work.
- Downstream consumers fail on the _absence_ of the expected output, so the visible error names a symptom, not the cause.
- The run produced no log artifact, leaving only a generic `APIError; status=400` with no provider detail.

## What Didn't Work

Reading the downstream failure at face value. `fatal: couldn't find remote ref` describes a missing input, and it is tempting to investigate the thing that consumes the ref. The producing job had already declared success, so it does not look like a suspect. The short agent duration was the only signal pointing upstream.

## Solution

### 1. Fail when the failure cannot be delivered

The finalize path returned `0` for a recoverable LLM error on the assumption that the error had been reported to a human as a comment. That assumption silently breaks when there is no comment target — for example a `workflow_dispatch`/`schedule` run, or any job configured with no response surface:

Previously the unresolvable-target case logged a warning and fell through to `return 0`. The fix treats it as the failure it is:

```ts
} else {
  logger.warning("Cannot post error comment: missing target context")
  core.setFailed(
    "Agent execution failed with a recoverable LLM error, and no delivery surface was available to report it.",
  )
  return execution.exitCode === 0 ? 1 : execution.exitCode
}
```

The resolvable-target path is deliberately unchanged: there the failure _was_ delivered, the reader can see it, and returning `0` still encodes something true. The `setFailed` text is fixed and action-owned — no provider-controlled content reaches it.

### 2. Make the failure diagnosable

The log artifact upload already existed but was gated on an environment flag that this workflow never set, so the one job whose only other output is a pushed ref produced nothing to inspect:

```yaml
- name: Run Fro Bot
  uses: ./
  env:
    # Keep provider-level failures diagnosable; the pushed ref is this job's only other output.
    OPENCODE_PROMPT_ARTIFACT: "true"
```

If the job runs under an egress-blocking hardener, confirm the artifact endpoints are reachable rather than assuming. In the run logs, permitted hosts appear as `endpoint called …` while denied hosts appear as `domain not allowed: …`.

## Why This Works

Exit `0` was encoding a claim — _"this failure was reported to a human"_ — rather than a fact about the run. That claim is only true when a delivery surface exists. Where none exists, the same code path turned a real failure into a green check.

The two fixes are complementary and belong together: failing loudly makes the failure _visible_, and the artifact makes it _diagnosable_. Either alone still leaves an operator stuck — a red job with no logs is only marginally better than a green one that lied.

## Prevention

- **If a code path returns success because it reported the failure somewhere, assert that the reporting actually happened.** When it did not, fail.
- Treat "no delivery surface" as a first-class case in any delivery/notification path, not as a logging footnote. Non-interactive runs (dispatch, schedule, internal pipeline jobs) are exactly the ones with no surface, and exactly the ones nobody is watching.
- Enable log/artifact capture specifically on jobs whose only output is an artifact or a ref. A job with neither a comment surface nor an uploaded log is undiagnosable by construction.
- Regression-test both sides of the branch: unresolvable target must exit non-zero and call `setFailed`; resolvable target must still post and return `0`.
- When a downstream job fails on a missing input, check the producing job's **duration** before trusting its status.

## Related Issues

- [Terminal outcomes must survive deadline cleanup](terminal-outcomes-must-survive-deadline-cleanup-2026-07-24.md) — the adjacent rule in the same file: cleanup may degrade metadata but must never rewrite an accepted outcome. That one keeps a _known_ outcome intact; this one stops a failure from being reported as success in the first place.
- [A pipeline step that only works because the agent improvises is not a working pipeline step](../workflow-issues/integrate-push-strips-workflow-files-2026-08-07.md) — the first defect surfaced by the same release.
