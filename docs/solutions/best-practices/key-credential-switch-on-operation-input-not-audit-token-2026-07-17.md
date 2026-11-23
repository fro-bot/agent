---
title: Key a CI credential switch on the operation input, not an audit token
date: 2026-07-17
last_updated: 2026-11-23
category: best-practices
module: release-notes
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - an automation splits into jobs/steps that use different credentials (read-only vs write)
  - the dispatch surface accepts both an operation input and an audit/tracing token that can be set independently
  - untrusted content (PR titles, commit subjects, issue bodies) flows into a step the credential gates
  - a workflow may be dispatched by an older caller checked out from a released tag during a rollout window
related_components:
  - tooling
tags:
  - credential-selector
  - operation-input
  - audit-vs-trace
  - prompt-injection-via-forgeable-key
  - deploy-window-compat
  - release-pipeline
  - github-actions
---

# Key a CI credential switch on the operation input, not an audit token

## Context

The two-phase release-notes narration flow runs a **read-only generation agent**
(workflow `GITHUB_TOKEN`, `contents: read` + `pull-requests: read`) that gathers
untrusted PR evidence and writes a candidate, then a **separate trusted apply job**
(`FRO_BOT_PAT`, a single `gh release edit`). The whole security posture rests on one
conditional: which credential the generation agent's checkout and action step receive.

The first implementation keyed that switch on `correlation-id` — a UUID used purely
for run selection and audit correlation. That is the wrong axis. `correlation-id`
is a tracing token; it says nothing about whether the run is performing the
privileged operation. Two independent reviewers (security and adversarial)
converged on the same hole.

## Guidance

Key the read-only-vs-write credential switch on the **operation input** (the input
that names the privileged action being performed), never on an audit/tracing token
that can be set independently.

```yaml
# .github/workflows/fro-bot.yaml
# Keyed on release-tag (the operation), not correlation-id (an audit token):
#   (a) a manual dispatch that sets release-tag without correlation-id must NOT
#       hand the generation agent the PAT;
#   (b) an old dispatcher (checked out from a released tag) that sets
#       correlation-id but not release-tag is not classified as the release
#       operation, so an audit label never selects its credential.
# Direct autonomous schedule/dispatch and release-tag narration use
# github.token. Reusable callers and all other triggers retain the PAT.
token: ${{ github.event.inputs.release-tag != '' && github.token || ((github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && github.workflow_ref == format('{0}/.github/workflows/fro-bot.yaml@{1}', github.repository, github.ref) && github.token) || secrets.FRO_BOT_PAT }}
```

The first arm is the operation switch. The second arm gives direct `schedule` and
`workflow_dispatch` runs of `fro-bot.yaml` itself the workflow token too; the
`workflow_ref` comparison excludes reusable callers, whose `workflow_ref` names the
caller's workflow. `secrets.FRO_BOT_PAT` remains the fallback for reusable callers
and the other triggers.

The mutating apply job requires **both** inputs, so a half-specified manual dispatch
degrades to a harmless read-only generate run with no apply:

```yaml
# Both inputs required: the artifact name needs correlation-id, and a
# half-specified manual dispatch should produce a read-only generate run with no
# apply — fail-soft.
if: ${{ github.event.inputs.release-tag != '' && github.event.inputs.correlation-id != '' }}
```

Null-coercion note: for non-`workflow_dispatch` events (`mention`/`comment`/
`schedule`/`workflow_call`), `github.event.inputs.release-tag` is null and
`null != ''` evaluates false, so the operation arm never fires for them. Which
credential such a run gets is then decided by the remaining arms: direct
`schedule`/`workflow_dispatch` runs of `fro-bot.yaml` get the workflow token, while
mention/comment events and reusable callers keep the write-capable PAT. A future
refactor to strict comparison on the operation arm would classify every event
without the input as a release run and silently downgrade those PAT paths to the
read-only token — the coercion behavior is load-bearing.

## Why This Matters

**Security.** Keying on `correlation-id` let a manual dispatch set `release-tag`
(triggering the apply intent) while leaving `correlation-id` empty — handing the
generation agent the write-capable PAT while it processes prompt-injectable,
contributor-authored PR bodies. Keying on the operation input decouples the
write credential from a non-security field that an attacker or a misdispatch can
set on its own. The credential now tracks the operation, not a diagnostic label.

**Stale callers are not misclassified.** `@semantic-release/exec` runs its
`successCmd` from the checkout of the **released tag**, not from `main`, so an
*older* dispatcher can dispatch a *newer* workflow and set `correlation-id` without
`release-tag`. Because the operation arm keys on `release-tag`, that dispatcher is
not treated as the release operation, and the audit label never selects its
credential; the other arms of the expression decide it.

## When to Apply

- Any workflow where a credential or permission boundary is gated by a dispatch input.
- Especially when multiple inputs exist and at least one is diagnostic/audit-only —
  the credential selector must be the operation, never the label.
- Any semantic-release (or other tag-checkout) dispatch, where old callers can hit a
  new workflow during the deploy window and must degrade safely.

## Examples

### Bad: credential keyed on the audit token

```yaml
# release-tag (the operation) and correlation-id (audit) are independent inputs.
# A manual dispatch can set release-tag without correlation-id → PAT on an
# agent processing untrusted PR content.
token: ${{ github.event.inputs.correlation-id != '' && github.token || secrets.FRO_BOT_PAT }}
```

### Good: credential keyed on the operation input

```yaml
# operation arm of the real expression (full form under Guidance):
token: ${{ github.event.inputs.release-tag != '' && github.token || secrets.FRO_BOT_PAT }}
# mutating apply job additionally requires BOTH inputs:
if: ${{ github.event.inputs.release-tag != '' && github.event.inputs.correlation-id != '' }}
```

## Related

- [`release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md`](./release-notes-narration-routing-and-fail-soft-guards-2026-06-07.md)
  — the progenitor doc for this pipeline. Its correlation-id guidance is for run
  selection/audit only; this doc adds the constraint that the credential selector
  must be the operation input.
- [`response-file-is-untrusted-input-2026-07-11.md`](./response-file-is-untrusted-input-2026-07-11.md)
  — closest neighbor: "delivery mode and credential provisioning are two
  independent axes, resolved separately." Same trust-boundary discipline, applied
  to response delivery rather than the operation-vs-audit input split.
- [`same-job-phase-split-not-a-security-boundary-2026-07-04.md`](./same-job-phase-split-not-a-security-boundary-2026-07-04.md)
  — same problem space (isolate a write credential from a prompt-injectable step),
  different mechanism (cross-job vs input-selector).
- [`inline-scoped-app-token-mint-2026-07-12.md`](./inline-scoped-app-token-mint-2026-07-12.md)
  — a neighboring rung on the credential-minimization ladder.
- [`../workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md`](../workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md)
  — same trust-boundary discipline applied to credential issuance; the prohibition
  generalizes to credential-selector inputs.
- PR #1239 — the two-phase narration redesign that introduced this switch.
