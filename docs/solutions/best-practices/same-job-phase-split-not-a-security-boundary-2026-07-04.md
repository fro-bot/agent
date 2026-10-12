---
title: Sequential steps in one GitHub Actions job are not a security boundary
date: 2026-07-04
last_updated: 2026-10-12
category: best-practices
module: ci-workflows
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - A prompt-injectable or untrusted step runs before a trusted credential-holding step in the same job
  - You are relying on step ORDER to isolate trust while preserving a one-job constraint
  - An earlier step can influence env, workspace files, git config, hooks, or shell startup files
  - A long-lived App key or PAT is read by a step placed after an agent step in the same job
tags:
  - github-actions
  - security-boundary
  - prompt-injection
  - step-order
  - credential-isolation
  - github-env
  - app-private-key
---

# Sequential steps in one GitHub Actions job are not a security boundary

## Context

To keep an agent from holding a write credential while still doing a privileged push, a tempting design is a same-job "phase split": run the prompt-injectable agent in one step with no write token, then a later "trusted" step holds the token and does the push — all in one job (e.g. to preserve `harness-integrate.yaml`'s one-job security invariant). Evaluated (and rejected) while scoping #1107.

## Guidance

Same-job sequential steps are **not** a trust boundary. Steps in one job share a runner, a filesystem, and a shell environment, and an earlier step can poison every later step. If the earlier step runs untrusted/prompt-injectable code, a later step in the same job cannot be treated as trusted relative to it.

Poisoning vectors an earlier step controls:

- **`GITHUB_ENV`** — append env vars (`GIT_ASKPASS`, `PATH`, `BASH_ENV`, `GH_TOKEN`, `GIT_CONFIG_*`) that later steps silently inherit.
- **Workspace files** — write scripts/configs a later step reads or executes.
- **`.git/config` and git hooks** — later `git` invocations pick up attacker-controlled config (`core.hooksPath`, `core.sshCommand`, remotes).
- **`BASH_ENV`** — a file sourced by every non-interactive bash step.
- **`PATH` / shims** — shadow real binaries a later step calls.

`git --no-verify` disables hooks but does **not** make the later step trusted — it closes one vector of many.

Real isolation requires either:
- a **separate job** (fresh runner, explicit `needs.*`/outputs hand-off, no shared filesystem or env), or — better for credentials —
- **credential minimization**: give the untrusted step only a short-lived, narrowly-scoped token so there is little worth protecting from it, rather than trying to withhold a broad one until "later" in the same job.

If a same-job split is unavoidable, the later step needs aggressive hardening (clean env, `BASH_ENV=/dev/null`, safe `PATH`, ignore workspace git config, hardcoded remote/ref) — and even then it is defense-in-depth, not a boundary.

## Why This Matters

Same-job phase splits look neat and preserve one-job constraints, so teams reach for them believing they isolate. They don't. Designing security around step order gives a false sense of a boundary that an injected earlier step walks straight through. Naming this prevents shipping a design whose "trusted step" is trusting attacker-influenced state.

## When to Apply

- Designing any agent-vs-privileged-operation split in CI ("run the untrusted thing, then do the privileged thing").
- Any attempt to keep one job while pretending its steps are mutually isolated.
- Reviewing a workflow that runs untrusted/agent code and later consumes a credential or pushes.

## Examples

Poisoning via `GITHUB_ENV` (earlier untrusted step):

```bash
echo "GIT_ASKPASS=$PWD/evil-askpass.sh" >> "$GITHUB_ENV"
echo "PATH=$PWD/bin:$PATH" >> "$GITHUB_ENV"
# a later "trusted" push step now uses attacker-controlled askpass + PATH
```

Poisoning via `BASH_ENV`:

```bash
echo 'export GH_TOKEN=exfil' > /tmp/be
echo "BASH_ENV=/tmp/be" >> "$GITHUB_ENV"
# every later non-interactive bash step sources /tmp/be automatically
```

Better — separate jobs (real hand-off):

```yaml
jobs:
  agent:
    runs-on: ubuntu-latest
    outputs:
      ref: ${{ steps.out.outputs.ref }}
    steps:
      - id: out
        run: echo "ref=refs/harness-integrate/v1" >> "$GITHUB_OUTPUT"
  push:
    needs: agent
    runs-on: ubuntu-latest # fresh runner — no shared fs/env with `agent`
    permissions:
      contents: write
    steps:
      - run: git push origin "${{ needs.agent.outputs.ref }}"
```

Better still for credentials — minimize instead of "trust later":

```yaml
# give the agent only a short-lived, contents:write-scoped token;
# there is nothing broad left to protect from it, so no boundary is needed
env:
  GH_TOKEN: ${{ steps.mint.outputs.token }}
```

## Post-phase input re-injection (2026-07-12)

A marketplace action's `post:` hook is another same-job boundary failure, distinct from step-order poisoning but rooted in the same shared-filesystem reality: the runner re-supplies the action's `with:` inputs as `INPUT_*` environment variables during the post (cleanup) phase, at the **end** of the job. An action that received a private key via `with:` therefore exposes that key again at job end, after every untrusted step has already run. A prompt-injected earlier step can tamper with the on-disk `_actions/**/dist/post.js` before the post phase executes and harvest the re-supplied input directly. SHA-pinning the action pins the download it fetched, not same-job filesystem integrity — it does nothing to stop a same-job step from rewriting the checked-out post script.

Consequence: any step that must hold a genuinely sensitive key (e.g. a GitHub App private key) has to be a plain `run:` step invoking a checked-in script, not a marketplace action with a `post:` hook — see `docs/solutions/best-practices/inline-scoped-app-token-mint-2026-07-12.md` for the concrete pattern this rules out `actions/create-github-app-token` for. Evidence: `actions/create-github-app-token`'s post phase re-reads its inputs via `getBooleanInput`, confirming the re-injection is real, not theoretical.

## Mint before the agent, not after (2026-10-12)

In `.github/workflows/harness-integrate.yaml` the App token mint step used to run after the prompt-injectable `Run Fro Bot` step. Both steps run as the same user on the same runner. The agent step could therefore change the checked-in `scripts/harness/mint-app-token.ts`, or anything it imports, and the next step would run that code with `APPLICATION_ID` and `APPLICATION_PRIVATE_KEY` in its environment. The App private key reaches every repository the App is installed on, with the App's full permissions, until it is revoked. Untrusted content can reach the agent through the allowlisted carry PR refs, which are fetched by the mutable `refs/pull/N/head`.

The fix was an ordering change, not a redesign. In #1792 the mint step runs immediately before `Run Fro Bot`. From the agent step onward, no step receives the App secrets. The rule:

- In a job that runs untrusted or agent code, exchange any long-lived secret for a short-lived, narrowly scoped token **before** the untrusted step.
- Pass only that token downstream, through a masked step output. Never use `GITHUB_ENV` or job-level `env` for it.
- The token now has to outlive the agent run. Cap the agent step (`timeout-minutes: 40`) so the roughly 1-hour token leaves headroom for the trusted push. A finalization that runs past expiry fails closed at the push.

```yaml
      - name: Mint scoped App token for trusted finalization
        id: mint-app-token
        run: node --experimental-strip-types scripts/harness/mint-app-token.ts
        env:
          APPLICATION_ID: ${{ secrets.APPLICATION_ID }}
          APPLICATION_PRIVATE_KEY: ${{ secrets.APPLICATION_PRIVATE_KEY }}

      - name: Run Fro Bot
        uses: ./
        timeout-minutes: 40
```

`scripts/fro-bot-workflow.test.ts` pins the ordering:

- the mint runs before the agent;
- no step from the agent onward references `APPLICATION_ID` or `APPLICATION_PRIVATE_KEY`;
- the job-level `env` carries neither;
- the token reaches the push step only through the step output;
- the mint is a plain `run:` of the checked-in script with no `uses:`, and its `env` is exactly the two secrets;
- the agent's `timeout-minutes` is at most 45.

This ordering closes the escalation to the App private key. It deliberately leaves these open:

- The scoped push token is written to the runner's `$GITHUB_OUTPUT` file, so a same-runner agent can read it. Masking only keeps it out of logs.
- The agent step still receives its model credential through `auth-json` from the broker mint.
- The trusted push step still runs checked-out code (`packages/harness/src/cli.ts`) with the token.
- A malicious integration candidate can still ship.

## Related

- `docs/solutions/best-practices/inline-scoped-app-token-mint-2026-07-12.md` — the inline no-post mint pattern this post-phase finding rules toward.
- Issue #1180; PR #1792 (mint before the agent).
- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — credential minimization via broker-mint (the real fix for #1107), and why credential-lifetime/process boundaries matter more than agent config.
- `docs/solutions/workflow-issues/create-github-app-token-caller-mint-invalid-2026-07-04.md` — the reusable-workflow constraint that pushes this design toward mint-in-workflow or broker-mint.
- Issue #1107; PR #1119 (interim hygiene); #1124 + `marcusrbrown/infra#771` (the broker-mint fix).
