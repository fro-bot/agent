---
title: An eval never provisioned session retrieval, and filesystem assertions hid it through two invalid runs
date: 2026-08-16
category: integration-issues
module: evals
problem_type: integration_issue
component: testing_framework
severity: high
symptoms:
  - "A treatment mode fails every sample with 'Required signal groups missing: prior-decision'"
  - "sessionPresearch reports priorWorkResultCount 0 and injectedContextBytes 0 in the failing mode"
  - "The comparison reads as a decisive finding rather than as a broken fixture"
  - "A session seeded as JSON files under XDG_DATA_HOME is invisible to session_search"
  - "A transient server startup failure is counted against the bounded quality budget"
root_cause: incomplete_setup
resolution_type: code_fix
related_components:
  - evals/runner.ts
  - evals/presearch-differential.ts
  - packages/runtime/src/agent/session-tools.ts
  - src/services/setup/session-tools-config.ts
tags:
  - eval-validity
  - session-retrieval
  - continuation
  - sdk-seeding
  - test-assertions
---

# An eval never provisioned session retrieval, and filesystem assertions hid it through two invalid runs

## Problem

A bounded differential experiment compared two modes of the agent's session handling: production, which eagerly injects recent-session and prior-work context into the prompt, and a treatment that disables that injection while leaving the native `session_*` tools available for on-demand retrieval. The treatment failed every sample, which read as evidence that eager injection is load-bearing. It was not. The isolated eval never made prior work retrievable by any means other than the prompt injection being removed, so the treatment was measured against data that did not exist.

## Symptoms

- The treatment mode failed 4/4 samples on the discriminating scenario, always on the same gate: `Required signal groups missing: prior-decision`.
- The advisory accounting for the failing mode showed `priorWorkResultCount: 0` and `injectedContextBytes: 0`, while the passing mode showed `1` and `289` bytes.
- Failures were perfectly consistent rather than stochastic, which is the signature of a structural fault rather than a model-quality difference.
- After a first repair attempt, a prior session seeded as JSON files under `$XDG_DATA_HOME/opencode/storage/` was still not returned by `session_search`.
- A transient `Server exited with code 1 ... ServeError` was recorded as a quality sample, leaving the comparison ambiguous while sample budget went unused.

## What Didn't Work

### Treating prompt-injected text as if it were retrievable prior work

The scenario's required signal existed only inside the fixture's `priorWork` structure, which was rendered into the prompt. Nothing wrote that prior work anywhere a tool could read it. Removing the injection therefore removed the only copy in existence.

Three gaps combined to produce this, all in the isolated eval setup:

- The native `session_*` tools were never provisioned. Production installs them by writing a tool file into the OpenCode config directory via `writeSessionToolsFile` (`src/services/setup/session-tools-config.ts`), but the eval's config builder wrote only model, optional auth plugin, and permissions.
- Scenario prior work was never persisted as a session. Fixture creation copied `scenario.files` and nothing else.
- `continueSessionId` never reached the execution config, so every scenario silently started a fresh session even while reporting a continuation identifier as accounting.

The result is a one-variable experiment that varied two things: the prompt injection, and whether the data was reachable at all.

### Seeding a session as JSON files on disk

The first repair wrote a file layout (`.version`, `project/`, `session/`, `message/`, `part/`) under `$XDG_DATA_HOME/opencode/storage/`. This looked plausible and its tests passed, but the data was never visible to the consumer.

Checked against the pinned OpenCode source for the shipped harness base:

- Sessions, messages, parts, and projects are SQLite rows, not files. The database lives at `Global.Path.data/opencode.db`, with table shapes defined in `packages/core/src/session/sql.ts`.
- The `storage/` directory does still exist, but it is a generic key-value area. Its only migration operates on that key-value layout and does not import session data into the database.
- Every seeded object shape was wrong independently: the tables expect DB columns with payloads nested under a `data` field, not the flat JSON objects written.

Most decisively, `session_search` never touches the filesystem or the database directly. It goes through the SDK client — `packages/runtime/src/agent/session-tools.ts` calls `searchSessions` (`packages/runtime/src/session/search.ts`), which calls `client.session.list()` and `client.session.messages()`.

Writing SQLite rows directly was considered and rejected. It would couple the eval corpus to a private, migration-versioned schema with no compatibility contract, so any harness base bump could silently return the experiment to a tautology.

## Solution

Seed the prior session through the same public interface the consumer reads from, and provision the real tool surface.

Provision the native tools with the production writer rather than a copy of its logic:

```ts
const sessionToolsAsset = path.resolve(import.meta.dirname, '..', 'dist', 'session-tools.js')
await writeSessionToolsFile(configDir, logger, () => pathToFileURL(sessionToolsAsset))
```

Create the prior session through the SDK, scoped to the fixture repository, and persist the message without invoking inference:

```ts
const sessionResponse = await client.session.create({
  query: {directory: repoPath},
  body: {title: buildSessionTitle(logicalKey)},
})

const promptResponse = await client.session.prompt({
  path: {id: seededSessionID},
  query: {directory: repoPath},
  body: {
    noReply: true,
    parts: [{type: 'text', text: match.excerpt}],
  },
})
```

`noReply: true` is what keeps seeding deterministic and free: the message is persisted without generating an assistant turn.

Wire the server-generated session ID into execution so continuation actually applies, rather than passing the fixture's synthetic identifier:

```ts
continuationSessionId = await resolvedSessionSeeder(fixtureRepo.path, scenario, logicalKey, logger)
if (continuationSessionId == null) {
  throw new Error(`Scenario ${scenario.id} declared continuation but seeding returned no session ID`)
}

const executionConfig: ExecutionConfig = {
  agent: 'build',
  model: modelConfig,
  timeoutMs,
  omoProviders: NO_OMO_PROVIDERS,
  ...(continuationSessionId == null ? {} : {continueSessionId: continuationSessionId}),
}
```

The seeding server runs on the isolated data home and is closed in a `finally`; the execution server that follows reads the same store.

With the seam corrected, both modes passed both scenarios with no stable differences. The original result was entirely an artifact of unreachable data.

## Why This Works

`session_search` resolves sessions through the SDK, so only sessions that entered the store through that surface are visible. Files placed under `storage/` never become rows, are never indexed, and never appear in `session.list()` or `session.messages()`.

Directory scope is equally load-bearing. `searchSessions` scopes to `process.cwd()`, and the SDK client sends that as the workspace scope on each request. A session that is correctly created but attached to a different directory is still invisible. Seeding therefore has to pass `query: {directory: repoPath}` for the same fixture repository the runner switches into.

Fail-loud behavior matters as much as the mechanism. Seeding now throws when a scenario declares continuation but yields no session, when a logical key is missing, and when the API returns an error. The original defect survived precisely because every one of those conditions was a silent no-op.

## Prevention

**Assert through the interface the production consumer uses, not the artifact just written.** This is the rule that would have caught the bug on day one. Filesystem assertions confirmed that a tool file existed and that a session path was present on disk. Both were true. Neither established that anything could read them, and they passed through two invalid runs.

```ts
// Insufficient: proves a write happened, not that the consumer can see it
expect(fs.existsSync(seededSessionPath)).toBe(true)

// Meaningful: exercises the same path session_search uses
const listed = await client.session.list({query: {directory: repoPath}})
expect(listed.data?.some(session => session.id === seededSessionID)).toBe(true)
```

**Seed and verify in the same scope the capability is consumed in.** When retrieval is scoped by workspace, project, or tenant, a correctly created record in the wrong scope is indistinguishable from a missing one.

**Suspect perfectly consistent failures.** A stochastic quality difference produces mixed samples. A 4/4 identical failure with a single mechanistic explanation usually means the scenario cannot succeed, not that the candidate is worse.

**Keep infrastructure loss out of quality accounting.** The comparison layer already distinguished the two — stochastic quality failures surface as bounded repeat requests, infrastructure loss as rerun requests — but the driver consumed only the former. A transient startup failure was appended as a quality sample, poisoning that mode's stable outcome and ending the comparison ambiguous while budget remained. Infrastructure failures should retry under their own cap, never consume quality budget, and be recorded in the report so the run stays auditable.

**An experiment that cannot fail informatively is worse than no experiment.** The first run did not merely produce no answer; it produced a confident wrong one that could have justified keeping a subsystem for the wrong reason.

## Related Issues

- [#1188](https://github.com/fro-bot/agent/issues/1188) — the mirror image at runtime: the prompt required `session_search`/`session_read` that the agent runtime did not provide. Same class of defect, opposite side of the boundary.
- [A check reports clean for the part of the world it cannot observe](../workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — the same false-confidence shape, where a green result is trusted without knowing what the check could actually see.
- [Non-failing gates are worse than no gates](../workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — a gate that structurally cannot fail, here extended to a harness that never exposed the capability under test.
- [Deterministic agent-outcome eval corpus](../best-practices/deterministic-agent-outcome-eval-corpus-2026-08-09.md) — deterministic provenance is necessary but not sufficient; the harness must also provision the same capability surface as production.
- [A read-only Actions cache token broke session continuity](read-only-actions-cache-token-broke-session-continuity-2026-08-11.md) — adjacent continuity failure through the cache path rather than the eval harness.
- [Archive v1 read, v2 write asymmetry](../logic-errors/archive-v1-read-v2-write-asymmetry-2026-08-03.md) — another case where the write path and the read path disagreed about where session state lives.
