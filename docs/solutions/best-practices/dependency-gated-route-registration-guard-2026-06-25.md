---
title: 'Guard dep-gated routes with a shared wiring seam and an offline route-inventory smoke'
date: 2026-06-25
last_updated: 2026-06-26
category: best-practices
module: gateway
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Adding or modifying a route/feature that mounts only when a runtime dependency is present
  - Wiring a new optional dep into a server/CLI bootstrap that may silently skip the dep
  - Building a CI smoke for an HTTP surface that cannot be HTTP-probed in the test environment
  - Reviewing a PR that adds a gated route and wanting a non-vacuous regression check
  - Centralizing scattered inline deps-construction into a single named helper
tags:
  - gateway
  - operator
  - routes
  - smoke
  - diagnostic
  - dep-gating
  - regression-guard
  - offline-smoke
---

# Guard dep-gated routes with a shared wiring seam and an offline route-inventory smoke

## Context

The gateway operator HTTP surface (`packages/gateway/src/web/server.ts`, `buildOperatorApp`)
mounts each route behind a runtime **dependency-presence gate**:

- `GET /operator/repos` mounts only if `deps.listBindings !== undefined`
- `POST /operator/runs` mounts only if `deps.getBindingByRepo !== undefined && deps.launchWorkDeps !== undefined`
- `GET /operator/runs` mounts only if `deps.runIndex !== undefined && deps.listBindings !== undefined`
- `POST /operator/runs/:runId/approvals/:requestId/decision` and
  `GET /operator/runs/:runId/approvals` mount only if `deps.approvalRegistry !== undefined`

Every gated dep is **optional** on `OperatorServerDeps`. So a construction site that forgets to
pass one compiles clean, `buildOperatorApp` silently drops the route, and the framework's catch-all
404 is indistinguishable from a path that simply doesn't exist. Three omissions actually shipped to
production, in sequence: `listBindings` (#1001 → #1020), then `getBindingByRepo` + `launchWorkDeps`
(#1030), then `approvalRegistry` (#1031). The launch route and both approval routes were **404 in the
deployed image** while the code looked correct.

The unit test (`server.test.ts`) passed the whole time because it hand-wires a *complete* deps object
and asserts the routes mount — proving the app is *capable* of mounting them, never that production
*provides* complete deps. The two are separated by exactly the wiring step, which is the step that
broke. HTTP-probing in CI is infeasible too: the operator server only starts after a provider
self-test (fails with fake S3 creds) and a Discord login (fails with a fake token), so a booted
server never even binds in the smoke environment.

This is the same problem shape as
[gateway-docker-runtime-resolution-crash-loop](../build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md):
a bug class that source-checkout tests structurally cannot catch, only a guard against the **built
image** can. There, it was module resolution; here, it's route registration.

## Guidance

A reusable four-rule pattern for any system where features mount behind runtime dep/flag presence and
a separate construction site wires them.

**1. Extract the wiring into one shared helper that production AND the diagnostic both call.**
The construction site must not be the only place that knows how to build the dep object. If a dep is
dropped from the helper, *both* production and the diagnostic lose it — so the diagnostic can never
have a more complete view than production, and a silent omission surfaces in both. Here,
`buildOperatorServerInputs()` (`packages/gateway/src/program.ts`) is the sole thing that decides which
deps flow into `OperatorServerDeps`; production's `startOperatorServer(...)` and the smoke both call it.

**2. Add an offline diagnostic that builds the app via the helper, reads the framework's route
registry, and asserts the expected route inventory.** No server bind, no credentials, no network —
the mount gates only check dep presence/shape, not liveness, so stub-but-present deps are sufficient.
A missing dep → the route is absent from the route table → the diagnostic names it and exits non-zero.
Here, `runOperatorRouteSmoke()` (`packages/gateway/src/web/operator-route-smoke.ts`) reads Hono's
`app.routes`. The framework-specific analog: Express `app._router.stack`, Fastify `app.printRoutes()`,
Nest module metadata.

**3. Expose the diagnostic as a subcommand of the shipped binary and run it in CI against the BUILT
artifact, not a local build.** A local `vitest` run only proves your source compiles. The
diagnostic-in-image catches the cases a source test cannot: a side-effectful registration tree-shaken
out, the wrong `dist/` shipped, or the dep never wired into the build entry point. Here,
`node dist/main.mjs operator-route-smoke` (dispatched in `main-dispatch.ts`) runs inside the
`Gateway Image Smoke Test` job via `docker run --rm fro-bot-gateway:smoke ...`.

**4. Make the guard non-vacuous.** Two checks, both required:
(a) one shared canonical `EXPECTED_*` constant imported by *both* the smoke and the unit test so they
cannot drift — plus a `length > 0` assertion, because an emptied list passes vacuously with zero
missing routes; and
(b) a regression test that explicitly omits each gated dep from the helper input and asserts the
corresponding route goes absent. Preserve the exit-code contract through the subcommand dispatch (no
`process.exit(0)` swallowing the diagnostic's return value).

## Why This Matters

DI + optional deps is a whole class of silent feature-unmount bug. The compile-time signal is zero —
an object literal with a missing optional field type-checks. The runtime signal is zero — no error,
the route just never registers, and the catch-all 404 looks identical to an unknown path. The only
signal is "the route is absent from the route inventory," and that is invisible to any test that
constructs the app with hand-wired complete deps.

Hand-wired unit tests miss this because they prove the wrong property. "Given complete deps, the app
mounts route X" tells you the app is *capable* of mounting X; it says nothing about whether production
*provides* complete deps. A test that builds the app via the **same helper production uses** proves
both at once: correct helper output → route mounts; a dropped dep → route absent → test fails. That is
the only test that catches the actual production failure mode.

Running against the **shipped artifact** closes a second class: bundler misconfiguration, wrong
`dist/` shipped, side-effectful registration dropped by tree-shaking. Local tests can pass on a build
that doesn't match what production runs.

The canonical-constant rule matters because the smoke and the unit test assert the same property —
"the full route set is registered." Separate copies drift the moment someone adds a route. One
constant imported by both means one place to update, and the unit test's equality check catches drift
at PR time before the diagnostic even runs.

## When to Apply

- **DI containers / plugin registries / feature-flag gated routes.** Any system where features mount
  behind runtime presence checks on a deps/flags/config object and a separate construction site
  populates it: Hono/Express/Fastify/Nest route gating, plugin arrays, NestJS module metadata, Effect
  layers — anything where a `!== undefined` or `if (flag)` gate decides whether a feature is wired.
- **Constructor-site wiring separated from use-site.** The bug is structural: the assembler is a
  different function from the consumer. The unit test exercises the consumer's contract; the
  diagnostic exercises the wiring. Only the diagnostic closes the gap.
- **Production-only or slow-to-start surfaces.** If the surface can only run end-to-end after real
  credentials or a long startup, HTTP-probing isn't feasible in CI; read the framework's internal
  registry without binding a port instead.
- **Schemas that mark deps optional.** If `readonly foo?: T` and `foo`'s presence decides whether a
  feature mounts, `foo` is structurally optional-but-required and needs a runtime presence check.
- **Bundled/shipped artifacts.** If the surface runs from a `dist/` or container image, the
  diagnostic must run against that artifact.

Skip it when the wiring is trivial (one file, one path, no optional fields) or when the surface is
small enough to construct in-test with all real deps and bind to `127.0.0.1:0`.

**Maintenance rule:** the route inventory is a load-bearing claim about the surface. When a new route
lands, add it to `EXPECTED_OPERATOR_ROUTES` in the same PR. `GET /operator/runs` is now part of that
canonical inventory. Forgetting to update the constant when adding a route silently lets the new route
skip the guard's coverage — a fresh instance of the same bug class.

## Examples

**A. The wiring seam — production and the diagnostic share one helper.** Drop a field here → both
production and the diagnostic lose it.

```ts
// packages/gateway/src/program.ts
export function buildOperatorServerInputs(inputs: BuildOperatorServerInputs): {
  readonly deps: OperatorServerDeps
  readonly config: OperatorServerConfig
} {
  const {logger, denylistCache, bindingsStore, runObservationManager,
         runIndex, approvalRegistry, launchWorkDeps, operatorWebConfig} = inputs
  // ...operator-local pieces (rate limiter, session store, OAuth deps) built here...

  const deps: OperatorServerDeps = {
    logger,
    denylistCache,
    bindingsLookup: bindingsStore,
    // listBindings is a DISTINCT dep from bindingsLookup: server.ts gates
    // GET /operator/repos on listBindings, so omitting it leaves that route unmounted.
    listBindings: bindingsStore.listBindings === undefined
      ? undefined
      : bindingsStore.listBindings.bind(bindingsStore),
    getBindingByRepo: bindingsStore.getBindingByRepo.bind(bindingsStore),
    launchWorkDeps,
    runObservationManager,
    runIndex,
    approvalRegistry,
  }
  return {deps, config}
}
```

The anti-pattern that shipped three times — don't hand-wire inline at the construction site:

```ts
// ❌ Compiles clean even when a gated dep is forgotten — the route is silently
// unmounted, and the unit test still passes because it hand-wires a COMPLETE deps object.
const operatorDeps: OperatorServerDeps = {
  logger, isShuttingDown,
  // listBindings: ...,       // ← forgot → GET /operator/repos 404
  // getBindingByRepo: ...,   // ← forgot → POST /operator/runs 404
  // launchWorkDeps: ...,     // ← forgot → POST /operator/runs 404
  // approvalRegistry,        // ← forgot → approval routes 404
}
// (Pre-refactor call site — the construction is now centralized in the helper above.)
startOperatorServer(operatorDeps, config)
```

**B. The diagnostic core — assert the route inventory, no port bind, no credentials.**

```ts
// packages/gateway/src/web/operator-route-smoke.ts
// The single canonical list — imported by server.test.ts so the two cannot drift.
// Including every gated route is load-bearing: a route omitted here is silently
// never asserted (the same bug class this guard exists to catch).
export const EXPECTED_OPERATOR_ROUTES: readonly {readonly method: string; readonly path: string}[] = [
  {method: 'GET',  path: '/operator/health'},
  {method: 'GET',  path: '/operator/auth/github/start'},
  {method: 'GET',  path: '/operator/auth/github/callback'},
  {method: 'POST', path: '/operator/auth/logout'},
  {method: 'GET',  path: '/operator/session/csrf'},
  {method: 'GET',  path: '/operator/session'},
  {method: 'GET',  path: '/operator/repos'},
  {method: 'POST', path: '/operator/runs'},
  {method: 'GET',  path: '/operator/runs'},
  {method: 'GET',  path: '/operator/runs/:runId/stream'},
  {method: 'POST', path: '/operator/runs/:runId/approvals/:requestId/decision'},
  {method: 'GET',  path: '/operator/runs/:runId/approvals'},
]

export async function runOperatorRouteSmoke(options?: OperatorRouteSmokeOptions): Promise<number> {
  // Build via the same helper production uses — a dropped dep here is dropped there too.
  const {deps, config} = buildOperatorServerInputs(/* stub-but-present deps */)
  const app = buildOperatorApp(deps, config) // no serve(), no bind

  // Explicit comparisons, not implicit falsy checks (project convention).
  const seen = new Set<string>()
  for (const route of app.routes) {
    if (route.method === 'ALL' && route.path === '/*') continue // global middleware
    seen.add(`${route.method}:${route.path}`)
  }

  if (EXPECTED_OPERATOR_ROUTES.length === 0) return 1 // guard against a vacuous pass
  const missing = EXPECTED_OPERATOR_ROUTES.filter(r => seen.has(`${r.method}:${r.path}`) === false)
  return missing.length > 0 ? 1 : 0
}
```

**C. The non-vacuous regression test — drop a dep, assert the route goes absent.**

```ts
// packages/gateway/src/web/operator-route-smoke.test.ts
it('expected route list is non-empty (guards against vacuous pass)', () => {
  expect(EXPECTED_OPERATOR_ROUTES.length).toBeGreaterThan(0)
})

it('returns non-zero when POST /operator/runs is absent (launchWorkDeps omitted)', async () => {
  expect(await runOperatorRouteSmoke({launchWorkDepsOverride: undefined})).not.toBe(0)
})

it('returns non-zero when approval routes are absent (approvalRegistryOverride undefined)', async () => {
  expect(await runOperatorRouteSmoke({approvalRegistryOverride: undefined})).not.toBe(0)
})
```

The canonical-constant drift-guard keeps the unit test honest against the smoke's list:

```ts
// packages/gateway/src/web/server.test.ts
import {EXPECTED_OPERATOR_ROUTES} from './operator-route-smoke.js'

it('registers the full operator route set when all deps are provided', () => {
  const app = buildOperatorApp(/* full stub deps */, /* config */)
  const routeSet = new Set(extractRoutes(app).map(r => `${r.method}:${r.path}`))
  const expected = new Set(EXPECTED_OPERATOR_ROUTES.map(r => `${r.method}:${r.path}`))
  // If this fails, a route was added/removed. Update EXPECTED_OPERATOR_ROUTES (the
  // single canonical source) AND the deploy/README operator-API table.
  expect(routeSet).toEqual(expected)
})
```

**D. The subcommand dispatch + CI gate — runs against the BUILT image.**

```ts
// packages/gateway/src/main-dispatch.ts
} else if (subcommand === 'operator-route-smoke') {
  const exitCode = await runOperatorRouteSmoke() // never process.exit inside the diagnostic
  process.exit(exitCode)                          // exit-code contract preserved here
}
```

```yaml
# .github/workflows/ci.yaml — Gateway Image Smoke Test
- name: Smoke-test gateway image — operator route registration (offline diagnostic)
  timeout-minutes: 8
  run: |
    set +e
    output="$(timeout 60s docker run --rm fro-bot-gateway:smoke \
      node dist/main.mjs operator-route-smoke 2>&1)"
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
      echo "REGRESSION: operator-route-smoke exited $status — a route is not registered in the shipped image"
      exit 1
    fi
    if ! echo "$output" | grep -qE '^operator-route-smoke: all [0-9]+ operator routes registered$'; then
      echo "REGRESSION: operator-route-smoke did not print the expected success marker"
      exit 1
    fi
```

## Related

- [gateway-docker-runtime-resolution-crash-loop](../build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md)
  — the sibling "build-time invariant + CI self-check against the BUILT image" pattern, applied to
  module resolution rather than route registration.
- [web-operator-launch-surface](./web-operator-launch-surface-2026-06-20.md) — the operator listing and launch
  surface whose `GET /operator/repos`, `GET /operator/runs`, and `POST /operator/runs` routes are in
  `EXPECTED_OPERATOR_ROUTES`; this guard is their registration regression test.
- [gateway-control-surface-spine](./gateway-control-surface-spine-2026-06-15.md) — the spine that defines
  the operator transports; this guard asserts those routes are actually mounted.
- [authenticated-sse-run-observation](./authenticated-sse-run-observation-2026-06-20.md) — the SSE route
  whose `GET /operator/runs/:runId/stream` is in the inventory.
- [build-pipeline-fallible-preflight-and-finally-cleanup](../workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md)
  — same "share the production helper, don't reconstruct it in the diagnostic" principle.
