/**
 * Production MetadataReader over the gateway's GitHub App client Contents API.
 *
 * Fetches `metadata/repos.yaml` from `fro-bot/.github` on the `data` branch
 * using the gateway App client's authenticated Octokit instance.
 *
 * Signals 404 / not-found via `makeNotFoundError()` so `readRepoDenylist` maps
 * it to `MetadataUnavailableError` (fail closed on cold start).
 *
 * Injectable: tests inject a fake MetadataReader instead of calling this.
 * This module is the production wiring only.
 */

import type {AppClient} from '../github/app-client.js'
import type {MetadataReader} from './metadata-reader.js'

import {Buffer} from 'node:buffer'

import {isOctokitNotFound} from '../github/errors.js'
import {makeNotFoundError} from './metadata-reader.js'

// ---------------------------------------------------------------------------
// Constants (mirror dashboard DATA_REF / METADATA_PATH)
// ---------------------------------------------------------------------------

/** The GitHub org that owns the `.github` config repo. */
const METADATA_OWNER = 'fro-bot'

/** The repo that holds `metadata/repos.yaml`. */
const METADATA_REPO = '.github'

/** The git ref (branch) where the metadata lives. */
const METADATA_REF = 'data'

/**
 * Timeout for GitHub Contents API requests (FIX 3).
 *
 * A hanging Octokit call combined with inflight-refresh deduplication would
 * stall the cache indefinitely (stale → deny-all until restart). This timeout
 * bounds the hang to 10s; on timeout the transport-error sentinel is returned
 * and the cache handles it via the grace window.
 */
export const METADATA_REQUEST_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a production MetadataReader backed by the gateway App client.
 *
 * The reader authenticates as the App installation for `fro-bot/.github` and
 * fetches the requested file via the GitHub Contents API.
 *
 * @param appClient - The gateway App client (injectable for tests).
 * @returns A MetadataReader that fetches file content from GitHub.
 */
export function createAppClientMetadataReader(appClient: AppClient): MetadataReader {
  return async function appClientMetadataReader(path: string, ref: string): Promise<string> {
    // Authenticate as the App installation for fro-bot/.github
    const authResult = await appClient.authForRepo(METADATA_OWNER, METADATA_REPO)

    if (authResult.success === false) {
      // Auth failure — signal as a transport error (not not-found)
      throw new Error(`Failed to authenticate for ${METADATA_OWNER}/${METADATA_REPO}: ${authResult.error.message}`)
    }

    const {octokit} = authResult.data

    // Fetch the file via the Contents API with a timeout (FIX 3).
    // A hanging request combined with inflight-refresh deduplication would stall the cache
    // indefinitely. AbortSignal.timeout() bounds the hang; on timeout the error propagates
    // as a transport error and the cache handles it via the grace window.
    let response: {data: unknown}
    try {
      response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: METADATA_OWNER,
        repo: METADATA_REPO,
        path,
        ref: ref === METADATA_REF ? METADATA_REF : ref,
        request: {signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS)},
      })
    } catch (fetchError) {
      // Map 404 to the not-found sentinel so readRepoDenylist maps it to MetadataUnavailableError
      if (isOctokitNotFound(fetchError)) {
        throw makeNotFoundError(`${path} not found on ref=${ref} in ${METADATA_OWNER}/${METADATA_REPO}`)
      }
      // Re-throw other errors as-is (transport errors, including timeout AbortError)
      throw fetchError
    }

    // Decode the base64-encoded file content from the Contents API response
    const data = response.data
    if (
      data === null ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      (data as Record<string, unknown>).type !== 'file'
    ) {
      throw new Error(`Unexpected Contents API response shape for ${path} (expected a file object)`)
    }

    const content = (data as Record<string, unknown>).content
    const encoding = (data as Record<string, unknown>).encoding

    if (typeof content !== 'string' || encoding !== 'base64') {
      throw new Error(`Unexpected Contents API encoding for ${path} (expected base64)`)
    }

    // GitHub's Contents API returns base64 with newlines — strip them before decoding
    return Buffer.from(content.replaceAll('\n', ''), 'base64').toString('utf8')
  }
}

// ---------------------------------------------------------------------------
// Re-export the ref constant for callers that need it
// ---------------------------------------------------------------------------

export {METADATA_OWNER, METADATA_REF, METADATA_REPO}
