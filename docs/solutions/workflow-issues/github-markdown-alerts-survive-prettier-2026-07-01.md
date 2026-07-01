---
title: GitHub Markdown alerts need a blank quote separator to survive prettier
date: 2026-07-01
category: docs/solutions/workflow-issues
module: documentation
problem_type: workflow_issue
component: documentation
severity: low
applies_when:
  - Writing GitHub-flavored Markdown alerts ([!TIP], [!NOTE], [!WARNING], [!IMPORTANT], [!CAUTION]) in any committed .md file
  - The repo runs prettier as a pre-commit formatter via lint-staged
related_components:
  - tooling
  - development_workflow
tags:
  - markdown
  - prettier
  - github-alerts
  - pre-commit-hook
  - lint-staged
  - callouts
  - formatting
  - gfm
---

# GitHub Markdown alerts need a blank quote separator to survive prettier

## Context

GitHub-flavored Markdown renders styled callouts ("alerts") when a blockquote's first line is a lone marker — `> [!TIP]`, `> [!NOTE]`, `> [!WARNING]`, `> [!IMPORTANT]`, or `> [!CAUTION]`. The intuitive way to write one is the marker followed immediately by a quoted body line:

```markdown
> [!TIP]
> Body text here.
```

In this repo that form does not survive a commit. The pre-commit hook chain — `simple-git-hooks` → `pre-commit` → `bunx lint-staged` → `bunx eslint --fix --no-warn-ignored` with the prettier config `@bfra.me/prettier-config/120-proof` — reflows the marker and the body onto a single line (`> [!TIP] Body text here.`). GitHub renders that as a plain blockquote, silently dropping the styled callout. The Markdown still lints clean and the links still work, so the regression is invisible until you look at the rendered page.

## Guidance

Insert a blank quoted line (`>`) between the alert marker and its body:

```markdown
> [!TIP]
>
> Body text here.
```

The blank-`>` separator survives the formatter — prettier keeps the marker on its own line — and GitHub renders the styled callout correctly. This applies to every alert type.

If the callout should also contain a directly-copyable block (e.g. a prompt or command), keep that block out of the alert as its own top-level blockquote rather than nesting it (`> >`), which both reads awkwardly and is fragile under reflow.

## Why This Matters

The failure is silent on every automated signal: `bun run lint` passes, relative links resolve, and the diff looks correct in the editor. Only the rendered GitHub page reveals the degraded callout. Without the blank-`>` form, a docs change can land on `main` with every alert quietly downgraded to a plain quote — exactly the kind of drift the living-docs workflow is meant to prevent.

## When to Apply

- Authoring or editing any `> [!...]` alert in a committed Markdown file.
- Reviewing a docs PR: if an alert marker has body text on the same line in the diff, the callout is already broken.
- Verifying before commit: run `bunx lint-staged` (or `bun run fix`) on the file and re-read it — the marker must remain on its own line.

## Examples

Broken (formatter reflows marker + body onto one line → plain blockquote):

```markdown
> [!TIP]
> The snippet above wires a single trigger. Copy the full example instead.
```

Correct (blank `>` separator survives prettier → styled callout):

```markdown
> [!TIP]
>
> The snippet above wires a single trigger. Copy the full example instead.
```

A copyable block belongs outside the alert, as its own quote:

```markdown
> [!TIP]
>
> Point an agent at the example file with the prompt below.

> Fetch <url> and follow the instructions at the top of the file.
```

## Related

- `AGENTS.md` — names the prettier config responsible for the reflow (`@bfra.me/prettier-config/120-proof`, 120-char width).
- `CONTRIBUTING.md` — documents the pre-commit hook chain (`simple-git-hooks` → `lint-staged` → `bunx eslint --fix`).
- `docs/solutions/workflow-issues/durable-dist-hidden-unicode-fix-2026-06-22.md` — nearest-neighbor pattern: same hook chain, same "engineer around what the formatter does to committed content" shape, different subject.
- Verified on `README.md` in PR #1077.
