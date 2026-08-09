---
title: File existence is not deliverable existence, and an unknown status must fail closed
date: 2026-08-08
category: logic-errors
module: agent-execution
problem_type: logic_error
component: service_object
symptoms:
  - "A recovery path is suppressed, and then delivery fails, so nothing is produced at all"
  - "A partially written artifact counts as a completed one"
  - 'A permission or I/O error on a safety gate is treated as "not there"'
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - fail-closed
  - safety-gate
  - filesystem
  - response-file
  - three-state
---

## Problem

A recovery gate needed to know whether the agent had already produced a response, so that recovery would not duplicate a delivery. It asked the filesystem:

```ts
async function responseFileExists(responseFilePath: string | null | undefined): Promise<boolean> {
  if (responseFilePath == null) return false
  try {
    await fs.access(responseFilePath)
    return true
  } catch {
    return false
  }
}
```

Two distinct defects, in opposite directions.

**Existence is weaker than the property being gated.** An agent that created the file and then failed before writing a body leaves an empty file. `fs.access` reports it present, so recovery is suppressed. Delivery then reads the same file and rejects it, because the parser refuses empty content:

```ts
if (raw.trim().length === 0) {
  return err(createResponseFileError("empty", "Response file is empty"))
}
```

Recovery declined because a deliverable existed; delivery declined because it did not. Nothing was posted — strictly worse than the gate this replaced.

**`catch { return false }` fails open on a safety gate.** `EACCES`, `EIO`, and `EBUSY` are reported as "no deliverable", which is the permissive answer. The gate exists to prevent duplicate work, so an unreadable file should make it _more_ cautious, not less.

## What Didn't Work

**Treating the cheap check as a conservative one.** `fs.access` feels like the safe, minimal question. It is only safe when existence and the gated property coincide, and here they diverge exactly in the failure case the gate is for.

**Collapsing errors to a boolean.** A two-state return has nowhere to put "I could not find out", so that case has to be assigned to one of the two answers. Whichever is chosen is wrong half the time; the type forces the bug.

## Solution

Return three states, and make the affirmative answer require actually parsing the artifact:

```ts
export type ResponseFileStatus = 'present' | 'absent' | 'unknown'

export async function inspectResponseFile(
  responseFilePath: string | null | undefined,
  surface: ResponseSurface,
  logger: Logger,
): Promise<ResponseFileStatus> {
  if (responseFilePath == null) return 'absent'

  let raw: string
  try {
    raw = await fs.readFile(responseFilePath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) return 'absent'
    logger.warning('Response-file status is unknown; declining recovery', {responseFilePath, error: …})
    return 'unknown'
  }

  const parsed = parseResponseFile(raw, {surface})
  if (parsed.success === true) return 'present'

  logger.warning('Response file is not a valid deliverable; allowing recovery', {responseFilePath, reason: parsed.error.reason})
  return 'absent'
}
```

Callers proceed only on `absent`:

```ts
if (responseFileStatus !== "absent") break
```

`present` requires the same parse that delivery will later perform, so the gate and the consumer agree on what counts. `unknown` declines, because an unreadable file is not evidence of absence.

Reusing `parseResponseFile` rather than hand-rolling a validity check is load-bearing: a second implementation would drift, and the gate would resume disagreeing with delivery.

## Why This Works

The gate now measures the property it is gating on rather than a proxy that usually correlates with it. The three-state return gives the uncertain case its own home, so it can be routed by policy — decline — instead of being silently folded into an answer.

## Prevention

- **Ask whether the cheap predicate and the gated property can ever diverge.** If they can, the divergence will happen exactly in the failure case the gate exists for, because that is when partial states occur.
- **Gate on the same check the consumer performs.** If delivery parses the artifact, the gate must parse it too, or the two will disagree.
- **A boolean cannot express "unknown".** When a check can fail for reasons other than the answer being no, use three states and decide the uncertain case deliberately.
- **On a safety gate, unknown takes the cautious branch.** Fail-soft is right for observability; fail-closed is right for anything preventing duplicate or destructive work.
- **Test the partial-artifact case.** An empty or truncated file is the state that distinguishes existence from validity, and a test that only covers present-and-valid versus absent will pass against the broken gate.

## Related Issues

- [A gate that cannot fail manufactures confidence](../workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — the same theme from the other end: there, a gate no input could fail; here, a gate whose predicate was too weak.
- [Absence of an outcome is not a failed outcome](../workflow-issues/absence-of-outcome-is-not-a-failed-outcome-2026-08-07.md) — the same three-state discipline applied to run scoring.
- [A failed run reported success with no delivery surface](failed-run-reported-success-with-no-delivery-surface-2026-08-07.md) — an adjacent way the delivery path can produce nothing while looking fine.
