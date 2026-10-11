---
title: Bound attacker-controlled key cardinality by aggregating keys and evicting, not refusing
date: 2026-10-10
category: best-practices
module: gateway
problem_type: best_practice
component: authentication
severity: high
related_components:
  - assistant
applies_when:
  - a pre-auth path keeps per-client state (rate-limit buckets, OAuth state, attempt counters)
  - a cap on that state would otherwise fail closed for everyone, including the operator
  - deriving an abuse-accounting key from a client address
tags:
  - rate-limiting
  - dos-hardening
  - ingress
  - oauth
  - cardinality
---

# Bound attacker-controlled key cardinality by aggregating keys and evicting, not refusing

## Context

Keying operator ingress per client (#1638, PR #1651) turned a key space of exactly one value into one key per client address. That made two previously unreachable ceilings live on the sign-in path (#1652): the rate limiter's 10,000-key map **refused** any new key once full, and the OAuth state store's 1,000-entry ceiling made `/start` **refuse** everyone once about 200 addresses held five outstanding attempts each. Both fail closed in the worst direction — the person who has to fix an outage is the one locked out — and the limiter also swept its whole map on every call (~83 µs/request at 10,000 keys).

## Decision

1. **Aggregate the key, never the identity.** Abuse accounting uses a derived key (`ResolvedClientAddress.accountingKey`: IPv6 /64, IPv4 /32; IPv4-mapped IPv6 is already normalized to IPv4). Exact canonical identity stays the only input to trust and binding: trusted-proxy equality and the OAuth `boundAddress` binding. Aggregating in the canonical parser would widen proxy trust (an address in the same /64 as a trusted proxy must not be trusted). Without the /64 step, one host with a routed /64 owns 2^64 free keys and any ceiling is reachable from a single box.
2. **Split counting from binding on the stored record.** `OAuthStateEntry` has `boundAddress` (exact, compared on callback) and `accountingKey` (derived, counted). One field doing both is what made the aggregation unsafe to apply.
3. **Admit by evicting the oldest, at the insertion point.** The store owns bounded insertion, and `/start` evicts only after reclaiming consumed/expired states, enforcing the per-key cap, and validating the request. Invalid or per-key-rejected requests must never evict — otherwise rejected traffic can still push out a legitimate attempt.
4. **No sweep; delete-then-set on renewal.** Expiry is lazy per key. `Map.set` on an existing key keeps its position, so a renewed key must be deleted first to move to the tail. The result is window-renewal FIFO, not LRU.

## Accepted tradeoffs (documented, not hidden)

- **Admission, not guaranteed completion.** A flood can evict an operator's in-flight OAuth attempt; its callback finds an unknown state and gets the ordinary 400. The operator retries. Consistent with the existing burned-flow policy.
- **Evicting an active rate-limit counter resets that key's bucket.** The limiter is best-effort under cardinality pressure; bound the key space upstream rather than relying on it as a hard quota.
- **Shared buckets.** Distinct clients behind one /64 (or IPv4) share a rate-limit bucket and an outstanding-attempt slot, and anonymous `/start`/`/callback` traffic spends the same 20/min bucket authenticated logout uses (logout itself is guarded by session, allowlist, origin, and CSRF before it touches the limiter).
- **Headerless trusted-peer health probe** stays keyed on the peer's exact address: it is a configured proxy, bounded by configuration, and an unprefixed exact string cannot collide with a prefixed derived key.

## Guidance for the next bounded pre-auth store

Ask three questions before adding a cap: who controls the key's cardinality, what does the cap do to the one client who must get through, and does the eviction order guarantee that rejected requests cannot displace admitted ones. Pin each with a test that breaks when the behavior is reverted (saturated map admits a newcomer; invalid and per-key-rejected starts evict nothing; same-/64 shares a slot while adjacent /64s do not; a same-/64 address change still trips the exact binding mismatch).
