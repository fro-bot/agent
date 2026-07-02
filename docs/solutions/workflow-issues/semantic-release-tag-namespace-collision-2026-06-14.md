---
title: "Auxiliary v-Prefixed Tags Poison semantic-release Version Computation"
module: "release-pipeline"
date: 2026-06-14
category: workflow-issues
problem_type: workflow_issue
component: tooling
severity: high
tags:
  - semantic-release
  - tag-namespace
  - release-pipeline
  - github-release
  - git-tag
  - harness
  - recovery
applies_when:
  - A repo runs semantic-release with the default `tagFormat: 'v${version}'` AND also publishes other GitHub Releases (sub-package binaries, etc.)
  - You discover the next product version computed wrong (a major/minor jump) after a release
  - You need to migrate a GitHub Release to a different tag name
  - You're tempted to reach for semantic-release config to "exclude tags by pattern" — there is none
  - You reset the `release` branch during release-pipeline recovery
---

# Auxiliary v-prefixed tags poison semantic-release version computation

semantic-release published the wrong product version (`v1.18.0` instead of `v0.63.0`) because the `@fro.bot/harness` sub-package published its GitHub Releases under **`v`-prefixed** tags (`v1.17.3+harness.<sha>`) in the same repo. Those tags matched semantic-release's product tag pattern, parsed as `1.17.3`, outranked the real `v0.62.0`, and jumped the release off a cliff. Fixed forward (PRs #889/#890) and recovered by tag cleanup + a `release`-branch reset.

## Root cause (verified)

semantic-release v25 discovers releases by building a regex from `tagFormat` (`lib/branches/get-tags.js:14`):

```js
const tagRegexp = `^${escapeRegExp(template(tagFormat)({ version: " " })).replace(" ", "(.+)")}`
```

For the default `tagFormat: 'v${version}'` (this repo's `.releaserc.yaml` has no override) that is `^v(.+)`. It then validates the capture with `semver.valid(semver.clean(version))` — and **`semver.clean()` strips SemVer build metadata**. So `v1.17.3+harness.94c10df9` matches `^v(.+)`, cleans to `1.17.3`, and sorts above the product `0.62.0` by core-version precedence. There is **no semantic-release config to exclude tags** — `tagFormat` is a single fixed `${version}` template, not a regex or allowlist.

## Rules

### 1. Keep auxiliary release tags out of the product's tag namespace

If a repo runs semantic-release with `v${version}` and also publishes other releases, those other tags must not be `v`-prefixed-semver-valid, or they contaminate the product version computation. The fix is a **non-`v`** tag form. Build metadata (`+...`) is *not* protection — semantic-release strips it and sorts by core version, so any non-zero core version in the auxiliary namespace wins silently.

```diff
- v1.17.3+harness.94c10df9   # matches /^v(.+)/, cleans to 1.17.3, outranks v0.62.0
+ 1.17.3+harness.94c10df9    # invisible to /^v(.+)/, isolated namespace
```

Verified anchors: `.github/workflows/harness-release.yaml` (`RELEASE_TAG="${BASE_VERSION}+harness.${SHORT_SHA}"`, no `v`); `src/services/setup/opencode.ts` `encodeHarnessTag()` strips a leading `v` for the harness download URL while `buildDownloadUrl()` keeps the `v` for stock `anomalyco/opencode` downloads (separate path, regression-tested).

### 2. semantic-release has no tag-exclusion knob — don't try to fix this in config

`tagFormat` is a single `${version}` template. Removing the `v` from `tagFormat` changes the *captured group*, not the *matched set* — `^(.+)` would still match `v1.17.3+harness.<sha>`. The only durable lever is the **names of the tags you create**. The workflow-side `git tag --list 'v*' | grep -vF '+harness'` filter in this repo guards the pipeline's *own* before/after detection, but it does **not** reach semantic-release's internal scan — only non-`v` tag names do.

```text
default tagFormat 'v${version}':
  matched   = tags matching /^v(.+)/
  effective = semver.clean(capture)   ← strips +metadata
  precedence= semver.compare on effective
  → v1.17.3+harness.x competes as 1.17.3 and beats v0.62.0
```

### 3. Deleting a git tag orphans its GitHub Release — migrate, don't delete-in-place

`git push --delete origin <tag>` does **not** delete the GitHub Release, but it orphans it: the release flips to `draft`, its asset `browser_download_url` rewrites to `releases/download/untagged-<id>/...`, and the canonical `/releases/download/<tag>/...` URL returns **404**. (Empirically observed and confirmed this incident — an assumption that the tag delete keeps asset URLs alive was directly disproved.)

To move a release to a new tag namespace, **create the new release on the new tag with the same assets first** (so the new URL resolves), then delete the old — never rely on tag-delete preserving URLs.

```bash
# Mirror (safe relocation): download existing assets, then
gh release create "<new-tag>" --target "<sha>" --latest=false <assets...> SHA256SUMS
# Only after the new URL is verified 200, retire the old:
gh release delete "<old-tag>" --cleanup-tag --yes
```

Recovery if a tag was already deleted and the release orphaned:

```bash
git tag "<tag>" "<sha>" && git push origin "refs/tags/<tag>"
gh api -X PATCH "repos/<owner>/<repo>/releases/<id>" -f tag_name="<tag>" -F draft=false -F make_latest=false
# allow ~12s CDN propagation before re-checking the canonical download URL
```

### 4. Reset the `release` branch to the last release TAG, not the last merge commit

The `next → release` pipeline requires `release` to sit at the **last released tag** (e.g. `v0.62.0`); merging `next` is what advances it. Resetting `release` to a merge commit that is *ahead* of the last tag makes the next `next → release` PR conflict (DIRTY — typically rename/rename on `dist/artifact-*.js`, whose bundle hash changes every commit). The release branch is a projection of `main` at the last *released* version, not the last *merged* commit.

Verified anchor: `prepare-release-pr.yaml` "Reset to last release tag and merge main" does `git reset --hard "$last_tag"` where `last_tag=$(git tag --list 'v*' --sort=-version:refname | grep -vF '+harness' | head -1)`.

### 5. Know your release trigger's side effects

`prepare-release-pr.yaml -f force-release=true` does **not** just create the release PR — its merge-policy step **auto-merges** it (`gh pr merge --merge`), which fires Auto Release. And Auto Release only triggers on `pull_request: closed` with `merged==true && head=='next' && base=='release'` — **not** on a plain push to `release`. So resetting the `release` branch alone will not re-fire a release; regenerate via `prepare-release-pr.yaml` (which produces the qualifying `next → release` PR merge).

## Recovery sequence used (verified, worked)

1. Forward fix merged (#889/#890): harness tags + URLs drop the `v`; stock keeps it; `buildHarnessReleaseTag` helper aligned to non-`v`.
2. Created non-`v` mirror releases for the two existing harness builds (assets re-uploaded, `--latest=false`). Required `gh auth refresh -s workflow` because the target commits touch `.github/workflows/`.
3. Deleted both `v`-harness releases+tags (`gh release delete <tag> --cleanup-tag`) and the bad `v1.18.0` tag → `scripts/release/preview-next-release.ts` then predicted `next_version=0.63.0`.
4. Reset `release` to the last release tag (`v0.62.0` commit), then `gh workflow run prepare-release-pr.yaml -f force-release=true` → regenerated and auto-merged the `next → release` PR → Auto Release published **v0.63.0** (correct), `v0` major channel updated, release-notes narration ran.

## When to apply

- Adding any auxiliary GitHub Release stream to a repo that runs semantic-release with the default `v${version}`.
- Diagnosing a surprise major/minor version jump after a release.
- Relocating or retiring a GitHub Release whose download URLs may have consumers.
- Recovering a release branch — reset to the last *tag*, regenerate via the prepare-release workflow.

## Related

- `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md` — same domain (harness version management), different failure mode (duplicate version *source* drift vs. tag-*namespace* collision).
- `docs/solutions/best-practices/cross-libc-build-and-release-safety-2026-06-14.md` — sibling harness release-pipeline lessons (musl builds, coupled version bumps, fail-closed download). Both came out of the same harness rollout.
- `docs/solutions/best-practices/release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md` — adjacent semantic-release ops lesson (post-publish narration).
- PRs #889 (workspace repoint), #890 (forward fix: non-`v` harness tags).
