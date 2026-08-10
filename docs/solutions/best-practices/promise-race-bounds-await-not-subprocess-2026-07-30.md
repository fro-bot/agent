---
title: Promise.race bounds the await, not a non-abortable subprocess — process exit is the hard bound
date: 2026-07-30
category: best-practices
module: delegated-work
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Adding a deadline around an async step that spawns a child process or makes network calls
  - Some operations under the deadline can observe an AbortSignal and some cannot
  - You need a hard wall-clock ceiling on a step that can hang
tags:
  - deadline
  - timeout
  - abortsignal
  - promise-race
  - subprocess
  - process-exit
---

# Promise.race bounds the await, not a non-abortable subprocess — process exit is the hard bound

## Context

Bounding a step that (a) makes cancelable network calls and (b) shells out to a child process that cannot be cancelled. The brokered-push finalize step runs octokit calls (which accept `request.signal`) plus a `git` subprocess through `@actions/exec` — whose options are only `cwd`/`env`/`silent`/`ignoreReturnCode`/`input`/`listeners`, with **no** `signal` or `timeout`. A naive reading is "wrap it in `Promise.race([work, timeout])` and it's bounded." That is only half true, and the gap matters.

## Guidance

Combine three mechanisms, each covering a different failure mode:

1. **`AbortSignal` into the operations that can observe it** (octokit `{request:{signal}}`) — so network stalls cancel _promptly_, not just at the deadline.
2. **`Promise.race` against a wall-clock timeout** for the operations that can't be cancelled (the subprocess) — so a stalled child can't keep the awaiting code pending past the budget. The race bounds the **await**, letting control return with a fail-loud outcome.
3. **A process-level hard exit** as the true ceiling — the losing `Promise.race` branch is _abandoned_, not killed; a hung child keeps running. Rely on the entrypoint's `process.exit(exitCode)` to terminate the whole process (and its children) once the run resolves.

```ts
const controller = new AbortController()
let timeout: ReturnType<typeof setTimeout> | undefined
try {
  const outcome = await Promise.race([
    doWork({...params, signal: controller.signal}), // octokit calls observe the signal
    // This branch only ever RESOLVES (to fail-loud), never rejects — load-bearing:
    // doWork is async and always resolves, so the race can't reject and the
    // abandoned losing promise can't surface as an unhandled rejection.
    new Promise(resolve => {
      timeout = setTimeout(() => {
        controller.abort() // cancel what CAN cancel
        resolve({kind: "fail-loud", reason: "exceeded time budget"})
      }, BUDGET_MS)
    }),
  ])
} finally {
  if (timeout != null) clearTimeout(timeout) // never hold the event loop
}
// entrypoint: await run().then(code => process.exit(code)) — the hard bound
```

## Why This Matters

Getting this wrong produces a deadline that _looks_ enforced but isn't. If you only `Promise.race` and the entrypoint does **not** `process.exit` (e.g. it returns and lets the event loop drain), a hung child process keeps Node alive until the outer job timeout — the 2-minute budget silently becomes 40 minutes. Conversely, if you thread a signal but don't race, an operation with no signal support (the subprocess) ignores it entirely. Each mechanism covers a distinct case: signal = prompt cancellation of cancelable work; race = bounded await; `process.exit` = actual termination of the uncancelable remainder.

Two invariants keep the pattern safe:

- **The timeout branch must only resolve, never reject.** If the awaited work always resolves to a typed outcome (its own try/catch maps every throw to `fail-loud`), the race can never reject and the abandoned losing promise cannot leak an unhandled rejection (a process crash on Node with no `unhandledRejection` handler).
- **Accept the non-atomic tail honestly.** A timeout firing after a server-side write already landed reports failure for work that partially succeeded. Document it and make it self-heal on re-run rather than pretending the deadline is transactional.

## When to Apply

- Any deadline around a step mixing cancelable (network/SDK with `AbortSignal`) and non-cancelable (`@actions/exec`, `child_process` without a kill path) operations.
- Before assuming `Promise.race` "cancels" anything — it only settles the await; verify what actually stops on the losing branch and what backstops the rest.
- When the entrypoint's exit strategy is load-bearing for a deadline, state it in a comment at the deadline site so a future refactor of `main` doesn't silently remove the hard bound.

## Examples

**Wrong** — race alone, treated as full cancellation:

```ts
await Promise.race([spawnGitAndCallApis(), timeout(120_000)])
// the git child keeps running; if main() doesn't process.exit, the job hangs to the outer ceiling
```

**Right** — signal + race + documented `process.exit` backstop, timeout branch resolve-only, timer cleared in `finally` (see snippet above). Verified in `src/harness/phases/finalize.ts` with the entrypoint hard-exit at `src/main.ts` (`await run().then(code => process.exit(code))`); shipped for #1305.
