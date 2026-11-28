---
title: "Turn on run tracing in a caller repo, including the repo's own `uses: ./` jobs"
date: 2026-11-27
category: workflow-issues
module: ci-workflows
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - A repo starts sending Fro Bot run traces to the collector
  - A new fro-bot/agent call is added to a repo that already sends traces
  - A reusable or composite workflow wraps the Action
tags:
  - tracing
  - rollout
  - trace-headers
  - reusable-workflows
  - harden-runner
  - self-runs
---

# Turn on run tracing in a caller repo, including the repo's own `uses: ./` jobs

## Context

Configure and verify every call, including `uses: ./`, wrappers and their gates. Run tracing is set per Action call, with `trace-endpoint` and `trace-headers`; a call without them still runs and sends nothing, and nothing in the run says so, so a missing call, secret, egress entry or gate stays hidden until someone looks for a trace that isn't there.

A traced call exports prompt and tool content to the collector (see [Tracing a run](../../wiki/Setup%20and%20Configuration.md#tracing-a-run)). By adding a repo, the operator accepts the collector's access and retention, and the sensitivity of that repo's content. Once a repo is in, every eligible call is traced; it is not a per-call option. A call is eligible when the workflow and the code it checks out are trusted (item 7). Isolating the agent doesn't protect the credential from code the workflow itself runs outside the sandbox.

## Guidance

Work through this list for each repo.

1. **Trace every call in the repo.** Once a repo is in, all of its fro-bot/agent calls are in. That includes `uses: ./` jobs, the reusable workflows it hosts, and composite actions that wrap the Action. The first rollout pass skipped fro-bot/agent's `ci.yaml` "Test main action" and `fro-bot.yaml` "Run Fro Bot" because they are `uses: ./`; #2378 added both, with their gates.
2. **Set the token with the infra CLI, one sender group at a time.** The command writes the repo secret itself, so the token never appears in a terminal or in agent output:

   ```
   bunx @marcusrbrown/infra@latest traces sender add <group> --secret-name FRO_BOT_TRACE_TOKEN --repo OWNER/REPO
   ```

   `--repo` can be repeated. The groups are `marcusrbrown` and `fro-bot`. Use `gh secret set` only when no tool sets the secret for you; that path puts the token in your terminal.
3. **Give each direct call the endpoint for its group:**

   ```yaml
   trace-endpoint: https://traces.fro.bot/fro-bot/v1/traces
   trace-headers: 'Authorization: Bearer ${{ secrets.FRO_BOT_TRACE_TOKEN }}'
   ```

4. **Plumb reusable workflows.** Declare the secret as optional, and have each caller pass it by name. `secrets: inherit` does not cross owners. When a reusable workflow can't read the caller's variables, pass the endpoint as an input. Declaring the secret optional doesn't turn tracing off by itself. An endpoint with empty headers exports without authentication to any collector that accepts it. Build the header as `format('Authorization: Bearer {0}', secrets.FRO_BOT_TRACE_TOKEN)`, so a missing token leaves the scheme alone and item 8 turns tracing off. Otherwise, blank both inputs when the token is absent.

   ```yaml
   FRO_BOT_TRACE_TOKEN:
     description: >-
       Bare trc_ token for the run-tracing collector (optional; when it is not passed, tracing is off for the run)
     required: false
   ```

5. **Release the wrapper first.** A composite action or reusable workflow in another repo needs a release that declares the trace inputs. Then the caller's pin has to move to it, and only then does the caller change. Connect waited for Systematic v3.38.3 for this reason (#2363, then #2367).
6. **Allow the collector through egress blocks.** A job running Harden-Runner with `egress-policy: block` needs `traces.fro.bot:443` in its allowed endpoints (marcusrbrown/infra#2091). Without it the relay can't reach the collector.
7. **Gate the calls that can't prove whose code they run.** These gates apply to self-runs, where the agent can't be isolated. They reduce exposure but are not a secrecy boundary:
   - **Fork mentions.** An authorized `@fro-bot` mention on a fork PR runs as `issue_comment` in the base repo, with its secrets. The `prehead` step sets `trace=false` unless the head repo is this repo, and also when the head lookup fails (`.github/workflows/fro-bot.yaml:352-373`).
   - **`merge_group`.** It has no PR payload to check, so both inputs are blank (`.github/workflows/ci.yaml:275-276`). This relies on the job's own condition (`.github/workflows/ci.yaml:195-204`). When there is a PR payload, that condition admits only a same-repo PR from someone who isn't a bot. It checks repo and author only then. It also admits `workflow_dispatch`, so a dispatched ref needs its own trust decision before the credential goes to it. The input expressions are what turn tracing off for `merge_group`. Copy the two together. Never pass the credential on a secret-bearing trigger that checks out and runs untrusted code:

     ```yaml
     trace-endpoint: ${{ github.event_name != 'merge_group' && 'https://traces.fro.bot/fro-bot/v1/traces' || '' }}
     trace-headers: "${{ github.event_name != 'merge_group' && format('Authorization: Bearer {0}', secrets.FRO_BOT_TRACE_TOKEN) || '' }}"
     ```

   - **Reusable callers.** `fro-bot.yaml` traces only when it runs directly. It checks that `github.workflow_ref` is its own file (`.github/workflows/fro-bot.yaml:507-508`).

   Even on an allowed self-run, the non-isolated agent reads model-visible untrusted content (comments, diffs), so prompt injection can expose the write-only token. That risk is accepted because the token can only write spans: the worst case is junk spans or used-up quota.
8. **Pin v0.149.1 or later.** An unset secret expands to a bare `Authorization: Bearer`. From v0.149.1 (#2357), an `Authorization` value of only `Bearer`, `Basic` or `Token`, in any case, turns tracing off for the run (`SCHEME_WITHOUT_CREDENTIAL`, `src/harness/config/trace-inputs.ts:71`). The run starts no relay, exports no lifecycle trace and logs one warning: `trace-headers has an Authorization header with no credential (is the secret set?), so tracing is off`. Before v0.149.1 the relay started and the collector refused every span (fro-bot/.github#4338 hit this on v0.149.0 and was repinned to v0.149.1).
9. **Verify by counts, not by a green run.** Export is best-effort and never fails a run, so a green run proves nothing. Check the run log for two independent results: acknowledged relay batches with `dropped: 0` (turn spans), and a lifecycle export with `undelivered: 0`. A missing `Trace relay started` line can mean tracing was off, the run skipped early, or the relay failed to start, so read the warnings. An acknowledgment means the collector received the batch, not that the backend stored it. For an end-to-end check, find the trace in the backend. Before enabling a repo, also check that a run with the token omitted, and a run on a denied trigger, send no plugin or lifecycle spans to a test collector. The exact lines are in [Check run tracing end to end](./run-tracing-live-check-2026-11-23.md).

## Why This Matters

Each gap fails silently. A missed call, an unset secret or a blocked egress entry leaves a run that looks healthy and sends nothing. A missing gate is worse: it exposes the write-only token to a run started from a fork. That's why every item above is something you can check in the workflow file or the run log.

## When to Apply

- When adding a repo to tracing, go through the list once for every workflow that calls the Action.
- When adding a new Action call to a traced repo, apply items 1, 3, 7 and 9.
- When a reusable or composite wrapper changes, apply items 4 and 5.

## Related

- [Check run tracing end to end, locally and on the published Action](./run-tracing-live-check-2026-11-23.md): the live check that comes before a rollout, and the refusal of a bare token without a scheme.
- [Published-install live check before rollout](./published-install-live-check-before-rollout-2026-11-17.md): the general check of a published Action across callers.
- [Harden-Runner allowed endpoints](./harden-runner-allowed-endpoints-literal-scalar-drops-endpoints-2026-07-07.md): how an allowed-endpoints list can silently drop entries.
