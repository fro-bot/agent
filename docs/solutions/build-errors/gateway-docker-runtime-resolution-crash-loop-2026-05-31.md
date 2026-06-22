---
title: Gateway Docker image crash-loop — workspace runtime externalized but not shipped
date: 2026-05-31
category: build-errors
module: packages/gateway
problem_type: build_error
component: tooling
symptoms:
  - Gateway Docker image crash-loops on boot
  - ERR_MODULE_NOT_FOUND for @fro-bot/runtime resolving to src/index.ts
  - Fails only in the built image; local dev and tests pass
root_cause: config_error
resolution_type: config_change
related_components:
  - gateway
  - runtime
  - docker
  - tsdown
  - github-actions
tags:
  - docker
  - bundling
  - tsdown-noexternal
  - monorepo
  - module-resolution
  - ci-smoke
---

# Gateway Docker image crash-loop — workspace runtime externalized but not shipped

## Problem

The gateway Docker image crash-looped on boot with `ERR_MODULE_NOT_FOUND` for `@fro-bot/runtime`. The gateway bundle left the workspace package external, so at runtime Node tried to resolve a package entry (`src/index.ts`) that exists only in a source checkout — not in the image. This shipped silently across v0.45.0–v0.47.0 and forced a downstream deployer to pin back.

## Symptoms

- `ERR_MODULE_NOT_FOUND` on boot, resolving to `node_modules/@fro-bot/runtime/src/index.ts`.
- Crash-loop before the gateway finishes loading config.
- **Only in the built image** — local dev and `pnpm test` pass because `packages/runtime/src/` exists on the host checkout, so the bare import resolves there.

## What Didn't Work / Why It Stayed Hidden

- Host-checkout tests can't catch it: `packages/runtime/src/index.ts` is present locally, so the bare specifier resolves during dev and CI unit tests.
- Nothing in CI built or booted the gateway image, so an image-only packaging regression had no guard.
- Rejected alternative — pointing `packages/runtime/package.json` `exports` at compiled `dist/` (conditional exports `development`→src, `import`/`default`→dist): adds build-order coupling and risks the action tier, which inlines runtime at build time. Inlining the consumer bundle is simpler and matches existing precedent.

## Solution

Three changes (PR #708):

**1. Inline `@fro-bot/runtime` into the gateway bundle** — `packages/gateway/tsdown.config.ts`:

```ts
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  outDir: 'dist',
  noExternal: id => {
    if (id === '@fro-bot/runtime' || id.startsWith('@fro-bot/runtime/')) return true
    return false
  },
})
```

This mirrors the action tier, which already inlines the same workspace dep in the root `tsdown.config.ts` (`if (id.startsWith('@fro-bot/runtime')) return true`). The exact-or-subpath predicate avoids over-matching a hypothetical sibling like `@fro-bot/runtime-foo`.

**2. Stop shipping the now-dead runtime files** — `deploy/gateway.Dockerfile` final stage:

```dockerfile
# removed — bundle no longer references @fro-bot/runtime at runtime
- COPY --from=build /workspace/packages/runtime/package.json ./packages/runtime/package.json
- COPY --from=build /workspace/packages/runtime/dist/ ./packages/runtime/dist/
```

**3. Add a CI image build + boot smoke** — `.github/workflows/ci.yaml` (`gateway-smoke` job). Build-time invariant plus an image boot that proves resolution, with a hang guard:

```sh
# build-time: bundle must be self-contained
if grep -q 'from "@fro-bot/runtime"' packages/gateway/dist/main.mjs; then
  echo "REGRESSION: gateway dist has bare @fro-bot/runtime import"; exit 1
fi

# boot the image with no secrets — must reach config load, not a module crash
output="$(timeout 60s docker run --rm fro-bot-gateway:smoke 2>&1)"; status=$?
[ "$status" -eq 124 ] && { echo "REGRESSION: image hung on boot"; exit 1; }
test "$status" -ne 0
echo "$output" | grep -q "Missing required secret: DISCORD_TOKEN"
echo "$output" | grep -q "ERR_MODULE_NOT_FOUND" && { echo "REGRESSION: module resolution failed"; exit 1; } || true
```

## Why This Works

Inlining removes the bare `@fro-bot/runtime` specifier from `dist/main.mjs`, so the image has nothing to resolve at boot — the dependency travels inside the bundle. That matches the action tier's established bundling rule. The CI smoke catches both the bad bundle shape (build-time grep) and the image-only boot failure (docker run), which host-checkout tests structurally cannot.

## Prevention

- **Rule:** when a bundler externalizes a workspace package whose published entry points at uncompiled `src/`, the consuming deployable must either inline it (`noExternal`) or ship the resolved `dist/`. Externalizing-and-not-shipping is the trap.
- **Guard:** any deployable image needs a CI build-and-boot smoke. Unit tests on a source checkout can't see image-only packaging gaps because `src/` is present locally.
- **Concrete invariant:** `grep -q 'from "@fro-bot/runtime"' packages/gateway/dist/main.mjs` returning true means the image is unsafe to ship.

## Related

- Issue #707 (fixed by PR #708, `721f213`).
- [Adding a Config-Declared Plugin to the Versioned Tool Pattern](../best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md) — the same "verify how a dependency is actually resolved before copying a pattern" discipline, applied to workspace-package bundling.
- [Tool Binary Caching Across Ephemeral Runners](./tool-binary-caching-ephemeral-runners.md) — related CI-hygiene angle; note that cache optimization does not address image-only packaging gaps.
- [Committed-bundle attribution and SBOM hygiene](../workflow-issues/committed-dist-attribution-and-sbom-hygiene-2026-06-21.md) — the same "build a concrete invariant into the bundler, then let a CI self-check prove it" discipline, applied to a committed dist/ attribution file.
