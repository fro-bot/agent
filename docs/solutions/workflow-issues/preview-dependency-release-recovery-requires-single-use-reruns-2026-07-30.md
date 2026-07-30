---
title: Preview-dependency release recovery requires provenance checks and single-use reruns
date: "2026-07-30"
category: workflow-issues
module: "harness/release pipeline"
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A release matrix intermittently fails while fetching an upstream preview package"
  - "A failed GitHub Actions run may be rerun after the external dependency recovers"
  - "A long-running monitor observes a workflow after a mutating rerun command"
tags:
  - github-actions
  - harness
  - release-pipeline
  - preview-dependency
  - pkg-pr-new
  - rerun-control
  - all-or-nothing
  - opencode
---

# Preview-dependency release recovery requires provenance checks and single-use reruns

## Context

The OpenCode v1.18.5 harness release failed when two of six build-matrix jobs received `404 Not Found` while installing OpenCode's stock dependency:

```text
@solidjs/start@https://pkg.pr.new/@solidjs/start@dfb2020
```

The pin existed in OpenCode v1.18.5's `package.json` and `bun.lock`; none of the harness carries introduced it. All six jobs used integration commit `3a55d7d2`, and the other four completed successfully. The exact preview URL later returned HTTP 200 without a source change, so the incident was an external availability failure rather than an integration-tree or platform-specific defect.

The release pipeline contained the failure correctly. Its downstream binary-release, npm-publish, and default-sync jobs require the complete matrix, so attempt 1 produced no partial release. After the endpoint recovered, one explicitly authorized failed-job rerun succeeded and published `1.18.5+harness.3a55d7d2`.

A second rerun was then triggered after the successful attempt had already finished. It was canceled before any publish, release, or sync step ran. That exposed a separate operational rule: a rerun is a single-use mutation, not part of workflow monitoring.

## Guidance

Safe recovery has two inseparable controls: prove which immutable dependency failed and execute at most one authorized rerun before returning to read-only monitoring.

### Separate cause, containment, and recovery

Treat these as three different facts:

1. **Cause:** an upstream release pinned a preview-package URL whose host was temporarily unavailable.
2. **Containment:** the all-or-nothing release graph prevented partial publication.
3. **Recovery:** the same immutable integration succeeded after the endpoint recovered and one rerun was authorized.

Do not describe the rerun as a dependency fix. No mirror, replacement version, filtered install, or targeted install retry shipped in this incident; the upstream preview pin remained unchanged.

### Diagnose read-only before choosing recovery

Confirm the exact failure, immutable source, and current endpoint state without changing the run:

```bash
run_id=30139187128

gh run view "$run_id" --json attempt,status,conclusion,url,jobs
gh run view "$run_id" --log-failed | grep -i 'pkg.pr.new\|404'
curl --fail --silent --show-error --head --location \
  https://pkg.pr.new/@solidjs/start@dfb2020
```

The workspace install occurs in `packages/harness/scripts/build-platform.ts`, after the integrated OpenCode source is selected. Compare that source's dependency metadata with the stock tag before blaming carries or platform patches.

Cache warmth is not correctness evidence. `.github/actions/setup/action.yaml` keys Bun's global cache from this repository's root `bun.lock`, not the integrated OpenCode tree's lockfile. A cache hit therefore does not prove the nested workspace install can resolve every upstream dependency. In this incident, cache hit/miss status did not explain which matrix jobs failed.

An endpoint preflight is also only a point-in-time signal. A successful HEAD request cannot guarantee that six later parallel installs will see the same availability.

### Make the rerun a single explicit mutation

Record the current attempt before the authorization boundary:

```bash
run_id=30139187128
gh run view "$run_id" --json attempt,status,conclusion,url
```

After explicit approval, invoke the mutating command exactly once:

```bash
gh run rerun "$run_id" --failed
```

Then observe only:

```bash
gh run view "$run_id" --json attempt,status,conclusion,url
gh run watch "$run_id" --exit-status
```

Every additional `gh run rerun` requires a fresh authorization and a fresh preflight. A monitor must never infer that a previous failure authorizes another attempt. This remains true after a rerun succeeds: invoking `--failed` again can create another workflow attempt from the run's recorded failed-job history.

`--failed` is not necessarily a build-only probe. GitHub can also reactivate jobs that were previously skipped because they depended on the failed jobs. In this release graph, that included binary release, npm publish, and default-version sync. The command can therefore complete the release if the rebuilt matrix passes.

### Preserve the exact dependency unless equivalence is proven

Do not replace the preview pin with a nearby `@solidjs/start` version merely because it is available from npm. The preview targets a specific commit, and no release was proven behaviorally equivalent. An unverified substitution turns a loud dependency-fetch failure into a potentially silent headed/web runtime regression.

Durable mitigations require a separate design decision, such as:

- an internally controlled, checksum-verified mirror of the exact preview tarball;
- a narrowly bounded retry around the integrated workspace install;
- an upstream OpenCode release that moves to a stable, published dependency.

These are future hardening options, not changes delivered by the successful rerun.

## Why This Matters

External preview artifacts are release inputs even when they are buried inside an upstream monorepo. Their temporary unavailability can make identical matrix jobs disagree, while warm caches create misleading confidence. Correct recovery depends on immutable provenance and publication containment, not on assuming a successful runner proves the dependency is durable.

Reruns have a second risk: they are side-effecting workflow executions. A successful failed-job rerun can reach publishing jobs, and another invocation can create an unnecessary attempt after the release is already complete. Separating the one mutating command from read-only monitoring prevents duplicate releases and surprise workflow runs.

## When to Apply

- A release build consumes commit-preview, snapshot, nightly, or direct tarball dependencies.
- Matrix jobs disagree while building the same integration commit.
- A failed release is safe to retry only because downstream publication is all-or-nothing.
- A command runner or monitoring process remains active after invoking `gh run rerun`.
- A replacement package version appears available but has no verified equivalence to the pinned preview.

## Examples

The v1.18.5 incident followed the safe recovery boundary after the first failure:

```text
attempt 1: two matrix builds fail -> release/publish/sync skipped
endpoint: 404 recovers to 200
attempt 2: one authorized failed-job rerun -> release completes
attempt 3: unexpected additional rerun -> canceled before publish side effects
```

The prevention rule is narrower than "retry transient failures":

```text
preflight -> explicit approval -> one rerun -> read-only monitoring
```

It is not:

```text
monitor failure -> rerun until green
```

## Related

- [Cross-libc builds and release-pipeline safety](../best-practices/cross-libc-build-and-release-safety-2026-06-14.md)
- [Bun's local cache can mask the minimumReleaseAge gate](./bun-local-cache-masks-minimum-release-age-2026-07-13.md)
- [Auxiliary v-prefixed tags poison semantic-release version computation](./semantic-release-tag-namespace-collision-2026-06-14.md)
- [Harness release run 30139187128](https://github.com/fro-bot/agent/actions/runs/30139187128)
- [OpenCode v1.18.5 dependency catalog](https://github.com/anomalyco/opencode/blob/v1.18.5/package.json)
