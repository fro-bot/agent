---
title: Discord slash command orchestration — permission checks, bootstrap wiring, and token safety
date: 2026-05-27
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

// Call site:
if (botHasRequiredPermissions(interaction.appPermissions) === false) {
  await interaction.editReply({
    content: `fro-bot needs **Manage Channels** and **Send Messages**. Re-invite at: ${installUrl}`,
  })
  return
}
```

### 2. Test the real dispatch path, not just the handler

The command was refactored to receive its dependencies through a factory (`createFroBotCommand(deps)`), but the bootstrap in `program.ts` never constructed and passed those deps. Every test still passed — because the tests called the orchestration function (`executeAddProject`) **directly**, bypassing the Discord dispatch path entirely. The wiring gap would have shipped broken-in-production code with a green suite. An architecture reviewer caught it, not the tests.

The fix is an integration-level test that builds the **real** registry and dispatches a **real** interaction:

```ts
export function createFroBotCommand(deps: AddProjectDeps): SlashCommand {
  const execute = (interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> => {
    const subcommand = interaction.options.getSubcommand(true)
    if (subcommand === 'add-project') return executeAddProject(interaction, deps)
    return Effect.fail(new Error(`Unknown subcommand: ${subcommand}`))
  }
  return {data, execute}
}

// Test the dispatch seam, not just executeAddProject:
const registry = getCommandRegistry(makeMockDeps())
await Effect.runPromise(dispatchCommand(mockInteraction, registry))
expect(mockDeps.workspaceClient.clone).toHaveBeenCalled()
```

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

const expectedSuffix = `/${owner.toLowerCase()}/${repo.toLowerCase()}`
if (parsed.path.toLowerCase().endsWith(expectedSuffix) === false) {
  return err({kind: 'response-mismatch'})
}
```

```ts
// Captured-logger security test — iterate ALL error paths:
for (const line of spy.lines) {
  expect(line).not.toContain('ghs_')
}
```

> Note: a stronger variant checks the **absolute** path prefix (`/workspace/repos/...`), not just the `owner/repo` suffix — a suffix-only check still accepts `/etc/passwd/owner/repo`. Tracked as a follow-up hardening item.

### 4. Multi-phase orchestration with documented partial-failure recovery

The flow is a five-phase state machine: `PRE_FLIGHT → CLONING → CREATING_CHANNEL → WRITING_BINDING → READY`. For v1, the orchestration is intentionally **in-memory only** — a process crash mid-flow leaves orphaned state. Rather than building durable resume infrastructure prematurely, the accepted v1 contract is **documented manual recovery per partial-failure shape**, plus:

- **A defensive permission re-check at the side-effect boundary** (`CREATING_CHANNEL`) — permissions can change between `PRE_FLIGHT` and the first mutation.
- **Preserve expensive prior work** — a failure after `CLONING` keeps the clone on disk; the recovery message names the path so the operator can retry or clean up.

```ts
// Defensive re-check before the first side effect:
if (botHasRequiredPermissions(interaction.appPermissions) === false) {
  await interaction.editReply({
    content: `fro-bot lost **Manage Channels**. Clone preserved at \`${workspacePath}\`. Re-grant and retry.`,
  })
  return
}

// Partial-write recovery names both keys for manual cleanup:
if (error.code === 'BINDING_PARTIAL_WRITE_ERROR') {
  await interaction.editReply({
    content: `Partial write: primary written, index failed. Manual S3 cleanup:\n- Primary: \`${error.primaryKey}\`\n- Index: \`${error.indexKey}\``,
  })
}
```

### 5. Re-read live caches inside find-or-create collision loops

Snapshotting `guild.channels.cache` once and iterating suffix candidates (`name`, `name-2`, …) against the frozen snapshot is a race. Two concurrent invocations see the same snapshot, both attempt to create the same name, and the loser's Discord 50035 (duplicate name) rejection gets silently swallowed as a "transient error" — the binding ends up pointing to the wrong suffixed channel with no operator-visible warning.

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
