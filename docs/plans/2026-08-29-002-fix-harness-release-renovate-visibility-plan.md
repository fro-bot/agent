---
title: Make harness releases invisible to Renovate's stable-candidate selection
type: fix
status: active
date: 2026-08-29
issue: https://github.com/fro-bot/agent/issues/1492
---

# Fix: Harness releases outrank v0.x action releases in Renovate

## Problem Frame

Harness build releases use bare-semver tags with build metadata (`1.18.21+harness.22dee0ee`). SemVer strips build metadata for precedence, so Renovate's `github-actions` manager — which discovers candidates from **git tags** (`github-tags` datasource), not release objects — sees a stable `1.18.21` that outranks the real `v0.x` action line. In fro-bot/.github, the grouped `major-github-actions` branch fails quietly expecting `1.18.21+harness.22dee0ee`.

The harness tag has two adversarial consumers with opposite requirements: it must stay invisible to semantic-release's `^v(.+)` tag scan (solved in June by dropping the `v` prefix — #889/#890) AND excluded from Renovate's stable candidates (this issue; the June fix is what exposed it).

**Why the triage's primary fix is insufficient:** `--prerelease` on the GitHub Release is release-object metadata; Renovate's candidate discovery is tag-based. Current Renovate may enrich tags with `isStable` from release data, but that is an implementation detail, not a contract (docs.renovatebot.com/modules/manager/github-actions, /modules/datasource/github-tags). The durable repo-side fix is the tag shape itself: a SemVer **prerelease identifier** (`1.18.21-harness.22dee0ee`) is excluded by Renovate's default `ignoreUnstable=true` — guaranteed by the SemVer spec, not by enrichment behavior.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "fro-bot/agent: .github/workflows/, src/services/setup/, scripts/, docs/solutions/",
  "freshness": {
    "vcs_reference": "5710335c6"
  },
  "budget": {
    "max_search_passes": 8,
    "max_candidate_inspections": 24,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "src/services/setup/opencode.ts::toolCacheVersion",
      "description": "Converts the '+harness.' build-metadata marker to '-harness.' so semver.clean does not strip it into a colliding tool-cache key.",
      "disposition": "extend",
      "insufficiency_reason": "Owns exactly the conversion the release-tag derivation needs, but is currently scoped to the tool-cache key alone."
    },
    {
      "path_or_symbol": "src/services/setup/opencode.ts::buildDownloadUrl",
      "description": "Constructs release asset URLs, percent-encoding '+' as %2B for harness tags and keeping the v-prefix for stock tags.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": ".github/workflows/harness-release.yaml",
      "description": "Derives RELEASE_TAG as ${BASE_VERSION}+harness.${SHORT_SHA} in two jobs and publishes via gh release create --latest=false.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "docs/solutions/workflow-issues/semantic-release-tag-namespace-collision-2026-06-14.md",
      "description": "Establishes the non-v tag namespace rule and the migrate-never-delete rule for releases whose asset URLs are load-bearing.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "scripts/release/",
      "description": "Existing release-adjacent Node ESM scripts establishing the local CLI, logging, and erasable-syntax conventions.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "renovate.json5 packageRules (@types/node, OpenCode, Bun caps)",
      "description": "Established pattern for capping a dependency's candidate range to the version line the project actually runs.",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "gh release create --latest=false / --prerelease",
      "description": "Release-object visibility flags; --latest=false already in use to protect the product release pointer.",
      "disposition": "insufficient",
      "insufficiency_reason": "Release-object metadata cannot durably suppress a tag-derived candidate: Renovate's github-actions manager discovers versions from the github-tags datasource, using release data only as optional isStable enrichment."
    }
  ],
  "excluded_scopes": [
    {
      "scope": "fro-bot/.github",
      "reason": "Consumer-side containment (Unit 5) lives in a separate repository and is tracked as an independent unit, not implemented from this workspace."
    },
    {
      "scope": ".slim/clonedeps/repos/",
      "reason": "Read-only vendored upstream OpenCode source; its release tooling is not this repository's harness-release consumer."
    }
  ]
}
```

## Key Technical Decisions

1. **New harness release tags switch `+harness.` → `-harness.`** (`1.18.21-harness.22dee0ee`). Properties: no `v` prefix (semantic-release isolation preserved); SemVer-unstable (Renovate exclusion guaranteed); **identical to the npm version string**, which already uses the hyphen form — the two public version identities unify.
2. **The binary's self-reported version stays `+harness.<sha>`** (build metadata is the semantically correct form for a build variant). `DEFAULT_OPENCODE_VERSION`, `isHarnessVersion()`, `ci.yaml`'s `+harness.` binary check, and the npm derivation are all unchanged. Only the *tag* representation flips, at the URL-construction boundary: `buildDownloadUrl`/`buildChecksumsUrl` convert `+harness.` → `-harness.` when deriving the release tag — the same conversion `toolCacheVersion()` already performs for the tool cache.
3. **Backfill-by-duplication, never deletion** (June doc rule 3): existing `+` tags and their asset URLs must keep working forever — shipped action versions construct `%2B` URLs from their own bundled code. To keep the new unconditional `+`→`-` tag mapping working for the current pin and for any explicitly-pinned older harness version, duplicate all 18 existing releases under their hyphen tags (same integration commit, same assets, `--prerelease`), created and verified before the mapping code ships.
4. **Mark all harness releases `--prerelease`** (new ones in the workflow, existing 18 via `gh release edit`): zero repo-side risk (verified: nothing in setup/download/CI filters on prerelease; downloads are direct tag URLs), correct metadata, and it activates Renovate's `isStable` enrichment where the deployed Renovate version supports it — defense in depth for the 18 legacy `+` tags that remain stable-shaped forever.
5. **Consumer-side containment in fro-bot/.github** (separate repo, immediate recovery): `packageRules: [{matchManagers: ["github-actions"], matchPackageNames: ["fro-bot/agent"], allowedVersions: ">=0.0.0 <1.0.0"}]`. This also permanently guards the legacy tags for that consumer.
6. **Residual risk, accepted and documented:** consumers other than fro-bot/.github without the packageRule can still see the 18 legacy `+` tags as stable candidates (deleting those tags would break published action versions' asset URLs — the worse failure). Time bounds the exposure: no new stable-shaped tags are ever created again.

## Units

- [ ] **Unit 1: hyphen-tag duplicate releases for the 18 existing harness releases.** Script (one-off, `gh` CLI): for each existing `<base>+harness.<sha>` release, create `<base>-harness.<sha>` with the same target commitish, same assets (download + re-upload), `--prerelease --latest=false`, notes pointing at the original. Verify each new asset URL with a HEAD request before proceeding (rule 3: create-first, verify, never delete the old). Also `gh release edit --prerelease` each of the 18 originals. Gate: requires explicit approval before running (public repo mutation, ~126 asset transfers).
- [ ] **Unit 2: workflow cutover.** `harness-release.yaml`: both `RELEASE_TAG` derivations (`:474`, `:922`) become `${BASE_VERSION}-harness.${SHORT_SHA}`; add `--prerelease` to `gh release create` (`:796`); update the `--latest=false` comment to state both isolation axes (semantic-release via non-v, Renovate via prerelease identifier + prerelease flag); verify the version guards (`:562`, `:574`) and idempotency `gh release view` lookups handle the hyphen tag; `NPM_VERSION` derivation is already hyphen — confirm no drift.
- [ ] **Unit 3: setup-path tag mapping.** `src/services/setup/opencode.ts`: `buildDownloadUrl` and `buildChecksumsUrl` derive the release tag by converting `+harness.` → `-harness.` (reuse/extract the `toolCacheVersion` conversion); URL encoding then has no `%2B` case for harness tags. `isHarnessVersion`, `toolCacheVersion`, `DEFAULT_OPENCODE_VERSION` unchanged. Tests: URL construction for both builders against the hyphen tag; the `%2B` assertions updated; a regression test pinning that a `+harness.` *input* maps to the `-harness.` *tag URL*; fail-closed behavior unchanged.
- [ ] **Unit 4: docs + compound.** Update `docs/solutions/workflow-issues/semantic-release-tag-namespace-collision-2026-06-14.md` with the dual-consumer constraint (non-v solved semantic-release, re-exposed to Renovate; hyphen form satisfies both); note the unified tag/npm identity; close the loop on issue #1492 with the residual-risk statement from KTD 6.
- [ ] **Unit 5 (fro-bot/.github, separate repo): containment packageRule** pinning `fro-bot/agent` action updates to `<1.0.0`, plus a look at the silent `update failure`-with-green-job behavior flagged in triage.

## Verification

- Unit 1: every new hyphen-tag asset URL returns 200 on HEAD; originals untouched (still 200); all 36 releases show `isPrerelease: true`.
- Unit 2: dry-run of `harness-release.yaml` (release creation is skipped under dry-run but tag derivation and guards execute); next real harness release publishes under the hyphen tag.
- Unit 3: full setup test suite; a live-download smoke against the Unit 1 duplicate of the current pin (`1.18.21-harness.22dee0ee`) proving the new mapping resolves real assets.
- End-to-end: after Unit 5 lands, confirm fro-bot/.github's `major-github-actions` branch recovers (no `1.18.x` candidate proposed).

## Sequencing

Unit 1 strictly before Unit 3 ships (the mapping 404s without the duplicates). Unit 2 and Unit 3 land together in one PR (a hyphen release without the mapping is unreachable by new code; the mapping without hyphen releases 404s — they are one cutover). Unit 4 rides the same PR. Unit 5 is independent and can land immediately (containment now, independent of the upstream fix).
