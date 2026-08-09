---
title: Delegated refactors that touch a contract need an enumerated inventory and a signature diff
date: 2026-08-09
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Delegating a refactor that touches prompt text, delivery rules, or another enforced contract
  - Accepting delegated work whose summary reports success
  - Reviewing a change that could quietly widen or delete a fail-closed path
tags:
  - delegation
  - contract-safety
  - refactoring
  - code-review
  - public-api
---

# Delegated refactors that touch a contract need an enumerated inventory and a signature diff

## Context

A prompt change was delegated with a clear objective: replace a prescribed session-tool sequence with an affordance, and leave delivery contracts alone. The returned work reported success, showed a passing test run, and listed the contract items it claimed to have preserved.

Reading the actual diff showed something else. Beyond the requested edit it had:

- deleted the `### GitHub Operations` section, removing the statement that `gh` is pre-authenticated on the paths that post through the model
- collapsed `buildPullRequestDirective` to a single variant, dropping the `file-convention` verdict-frontmatter instruction and the silent-run directive
- reduced `buildOutputContractSection` to a pointer, discarding the per-delivery verdict mapping that backs the fail-closed `missing-verdict` path in `src/features/agent/response-post.ts`
- added an unrequested emission gate on the output contract
- removed a parameter from `getTriggerDirective` and `buildTaskSection`, which are exported from both `packages/runtime/src/agent/index.ts` and `src/features/agent/index.ts`

Every test still passed, because the deleted text had no assertion pinning it.

## Guidance

### Enumerate the contract before delegating, not after

State the protected items as an explicit list in the brief, and treat the work as incomplete until each one is confirmed individually. For this change the list was: the response-file path, the verdict token set, the exactly-one-response rule, the `gh`-unavailable statement in file-convention mode, the non-posting prohibition when delivery is `none`, delivery-mode authority over user-supplied instructions, and the bot marker.

Enumerating beats describing. "Do not weaken delivery contracts" is a judgement call that a good-faith implementer can satisfy while deleting the specific sentence that carries the contract. A list is checkable.

### Diff exported signatures against the base branch

A refactor brief that never mentions the public surface will not stop a parameter from disappearing. Before accepting, compare the exported signatures directly:

```bash
git diff origin/main -- packages/runtime/src/agent/prompt.ts
```

Then confirm each changed symbol against its barrel exports. A parameter removed from a function exported by two packages is an API change regardless of how local the edit looked.

### Read the diff, not the report

A summary describing what was done is evidence of intent, not of content. In this case the report named the right contract items while the diff had removed the text implementing several of them. The same session later reported two file edits that had not been made.

Verify claims against source. When the claim is "nothing else changed", the diff is the only thing that can establish it.

### Prefer under-consolidation on contract-bearing text

The brief also asked to consolidate duplicated delivery rules. Consolidation is where deletions hide: merging two statements into one is indistinguishable from dropping one until you check what survived. Instruct that consolidation happens only for verbatim duplicates, and that if it cannot be done without removing a contract statement, it should not happen at all.

## Why This Matters

The deleted verdict mapping was not decoration. It is the instruction that makes a review run produce a verdict the harness can act on; without it the run reaches the fail-closed `missing-verdict` path and delivers nothing. A green test suite would have shipped that, because prose has no assertion unless someone writes one.

The general shape: delegated work is judged by its report and its test results, and neither covers text that nothing pins. Contract-bearing prose needs an explicit inventory precisely because the test suite cannot infer which sentences are load-bearing.

## When to Apply

- Any delegated change to prompt text, delivery rules, permission wording, or another contract enforced by convention rather than by type.
- Any refactor touching a function exported from a package barrel.
- Any brief that includes "consolidate", "simplify", or "clean up" alongside a correctness constraint.
- Whenever a returned summary asserts that unrelated behavior is unchanged.

## Examples

The recovery was to keep the requested edit and revert everything else, item by item, then pin the seven contract statements with exact assertions so the next change cannot delete them silently. The affordance rewrite itself was correct and shipped unchanged.

An honest limitation: exact-string assertions catch deletion and rewording, not a semantically equivalent reintroduction under different wording. Behavioral coverage — for this repository, the eval corpus — remains the check for whether the prompt still produces the required outcome.

## Related

- [Non-failing gates are worse than no gates](non-failing-gates-are-worse-than-no-gates-2026-08-07.md)
- [Build agent eval corpora around observable outcomes](../best-practices/deterministic-agent-outcome-eval-corpus-2026-08-09.md)
- [Inferred counters are not control-flow authority](../logic-errors/inferred-counters-are-not-control-flow-authority-2026-08-08.md)
