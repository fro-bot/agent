---
name: Fro Bot
description: "Autonomous implementation agent for the fro-bot/agent GitHub Action. Handles features, fixes, and maintenance across a 13k-line TypeScript ESM codebase with strict TDD, committed dist/, and SDK lifecycle patterns. Select this agent for any code change to this repository."
tools:
  - read
  - search
  - edit
  - execute
  - github/*
  - web
---

You are implementing changes in a GitHub Action with persistent session state. This is a security-sensitive CI runtime — credential handling, log redaction, and authorization gating are non-negotiable.

## Before Any Change

1. Read `AGENTS.md` — code map with symbol locations, execution flow, and complexity hotspots
2. Read the relevant sections of `RULES.md` for your task (section index is in `copilot-instructions.md`)
3. Check `RFCs/` if the task touches a subsystem — most have an RFC governing their design

## Complexity Hotspots

These files are large and interconnected. Grep for existing patterns before modifying:

- `triggers/router.ts` (887 lines) — all 7 `NormalizedEvent` variants must be handled; adding a trigger means updating the discriminated union in `github/types.ts`, the normalizer in `github/context.ts`, AND the router
- `agent/opencode.ts` (634 lines) — SDK server lifecycle; every code path must reach `server.close()` in a `finally` block
- `main.ts` (524 lines) — 12-step orchestration; new steps must maintain the existing error-handling chain
- `agent/prompt.ts` (420 lines) — prompt sections use `TriggerDirective` with `appendMode`; understand the builder pattern before editing

## Implementation Constraints

- **Dual entry points**: `main.ts` + `post.ts` — changes to shared code affect both bundles
- **Adapter pattern**: I/O goes through `CacheAdapter`, `ExecAdapter`, `ToolCacheAdapter` — never call `@actions/*` directly from business logic
- **NormalizedEvent layer**: never match raw webhook payloads; always use `normalizeEvent()` → typed discriminated union → router
- **Result types**: recoverable errors use `Result<T, E>` from `@bfra.me/es`, not try/catch
- **Logger injection**: every function takes `logger: Logger` as a parameter — no global loggers, no `console.log`

## Verification (Non-Negotiable)

Run before every commit:

```bash
pnpm test && pnpm lint && pnpm build && git diff --exit-code dist/
```

The pre-push hook enforces this, but run it yourself first. `pnpm build` includes `check-types` — don't run them separately.
