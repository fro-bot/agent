---
title: A ref guard is not a security boundary, and a comment must not name an environment the job does not reference
date: 2026-11-23
category: best-practices
module: ci-workflows
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - A workflow_dispatch job guards itself with an if on github.ref and then mints or receives a write credential
  - A comment, test docblock or document says the boundary is a deployment environment, but the job has no environment key
  - The credential is a repository-level secret that any job in any workflow can read
tags:
  - workflow-dispatch
  - github-ref
  - environments
  - deployment-branches
  - app-token
  - false-assurance
  - defense-in-depth
---

# A ref guard is not a security boundary, and a comment must not name an environment the job does not reference

## Context

`.github/workflows/prepare-release-pr.yaml` runs on a schedule and on `workflow_dispatch`. Its `prepare-release` job (`:23-43`) mints a GitHub App installation token from `secrets.APPLICATION_PRIVATE_KEY` with `permission-contents: write`, `permission-pull-requests: write` and `permission-workflows: write` (`:41-43`), then uses it to push the `next` branch and to open, update, close and merge the release pull request.

The job carries a ref guard. Its comment and the docblock of `scripts/prepare-release-pr-workflow.test.ts` (`:14-16`) once called the enforced boundary "a deployment environment restricted to the default branch". The job has no `environment:` key, no workflow under `.github/workflows/` in this repository references an environment, and the only gate in the file is the `if:`. Both now say what the guard does (`:24-26`):

```yaml
    # Keeps scheduled and dispatched runs on the default branch. This is not a security boundary:
    # a dispatched ref supplies its own copy of this file, and no environment gates the App key.
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
```

The test beside the docblock (`:67-73`) pins the text of the `if:`, not any environment.

## Guidance

1. **Treat a ref `if:` in a dispatchable workflow as defense in depth, not as the boundary.** `workflow_dispatch` runs the workflow file of whichever ref the dispatcher selects. A user with write access can push a branch whose copy of the file omits the `if:` line, or adds steps that use the minted token, and dispatch that branch. The guard skips the job for an accidental dispatch from the wrong ref; it does not stop a deliberate one.
2. **Put the boundary in a GitHub environment that holds the credential.** The environment needs a deployment-branch policy limited to the default branch, and the job must reference it:

   ```yaml
   jobs:
     prepare-release:
       environment:
         name: release # proposed; deployment-branch policy: default branch only
   ```

   Adding `environment:` to the job is not enough by itself. A deployment-branch policy only gates secrets that live in the environment. A key that is also a repository-level secret stays readable by any job in any workflow, including a dispatched branch's modified copy of this file, so the protected key must not remain available as a repository secret. The environment and its policy are configured in repository Settings; the workflow file alone cannot create the boundary.

   `APPLICATION_PRIVATE_KEY` is shared. `auto-release.yaml:35`, `ci.yaml:1260`, `fro-bot.yaml:396`, `prepare-release-pr.yaml:35`, `renovate.yaml:54` and `update-repo-settings.yaml:20` all read it, and none of those jobs references an environment. Moving the shared key into an environment used only by `prepare-release` breaks every other consumer. Two shapes keep the boundary and the consumers working:

   - **A dedicated, least-privilege credential for `prepare-release`.** Create a separate App that holds only the permissions this job needs, store its key only in the environment, and leave the shared key where the other consumers read it. A second key for the same App is not enough: every key for an App authenticates as the same identity, so protecting one key leaves the App's authority available through the other. The dedicated credential must not also exist as a repository secret.
   - **A coordinated migration of every consumer.** Move the shared key into environments and give each consumer's job an `environment:` with a default-branch policy that fits that job, in one change set, so no job is left reading a secret that moved. `renovate.yaml:55` and `update-repo-settings.yaml:21` call reusable workflows in `bfra-me/.github`, and GitHub reads `environment:` only on a job inside the called workflow, not on the caller's `uses:` job, so those two consumers need the called workflow to declare the environment. The shared key must not remain a repository secret afterwards.
3. **A comment that names a boundary the job does not reference is a false assurance.** Either make the claim true (a referenced environment with a default-branch policy that holds a credential no other path can read), or reword the comment so it says what the `if:` does and no more. The next reviewer reads "the enforced boundary is a deployment environment" and stops looking for one.

What this repository's git history can and cannot show:

- Git shows the job has no `environment:` key.
- Git cannot show whether a matching environment exists in repository Settings, what its deployment-branch policy is, or whether `APPLICATION_PRIVATE_KEY` is a repository-level or environment-level secret. Checking that needs repository admin access to Settings or the environments API. Even if an environment named in Settings exists, a job that does not reference it is not gated by it.
- Not verified: that a deployment-branch policy is enforced against a `workflow_dispatch` started from another ref. Confirm that with a live dispatch from a non-default branch before relying on it.

## Why This Matters

The job holds a token that can write workflow files (`permission-workflows: write`) and merge to the release branch. A branch-supplied copy of the workflow that reaches the mint step gets that token. Whether the repository is exposed to this depends on settings that git cannot show, so the file's own comment is the only assurance a reviewer sees. A comment that names a boundary the file does not have is wrong about what the file does.

A guard described as a boundary is worse than no guard, because it stops the next reviewer from asking where the boundary is.

## When to Apply

- Any `workflow_dispatch` job, or a `workflow_call` workflow reached from a dispatch, that mints a token or writes with a secret.
- Any comment, test name, test docblock or document that calls a ref guard, or an environment, the boundary.
- Any review of a workflow comment that names a control outside the file: confirm the job references that control.

## Examples

Fix options for `prepare-release-pr.yaml`. The comment correction is applied; the boundary is not:

- **Add the boundary.** Either give `prepare-release` a dedicated least-privilege credential held only in an environment restricted to the default branch, with `environment:` on the job, or migrate every consumer of the shared App key in one coordinated change. Both need the branch policy, and the protected key must not remain a repository secret.
- **Correct the comment (applied).** `:24-25` and the test docblock say the `if:` keeps normal runs on the default branch and is not a security boundary, and drop the claim of an enforced environment boundary.

## Related

- [A dispatch ref guard is not a security boundary; gate the credential with an environment and a deployment-branch policy](https://github.com/fro-bot/.github/blob/main/docs/solutions/best-practices/dispatch-ref-guard-is-not-a-security-boundary-2026-10-10.md) (`fro-bot/.github`, `docs/solutions/best-practices/dispatch-ref-guard-is-not-a-security-boundary-2026-10-10.md`): the same finding for `rename-tracked-repo.yaml`, including what GitHub documents about dispatching a workflow from any ref and about environment deployment-branch policies.
- [`same-job-phase-split-not-a-security-boundary-2026-07-04.md`](./same-job-phase-split-not-a-security-boundary-2026-07-04.md): another control that looks like a boundary in the workflow file and is not.
- [`inline-scoped-app-token-mint-2026-07-12.md`](./inline-scoped-app-token-mint-2026-07-12.md): minting a narrower App token bounds what a reached mint step can do, not who can reach it.
