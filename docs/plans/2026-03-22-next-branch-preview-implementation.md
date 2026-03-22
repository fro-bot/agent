# Next Branch Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace PR CI semantic-release branch emulation with a repo-owned release preview script while keeping the prepare workflow as the only creator of the real remote `next` branch.

**Architecture:** PR CI will compute release intent from the synthetic candidate commit range using a small script instead of full semantic-release. The prepare workflow continues to push a real disposable `next` branch and run full semantic-release there.

**Tech Stack:** GitHub Actions YAML, Node.js, TypeScript or ESM script, semantic-release commit analysis libraries already present in the repo.

---

### Task 1: Capture current CI release preview behavior in a focused test

**Files:**

- Create: `scripts/release/preview.test.ts`
- Modify: `package.json`

**Step 1: Write the failing test**

Add tests that describe the preview contract:

- patch commit messages produce `patch`
- feat commit messages produce `minor`
- no release-worthy commits produce `none`
- given `0.30.10` and `minor`, next version is `0.31.0`

**Step 2: Run test to verify it fails**

Run: `pnpm test scripts/release/preview.test.ts` Expected: FAIL because preview module does not exist yet

**Step 3: Commit**

Do not commit yet.

### Task 2: Implement minimal release preview logic

**Files:**

- Create: `scripts/release/preview.ts`
- Test: `scripts/release/preview.test.ts`

**Step 1: Write minimal implementation**

Implement functions to:

- normalize commit messages
- determine the highest release type
- compute the next semver from the previous version and release type

Keep the API small, for example:

```ts
export type ReleaseType = "none" | "patch" | "minor" | "major"

export function analyzeReleaseType(messages: readonly string[]): ReleaseType
export function computeNextVersion(currentVersion: string, releaseType: ReleaseType): string | null
```

**Step 2: Run test to verify it passes**

Run: `pnpm test scripts/release/preview.test.ts` Expected: PASS

**Step 3: Commit**

```bash
git add scripts/release/preview.ts scripts/release/preview.test.ts
git commit -m "feat(ci): add release preview analyzer"
```

### Task 3: Add a CLI wrapper for workflow consumption

**Files:**

- Create: `scripts/release/preview-next-release.ts`
- Modify: `package.json`
- Modify: `scripts/release/preview.ts`

**Step 1: Write the failing test**

Add a focused test for any parsing/helper logic that the CLI wrapper depends on.

**Step 2: Run test to verify it fails**

Run: `pnpm test scripts/release/preview.test.ts` Expected: FAIL for the new helper behavior

**Step 3: Write minimal implementation**

Build a script that:

- reads the latest `v*` tag via git
- reads commit subjects/bodies from latest tag to supplied HEAD
- calls preview helpers
- prints `release_type=<...>` and `next_version=<...>`
- optionally appends values to `$GITHUB_OUTPUT` when present

**Step 4: Run tests and a manual script invocation**

Run: `pnpm test scripts/release/preview.test.ts` Expected: PASS

Run: `node --experimental-strip-types --experimental-transform-types scripts/release/preview-next-release.ts --from v0.30.10 --to HEAD` Expected: structured preview output

**Step 5: Commit**

```bash
git add scripts/release/preview-next-release.ts scripts/release/preview.ts scripts/release/preview.test.ts package.json
git commit -m "feat(ci): add next release preview script"
```

### Task 4: Replace PR CI semantic-release call with the preview script

**Files:**

- Modify: `.github/workflows/ci.yaml`

**Step 1: Write the failing test**

No workflow-text test. Instead, define the expected behavior change in the plan and verify by command output after implementation.

**Step 2: Write minimal implementation**

Change the `Release` job so that in `DRY_RUN=true` mode it:

- skips `pnpm semantic-release`
- runs `node scripts/release/preview-next-release.mjs`
- writes `release_type` and `next_version` to step outputs

Keep non-dry-run behavior for the real prepare path aligned with the chosen topology.

**Step 3: Verify locally**

Run: `pnpm lint .github/workflows/ci.yaml` Expected: PASS

**Step 4: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "fix(ci): use repo release preview in PR dry-runs"
```

### Task 5: Remove CI-only semantic-release hacks

**Files:**

- Modify: `.github/workflows/ci.yaml`

**Step 1: Write the failing test**

No new automated test. This is cleanup tied to the prior task.

**Step 2: Write minimal implementation**

Delete the temporary CI-only hacks:

- local `next` ref creation when only needed for fake semantic-release invocation
- `repository-url .`
- plugin override flags

Keep only logic required for the preview script.

**Step 3: Verify diff and lint**

Run: `git diff -- .github/workflows/ci.yaml` Expected: only preview-script-based CI logic remains

Run: `pnpm lint .github/workflows/ci.yaml` Expected: PASS

**Step 4: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "refactor(ci): remove synthetic next branch hacks"
```

### Task 6: Run repo verification

**Files:**

- Modify: none unless fixes are required

**Step 1: Run focused tests**

Run: `pnpm test scripts/release/preview.test.ts` Expected: PASS

**Step 2: Run typecheck**

Run: `pnpm check-types` Expected: PASS

**Step 3: Run lint**

Run: `pnpm lint` Expected: existing warnings only

**Step 4: Run build**

Run: `pnpm build` Expected: PASS

**Step 5: Commit verification-only fixes if needed**

```bash
git add <files>
git commit -m "fix: satisfy verification for release preview changes"
```

### Task 7: Validate in GitHub Actions

**Files:**

- Modify: none unless follow-up fixes are needed

**Step 1: Push branch and inspect PR CI**

Run: `git push` Expected: PR CI reruns

**Step 2: Verify PR Release job**

Use `gh run view <run-id> --job <job-id> --log` Expected:

- no full semantic-release dry-run in PR mode
- preview script emits release type and predicted version
- job passes

**Step 3: Merge and validate prepare flow**

Run: `gh workflow run prepare-release-pr.yaml --ref main` Expected: real remote `next` branch created only by prepare workflow

**Step 4: Verify pending PR creation**

Run: `gh pr list --base release --head next` Expected: pending `next -> release` PR exists

**Step 5: Commit**

No commit unless follow-up fixes are required.
