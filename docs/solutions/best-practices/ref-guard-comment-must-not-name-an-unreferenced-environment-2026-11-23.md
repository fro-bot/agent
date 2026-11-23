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

The job carries a ref guard and a comment about it (`:24-26`):

```yaml
    # Defense in depth: a dispatched ref supplies its own copy of this file, so the enforced
    # boundary is a deployment environment restricted to the default branch.
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
```

The comment names a deployment environment as the enforced boundary. The job has no `environment:` key, and no workflow under `.github/workflows/` in this repository references an environment. The only gate in the file is the `if:`. The docblock of `scripts/prepare-release-pr-workflow.test.ts` (`:14-16`) repeats the same claim, and the test beside it (`:67-73`) pins the text of the `if:`, not any environment.

## Guidance

1. **Treat a ref `if:` in a dispatchable workflow as defense in depth, not as the boundary.** `workflow_dispatch` runs the workflow file of whichever ref the dispatcher selects. A user with write access can push a branch whose copy of the file omits the `if:` line, or adds steps that use the minted token, and dispatch that branch. The guard skips the job for an accidental dispatch from the wrong ref; it does not stop a deliberate one.
2. **Put the boundary in a GitHub environment that gates the credential.** The environment needs a deployment-branch policy limited to the default branch, and the job must reference it:

   ```yaml
   jobs:
     prepare-release:
       environment:
         name: release # proposed; deployment-branch policy: default branch only
   ```

   Setting the policy requires an environment configured in repository Settings. The workflow file alone cannot create the boundary. To keep a dispatched branch from reading the credential at all, move `APPLICATION_ID` and `APPLICATION_PRIVATE_KEY` from repository-level secrets into that environment; repository-level secrets stay readable by any job in any workflow.
3. **A comment that names a boundary the job does not reference is a false assurance.** Either make the claim true by adding the `environment:` key, or reword the comment so it says what the `if:` does and no more. The next reviewer reads "the enforced boundary is a deployment environment" and stops looking for one.

What this repository's git history can and cannot show:

- Git shows the job has no `environment:` key and that the comment and the test docblock claim one.
- Git cannot show whether a matching environment exists in repository Settings, what its deployment-branch policy is, or whether `APPLICATION_PRIVATE_KEY` is a repository-level or environment-level secret. Checking that needs repository admin access to Settings or the environments API. Even if an environment named in Settings exists, a job that does not reference it is not gated by it.
- Not verified: that a deployment-branch policy is enforced against a `workflow_dispatch` started from another ref. Confirm that with a live dispatch from a non-default branch before relying on it.

## Why This Matters

The job holds a token that can write workflow files (`permission-workflows: write`) and merge to the release branch. A branch-supplied copy of the workflow that reaches the mint step gets that token. Whether the repository is exposed to this depends on settings that git cannot show, so the file's own comment is the only assurance a reviewer sees, and that comment is wrong about what the file does.

A guard described as a boundary is worse than no guard, because it stops the next reviewer from asking where the boundary is.

## When to Apply

- Any `workflow_dispatch` job, or a `workflow_call` workflow reached from a dispatch, that mints a token or writes with a secret.
- Any comment, test name, test docblock or document that calls a ref guard, or an environment, the boundary.
- Any review of a workflow comment that names a control outside the file: confirm the job references that control.

## Examples

Fix options for `prepare-release-pr.yaml`. This learning does not apply either one:

- **Add the boundary.** Create an environment restricted to the default branch in repository Settings, add `environment:` to the `prepare-release` job, and move the App credentials into the environment.
- **Correct the comment.** Reword `:24-25` to say the `if:` is defense in depth that skips the job for an accidental dispatch from another ref, and drop the claim of an enforced environment boundary. Update the test docblock to match.

## Related

- [A dispatch ref guard is not a security boundary; gate the credential with an environment and a deployment-branch policy](https://github.com/fro-bot/.github/blob/main/docs/solutions/best-practices/dispatch-ref-guard-is-not-a-security-boundary-2026-10-10.md) (`fro-bot/.github`, `docs/solutions/best-practices/dispatch-ref-guard-is-not-a-security-boundary-2026-10-10.md`): the same finding for `rename-tracked-repo.yaml`, including what GitHub documents about dispatching a workflow from any ref and about environment deployment-branch policies.
- [`same-job-phase-split-not-a-security-boundary-2026-07-04.md`](./same-job-phase-split-not-a-security-boundary-2026-07-04.md): another control that looks like a boundary in the workflow file and is not.
- [`inline-scoped-app-token-mint-2026-07-12.md`](./inline-scoped-app-token-mint-2026-07-12.md): minting a narrower App token bounds what a reached mint step can do, not who can reach it.
