#!/usr/bin/env node

// Mints a short-lived, single-repo, contents:write-only GitHub App
// installation token for the harness-integrate merge agent.
//
// Security contract (docs/plans/2026-07-11-002-feat-inline-app-token-mint-integrate-plan.md),
// mirroring scripts/harness/mint-broker-credential.ts:
//   1. Read the App private key from process.env and IMMEDIATELY mask it via
//      core.setSecret, before any parsing, HTTP call, error log, or stack
//      trace can surface it.
//   2. Build the App JWT locally (node:crypto, no dependencies) and use it
//      for a SINGLE bounded GET + SINGLE bounded POST under one shared
//      timeout — no retry loop.
//   3. Validate the minted token response ALL-OR-NOTHING: token, expires_at,
//      exact permissions echo, and exact single-repo echo must all hold or
//      the entire mint is rejected. GitHub adds the implied `metadata: read`
//      grant to every installation access token — it is not requestable or
//      declinable — so the echo is pinned to exactly the requested grant
//      plus that implied read; any other extra, missing, or different grant
//      still rejects.
//   4. Emit the minted token as a masked GitHub Actions step output — never
//      write it to disk, never place it (or the private key) in
//      process.env, GITHUB_ENV, or logs.
//   5. Fail closed: any error exits non-zero and emits nothing usable. Error
//      messages are constant-class only — never interpolate caught error
//      text, PEM content, or response bodies (they could carry the key or
//      token along for the ride).
//
// Run via: node --experimental-strip-types scripts/harness/mint-app-token.ts
//
// This file uses no sibling .ts imports. main() is exported (not called at
// module top level) and only invoked by the guard at the bottom of this
// file, which fires solely when the script is executed directly — mirrors
// mint-broker-credential.ts and packages/harness/scripts/build-platform.ts.
// This keeps the module import-safe for the test file (imported under
// Vitest, .js extension), while `node --experimental-strip-types` execution
// still runs main().

import {Buffer} from 'node:buffer'
import {createSign} from 'node:crypto'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import * as core from '@actions/core'

const OWNER = 'fro-bot'
const REPO = 'agent'
const MINT_TIMEOUT_MS = 30_000
const JWT_BACKDATE_SECONDS = 60
const JWT_LIFETIME_SECONDS = 540
const REQUESTED_PERMISSIONS: Readonly<Record<string, string>> = {contents: 'write'}
// GitHub always adds the implied `metadata: read` grant to every installation
// access token — it is not requestable or declinable in the request body, but
// it is always present in the response echo. The validator pins the echo to
// exactly the requested grant plus that implied read; any other extra,
// missing, or different grant still rejects.
const EXPECTED_PERMISSIONS_ECHO: Readonly<Record<string, string>> = {contents: 'write', metadata: 'read'}

function base64url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * Build and sign an RS256 App JWT. Pure — no I/O. Throws a generic Error on
 * any signing failure; the caller wraps it in a constant-class message
 * (never interpolating the caught error, which could echo PEM content).
 */
export function buildAppJwt(appId: string, privateKey: string, nowSeconds: number): string {
  const header = {alg: 'RS256', typ: 'JWT'}
  const payload = {
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey)
  return `${signingInput}.${base64url(signature)}`
}

export type ValidateTokenResponseResult =
  {readonly ok: true; readonly token: string} | {readonly ok: false; readonly reason: string}

/**
 * Validate the installation access-token response ALL-OR-NOTHING. Pure — no
 * I/O, never throws; every branch returns a discriminated result. Mirrors
 * validateBrokerResponse in mint-broker-credential.ts.
 */
export function validateTokenResponse(parsed: unknown): ValidateTokenResponseResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {ok: false, reason: 'token response is not an object'}
  }
  const body = parsed as Record<string, unknown>

  if (typeof body.token !== 'string' || body.token.length === 0) {
    return {ok: false, reason: 'token response has an empty or missing token'}
  }
  if (typeof body.expires_at !== 'string' || body.expires_at.length === 0) {
    return {ok: false, reason: 'token response has an empty or missing expires_at'}
  }

  const permissions = body.permissions
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return {ok: false, reason: 'token response permissions is not an object'}
  }
  const permissionEntries = Object.entries(permissions as Record<string, unknown>)
  const expectedEntries = Object.entries(EXPECTED_PERMISSIONS_ECHO)
  if (permissionEntries.length !== expectedEntries.length) {
    return {ok: false, reason: 'token response permissions do not match the requested scope exactly'}
  }
  for (const [key, value] of expectedEntries) {
    if ((permissions as Record<string, unknown>)[key] !== value) {
      return {ok: false, reason: 'token response permissions do not match the requested scope exactly'}
    }
  }

  const repositories = body.repositories
  if (!Array.isArray(repositories) || repositories.length !== 1) {
    return {ok: false, reason: 'token response repositories does not name exactly one repository'}
  }
  const repository: unknown = repositories[0]
  if (typeof repository !== 'object' || repository === null || (repository as Record<string, unknown>).name !== REPO) {
    return {ok: false, reason: 'token response repository echo does not match the requested repository'}
  }

  return {ok: true, token: body.token}
}

/**
 * Orchestrates the mint: read + mask key → build App JWT → single bounded
 * installation lookup → single bounded token mint (no retry) →
 * all-or-nothing validation → masked step output.
 *
 * Fails closed: every error branch throws inside the try block, caught by
 * the single catch below. The try/finally guarantees a non-zero exit and
 * that no output is emitted on any failure branch.
 */
export async function main(): Promise<void> {
  let succeeded = false
  try {
    const appId = process.env.APPLICATION_ID?.trim() ?? ''
    const privateKey = process.env.APPLICATION_PRIVATE_KEY ?? ''
    // Mask the key IMMEDIATELY — before any parsing, HTTP call, log, or
    // thrown error can surface it.
    if (privateKey.length > 0) {
      core.setSecret(privateKey)
    }
    if (appId.length === 0 || privateKey.trim().length === 0) {
      throw new Error('missing-app-credentials')
    }

    let jwt: string
    try {
      jwt = buildAppJwt(appId, privateKey, Math.floor(Date.now() / 1000))
    } catch {
      throw new Error('app-jwt-build-failed')
    }

    // One AbortSignal bounds BOTH requests. A signal passed to fetch also
    // aborts an in-progress response body read, so every response.json()
    // below is covered by the same timeout — a slow/hung body cannot
    // exceed the bound.
    const signal = AbortSignal.timeout(MINT_TIMEOUT_MS)

    let installationResponse: Response
    try {
      installationResponse = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/installation`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      })
    } catch {
      throw new Error('installation-lookup-failed')
    }
    if (!installationResponse.ok) {
      throw new Error(`installation-lookup-failed: HTTP ${installationResponse.status}`)
    }
    let installationBody: unknown
    try {
      installationBody = await installationResponse.json()
    } catch {
      throw new Error('installation-lookup-failed')
    }
    const installationId =
      typeof installationBody === 'object' && installationBody !== null
        ? (installationBody as Record<string, unknown>).id
        : undefined
    if (typeof installationId !== 'number') {
      throw new TypeError('installation-lookup-failed')
    }

    let tokenResponse: Response
    try {
      tokenResponse = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({repositories: [REPO], permissions: REQUESTED_PERMISSIONS}),
        // Single attempt — no retry loop.
        signal,
      })
    } catch {
      throw new Error('token-mint-failed')
    }
    if (tokenResponse.status !== 201) {
      throw new Error('token-mint-failed')
    }
    let tokenBody: unknown
    try {
      tokenBody = await tokenResponse.json()
    } catch {
      throw new Error('token-mint-failed')
    }

    const result = validateTokenResponse(tokenBody)
    if (!result.ok) {
      throw new Error('token-mint-failed')
    }

    // Mask BEFORE any other statement touches the token.
    core.setSecret(result.token)
    core.setOutput('github-token', result.token)
    succeeded = true
  } catch (error: unknown) {
    // Constant-class messages only — never interpolate the caught error,
    // response bodies, or key material. `error.message` here is always one
    // of the constant strings thrown above (or an HTTP-status suffix with
    // no body content), never a raw caught exception.
    const message = error instanceof Error ? error.message : 'mint-app-token-failed'
    process.stderr.write(`[mint-app-token] ${message}\n`)
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
