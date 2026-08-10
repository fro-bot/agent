---
title: A pipeline step that only works because the agent improvises is not a working pipeline step
date: 2026-08-07
category: workflow-issues
module: harness-release
problem_type: workflow_issue
component: development_workflow
symptoms:
  - "Push rejected: refusing to allow a GitHub App to create or update workflow .github/workflows/beta.yml without workflows permission"
  - "All build matrix jobs fail with: fatal: couldn't find remote ref refs/harness-integrate/<version>"
  - "The integration ref is never created even though the merge itself succeeded"
root_cause: missing_permission
resolution_type: workflow_improvement
severity: high
tags:
  - harness-release
  - github-app
  - workflows-permission
  - agent-improvisation
  - least-privilege
---

# A pipeline step that only works because the agent improvises is not a working pipeline step

## Problem

The harness release integrate job has an LLM agent merge the carried upstream PRs onto an OpenCode base tag and push the merged tree to a throwaway ref (`refs/harness-integrate/<version>`). That push authenticates as a GitHub App whose minted token requests exactly `contents: write`. GitHub rejects **any** App push that creates or updates a file under `.github/workflows/` unless the token also carries the `workflows` permission — and the upstream tree ships 26 such files. The push was rejected, the ref was never created, and every build job then failed on a missing ref.

## Symptoms

```
! [remote rejected] integrate/v1.18.14 -> refs/harness-integrate/1.18.14
(refusing to allow a GitHub App to create or update workflow
 .github/workflows/beta.yml without workflows permission)
```

followed, in all six platform build jobs, by:

```
fatal: couldn't find remote ref refs/harness-integrate/1.18.14
```

The build failure is a downstream symptom. The real failure is the rejected push.

## What Didn't Work

Every "what changed?" theory was wrong, because **nothing had changed**:

- _A new upstream workflow file._ `.github/workflows/beta.yml` has the same blob SHA at both the previous and current base tags.
- _GitHub tightened enforcement._ The constraint is long-standing.
- _The App's granted permissions changed._ The mint has always requested only `contents: write`.

The actual explanation is that **previous releases only succeeded because the agent improvised an undocumented workaround.** The prior release's job log shows it plainly: the push was rejected, and the agent then ran

```bash
git rm -r --cached --quiet .github/workflows
git commit --amend --no-edit
```

and pushed again successfully. Its own summary said it "amended to drop `.github/workflows/*` … their presence caused GitHub to reject the push." Nothing in the procedure asked for that.

The failing run's agent, correctly, refused to invent a workaround — "Per the operating constraints I could not improvise alternate auth or strip the workflow files" — and the pipeline broke.

**Diagnostic technique that settled it:** compare the _pushed_ integration tree against the _upstream_ tree. The pushed trees for prior releases contain **zero** files under `.github/workflows/`, while upstream ships 26. Check `truncated` on the tree response first — a missing directory otherwise looks identical to a truncated API result, which is exactly the wrong conclusion to draw.

```bash
gh api "repos/<owner>/<repo>/git/trees/<integration-sha>?recursive=1" \
  --jq '{truncated, total:(.tree|length),
         workflows:[.tree[]|select(.path|startswith(".github/workflows/"))]|length}'
```

## Solution

Make the removal an explicit step, folded into the existing squash so no amend is needed:

```bash
git reset --soft {{tag}}
git rm -r --cached --quiet --ignore-unmatch .github/workflows
git commit -m "harness: integrate OpenCode {{version}} carrying {{branches}}"
```

`--cached` drops the files from the commit only, leaving them on disk so the build step is unaffected. `--ignore-unmatch` makes the command a no-op if upstream ever ships no workflows directory.

## Why This Works

Stripping is the least-privilege option, and it is preferred over granting the App `workflows: write`:

- the integration ref is a throwaway **build input**, not a fork of upstream;
- the release build compiles the source tree and never reads workflow files;
- every previously published integration ref already has exactly this shape, so this converges on the proven artifact rather than introducing a new one;
- granting `workflows: write` would permanently widen the minted token's scope on every integrate run, for files nothing consumes.

## Prevention

- **If a pipeline depends on an agent doing something, make it an explicit instruction and pin it with a test.** An undocumented improvisation is indistinguishable from a working pipeline right up until the model declines to improvise. That is not a model regression — it is a latent gap in the procedure.
- Pin the ordering, not just the presence. The strip must precede the commit; after the commit it is useless. Two assertions cover it: that the strip exists with `--ignore-unmatch`, and that it appears before the integration commit.
- Verify the pins are non-tautological: deleting the strip line from the procedure should fail exactly those tests and no others.
- When a long-standing pipeline suddenly breaks, check whether it was ever deterministic. Compare the produced artifact across successful runs before assuming an external change.

## Related Issues

- [Mint a scoped App token inline on the integrate path](../best-practices/inline-scoped-app-token-mint-2026-07-12.md) — how this job obtains its `contents: write` token.
- [An App token's permission echo includes an implied metadata read](../logic-errors/app-token-echo-includes-implied-metadata-read-2026-07-12.md) — companion gotcha in the same mint path.
- [A failed run reported success because it had no delivery surface](../logic-errors/failed-run-reported-success-with-no-delivery-surface-2026-08-07.md) — the second defect surfaced by the same release.
