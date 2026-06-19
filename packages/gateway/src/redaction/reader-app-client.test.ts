/**
 * Tests for the production MetadataReader backed by the gateway App client.
 *
 * All tests inject a fake AppClient — no real GitHub API calls are made.
 * BDD comments: #given / #when / #then.
 */

import type {AppClient, AppClientAuthResult} from '../github/app-client.js'

import {Buffer} from 'node:buffer'

import {describe, expect, it, vi} from 'vitest'

import {MetadataTransportError, MetadataUnavailableError} from './metadata-reader.js'
import {createAppClientMetadataReader, METADATA_REQUEST_TIMEOUT_MS} from './reader-app-client.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a base64-encoded file content string (as GitHub Contents API returns it). */
function encodeBase64(content: string): string {
  // GitHub returns base64 with newlines every 60 chars — simulate that.
  const raw = Buffer.from(content, 'utf8').toString('base64')
  // Insert newlines every 60 chars to match GitHub's format.
  return raw.match(/.{1,60}/g)?.join('\n') ?? raw
}

/** Build a fake Contents API response for a file. */
function makeContentsResponse(content: string): {data: unknown} {
  return {
    data: {
      type: 'file',
      encoding: 'base64',
      content: encodeBase64(content),
    },
  }
}

/** Build a fake Octokit with a controllable request mock. */
function makeFakeOctokit(requestImpl: (...args: unknown[]) => unknown) {
  return {request: vi.fn().mockImplementation(requestImpl)}
}

/** Build a fake AppClient that returns the given octokit on authForRepo. */
function makeFakeAppClient(octokit: {request: ReturnType<typeof vi.fn>}): AppClient {
  const authResult: AppClientAuthResult = {
    octokit: octokit as unknown as AppClientAuthResult['octokit'],
    installationId: 99,
    token: 'fake-token',
  }
  return {
    authForRepo: vi.fn().mockResolvedValue({success: true, data: authResult}),
    getRepoIdentity: vi.fn().mockResolvedValue({success: false, error: new Error('not used')}),
    invalidateCache: vi.fn(),
  }
}

/** Build a fake AppClient that fails authForRepo. */
function makeFakeFailingAppClient(error: Error): AppClient {
  return {
    authForRepo: vi.fn().mockResolvedValue({success: false, error}),
    getRepoIdentity: vi.fn().mockResolvedValue({success: false, error: new Error('not used')}),
    invalidateCache: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('createAppClientMetadataReader — happy path', () => {
  it('returns the decoded UTF-8 content for a valid file response', async () => {
    // #given — a YAML string to be returned by the Contents API
    const yamlContent = 'version: 1\nrepos: []\n'
    const octokit = makeFakeOctokit(async () => Promise.resolve(makeContentsResponse(yamlContent)))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when — read the file
    const result = await reader('metadata/repos.yaml', 'data')

    // #then — decoded content matches the original
    expect(result).toBe(yamlContent)
  })

  it('correctly decodes base64 content with embedded newlines (GitHub format)', async () => {
    // #given — a longer YAML string that will produce multi-line base64
    const yamlContent = [
      'version: 1',
      'repos:',
      '  - owner: "[REDACTED]"',
      '    name: "[REDACTED]"',
      '    private: true',
      '    node_id: "MDEwOlJlcG9zaXRvcnkxODY5MTU0"',
      '    database_id: 1869154',
    ].join('\n')

    const octokit = makeFakeOctokit(async () => Promise.resolve(makeContentsResponse(yamlContent)))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when
    const result = await reader('metadata/repos.yaml', 'data')

    // #then — newlines in base64 are stripped before decoding; content is correct
    expect(result).toBe(yamlContent)
  })

  it('passes the path and ref to the Contents API request', async () => {
    // #given
    const yamlContent = 'version: 1\nrepos: []\n'
    const octokit = makeFakeOctokit(async () => Promise.resolve(makeContentsResponse(yamlContent)))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when
    await reader('metadata/repos.yaml', 'data')

    // #then — the request was called with the correct path and ref
    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/contents/{path}',
      expect.objectContaining({
        path: 'metadata/repos.yaml',
        ref: 'data',
      }),
    )
  })

  it('includes a request signal (timeout) in the Contents API call (FIX 3)', async () => {
    // #given
    const yamlContent = 'version: 1\nrepos: []\n'
    const octokit = makeFakeOctokit(async () => Promise.resolve(makeContentsResponse(yamlContent)))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when
    await reader('metadata/repos.yaml', 'data')

    // #then — the request includes a signal (AbortSignal for timeout)
    const [, requestArgs] = octokit.request.mock.calls[0] as [string, Record<string, unknown>]
    expect(requestArgs).toHaveProperty('request')
    const requestOpts = requestArgs.request as Record<string, unknown>
    expect(requestOpts).toHaveProperty('signal')
    expect(requestOpts.signal).toBeInstanceOf(AbortSignal)
  })
})

// ---------------------------------------------------------------------------
// 404 → not-found sentinel
// ---------------------------------------------------------------------------

describe('createAppClientMetadataReader — 404 → not-found sentinel', () => {
  it('throws a makeNotFoundError when the Contents API returns 404', async () => {
    // #given — Octokit throws a 404 error
    const notFoundError = Object.assign(new Error('Not Found'), {status: 404})
    const octokit = makeFakeOctokit(async () => Promise.reject(notFoundError))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then — throws a not-found sentinel (code === NOT_FOUND_CODE)
    await expect(reader('metadata/repos.yaml', 'data')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('throws a makeNotFoundError when the Contents API returns a "not found" message', async () => {
    // #given — Octokit throws an error with "not found" in the message (no status field)
    const notFoundError = new Error('Resource not found')
    const octokit = makeFakeOctokit(async () => Promise.reject(notFoundError))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then
    await expect(reader('metadata/repos.yaml', 'data')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('maps to MetadataUnavailableError when used with readRepoDenylist (integration)', async () => {
    // #given — reader throws a not-found sentinel
    const notFoundError = Object.assign(new Error('Not Found'), {status: 404})
    const octokit = makeFakeOctokit(async () => Promise.reject(notFoundError))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // Import readRepoDenylist inline to avoid circular dep issues in test
    const {readRepoDenylist} = await import('./metadata-reader.js')

    // #when
    const result = await readRepoDenylist(reader)

    // #then — MetadataUnavailableError (not a throw)
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataUnavailableError)
  })
})

// ---------------------------------------------------------------------------
// Transport error
// ---------------------------------------------------------------------------

describe('createAppClientMetadataReader — transport error', () => {
  it('re-throws non-404 errors as-is (transport errors)', async () => {
    // #given — Octokit throws a generic network error
    const networkError = new Error('ECONNRESET')
    const octokit = makeFakeOctokit(async () => Promise.reject(networkError))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then — re-throws the original error (not a not-found sentinel)
    await expect(reader('metadata/repos.yaml', 'data')).rejects.toThrow('ECONNRESET')
  })

  it('maps to MetadataTransportError when used with readRepoDenylist (integration)', async () => {
    // #given — reader throws a generic error
    const networkError = new Error('ECONNRESET')
    const octokit = makeFakeOctokit(async () => Promise.reject(networkError))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    const {readRepoDenylist} = await import('./metadata-reader.js')

    // #when
    const result = await readRepoDenylist(reader)

    // #then — MetadataTransportError (not a throw)
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataTransportError)
  })

  it('auth failure throws a transport error (not a not-found sentinel)', async () => {
    // #given — authForRepo fails
    const authError = new Error('App not installed')
    const appClient = makeFakeFailingAppClient(authError)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then — throws a transport error (auth failure is not a 404)
    await expect(reader('metadata/repos.yaml', 'data')).rejects.toThrow('Failed to authenticate')
  })
})

// ---------------------------------------------------------------------------
// Timeout path (FIX 3)
// ---------------------------------------------------------------------------

describe('createAppClientMetadataReader — timeout (FIX 3)', () => {
  it('re-throws AbortError when the request times out', async () => {
    // #given — Octokit throws an AbortError (simulating a timeout)
    const abortError = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
    const octokit = makeFakeOctokit(async () => Promise.reject(abortError))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then — AbortError is re-thrown (not mapped to not-found)
    await expect(reader('metadata/repos.yaml', 'data')).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('maps to MetadataTransportError when timeout AbortError reaches readRepoDenylist', async () => {
    // #given — simulated timeout
    const abortError = Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})
    const octokit = makeFakeOctokit(async () => Promise.reject(abortError))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    const {readRepoDenylist} = await import('./metadata-reader.js')

    // #when
    const result = await readRepoDenylist(reader)

    // #then — MetadataTransportError (fail closed; cache handles via grace window)
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error : null).toBeInstanceOf(MetadataTransportError)
  })

  it('mETADATA_REQUEST_TIMEOUT_MS is exported and is a positive number', () => {
    // #given / #when / #then — constant is accessible and sane
    expect(typeof METADATA_REQUEST_TIMEOUT_MS).toBe('number')
    expect(METADATA_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Base64 decode correctness
// ---------------------------------------------------------------------------

describe('createAppClientMetadataReader — base64 decode correctness', () => {
  it('correctly decodes ASCII content', async () => {
    // #given
    const content = 'hello world'
    const octokit = makeFakeOctokit(async () => Promise.resolve(makeContentsResponse(content)))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then
    expect(await reader('any/path', 'data')).toBe(content)
  })

  it('correctly decodes UTF-8 content with non-ASCII characters', async () => {
    // #given — content with Unicode characters
    const content = 'version: 1\n# comment with emoji 🔒\nrepos: []\n'
    const octokit = makeFakeOctokit(async () => Promise.resolve(makeContentsResponse(content)))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then
    expect(await reader('any/path', 'data')).toBe(content)
  })

  it('throws when the response is not a file object', async () => {
    // #given — Contents API returns a directory listing (array)
    const octokit = makeFakeOctokit(async () => Promise.resolve({data: [{type: 'file', name: 'repos.yaml'}]}))
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then — throws (not a file object)
    await expect(reader('metadata/repos.yaml', 'data')).rejects.toThrow('Unexpected Contents API response shape')
  })

  it('throws when the encoding is not base64', async () => {
    // #given — Contents API returns a non-base64 encoding
    const octokit = makeFakeOctokit(async () =>
      Promise.resolve({
        data: {type: 'file', encoding: 'utf-8', content: 'raw content'},
      }),
    )
    const appClient = makeFakeAppClient(octokit)
    const reader = createAppClientMetadataReader(appClient)

    // #when / #then — throws (unexpected encoding)
    await expect(reader('metadata/repos.yaml', 'data')).rejects.toThrow('Unexpected Contents API encoding')
  })
})
