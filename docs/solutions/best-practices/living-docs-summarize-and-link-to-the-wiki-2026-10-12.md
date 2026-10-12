---
title: Living docs summarize and link to the wiki; detail does not belong in them
date: 2026-10-12
category: best-practices
module: documentation
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - Adding or changing a section of a living doc (ARCHITECTURE.md, STRUCTURE.md, README.md, CONTRIBUTING.md, SECURITY.md) in a feature or fix PR
  - A living doc is loaded into agent context on every turn
  - A living doc is near or past its size budget
symptoms:
  - ARCHITECTURE.md grew from 34 KB to 136 KB in under four weeks
  - Living docs loaded into agent context every turn reached about 153 KB with STRUCTURE.md and filled the context window
root_cause: missing_workflow_step
resolution_type: documentation_update
tags:
  - living-docs
  - architecture-md
  - documentation-budget
  - summary-and-link
  - wiki
  - agent-context
  - generating-project-docs
---

# Living docs summarize and link to the wiki; detail does not belong in them

## Context

`ARCHITECTURE.md` grew from 34 KB on 2026-09-15 to 136 KB on 2026-10-11. About 104 KB of that was under `## Cross-Cutting Concerns`, where feature and fix PRs had appended symbol-level design rationale, incident history and per-path matrices. The biggest jumps came from #1675 (+21.0 KB), #1624 (+16.4 KB) and #1749 (+12.3 KB). Nothing capped the file's size. The living-docs skill was triggered when a doc was created, refreshed or had a single section updated, but not when a feature or fix PR added a new section, so the summary treatment never ran on those sections.

Living docs exist to orient contributors and agents. When they are loaded into an agent's context on every turn, their size is paid on every turn. At the peak, `ARCHITECTURE.md` and `STRUCTURE.md` together came to about 153 KB and filled the context window.

#1793 cut `ARCHITECTURE.md` to 37.7 KB and moved the detail into anchored sections of existing wiki pages.

## Guidance

Write each mechanism in a living doc as a short summary that links down to the wiki.

1. **Keep each `###` summary to 3–10 lines, about 1 KB.**
   - One paragraph says what the mechanism is and where it lives (files, symbols).
   - Bullets list the invariants a contributor must not break.
   - A `> See also:` line links to the wiki section.
   - Keep the heading text stable, because code and docs link to its anchor.
2. **Put detail in the wiki, not in the living doc.** Rationale, incident history, per-path matrices and symbol-level walkthroughs belong in an anchored section on the best-fitting `docs/wiki/` page.
3. **Summaries keep invariants and exceptions, not only mechanisms.** Review of #1793 found two facts dropped by the first trim:
   - Where job-qualified identity sits on session keys versus cache keys.
   - The Action's exception for reclaiming its own expired lock.

   Check each summary against its wiki source before merging.

4. **Check the size budget at edit time.** `.agents/skills/generating-project-docs/SKILL.md` caps `ARCHITECTURE.md` at about 40 KB. If an edit would push the file past that, move detail to the wiki instead.
5. **Apply the rule to section edits, not only to regeneration.** The skill now triggers before any living-doc edit, including sections added in feature and fix PRs.

## Why This Matters

Living docs grow without anyone noticing. Each PR looks fine on its own, and the cost only shows up when someone opens the file. When the doc is loaded into agent context, that cost is paid again on every turn. A size budget and a trigger that fires on every edit catch regrowth early. A summary plus a link gives contributors the orientation they need and keeps the history one click away.

## When to Apply

- A feature or fix PR adds or changes a section of `ARCHITECTURE.md`, `STRUCTURE.md`, `README.md`, `CONTRIBUTING.md` or `SECURITY.md`.
- A living doc is near or past its size budget.
- A change needs its rationale or incident history recorded. Write that in the wiki, not the living doc.
- You are reviewing a summary. Check that it keeps every invariant and exception the wiki page states.

## Examples

`ARCHITECTURE.md` size through the regrowth and the trim (decimal KB, from `git show <commit>:ARCHITECTURE.md | wc -c`):

| Commit                   | Change                  | Size     |
| ------------------------ | ----------------------- | -------- |
| `04e5bbec9` (2026-09-15) | dependency bump (#1610) | 34.0 KB  |
| `b724d9554`              | #1624                   | 50.4 KB  |
| `293476153`              | #1675                   | 75.5 KB  |
| `ff8c37b66`              | #1749                   | 107.0 KB |
| `740916210`              | #1788                   | 136.4 KB |
| `18890129d`              | #1793 (trim)            | 37.7 KB  |

The shape of a trimmed cross-cutting subsection:

```markdown
### S3 Conditional-Write Locks (Gateway `repo.json`, Action `action.json`)

<What the mechanism is, and where it lives: files and symbols.>

- <Invariant a contributor must not break.>
- <Another invariant, including any exception to it.>

> See also: [Execution Lifecycle](docs/wiki/Execution%20Lifecycle.md#s3-conditional-write-locks-gateway-repojson-action-actionjson)
```

The live version is `### S3 Conditional-Write Locks` in `ARCHITECTURE.md`. It keeps the Action's reclaim exception. Without that sentence, the summary would imply that every expired lease needs corroboration, which is wrong for an expired Action lease.

## Related

- [`ARCHITECTURE.md`](../../../ARCHITECTURE.md), in particular `## Cross-Cutting Concerns`
- [Architecture Overview, Codemap Reference](../../wiki/Architecture%20Overview.md#codemap-reference): where the full codemap rows moved
- [`generating-project-docs` skill](../../../.agents/skills/generating-project-docs/SKILL.md): Core Rule 6, the ~40 KB budget and the subsection format
- PRs #1624, #1675 and #1749 (largest growth), #1788 (peak), #1793 (the trim)
