---
type: guide
last-updated: "2026-09-03"
updated-by: "pr-1527"
sources:
  - action.yaml
  - src/services/cache/save.ts
  - src/shared/brokered-push-paths.ts
  - src/features/delegated/brokered-push.ts
  - src/features/delegated/brokered-push-validation.ts
  - packages/gateway/src/web/operator-route.ts
  - docs/solutions/test-failures/gateway-operator-route-health-timeout-flake-2026-07-30.md
summary: "Diagnosing common Fro Bot Agent failures — no response, cache persistence, timeouts, brokered push, and a known gateway test flake"
---

# Troubleshooting

Common failure modes when running the Fro Bot Agent GitHub Action, and how to diagnose them. For configuration inputs see [`action.yaml`](../../action.yaml); for the execution model see [[Execution Lifecycle]].

## Agent Not Responding

If the agent does not react to a mention or event:

- **Check permissions** — the workflow needs `contents`, `issues`, and `pull-requests` write permissions for the triggers it handles.
- **Verify credentials** — the `OPENCODE_AUTH_JSON` secret must be well-formed JSON mapping provider IDs to credentials.
- **Check the trigger condition** — for comment triggers, `@fro-bot` must appear in the comment body, and the workflow `if:` guard must match the event.
- **Confirm mention identity** — `@fro-bot` mentions require a token whose login matches the mention. `GITHUB_TOKEN` posts as `@github-actions`, so a PAT or GitHub App token is required to answer `@fro-bot`.
- **Review access control** — only `OWNER`, `MEMBER`, and `COLLABORATOR` authors are processed; bot accounts and fork pull requests are skipped by design.

## Cache Issues

If sessions are not persisting between runs:

1. Check which trigger the run used. On GitHub-hosted runners, `issue_comment` and `issues` runs cannot write the Actions cache at all — GitHub scopes the cache token by trigger class, so this applies regardless of who triggered the run, and no `permissions:` change affects it. If the bot forgets between mentions while `workflow_dispatch` runs remember fine, this is the cause; enable `s3-backup` for continuity on GitHub-hosted runners. See [[Session Persistence]].
2. Check the GitHub Actions cache size (Settings → Actions → Cache). The cache has a 10 GB per-repository limit and entries expire after 7 days of inactivity.
3. Enable S3 backup (`s3-backup: true`) for durable persistence that outlives cache eviction, and for continuity on the mention triggers above.
4. Verify `skip-cache` is not set to `true`.
5. Review run logs for cache-corruption warnings — a corrupted restore falls back to S3 when configured.

See [[Session Persistence]] for how memory survives across runs.

## Timeout Errors

If the agent times out before completing:

- Increase the `timeout` input (default `1800000` ms / 30 minutes; `0` disables the limit).
- Check the run logs for stuck operations or loops.
- Break large tasks into smaller, focused steps.

## Brokered Push Not Landing

When an authorized `@fro-bot` PR comment produces workspace edits but no commit appears on the PR head branch, the [[Execution Lifecycle|brokered push]] step suppressed itself. It is fail-closed by design, so a missing push almost always means one of its trust gates declined rather than a bug:

- **Missing trust anchor** — the workflow must pass `trusted-head-sha` (from the PR head SHA) for the push to be eligible. Without it the step bypasses silently. See [[Setup and Configuration]].
- **Path outside the allowlist** — brokered pushes are limited to `src/`, package `src/`, `docs/`, and the top-level `README.md`, `ARCHITECTURE.md`, and `STRUCTURE.md`, capped at 100 files. Edits to config, scripts, or CI files are rejected and the run fails loudly. A consumer can widen the set with the `brokered-push-extra-paths` input (comma-separated prefixes), but protected surfaces stay denied no matter what is listed, and a malformed or overlapping entry fails the run at parse time on _every_ trigger rather than waiting until a push is attempted. To see what the run actually resolved, read the `brokered-push-allowlist` output — it reports the effective `defaultPaths`, `rootFiles`, and `extraPrefixes` as JSON (empty when the run exits before finalize).
- **Live re-check failed** — the actor's write permission, the PR's open state, and the head branch and SHA are all re-verified immediately before the commit. A moved head, a renamed branch, a closed PR, or a permission lookup error all abort the push.
- **Not a same-repo PR comment** — the step only runs for `issue_comment` events on a pull request in the same repository from an `OWNER`, `MEMBER`, or `COLLABORATOR`. Fork PRs and other event types never broker a push.
- **Timed out** — the push has a 120-second ceiling. If it fires after the commit already landed server-side, the run reports failure but the commit exists; a re-run reconstructs a clean workspace and does nothing rather than double-committing.

Since the failure paths above are hard to tell apart from a reason string alone, the brokered-push outcome now carries a closed `failureClass` discriminant — `validation`, `reconstruction`, `moved-head`, `identity`, `permission`, `commit`, `timeout`, or `unknown` — and validation rejections additionally list the offending paths. That is the field to read in the logs when diagnosing a suppressed push; the human-readable reason strings are unchanged and no caller branches on their text.

## Known Gateway Test Flake

A lone timeout in `packages/gateway/src/web/operator-route.test.ts` during a full `bun run test` is a known, non-blocking flake, not a regression. The suite only exercises static route-classification guards with no timing-sensitive logic; under peak parallel load its tasks can be starved past the default 5-second budget. Confirm the flake by checking that the failure is a **timeout** (not an assertion), that it is the only failure in an otherwise-green run, and that the file passes in isolation:

```bash
bunx vitest run packages/gateway/src/web/operator-route.test.ts
```

If all three hold, re-run rather than treating it as a signal. An assertion failure, or a timeout that reproduces in isolation, is a different problem and should be investigated normally.

The isolation check is what separates this flake from an ordinary slow test. A test that legitimately costs more than the default budget on _every_ run — for example one that builds several temporary git repositories — fails deterministically when run alone, not just under parallel load. That kind of timeout wants an explicit per-test budget, not a re-run. The rule of thumb: passing in isolation points back to this scheduler-contention flake; failing in isolation points at the test's own cost.
