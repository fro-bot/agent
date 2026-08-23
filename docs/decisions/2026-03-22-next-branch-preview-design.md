# Next Branch Preview Design

**Goal:** Remove semantic-release branch simulation hacks from PR CI while preserving the no-force-push release topology where `next` exists only as a disposable remote branch created by the prepare workflow.

**Decision:** Use a split model. PR CI computes release intent from the synthetic candidate commit range without running full semantic-release. The prepare workflow remains the only place that creates and uses the real remote `next` branch with full semantic-release behavior.

## Context

The current release architecture has two distinct needs:

1. PR CI needs a safe, side-effect-free preview that answers whether the synthetic release candidate would produce a release.
2. The prepare workflow needs the real semantic-release runtime so it can validate, materialize, and open the pending `next -> release` PR.

Trying to make PR CI impersonate a real `next` branch caused repeated failures because semantic-release and its plugins assume a coherent remote branch topology, a valid GitHub repository URL, and plugin-compatible repository metadata.

## Chosen Approach

### PR CI

PR CI will stop calling `pnpm semantic-release` entirely.

Instead, the `Release` job in `/.github/workflows/ci.yaml` will:

1. Check out `release`
2. Reset `release` to the latest `v*` tag
3. Merge the PR synthetic commit into that reset branch
4. Run a repo-owned preview script against the commit range from the last release tag to the synthetic merge commit
5. Report:
   - release type: `none`, `patch`, `minor`, or `major`
   - predicted next version when a release is triggered

This keeps PR CI deterministic and side-effect free.

### Prepare Workflow

`/.github/workflows/prepare-release-pr.yaml` remains the only workflow that:

1. Builds the synthetic release candidate
2. Pushes `HEAD` to remote `next`
3. Runs full semantic-release dry-run on real remote `next`
4. Creates or updates the `next -> release` PR when a release is predicted

This keeps `next` as a real but disposable branch only in the workflow that is allowed to mutate remote state.

## Why This Is Correct

This design matches the actual responsibilities of each workflow.

- PR CI is for validation and preview, not remote mutation.
- Prepare is for creating the releasable candidate branch.
- Publish is for releasing from merged `next -> release` state.

The earlier failures came from trying to force full semantic-release into a context that was neither a real release branch nor a valid remote-backed GitHub branch. That is the wrong abstraction boundary.

## Implementation Shape

Add a small script, likely under `scripts/release/`, that:

1. Finds the latest release tag
2. Collects commits from that tag to the provided synthetic HEAD
3. Uses semantic-release commit analysis logic to determine the highest release type
4. Computes the next semantic version from the last release version and release type
5. Prints structured output for GitHub Actions consumption

The script should be narrow and boring. It should not try to reproduce the full semantic-release pipeline. It only needs to answer the preview questions that PR CI actually cares about.

## Expected Outputs

PR CI should produce machine-readable outputs such as:

- `release_type=none|patch|minor|major`
- `next_version=<version or empty>`

It may also write a short job summary explaining whether the synthetic candidate would release.

## Error Handling

- If the preview script fails, the CI job fails with a repo-owned error message.
- If no relevant commits exist, the job succeeds with `release_type=none`.
- If the prepare workflow later disagrees with the preview, that is a bug in the preview script and should be debugged in our code instead of in semantic-release branch internals.

## Testing Strategy

- Add unit tests for the preview script using commit-message fixtures or focused function tests.
- Do not add workflow-text tests.
- Verify end to end by:
  1. making PR CI pass with the preview script
  2. merging to `main`
  3. running `prepare-release-pr.yaml`
  4. confirming real `next` creation and pending `next -> release` PR creation

## Non-Goals

- PR CI does not need to generate full release notes.
- PR CI does not need to publish artifacts.
- PR CI does not need to create or delete remote branches.
