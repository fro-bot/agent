---
type: guide
last-updated: "2026-07-01"
summary: "Diagnosing common Fro Bot Agent failures — no response, cache persistence, and timeouts"
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

1. Check the GitHub Actions cache size (Settings → Actions → Cache). The cache has a 10 GB per-repository limit and entries expire after 7 days of inactivity.
2. Enable S3 backup (`s3-backup: true`) for durable persistence that outlives cache eviction.
3. Verify `skip-cache` is not set to `true`.
4. Review run logs for cache-corruption warnings — a corrupted restore falls back to S3 when configured.

See [[Session Persistence]] for how memory survives across runs.

## Timeout Errors

If the agent times out before completing:

- Increase the `timeout` input (default `1800000` ms / 30 minutes; `0` disables the limit).
- Check the run logs for stuck operations or loops.
- Break large tasks into smaller, focused steps.
