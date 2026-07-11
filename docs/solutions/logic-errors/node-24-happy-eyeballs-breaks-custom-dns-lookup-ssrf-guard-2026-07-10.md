---
title: 'Node 24 Happy Eyeballs (autoSelectFamily) breaks a custom-DNS-lookup SSRF guard'
date: 2026-07-10
category: logic-errors
module: packages/gateway
problem_type: logic_error
component: service_object
severity: high
symptoms:
  - 'A custom https.Agent lookup-based SSRF guard rejects every real send with "Invalid IP address: undefined"'
  - 'Web Push / outbound HTTPS never connects on Node 20+ despite the guard passing unit tests'
  - 'Unit tests that drive the lookup with {family: 0} pass green while the guard is broken on the real runtime'
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - node
  - https-agent
  - dns-lookup
  - happy-eyeballs
  - web-push
tags:
  - ssrf
  - dns-rebinding
  - happy-eyeballs
  - autoselectfamily
  - custom-lookup
  - node-24
---

# Node 24 Happy Eyeballs (autoSelectFamily) breaks a custom-DNS-lookup SSRF guard

## Problem

A connect-time SSRF guard was implemented as a custom `lookup` function on a Node `https.Agent`, passed via `web-push`'s `options.agent`. The design intent was correct: validate the RESOLVED destination IP right before the socket connects (not at parse time), so a DNS-rebinding attacker cannot swap the record between validation and connect. The lookup function called back with a single address string, matching the classic `dns.lookup(host, cb)` shape. On Node 20+ — this repo runs Node 24 — every real send failed.

## Symptoms

- A custom `https.Agent` lookup-based SSRF guard rejects every real send with `Invalid IP address: undefined`.
- Web Push / outbound HTTPS never connects on Node 20+ despite the guard passing unit tests.
- Unit tests that drive the lookup with `{family: 0}` pass green while the guard is broken on the real runtime.

## What Didn't Work

The initial implementation resolved with `dns.lookup(host, {all: false, ...}, cb)` and called back a single `(err, address, family)`. Its unit tests mocked the lookup by invoking it with `options = {family: 0}` (i.e. `all` left unset) and asserted a single-address callback shape. That is a shape Node's connector does **not** use when `autoSelectFamily` is active, so the tests stayed green while production broke — the tests exercised a code path the real runtime never takes.

## Solution

Node 20+ enables `autoSelectFamily` (Happy Eyeballs) **by default**. Under it, `net.connect`/`tls.connect` invoke a custom `lookup` with `options.all === true` and expect an **array** of `{address, family}` candidates back — not a single address. The guard has to:

1. Always resolve with `{all: true}` regardless of what the caller's `options.all` says internally.
2. Classify **every** returned candidate and reject the whole connection if **any** one is internal (loopback, private, link-local, cloud metadata) — Happy Eyeballs may race to a candidate that was skipped if only the first address were checked.
3. Reshape the callback to match the caller's requested `options.all` (array passthrough when `all === true`, else just the first entry) so the guard is compatible with call sites that don't opt into `autoSelectFamily`.

Before (single-address, breaks under Happy Eyeballs):

```typescript
function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, {family: 0}, (err, address, family) => {
    if (err) return callback(err, address as never, family)
    if (isBlockedResolvedAddress(address)) {
      return callback(new Error(`Blocked internal address: ${address}`), address as never, family)
    }
    callback(null, address, family)
  })
}
```

After (`packages/gateway/src/web/operator-push/push-sender.ts`, `createGuardedLookup`):

```typescript
function createGuardedLookup(): CustomLookup {
  return (hostname, options, callback) => {
    dns.lookup(hostname, {all: true}, (err, addresses) => {
      if (err) return callback(err, [])

      const blocked = addresses.find(candidate => isBlockedResolvedAddress(candidate.address))
      if (blocked) {
        return callback(new Error(`Blocked internal address: ${blocked.address}`), [])
      }

      if (options.all === true) return callback(null, addresses)
      const [first] = addresses
      callback(null, first!.address, first!.family)
    })
  }
}
```

`isBlockedResolvedAddress` is shared with the parse-time validator in `ip-classification.ts`, so the same loopback/private/link-local/metadata classification rules apply at both parse time and connect time.

## Why This Works

Resolving once with `{all: true}` and handing the connector the same validated address set closes the DNS-rebinding gap (no re-resolution happens between validate and connect). Classifying every returned candidate, not just the first, closes the Happy-Eyeballs-specific hole: without `autoSelectFamily`, only the first address the guard checked would ever be dialed; with it, Node may attempt a later candidate in the array that was never checked if the guard only inspected `addresses[0]`.

## Prevention

When writing a custom `lookup` for a Node `https.Agent` or raw socket:

- Always handle the `options.all === true` array shape — it is the default path on Node 20+, not an edge case.
- Test the guard by driving it with `{all: true}` returning a **mixed** public+internal array, and assert the whole connection is blocked, e.g.:

```typescript
it('blocks the connection when any candidate in a mixed-family array is internal', async () => {
  const lookup = createGuardedLookup()
  await expect(
    new Promise((resolve, reject) => {
      lookup('rebind.example', {all: true}, (err, addresses) => (err ? reject(err) : resolve(addresses)))
    }),
  ).rejects.toThrow(/Blocked internal address/)
})
```

A test that only drives `{family: 0}` (`all` left unset) exercises a shape the real runtime never uses and will not catch this class of bug.
