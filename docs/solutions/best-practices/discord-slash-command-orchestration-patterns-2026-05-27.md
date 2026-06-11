---
title: Discord slash command orchestration — permission checks, bootstrap wiring, and token safety
date: 2026-05-27
last_updated: 2026-06-10
category: best-practices
module: gateway
problem_type: best_practice
component: assistant
severity: medium
applies_when:
  - A discord.js guild interaction checks bot permissions without the GuildMembers privileged intent
  - A command uses dependency injection via a factory but real dispatch/bootstrap wiring is not integration-tested
  - A short-lived credential (installation access token) crosses a process or HTTP boundary
  - A multi-phase command can partially fail and needs documented recovery
  - A find-or-create loop runs against a cache that concurrent operations mutate
tags:
  - discordjs
  - app-permissions
  - dependency-injection
  - bootstrap-wiring
  - integration-tests
  - installation-access-token
  - multi-phase-orchestration
  - cache-race
  - gateway
---

# Discord slash command orchestration — permission checks, bootstrap wiring, and token safety

## Context

Building the first user-facing gateway feature — the `/fro-bot add-project` Discord slash command — surfaced several non-obvious traps. The command orchestrates four subsystems: GitHub App authentication, a workspace clone over HTTP, Discord channel creation, and an S3 binding write. Each integration boundary hid a failure mode that the initial implementation and its unit tests missed, and that only surfaced under architecture review (Oracle) and automated review (Fro Bot).

These are reusable patterns for any agent-driven Discord command, any factory-injected feature, and any service-to-service flow carrying a credential.

## Guidance

### 1. Discord permission checks: use `interaction.appPermissions`, not `guild.members.cache.get()`

This is the highest-value learning. A permission check that resolves the bot's own `GuildMember` from the cache returns `undefined` whenever the bot runs **without** the privileged `GuildMembers` intent — which is the default, security-conscious posture. The result is a false-negative: the check fails even when the bot genuinely holds the permission, and the command aborts on a correctly-configured bot.

**Broken pattern:**

```ts
function botHasRequiredPermissions(guild: Guild, botUserId: string): boolean {
  const member = guild.members.cache.get(botUserId) // undefined without GuildMembers intent
  if (member === undefined) return false            // false-negative abort
  return member.permissions.has(PermissionFlagsBits.ManageChannels)
}
```

**Correct pattern** — `interaction.appPermissions` is a `PermissionsBitField | null` that Discord populates reliably for every guild interaction, independent of gateway intents:

```ts
function botHasRequiredPermissions(appPermissions: PermissionsBitField | null): boolean {
  if (appPermissions === null) return false // DM interaction — command is guild-only
  return (
    appPermissions.has(PermissionFlagsBits.ManageChannels) &&
    appPermissions.has(PermissionFlagsBits.SendMessages)
  )
}

// Call site — all Discord content sends go through discord/io.ts helpers
// (mention-safe by default; enforced by io.boundary.test.ts):
if (botHasRequiredPermissions(interaction.appPermissions) === false) {
  await editInteractionAsync(interaction, {
    content: `fro-bot needs **Manage Channels** and **Send Messages**. Re-invite at: ${installUrl}`,
  }, log)
  return
}
```

### 2. Test the real dispatch path, not just the handler

The command was refactored to receive its dependencies through a factory (`createFroBotCommand(deps)`), but the bootstrap in `program.ts` never constructed and passed those deps. Every test still passed — because the tests called the orchestration function (`executeAddProject`) **directly**, bypassing the Discord dispatch path entirely. The wiring gap would have shipped broken-in-production code with a green suite. An architecture reviewer caught it, not the tests.

The fix is an integration-level test that builds the **real** registry and dispatches a **real** interaction:

```ts
// Test the dispatch seam, not just executeAddProject:
const registry = getCommandRegistry(makeMockDeps())
await Effect.runPromise(dispatchCommand(mockInteraction, registry))
expect(mockDeps.workspaceClient.clone).toHaveBeenCalled()
```

`getCommandRegistry` and `dispatchCommand` live in `packages/gateway/src/discord/commands/index.ts`; the parent-command factory is in `commands/fro-bot.ts` and bootstrap wiring is in `program.ts`.

### 2a. The orchestration skeleton is now owned by `makeGuildCommand`

The per-command hand-rolled sequence (`deferReply → guild-null guard → auth → editReply`) is now owned by the shared `makeGuildCommand` pipeline (`packages/gateway/src/discord/commands/guild-command.ts`). New guild commands supply a `GuildCommandSpec` with `{authorize, work, preDefer?}` instead of hand-rolling the skeleton:

```ts
// packages/gateway/src/discord/commands/add-project.ts
export function buildAddProjectSpec(deps: AddProjectDeps): {
  readonly preDefer: (ctx: PreDeferCtx) => Effect.Effect<PreDeferSignal, never>
  readonly authorize: (ctx: GuildCommandCtx) => Effect.Effect<AuthDecision, never>
  readonly work: (ctx: GuildCommandCtx) => Effect.Effect<void, Error>
} { /* ... */ }

// Wired in executeAddProject:
const executor = makeGuildCommand(
  {name: 'add-project', preDefer, authorize, work, serverOnlyCopy: '...'},
  deps,
)
```

The underlying WHY is unchanged: `deferReply` must fire before any REST calls to beat the 3-second interaction-token window. That sequencing is now guaranteed by the pipeline rather than each command author. A structural test in `guild-command.test.ts` scans every `commands/*.ts` file (excluding `guild-command.ts`) and fails the suite if any hand-rolled `.deferReply(` call is found.

### 3. Installation access token (IAT) handling across an HTTP boundary

The IAT (`ghs_*`, ~1hr lifetime) flows from GitHub App auth into an HTTP request body to the workspace service. Three rules emerged:

- **Never log request or response body**, even on retry or error. The body carries the token. Mark it as a module invariant.
- **Captured-logger test** asserting no `ghs_` string appears in any log line, iterating **all** error paths (timeout, network, http, parse, response-mismatch, clone-error, malformed-success) — not just the happy path.
- **Response-path integrity check** — the response must correspond to the requested `owner/repo`, defending against a misbehaving or compromised service.
- **`AbortSignal.timeout`** on the fetch (native fetch has no default timeout).

```ts
// SECURITY INVARIANT: never log request/response body — it carries the IAT.
const response = await fetch(`${baseUrl}/clone`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body, // contains token
  signal: AbortSignal.timeout(timeoutMs),
})

// Compare the full path, not just the suffix. owner/repo are already
// lowercased upstream, so the expected path is canonical; do not lowercase
// the response path or a case-variant root could slip through.
const expectedPath = `${EXPECTED_WORKSPACE_ROOT}/${owner}/${repo}`
if (parsed.path !== expectedPath) {
  return err({kind: 'response-mismatch'})
}
```

A suffix-only check is the weaker form to avoid — `parsed.path.endsWith('/owner/repo')` accepts adversarial prefixes like `/etc/passwd/owner/repo`, letting a misbehaving agent bind a repo to an arbitrary filesystem location. Validate against the full expected path rooted at the known workspace root.

```ts
// Captured-logger security test — iterate ALL error paths:
for (const line of spy.lines) {
  expect(line).not.toContain('ghs_')
}
```

### 4. Multi-phase orchestration with idempotent self-healing recovery

The flow is a five-phase state machine: `PRE_FLIGHT → CLONING → CREATING_CHANNEL → WRITING_BINDING → READY`. The primary recovery path for the clone-exists/no-binding partial-failure shape is **re-running the command** — `/add-project` is idempotent for this case:

- **Atomic clone guarantee**: the workspace-agent renames the temp dir to the final dest atomically. `repo-exists` from a clone call means the clone is fully complete — not partial.
- **Resume keyed on confirmed absent binding**: when `repo-exists` is returned, the handler re-reads the bindings store. It only resumes (falls through to `CREATING_CHANNEL`) when the store confirms `data === null`. A store error (thrown or `success === false`) returns an internal-error reply and does **not** resume — resuming on an unreadable store would risk orphan channels if the binding write also fails.
- **A defensive permission re-check at the side-effect boundary** (`CREATING_CHANNEL`) — permissions can change between `PRE_FLIGHT` and the first mutation.
- **Preserve expensive prior work** — a failure after `CLONING` keeps the clone on disk; retrying the command will detect `repo-exists`, confirm no binding, and resume from `CREATING_CHANNEL`.

Accepted v1 fallout and boundaries:

- **Orphan channel on concurrent resume**: if two invocations both resume simultaneously, both create a channel, then both race to write the binding. The loser's `createBinding` is rejected with `BINDING_EXISTS_ERROR` (atomic IfNoneMatch write). The loser gets a "bound by a concurrent request / manual cleanup may be needed" reply. The orphan channel is a bounded, operator-visible artifact — not a silent data integrity issue.
- **Shutdown gating**: new invocations are refused during drain (after `deferReply` so Discord gets its mandatory ack). In-flight runs that are hard-cut during a process restart are healed by the next retry via the resume path.

```ts
// Resume only on CONFIRMED absent binding — store errors do NOT resume.
// All Discord content sends go through discord/io.ts helpers (editInteractionAsync
// / editInteraction) — mention-safe by default; enforced by io.boundary.test.ts.
let existing: Awaited<ReturnType<typeof bindingsStore.getBindingByRepo>>
try {
  existing = await bindingsStore.getBindingByRepo(owner, repo)
} catch {
  await editInteractionAsync(interaction, {content: 'Internal error checking existing bindings. Please retry in a moment.'}, log)
  return
}
if (existing.success === false) {
  await editInteractionAsync(interaction, {content: 'Internal error checking existing bindings. Please retry in a moment.'}, log)
  return
}
if (existing.data !== null) {
  // Already bound — redirect.
  await editInteractionAsync(interaction, {content: `\`${owner}/${repo}\` is already set up in <#${existing.data.channelId}>.`}, log)
  return
}
// Confirmed absent binding — resume from CREATING_CHANNEL.
workspacePath = workspaceRepoPath(owner, repo)
// fall through — do NOT return

// Partial-write recovery names both keys for manual cleanup:
if (error.code === 'BINDING_PARTIAL_WRITE_ERROR') {
  await editInteractionAsync(interaction, {
    content: `Partial write: primary written, index failed. Manual S3 cleanup:\n- Primary: \`${error.primaryKey}\`\n- Index: \`${error.indexKey}\``,
  }, log)
}
```

### 5. Re-read live caches inside find-or-create collision loops

Snapshotting `guild.channels.cache` once and iterating suffix candidates (`name`, `name-2`, …) against the frozen snapshot is a race. discord.js runs in a single Node process, so this is not OS-level concurrency — it's inter-await interleaving: between two `await` calls in the same event loop, the cache can be mutated by an incoming `channelCreate` gateway event or by another in-flight interaction. Two in-flight interactions interleaved across awaits can see the same snapshot, both attempt to create the same name, and the loser's Discord 50035 (duplicate name) rejection gets silently swallowed as a "transient error" — the binding ends up pointing to the wrong suffixed channel with no operator-visible warning.

```ts
for (const candidate of candidates) {
  // Re-read the LIVE cache each iteration — a concurrent setup may have
  // created this candidate since the loop began.
  const existing = guild.channels.cache.find(
    c => c.name.toLowerCase() === candidate.toLowerCase() && c.type === ChannelType.GuildText,
  )
  if (existing !== undefined) continue
  const result = await tryCreate(guild, candidate)
  // ...
}
```

Pair this with a `tryCreate` that distinguishes **name-taken** (advance to next suffix) from **permission-denied** (short-circuit) from **create-failed / rate-limited** (surface a distinct error instead of burning through all suffixes).

## Why This Matters

| Trap | Cost if unknown |
| --- | --- |
| Wrong permission source | False-negative abort makes the command unusable on a correctly-configured bot |
| Handler-only tests | Green CI ships broken-in-production bootstrap wiring |
| IAT leakage | Security incident — a short-lived credential on disk/in logs |
| No partial-failure recovery | Operators stranded mid-flow with orphaned channels and clones |
| Cache-snapshot race | Silently binds to the wrong channel under concurrent use |

## When to Apply

- Any discord.js slash command that checks bot permissions
- Any feature whose dependencies are injected via a factory and wired at bootstrap
- Any service-to-service flow carrying a short-lived credential
- Any multi-step orchestration with persistent side effects
- Any find-or-create loop against a cache that concurrent operations mutate

## Related

- `docs/solutions/code-quality/architectural-issues-type-safety-and-resource-cleanup.md` — adjacent: deterministic recovery and `finally`-style cleanup orchestration (different subsystem, same discipline of making partial-failure paths explicit)
- GitHub issue #646 — Gateway intent-posture flip (privileged intents opt-in), the posture that makes the `appPermissions` trap (learning #1) reachable
