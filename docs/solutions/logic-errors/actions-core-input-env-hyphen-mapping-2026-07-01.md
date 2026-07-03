---
title: '@actions/core input env scrub targeted the wrong key — hyphens survive in INPUT_ names'
date: 2026-07-01
category: logic-errors
module: src/harness/config
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - 'delete process.env.INPUT_AUTH_JSON ran without error but the secret remained in the process env'
  - "Child processes spawned with {...process.env} still inherited the credential after the 'scrub'"
  - 'All unit tests passed while the production control was a silent no-op'
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - development_workflow
tags:
  - actions-core
  - getinput
  - input-env-mapping
  - env-scrub
  - silent-noop
  - test-mocking
---

# `@actions/core` input env scrub targeted the wrong key — hyphens survive in `INPUT_` names

## Problem

PR #1080 added a security scrub that deletes the `auth-json` action input from `process.env` after parsing, so the OpenCode child process (spawned with `{...process.env}`) cannot inherit the credential. The first implementation deleted `process.env.INPUT_AUTH_JSON` — which is not the variable GitHub sets. The scrub was a silent no-op: no error, tests green, credential still in every child env on a real runner.

## Root Cause

`@actions/core`'s `getInput` maps an input name to its env var as:

```js
process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]
```

Only **spaces** become underscores. Hyphens survive. So the input `auth-json` is read from `INPUT_AUTH-JSON` (hyphen preserved), not `INPUT_AUTH_JSON`. GitHub's runner sets the same hyphenated form. An env var with a hyphen is unusual enough that the underscore spelling looks obviously correct — and dot-notation (`process.env.INPUT_AUTH_JSON`) compounds the trap because the hyphenated name is not even expressible that way.

The tests passed because they mocked `getInput` and stubbed the **same wrong name** — the test encoded the author's assumption instead of the platform's behavior.

## Fix

Bracket notation with the real key, at the single parse seam (`src/harness/config/inputs.ts`):

```ts
// eslint-disable-next-line dot-notation
delete process.env['INPUT_AUTH-JSON']
```

Tests were corrected to stub `INPUT_AUTH-JSON` and — more importantly — to assert the **name-independent behavioral outcome**: after parsing, no value in the simulated child env (`Object.values(childEnv)`) contains the raw credential. That assertion fails no matter which wrong name a future regression targets.

## Prevention

- When code depends on a library's name-mangling contract, verify the mangle rule **in the library source**, not from memory. The one-line check against `@actions/core/lib/core.js` is cheaper than a silently dead security control.
- Don't let tests mock the assumption under test. If the claim is "the env var is gone," at least one assertion must be name-independent (scan values, not keys).
- Treat `delete process.env.X` in dot-notation as a smell whenever `X` derives from a kebab-case action input.

## Related

- `docs/solutions/workflow-issues/isolate-ci-credential-via-oidc-broker-2026-07-01.md` — the credential-isolation work this scrub belongs to (PR #1080, issue #1060).
- Fro Bot's review on PR #1080 independently re-verified the mapping against `@actions/core` source.
