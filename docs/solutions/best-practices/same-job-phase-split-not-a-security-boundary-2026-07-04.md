---
title: Sequential steps in one GitHub Actions job are not a security boundary
date: 2026-07-04
category: best-practices
module: ci security
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - A prompt-injectable or untrusted step runs before a trusted credential-holding step in the same job
  - You are relying on step ORDER to isolate trust while preserving a one-job constraint
  - An earlier step can influence env, workspace files, git config, hooks, or shell startup files
tags:
  - github-actions
  - security-boundary
  - prompt-injection
  - step-order
  - credential-isolation
  - github-env
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

## Related

- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — credential minimization via broker-mint (the real fix for #1107), and why credential-lifetime/process boundaries matter more than agent config.
- `docs/solutions/workflow-issues/create-github-app-token-caller-mint-invalid-2026-07-04.md` — the reusable-workflow constraint that pushes this design toward mint-in-workflow or broker-mint.
- Issue #1107; PR #1119 (interim hygiene); #1124 + `marcusrbrown/infra#771` (the broker-mint fix).
