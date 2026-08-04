---
title: OpenCode SDK v1 can read but not typed-write session.time.archived (use v2 client)
date: 2026-08-03
category: logic-errors
module: agent-execution
problem_type: logic_error
component: service_object
symptoms:
  - "Reading session.time.archived compiled fine on the v1 SDK client"
  - "Writing time.archived via v1 session.update failed typecheck (body typed {title?})"
  - "The archive flow appeared to require an `as unknown as` cast"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags:
  - session-archive
  - opencode-sdk
  - sdk-v1
  - sdk-v2
  - time-archived
  - type-safety
---

# OpenCode SDK v1 can read but not typed-write session.time.archived (use v2 client)

## Problem

To archive an OpenCode session (set `time.archived` so it is skipped for continuation), the v1 `@opencode-ai/sdk` client can **read** `time.archived` (the `Session` type carries it) but **cannot** typed-write it — the v1 `session.update` body is typed `{title?}` only. The archive path looked like it needed a type cast; it did not.

## Symptoms

- `check-types` fails on the write: `Object literal may only specify known properties, and 'time' does not exist in type '{ title?: string | undefined; }'`.
- The read side (`resolveSessionForLogicalKey` reading `session.time.archived`) compiles and works.
- A cast makes the error disappear but hides whether the request shape is even correct.

## What Didn't Work

```ts
// Bad: an `as unknown as` double-cast to silence the type system.
// Violates the project's no-type-suppression rule AND hides a genuinely
// wrong request shape (the v1 body cannot express time.archived at all).
const update = client.session.update.bind(client.session) as unknown as (options: {
  path: {id: string}
  body: {time: {archived: number}}
}) => Promise<{error?: unknown}>
```

## Solution

The **v2** SDK client (`@opencode-ai/sdk/v2/client`) types the field. Its `session.update` is a flat shape (`{sessionID, time:{archived}}`), distinct from v1's `{path, body}`. Build a v2 client from the server loopback URL and write through it — fully typed, no suppression:

```ts
import type {Logger} from "../shared/logger.js"

// The v1 session client can READ time.archived but its typed session.update
// body only exposes {title?} — it cannot write time.archived. The v2 client
// is the typed write path; do not "simplify" this back to the v1 client.
import {createOpencodeClient} from "@opencode-ai/sdk/v2/client"

export async function archiveSession(baseUrl: string, sessionId: string, logger: Logger): Promise<boolean> {
  try {
    const client = createOpencodeClient({baseUrl})
    const response = await client.session.update({
      sessionID: sessionId,
      time: {archived: Date.now()},
    })
    if (response.error != null) {
      logger.warning("SDK session archive failed", {sessionId, error: String(response.error)})
      return false
    }
    logger.debug("Archived session via SDK", {sessionId})
    return true
  } catch (error: unknown) {
    logger.warning("SDK session archive failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
```

The caller passes the server's loopback URL (`serverHandle.server.url`) as `baseUrl`.

## Why This Works

The v1 and v2 SDK surfaces are genuinely different APIs. The write field (`time.archived`) exists on the v2 `SessionUpdateData` body but not on v1's. Constructing a per-call v2 client from the loopback baseURL is an established repo pattern (session tools do the same). Reading `time.archived` continues to work through the v1 client because the `Session` **read** type carries it — the asymmetry is read-anywhere / write-v2-only.

## Prevention

- When a typed SDK write appears to "need" a cast, first check whether a **v2 / alternate client subpath** types the field. A cast that hides a wrong request shape is worse than a compile error.
- Keep an explanatory comment at the v2 import (as above) so a future maintainer does not "simplify" the archive back to the v1 client and silently break the write.
- Never reach for `as unknown as` to satisfy a request-body type — it is type suppression by another name and is forbidden project-wide.

## Related Issues

- fro-bot/agent#1311 / PR #1313 — the overflow-recovery work that needed a session-archive primitive.
- See also: [Overflow-recovery architecture](../best-practices/overflow-recovery-architecture-2026-08-03.md) — where `archiveSession` is used.
