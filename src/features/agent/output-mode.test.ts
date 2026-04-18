import type {EventType} from '../../services/github/types.js'
import {describe, expect, it} from 'vitest'
import {resolveOutputMode} from './output-mode.js'

const SCHEDULE_PROMPT = `Perform daily repository maintenance and update a SINGLE rolling issue titled
"Daily Maintenance Report" in this repository.

Search for an open issue with this exact title. If multiple matches exist,
use the most recently updated one. If no open issue exists, create it.
If the most recent matching issue is closed, reopen it instead of creating
a new one.

Append a new dated section for each run using "## YYYY-MM-DD (UTC)".
To keep the issue bounded: after appending today's section, replace any
individual daily sections older than 14 days with a single
"## Historical Summary" section that lists only the count of prior runs
and any items that remained unresolved across those runs. If a Historical Summary already exists, update it in place — do not create a second one.

Include links only (no full content duplication). Keep it concise and actionable.
Flag items that appear in the stale list for the first time (not present in the previous dated section) with a ★ marker.

Sections (in order):
- Summary metrics (issues opened since last run, currently open PRs, stale
  issues/PRs count, main branch check status, security alerts if accessible)
- Stale issues (no activity >30 days; recommend next step)
- Stale PRs (no activity >7 days; stale >14 days)
- Unassigned bugs (label bug, no assignee)
- Recommended actions (bulleted checklist)
- Notes (use "data unavailable" for any inaccessible data source)

Do NOT comment on or modify individual issues/PRs. Do NOT apply labels.
Do NOT open PRs. This run must update ONE issue only.`

const WIKI_PROMPT = `You are maintaining a project wiki as an Obsidian vault in \`docs/wiki/\`.
This wiki provides human-readable documentation for the fro-bot/agent project.

== BRANCH WORKFLOW ==
1. Check for an existing open wiki PR: \`gh pr list --head fro-bot/wiki-update --state open --json number --jq '.[0].number // empty'\`
2. If branch \`fro-bot/wiki-update\` exists but has NO open PR, delete it: \`git push origin --delete fro-bot/wiki-update || true\`
3. Create or checkout branch \`fro-bot/wiki-update\` from \`main\`
4. After all changes, commit with message: \`docs(wiki): update project wiki\`
5. Push branch and create or update PR targeting \`main\`
6. Enable auto-merge: \`gh pr merge <number> --auto --squash\`
   If auto-merge fails, leave the PR open and note the failure in the PR body.

== LINT PASS (run before writing) ==
Check existing \`docs/wiki/\` pages for:
- Broken wikilinks: verify each \`[[Page Name]]\` reference has a corresponding \`Page Name.md\` file
- Orphan pages: verify each page (except index.md) has at least one inbound \`[[wikilink]]\` from another page
- Stale pages: compare each page's \`sources\` frontmatter list against \`git log\` — if any listed source file changed since the page's \`last-updated\` date, mark it for update
Fix any issues found inline during the update pass.

== UPDATE STRATEGY ==
Run \`git log --oneline\` to find commits since the last wiki update commit (look for \`docs(wiki):\` prefix).
Identify which wiki pages' \`sources\` files were touched by those commits.
Update ONLY those pages. Do not regenerate unchanged pages.

If NO wiki pages exist yet (seed run), generate ALL canonical pages:
- Architecture Overview (type: architecture)
- Execution Lifecycle (type: architecture)
- Session Persistence (type: subsystem)
- Prompt Architecture (type: subsystem)
- Setup and Configuration (type: subsystem)
- Conventions and Patterns (type: convention)

== PAGE SCHEMA ==
Every wiki page MUST have this YAML frontmatter:
\`\`\`yaml
---
type: architecture | subsystem | convention
last-updated: "YYYY-MM-DD"
updated-by: "<commit SHA or session ID>"
sources:
  - src/path/to/relevant/file.ts
  - RFCs/RFC-NNN-Name.md
summary: "One-line description of what this page covers"
---
\`\`\`

== CONTENT GUIDANCE ==
- Write for human developers, not agents. Clear prose, not bullet dumps.
- DESCRIPTIVE (how the system works, why decisions were made), NOT prescriptive (what to do).
- Use Obsidian wikilinks \`[[Page Name]]\` to cross-reference other wiki pages.
- Cite source files by path. Reference RFCs by number.
- Do NOT copy source code verbatim. Describe architecture and data flow.
- Do NOT duplicate AGENTS.md prescriptive content.

== INDEX UPDATE ==
After page changes, update \`docs/wiki/index.md\`:
- List each page with standard markdown links for GitHub: \`[Page Name](Page%20Name.md)\`
- Include the page's \`type\` and \`summary\` from frontmatter
- Organize by topic area

== CONSTRAINTS ==
- Do NOT modify AGENTS.md or any source code files.
- Do NOT create issues or post comments.
- This run must ONLY update files in \`docs/wiki/\` and create ONE PR.`

const ISSUE_511_PROMPT =
  'update or create `knowledge/wiki/repos/<slug>.md`, update `knowledge/index.md`, append an entry to `knowledge/log.md`'

describe('resolveOutputMode', () => {
  it('all 5 non-manual triggers resolve to null', () => {
    // #given
    const eventTypes: readonly EventType[] = [
      'discussion_comment',
      'issue_comment',
      'issues',
      'pull_request',
      'pull_request_review_comment',
    ]

    // #when
    const results = eventTypes.map(eventType => resolveOutputMode(eventType, 'create a pr', 'auto'))

    // #then
    expect(results).toEqual([null, null, null, null, null])
  })

  it('returns null for unsupported event type', () => {
    // #given
    const eventType: EventType = 'unsupported'

    // #when
    const result = resolveOutputMode(eventType, 'create a pr', 'auto')

    // #then
    expect(result).toBeNull()
  })

  it('each configured mode (working-dir, branch-pr) resolves explicitly regardless of prompt', () => {
    // #given
    const prompt = 'create a pr and push to origin'

    // #when
    const workingDirResult = resolveOutputMode('workflow_dispatch', prompt, 'working-dir')
    const branchPrResult = resolveOutputMode('schedule', null, 'branch-pr')

    // #then
    expect(workingDirResult).toBe('working-dir')
    expect(branchPrResult).toBe('branch-pr')
  })

  it('auto heuristic against each phrase in BRANCH_PR_PHRASES', () => {
    // #given
    const phrases = [
      'pull request',
      'open a pr',
      'create a pr',
      'create pr',
      'gh pr ',
      'push to origin',
      'git push',
      'auto-merge',
      'create branch',
      'update branch',
      'branch workflow',
    ] as const

    // #when
    const results = phrases.map(phrase =>
      resolveOutputMode('workflow_dispatch', `please ${phrase} after editing`, 'auto'),
    )

    // #then
    expect(results).toEqual(Array.from({length: phrases.length}, () => 'branch-pr'))
  })

  it('resolves auto to branch-pr for WIKI_PROMPT verbatim', () => {
    // #given
    const prompt = WIKI_PROMPT

    // #when
    const result = resolveOutputMode('workflow_dispatch', prompt, 'auto')

    // #then
    expect(result).toBe('branch-pr')
  })

  it('resolves auto to working-dir for SCHEDULE_PROMPT verbatim', () => {
    // #given
    const prompt = SCHEDULE_PROMPT

    // #when
    const result = resolveOutputMode('schedule', prompt, 'auto')

    // #then
    expect(result).toBe('working-dir')
  })

  it('resolves auto to working-dir for plain file-edit prompt', () => {
    // #given
    const prompt = ISSUE_511_PROMPT

    // #when
    const result = resolveOutputMode('workflow_dispatch', prompt, 'auto')

    // #then
    expect(result).toBe('working-dir')
  })

  it('empty/null prompt → working-dir', () => {
    // #given
    const emptyPrompt = '   '

    // #when
    const emptyResult = resolveOutputMode('workflow_dispatch', emptyPrompt, 'auto')
    const nullResult = resolveOutputMode('schedule', null, 'auto')

    // #then
    expect(emptyResult).toBe('working-dir')
    expect(nullResult).toBe('working-dir')
  })

  it('case-insensitive: PULL REQUEST → branch-pr', () => {
    // #given
    const prompt = 'PULL REQUEST'

    // #when
    const result = resolveOutputMode('workflow_dispatch', prompt, 'auto')

    // #then
    expect(result).toBe('branch-pr')
  })

  it('documented false positive: "pull the request body into the summary" → branch-pr', () => {
    // #given
    const prompt = 'pull the request body into the summary'

    // #when
    const result = resolveOutputMode('workflow_dispatch', prompt, 'auto')

    // #then
    expect(result).toBe('branch-pr')
  })

  it('resolves auto to branch-pr for prompt containing "pull request"', () => {
    // #given
    const prompt = 'Please open a pull request once the changes are ready.'

    // #when
    const result = resolveOutputMode('workflow_dispatch', prompt, 'auto')

    // #then
    expect(result).toBe('branch-pr')
  })

  it('documents the compile-time exhaustive switch guard', () => {
    // #given / #when / #then
    // Adding a new EventType in src/services/github/types.ts must break compilation in
    // src/features/agent/output-mode.ts at the const _exhaustive: never = eventType guard.
    expect(true).toBe(true)
  })
})
