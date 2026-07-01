#!/usr/bin/env node

// Mints a short-lived OpenCode auth.json from the OIDC credential broker.
//
// Security contract (docs/plans/2026-07-01-001-feat-harness-merge-credential-broker-plan.md):
//   1. Request a GitHub OIDC token and IMMEDIATELY mask it via core.setSecret,
//      before any HTTP call, error log, or stack trace can surface the JWT.
//   2. Exchange it at the broker with a SINGLE POST under a bounded timeout —
//      no retry loop. The OIDC token is single-use per jti; a retry either
//      fails replay protection or risks minting a duplicate credential.
//   3. Validate the broker's auth.json response ALL-OR-NOTHING: every
//      provider must be well-formed or the entire payload is rejected — no
//      partial acceptance.
//   4. Emit the minted credential as a masked GitHub Actions step output —
//      never write it to disk, never place it (or the OIDC token) in
//      process.env.
//   5. Fail closed: any error exits non-zero and emits nothing usable. Never
//      fall back to a durable key.
//
// Run via: node --experimental-strip-types scripts/harness/mint-broker-credential.ts
//
// This file uses no sibling .ts imports. main() is exported (not called at
// module top level) and only invoked by the guard at the bottom of this
// file, which fires solely when the script is executed directly — mirrors
// packages/harness/scripts/build-platform.ts. This keeps the module
// import-safe for the test file (imported under Vitest, .js extension),
// while `node --experimental-strip-types` execution still runs main().

import process from 'node:process'
import {fileURLToPath} from 'node:url'
import * as core from '@actions/core'

export const BROKER_AUDIENCE = 'https://broker.fro.bot'

const DEFAULT_BROKER_URL = 'https://broker.fro.bot'
const MINT_TIMEOUT_MS = 30_000
const PROVIDER_ID_PATTERN = /^[\w.-]+$/

/**
 * Resolve the broker base URL. Reads BROKER_URL as a test/override seam;
 * defaults to the production broker otherwise.
 */
export function resolveBrokerUrl(env: NodeJS.ProcessEnv): string {
  const override = env.BROKER_URL?.trim() ?? ''
  return override.length > 0 ? override : DEFAULT_BROKER_URL
}

export type ValidateBrokerResponseResult =
  {readonly ok: true; readonly authJson: string} | {readonly ok: false; readonly reason: string}

/**
 * Validate the broker's response body as an OpenCode auth.json, ALL-OR-NOTHING.
 * Mirrors the shape rules in src/services/setup/auth-json.ts
 * (parseAuthJsonInput), plus the stricter per-provider {type:'api', key}
 * and provider-id constraints the minted credential must satisfy. Pure —
 * no I/O, never throws; every branch returns a discriminated result. Any
 * single malformed provider rejects the entire payload.
 */
export function validateBrokerResponse(raw: string): ValidateBrokerResponseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {ok: false, reason: 'broker response is not valid JSON'}
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {ok: false, reason: 'broker response must be a JSON object'}
  }

  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) {
    return {ok: false, reason: 'broker response has zero providers'}
  }

  for (const [providerId, value] of entries) {
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      return {ok: false, reason: `provider id "${providerId}" contains invalid characters`}
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {ok: false, reason: `provider "${providerId}" is not an object`}
    }
    const provider = value as Record<string, unknown>
    if (provider.type !== 'api') {
      return {ok: false, reason: `provider "${providerId}" has an unsupported type`}
    }
    if (typeof provider.key !== 'string' || provider.key.length === 0) {
      return {ok: false, reason: `provider "${providerId}" has an empty or missing key`}
    }
  }

  // Re-serialize the parsed+validated object rather than passing the raw
  // string through, so the emitted payload is exactly the shape that was
  // validated (no incidental whitespace/formatting from the broker).
  return {ok: true, authJson: JSON.stringify(parsed)}
}

/**
 * Orchestrates the mint: OIDC token → mask → single bounded-timeout POST
 * (no retry) → all-or-nothing validation → masked step output.
 *
 * Fails closed: every error branch throws inside the try block, caught by
 * the single catch below. The try/finally guarantees a non-zero exit and
 * that no output is emitted on any failure branch — it is NOT memory
 * zeroing (out of the threat model: the child inherits process.env, not the
 * V8 heap). The OIDC token and minted credential live only in local
 * (function-scope) variables and are never placed in process.env.
 */
export async function main(): Promise<void> {
  let succeeded = false
  try {
    const oidcToken = await core.getIDToken(BROKER_AUDIENCE)
    // Mask IMMEDIATELY — before any HTTP call, log, or thrown error can
    // surface the JWT.
    core.setSecret(oidcToken)

    const brokerUrl = resolveBrokerUrl(process.env)
    let response: Response
    try {
      response = await fetch(`${brokerUrl}/v1/mint`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oidcToken}`,
          'Content-Type': 'application/json',
        },
        // Single attempt, bounded — no retry loop. The OIDC token is
        // single-use per jti; a retry either fails replay protection or
        // risks minting a duplicate credential.
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`broker request failed: ${message}`)
    }

    if (!response.ok) {
      throw new Error(`broker returned HTTP ${response.status}`)
    }

    const raw = await response.text()
    const result = validateBrokerResponse(raw)
    if (!result.ok) {
      throw new Error(`broker response rejected: ${result.reason}`)
    }

    core.setSecret(result.authJson)
    core.setOutput('auth-json', result.authJson)
    succeeded = true
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[mint-broker-credential] ${message}\n`)
  } finally {
    if (!succeeded) {
      process.exitCode = 1
    }
  }
}

// Only run when executed directly (node --experimental-strip-types ...), not
// when imported by the test file under Vitest.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
