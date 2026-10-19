---
title: "feat: one object-store config schema for the Action and the gateway"
type: feat
status: active
date: 2026-10-19
origin: docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md
---

# feat: one object-store config schema for the Action and the gateway

## Overview

This is the first config spine block. It adds a single S3 / object-store settings parser to `packages/runtime`, and the Action, the gateway server and the gateway backfill runner all use it. Each surface still reads its own sources: Action inputs on one side, env and `_FILE` values on the other. Defaults, validation and region precedence live in runtime only.

The gateway gains endpoint, prefix and encryption validation at startup, plus four settings: an `S3_ALLOW_INSECURE_ENDPOINT` opt-in, `S3_EXPECTED_BUCKET_OWNER`, `S3_SSE_KMS_KEY_ID`, and an `AWS_REGION` fallback for `S3_REGION`. Backfill stops ignoring the endpoint and encryption settings.

This block advances the end-state split in origin R16: surfaces own their config sources, and runtime owns what the values mean.

## Problem Frame

The three readers disagree on names, defaults and validation:

| Setting | Action (`src/harness/config/inputs.ts`) | Gateway server (`packages/gateway/src/config.ts`) | Gateway backfill (`packages/gateway/src/bindings/backfill-runner.ts`) |
| --- | --- | --- | --- |
| Region | `aws-region`, may be empty | `S3_REGION`, required, `AWS_REGION` never read | `AWS_REGION`, required, `S3_REGION` never read |
| Endpoint | `validateEndpoint` when enabled | read, never validated | never read, so the run goes to AWS |
| Insecure opt-in | `s3-allow-insecure-endpoint` | none | none |
| Prefix | `validatePrefix` when enabled | not checked at startup, rejected on every write | `?? 'fro-bot-state'`, empty string kept |
| SSE mode | `aws:kms` or `AES256`, else error | unchecked cast (`config.ts:628`) | never read |
| Expected owner | `s3-expected-bucket-owner` | none | none |
| SSE KMS key | `s3-sse-kms-key-id`, ignored unless KMS | none | none |
| Default prefix | runtime `DEFAULT_S3_PREFIX` | own literal (`config.ts:32`) | own literal (`backfill-runner.ts:258`) |

`packages/gateway/AGENTS.md` documents `AWS_REGION`, which the server never reads. `deploy/README.md` says gateway validation only checks that values are non-empty.

## Requirements Trace

- R1. One runtime parser defines the object-store settings: bucket, region, endpoint, insecure-endpoint opt-in, prefix, SSE mode, SSE KMS key ID and expected bucket owner. Each setting has one default and one validation rule. The one exception is region: the calling surface decides whether it is required (R3). The endpoint check is runtime's `validateEndpoint`. The SSE default stays the derived rule in `s3-adapter.ts` (origin R11).
- R2. Each surface maps its own sources onto the parser. No surface keeps its own defaults or validation for these settings. Credentials stay per surface (origin R12).
- R3. Region candidates are tried in order, and the first non-empty one wins. The gateway passes `S3_REGION` then `AWS_REGION` and requires a result. The Action passes `aws-region` and allows an empty result for R2 and MinIO. Backfill reads region the same way the gateway server does (origin R13, AE4).
- R4. The gateway validates its endpoint and accepts `S3_ALLOW_INSECURE_ENDPOINT`. The flag lifts the https and private-address checks, never the cloud-metadata check, matching the Action's flag (origin R14, AE5).
- R5. Errors name the source the operator set and the rule that failed. They never include the value. The substrings the Action tests pin still appear.
- R6. The bucket, region, endpoint, prefix and KMS-key rules run only when the store is enabled. The gateway is always enabled, and the Action is enabled when `s3-backup` is true. The SSE mode value is checked whenever it is set, as the Action does today.
- R7. The docs match the code. The requirements doc marks rung 2 as delivered (#1872) and this block as the first config spine block.

## Scope Boundaries

- Credentials stay where they are. The Action uses the SDK chain from the job env. The gateway server keeps its pair rule and session-token warning. Backfill keeps its two required keys and still has no session token.
- No `_FILE` or `process.env` reads in runtime. The parser takes plain values.
- The Action's input names and `post.ts` state keys don't change. `post.ts` keeps rebuilding the config from saved state without validating it again, because the main step already validated it.
- The Action's empty-region path doesn't change: runtime passes `undefined` to the S3 client, and the SDK's own chain picks the region.
- No new compose secret mounts. The new gateway settings are optional and are set through env or a compose override. Mounts with `create_host_path: false` would break existing deploys.
- The endpoint classifier fix (bracketed IPv6, CGNAT, unspecified and documentation ranges) ships first as its own PR, which also corrects `docs/wiki/Session Persistence.md` and the SSRF sentence in `docs/wiki/Setup and Configuration.md`. This plan depends on that PR and doesn't repeat it.
- Other gateway config blocks stay outside the schema until a second consumer needs them (origin R15).

## Context & Research

- Research with file:line references for every read site, a divergence table, the list of behaviour changes and the tests that pin current behaviour: produced for this plan (local, untracked) and summarized here.
- Runtime already shares `ObjectStoreConfig` (`packages/runtime/src/shared/types.ts`), `validateEndpoint` and `validatePrefix` (`packages/runtime/src/object-store/validation.ts`), the SSE default (`getEffectiveEncryption` in `s3-adapter.ts`) and `DEFAULT_S3_PREFIX`. The Action calls both validators at startup. `buildObjectStoreKey` (`key-builder.ts`) calls `validatePrefix` on every write on every surface.
- Runtime must not import `@actions/*` (`scripts/runtime-no-actions-import-guard.test.ts`). It returns `Result` from `@bfra.me/es`, not Effect.
- Action tests in `src/harness/config/inputs.test.ts`:
  - The pinned error substrings are `s3-bucket`, `https`, `cloud instance metadata services`, `loopback, link-local, or private network addresses` and `prefix`.
  - 679-680 asserts that the bucket error does not echo the input value.
  - 796-805 pins that a disabled store with a bad endpoint and a bad prefix does not fail.
- Gateway tests:
  - `config.test.ts` 542-549 pins `Missing required secret: S3_BUCKET`.
  - `config.test.ts` 24-50 scrubs a fixed env list that lacks `AWS_REGION` and several `_FILE` variants.
  - `backfill-runner.test.ts` 51-76 scrubs no S3 names.
- `config.ts` reads the S3 settings after the Discord settings and before the GitHub App settings. It imports runtime types through `./runtime-effect.js`.
- Backfill's `readEnv` treats an empty `_FILE` as an empty value. The gateway's `readOptionalSecret` treats an empty file as unset and falls back to the env var.
- The gateway service joins `gateway-net`, which has direct egress by design (`deploy/compose.yaml` network comments). mitmproxy confines the workspace, not the gateway.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/runtime/src/object-store, packages/runtime/src/shared, src/harness/config, packages/gateway/src/config.ts, packages/gateway/src/bindings",
  "freshness": {
    "vcs_reference": "515424ac0"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 10,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/object-store/validation.ts validateEndpoint / validatePrefix",
      "description": "Existing endpoint and prefix validators",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/shared/types.ts ObjectStoreConfig",
      "description": "Shared config type consumed by the S3 adapter",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "packages/runtime/src/object-store/s3-adapter.ts getEffectiveEncryption",
      "description": "Derived SSE mode rule; the parser uses it for the KMS-key check",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "src/harness/config/inputs.ts parseSseEncryption",
      "description": "Action-only SSE mode parser",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/gateway/src/config.ts readSecret / readOptionalSecret",
      "description": "Gateway env and _FILE readers",
      "disposition": "insufficient",
      "insufficiency_reason": "Filesystem and process.env IO; stays in the gateway as the source reader, not part of the runtime schema"
    }
  ]
}
```

## Key Technical Decisions

- **Parser contract.** `parseObjectStoreSettings(input, {region: 'required' | 'optional'})` lives in `packages/runtime/src/object-store/settings.ts` and returns `Result<ObjectStoreConfig, Error>`. The input is:

  ```ts
  interface Sourced {
    readonly value: string | null
    readonly source: string
  }
  interface ObjectStoreSettingsInput {
    readonly enabled: boolean
    readonly bucket: Sourced
    readonly region: readonly Sourced[] // candidates, first non-empty wins
    readonly endpoint: Sourced
    readonly allowInsecureEndpoint: boolean
    readonly prefix: Sourced
    readonly sseEncryption: Sourced
    readonly sseKmsKeyId: Sourced
    readonly expectedBucketOwner: Sourced
  }
  ```

  The parser trims every value, and a value that is empty after trimming counts as unset. Each surface parses its booleans with its own syntax. The output never carries credentials, and the gateway adds those afterwards.

- **Rules.**
  - Bucket: required when enabled.
  - Region: first non-empty candidate. Under `required`, an empty result is an error when enabled, and the error names every candidate source.
  - Endpoint: `validateEndpoint` when enabled and set.
  - Prefix: `validatePrefix` when enabled, with the default applied when unset.
  - SSE mode: `aws:kms` or `AES256` whenever set.
  - KMS key: when enabled and set, the effective mode from `getEffectiveEncryption` must be `aws:kms`. Today the adapter silently drops the key otherwise.
  - Expected owner: when enabled and set, must be a 12-digit AWS account ID (`/^\d{12}$/`).

- **Error text.** Messages read `<source>: <rule message>` and never include the value. The rule messages from `validateEndpoint` and `validatePrefix` are unchanged, so the pinned substrings survive. The bucket rule message is `is required`. The region message names every candidate source, joined with commas and a final `or` (`S3_REGION or AWS_REGION is required`). Sources are plain setting names; the surface decides whether they also accept `_FILE`.
- **Disabled store.** When `enabled` is false, the parser returns the trimmed values without the bucket, region, endpoint, prefix or KMS-key checks. The prefix is the trimmed value, or the default when it is empty, as in `inputs.ts` today.
- **One gateway mapping.** `config.ts` exports `loadObjectStoreSettings()`, and `loadGatewayConfig` and backfill both call it.
  - `S3_BUCKET` is read with `readSecret` before the parser, so its missing-value error keeps the current `Missing required secret: S3_BUCKET (...)` text. Every other setting, including both region candidates, is read with `readOptionalSecret`.
  - An `err` result is thrown with the parser's message.
  - The parser is re-exported through `runtime-effect.ts`, following the gateway rule that runtime values enter through that adapter.
  - `loadObjectStoreSettings` lives in `packages/gateway/src/object-store-config.ts` and the env and `_FILE` readers in `packages/gateway/src/secrets.ts`. `config.ts` re-exports the readers. Importing `config.ts` from backfill is avoided so the runner does not load the whole gateway config module.
  - Backfill imports `loadObjectStoreSettings` and the readers from those modules and deletes its own S3 reads. It reads `GITHUB_APP_ID`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` with `readSecret` and `GITHUB_APP_PRIVATE_KEY` with `readMultilineSecret`, so an empty `_FILE` counts as unset on every read.
- **Gateway names and booleans.** The new settings are `S3_ALLOW_INSECURE_ENDPOINT`, `S3_EXPECTED_BUCKET_OWNER` and `S3_SSE_KMS_KEY_ID`. Each also accepts a `_FILE` form through `readOptionalSecret`. `S3_ALLOW_INSECURE_ENDPOINT` is true only for the exact value `true`, matching `config.ts:1108`.
- **Error behaviour per surface.** The Action fails the step with `Invalid inputs: …`. The gateway server throws from `loadGatewayConfig`. Backfill logs the message and exits 1. How each surface reports an error doesn't change; the Action's error text does (see System-Wide Impact).
- **Rebuild `dist/`** in every unit that touches runtime or `src/`, because runtime is bundled into the Action.

## Open Questions

### Deferred to Implementation

- Whether importing `config.ts` from backfill pulls in anything with side effects at import time. `config.ts` imports `discord.js` and `effect` but defines only functions. If anything runs at import, move `loadObjectStoreSettings` and the readers it needs into a small `packages/gateway/src/object-store-config.ts`.

## Implementation Units

- [ ] **Unit 1: Runtime settings parser**

**Goal:** One pure parser, with tests.

**Requirements:** R1, R3, R5, R6

**Dependencies:** The endpoint classifier fix PR is merged, and this branch is rebased onto it.

**Files:**

- Create: `packages/runtime/src/object-store/settings.ts`, `settings.test.ts`
- Modify: `packages/runtime/src/object-store/index.ts` (export by name)
- Modify: `dist/` (rebuild)

**Approach:** Move the SSE mode parse in from `inputs.ts`. Use `validateEndpoint`, `validatePrefix` and `getEffectiveEncryption` for their rules.

**Test scenarios:**

- Happy path: every field set and enabled. The output matches `ObjectStoreConfig` with no extra keys.
- Region: the first candidate wins, and an empty first candidate falls through. All empty passes under `optional`. Under `required` it fails when enabled and passes when disabled, and the message names both sources.
- Enabled checks, each message starting with the field's source:
  - a missing bucket;
  - an http endpoint without the flag, and the same endpoint with the flag;
  - a metadata endpoint with the flag, which is still rejected;
  - a bad prefix.
- KMS key: rejected with a custom endpoint and no SSE mode (the derived mode is AES256). Rejected with `AES256`. Accepted with `aws:kms`, and accepted on AWS with no mode (the derived mode is `aws:kms`).
- Disabled: a bad endpoint, a bad prefix and a mismatched KMS key pass through unchecked. A bad SSE mode still fails.
- SSE mode: `aws:kms` and `AES256` pass. Anything else fails and names the source. Unset leaves the field absent.
- Prefix: unset or empty gives `DEFAULT_S3_PREFIX`.
- No echo: for every failing case, the message doesn't contain the input value.

**Verification:** Runtime tests pass. The `@actions/*` guard passes.

- [ ] **Unit 2: The Action uses the parser**

**Goal:** `inputs.ts` maps inputs onto the parser and deletes its own checks.

**Requirements:** R2, R5, R6

**Dependencies:** Unit 1

**Files:**

- Modify: `src/harness/config/inputs.ts` (remove `parseSseEncryption` and the inline S3 assembly and validation), `dist/`
- Test: `src/harness/config/inputs.test.ts`

**Approach:** Pass `aws-region` as the only region candidate under `optional`. Keep the fork-PR disable after parsing, and keep the `AWS_*` masking as it is.

**Test scenarios:**

- The existing S3 tests pass unchanged, including the disabled-store case at 796-805, the no-echo assertion at 679-680 and every pinned substring.
- New: the endpoint error starts with `s3-endpoint`.
- New: an enabled store with an empty `aws-region` parses, with region `''`.
- New: `s3-sse-kms-key-id` with `s3-sse-encryption: AES256` fails and names `s3-sse-kms-key-id`.

**Verification:** `inputs.test.ts`, `post.test.ts` and `scripts/action-input-defaults-guard.test.ts` pass.

- [ ] **Unit 3: The gateway server and backfill use the parser**

**Goal:** One gateway mapping that both paths call.

**Requirements:** R2, R3, R4, R5

**Dependencies:** Unit 1

**Files:**

- Modify: `packages/gateway/src/runtime-effect.ts` (re-export the parser)
- Create: `packages/gateway/src/secrets.ts` (the env and `_FILE` readers, moved from `config.ts`; an empty file falls through to the env var)
- Create: `packages/gateway/src/object-store-config.ts` (`loadObjectStoreSettings`)
- Modify: `packages/gateway/src/config.ts` (call `loadObjectStoreSettings`, re-export the readers, delete the local `DEFAULT_S3_PREFIX` and the SSE cast)
- Modify: `packages/gateway/src/bindings/backfill-runner.ts` (call `loadObjectStoreSettings`, read credentials through `readSecret`, update the USAGE text, delete its S3 reads and the prefix literal)
- Test: `packages/gateway/src/config.test.ts`, `packages/gateway/src/bindings/backfill-runner.test.ts`

**Approach:** Backfill catches the thrown error, logs its message and returns 1, matching its missing-var path. Both test files clear every name the loader reads, and each name's `_FILE` form, before each test: `S3_BUCKET`, `S3_REGION`, `AWS_REGION`, `S3_ENDPOINT`, `S3_PREFIX`, `S3_SSE`, `S3_ALLOW_INSECURE_ENDPOINT`, `S3_EXPECTED_BUCKET_OWNER` and `S3_SSE_KMS_KEY_ID`.

**Test scenarios:**

- AE4: when only `AWS_REGION` is set, the region comes from it. When both are set, `S3_REGION` wins. When neither is set, the error names `S3_REGION`, `S3_REGION_FILE` and `AWS_REGION`.
- AE5: `S3_ENDPOINT=http://minio:9000` without the flag fails startup. With `S3_ALLOW_INSECURE_ENDPOINT=true` it loads. A metadata endpoint fails even with the flag.
- `S3_PREFIX=../x` fails. `S3_SSE=aes256` fails and names `S3_SSE`. `S3_SSE=AES256` passes.
- `S3_EXPECTED_BUCKET_OWNER` and `S3_SSE_KMS_KEY_ID` reach `objectStore` from env and from `_FILE`. A KMS key with a custom endpoint and no `S3_SSE` fails.
- `config.test.ts` 542-549 (`Missing required secret: S3_BUCKET`) passes unchanged.
- Backfill: `S3_REGION` is honoured. `S3_ENDPOINT` and `S3_SSE` reach the store config. An invalid endpoint exits 1 with a logged error. The existing `AWS_REGION` fixture still works.
- The existing credential pair and session-token tests pass unchanged.

**Verification:** Gateway tests pass. The CI gateway smoke env (`S3_BUCKET`, `S3_REGION`) still loads.

- [ ] **Unit 4: Docs**

**Goal:** The docs describe the shared rules and the gateway's new behaviour.

**Requirements:** R7

**Dependencies:** Units 2 and 3

**Files:**

- Modify: `packages/gateway/AGENTS.md` 46-47 (region names), 55 (prefix)
- Modify: `deploy/README.md`:
  - 15 and 19 (what startup validates)
  - 23 (the validation sentence)
  - 46-50 (the optional settings and how to set them)
  - a rollout note covering the production endpoint, `S3_SSE`, and backfill region
- Modify: the gateway S3 env list in `docs/wiki/Setup and Configuration.md` (not the SSRF sentence at 255, which the classifier PR owns)
- Modify: `docs/product/FEATURES.md` 1206 (the stale `AWS_REGION` item)
- Modify: `README.md` `s3-sse-kms-key-id` row (the new KMS rule)
- Modify: `docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md` (mark rung 2 delivered in #1872 and this block as config spine block 1)

**Approach:** State the current rules plainly. Tell gateway users on R2 and MinIO to set `S3_REGION=auto`.

**Test expectation:** none. This is a docs change. The link check passes.

## System-Wide Impact

- **Gateway behaviour changes:**

| Change | Before | After |
| --- | --- | --- |
| `S3_ENDPOINT` that is http, private-IP or credentialed | accepted | startup error unless the opt-in is set |
| Cloud-metadata endpoint | accepted | startup error, even with the opt-in |
| `S3_PREFIX` that fails the prefix rule | starts, then every write is rejected | startup error |
| `S3_SSE` other than `aws:kms` or `AES256` | starts, then writes fail | startup error |
| Only `AWS_REGION` set | `Missing required secret: S3_REGION` | region resolved from it |
| `S3_EXPECTED_BUCKET_OWNER`, `S3_SSE_KMS_KEY_ID` | not read | applied to requests (opt-in) |
| KMS key without an effective `aws:kms` mode | not read | startup error |
| Backfill with `S3_ENDPOINT` set | ignored, so the run went to AWS | uses the endpoint |
| Backfill with `S3_SSE` set | ignored | applied |
| Backfill with `S3_REGION` and `AWS_REGION` both set | `AWS_REGION` | `S3_REGION` |
| Backfill with `S3_PREFIX=''` | empty prefix | default prefix |
| Backfill `_FILE` forms for the S3 settings | only `S3_BUCKET` and `AWS_REGION` | all of them, empty file means unset |
| Backfill with `S3_ENDPOINT` set and no `S3_SSE` | `aws:kms` against AWS (endpoint ignored) | derives `AES256` for the custom endpoint |
| Backfill with an empty `S3_PREFIX` | wrote and read the bucket root, so deny keys from an earlier empty-prefix run sit there | uses `fro-bot-state`; keys at the bucket root are not read |
| Backfill `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_APP_ID` with an empty `_FILE` | the empty string was used | the empty file counts as unset: the env var is used, or the run exits 1 naming the variable |
| Any gateway secret with an empty or whitespace-only `*_FILE` and a same-named env var | the empty file hid the env var (null) | the env var is used |
| `S3_EXPECTED_BUCKET_OWNER` that is not a 12-digit account ID | passed startup, failed S3 calls | startup error |
| Padded `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | used as given | trimmed |
| Backfill `--apply` while the gateway runs | unconditional overwrite, no guard | same; stop or quiesce the gateway first |

- **Action:** the inputs it accepts and rejects don't change, with two exceptions: a KMS key without an effective `aws:kms` mode is now an error instead of being silently dropped, and an `s3-expected-bucket-owner` that is not a 12-digit account ID is now an error. Every S3 error text now starts with the input name, and the pinned substrings still appear. The missing-bucket error is now `s3-bucket is required`, and an unknown SSE mode is `s3-sse-encryption: must be either 'aws:kms' or 'AES256'`.
- **Startup failure.** A bad S3 value now stops the gateway at startup, where before it degraded persistence at write time. This is intended: the persistence it degraded was silent.
- **Unchanged invariants:** the SSE default rule, `forcePathStyle` for custom endpoints, the Action's input names and state keys, the Action's empty-region path, and credential handling on every path.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| The classifier PR hasn't merged | Unit 1 depends on it, and the branch rebases onto it before Unit 1 |
| A production gateway endpoint fails the new check | Rollout note: check the configured endpoint before deploying. Use the opt-in only for MinIO |
| The production gateway writes with `aws:kms` to an SSE-S3-only bucket | Rollout note: confirm the bucket policy and set `S3_SSE=AES256` if needed |
| `S3_REGION` and `AWS_REGION` differ where backfill `--apply` runs | Rollout note: confirm that they match, or unset `AWS_REGION`, before running backfill |
| Backfill now targets a configured endpoint it used to ignore | Called out in the PR and the rollout note |
| Gateway S3 egress | Unchanged. The gateway uses its direct `gateway-net` egress, and this plan doesn't touch the network path |
| An ambient env value leaks into gateway tests | Both test files clear every loader name and its `_FILE` form |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-10-18-action-gateway-consolidation-requirements.md](../brainstorms/2026-10-18-action-gateway-consolidation-requirements.md)
- Inventory: [docs/brainstorms/2026-10-18-action-gateway-consolidation-inventory.md](../brainstorms/2026-10-18-action-gateway-consolidation-inventory.md)
- Rung 2: #1872
