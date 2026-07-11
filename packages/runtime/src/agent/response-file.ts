import type {Result} from '../shared/types.js'
import {Buffer} from 'node:buffer'
import * as path from 'node:path'

import {err, ok} from '../shared/types.js'

/**
 * Maximum body size (in bytes, UTF-8 encoded) accepted from a response file.
 * 64 KiB is generous for a comment/review body while bounding memory and
 * downstream API payload size.
 */
export const MAX_BODY_BYTES = 65_536

export type ResponseSurface = 'issue-comment' | 'pr-comment' | 'pr-review'

/**
 * The frontmatter key that carries a PR review verdict. Exported so prompt
 * construction can reference the exact key name instead of hardcoding it,
 * keeping the model-facing instructions and the parser in lockstep.
 */
export const RESPONSE_FILE_VERDICT_KEY = 'verdict' as const

/**
 * The frontmatter key that carries an optional schema version.
 */
export const RESPONSE_FILE_SCHEMA_VERSION_KEY = 'schemaVersion' as const

/**
 * The allowed values for the `verdict` frontmatter key. Exported so prompt
 * construction can interpolate the exact accepted values instead of
 * hardcoding them, keeping the model-facing instructions and the parser in
 * lockstep.
 */
export const RESPONSE_FILE_VERDICTS = ['approve', 'request-changes'] as const

export type ResponseFileVerdict = (typeof RESPONSE_FILE_VERDICTS)[number]

export interface ParsedResponse {
  readonly body: string
  readonly verdict?: ResponseFileVerdict
}

export type ResponseFileErrorReason =
  | 'empty'
  | 'malformed-frontmatter'
  | 'unknown-key'
  | 'verdict-on-non-review'
  | 'missing-verdict-value'
  | 'unknown-verdict'
  | 'body-too-large'

export interface ResponseFileError extends Error {
  readonly code: 'RESPONSE_FILE_ERROR'
  readonly reason: ResponseFileErrorReason
}

export function createResponseFileError(reason: ResponseFileErrorReason, message: string): ResponseFileError {
  return Object.assign(new Error(message), {code: 'RESPONSE_FILE_ERROR' as const, reason})
}

/**
 * Build the run-scoped response-file directory. This directory lives OUTSIDE
 * the checkout (under RUNNER_TEMP) so a compromised/malicious checkout can
 * never plant or tamper with the response file the harness reads back.
 */
export function buildResponseFileDir(parts: {
  readonly runnerTemp: string
  readonly runId: string | number
  readonly runAttempt: string | number
}): string {
  return path.join(parts.runnerTemp, 'fro-bot-response', `${parts.runId}-${parts.runAttempt}`)
}

/**
 * Build the full run+attempt+nonce scoped response-file path. The nonce MUST
 * be generated once by the caller (the action) and shared verbatim between
 * the prompt text (telling the model where to write) and the reader (that
 * later loads the file) — this module never generates or persists a nonce
 * itself, keeping it a pure, side-effect-free path builder.
 */
export function buildResponseFilePath(parts: {
  readonly runnerTemp: string
  readonly runId: string | number
  readonly runAttempt: string | number
  readonly nonce: string
}): string {
  return path.join(buildResponseFileDir(parts), `${parts.nonce}.md`)
}

interface Frontmatter {
  readonly verdict?: string
  readonly schemaVersion?: string
}

const ALLOWED_FRONTMATTER_KEYS = new Set<string>([RESPONSE_FILE_VERDICT_KEY, RESPONSE_FILE_SCHEMA_VERSION_KEY])
const VERDICT_VALUES = new Set<string>(RESPONSE_FILE_VERDICTS)
const FRONTMATTER_DELIMITER = '---'

/**
 * Splits a raw response file into an optional frontmatter block and a body.
 *
 * A leading `---` line is only treated as the start of a frontmatter block
 * when a matching closing `---` line is found. If the file's first line is
 * `---` but no closing fence exists anywhere after it, the leading `---` is
 * NOT frontmatter — it's just the first line of the body (e.g. a response
 * that legitimately opens with a markdown horizontal rule) — and the whole
 * file is treated as body-only. This is a fail-closed choice: we never guess
 * at a malformed frontmatter block, we just fall back to "no frontmatter".
 */
function splitFrontmatter(
  raw: string,
): Result<{readonly frontmatter: string | null; readonly body: string}, ResponseFileError> {
  if (raw.startsWith(FRONTMATTER_DELIMITER) === false) {
    return ok({frontmatter: null, body: raw})
  }

  const afterOpen = raw.slice(FRONTMATTER_DELIMITER.length)
  // The opening delimiter must be followed by a newline (a bare '---' body line
  // with no closing fence is not frontmatter — it's body-only).
  const openNewlineIndex = afterOpen.indexOf('\n')
  if (openNewlineIndex === -1) {
    return ok({frontmatter: null, body: raw})
  }

  const rest = afterOpen.slice(openNewlineIndex + 1)
  const closeDelimiter = `\n${FRONTMATTER_DELIMITER}`
  const closeIndex = rest.indexOf(closeDelimiter)
  if (closeIndex === -1) {
    return ok({frontmatter: null, body: raw})
  }

  const frontmatterBlock = rest.slice(0, closeIndex)
  const afterClose = rest.slice(closeIndex + closeDelimiter.length)
  // Skip trailing whitespace on the closing fence line, then the newline that ends it.
  const bodyStartMatch = /^[ \t]*\n/.exec(afterClose)
  if (bodyStartMatch == null) {
    return err(createResponseFileError('malformed-frontmatter', 'Response file has an unterminated frontmatter block'))
  }

  const body = afterClose.slice(bodyStartMatch[0].length)

  return ok({frontmatter: frontmatterBlock, body})
}

function parseFrontmatterBlock(block: string): Result<Frontmatter, ResponseFileError> {
  const lines = block.split('\n').filter(line => line.trim().length > 0)
  const result: {verdict?: string; schemaVersion?: string} = {}

  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      return err(
        createResponseFileError('malformed-frontmatter', `Frontmatter line is not a simple "key: value" pair: ${line}`),
      )
    }

    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1).trim()

    if (key.length === 0) {
      return err(createResponseFileError('malformed-frontmatter', `Frontmatter line has an empty key: ${line}`))
    }

    if (ALLOWED_FRONTMATTER_KEYS.has(key) === false) {
      return err(createResponseFileError('unknown-key', `Frontmatter key "${key}" is not permitted`))
    }

    if (key === RESPONSE_FILE_VERDICT_KEY) {
      result.verdict = value
    } else if (key === RESPONSE_FILE_SCHEMA_VERSION_KEY) {
      result.schemaVersion = value
    }
  }

  return ok(result)
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function parseResponseFile(
  raw: string,
  options: {readonly surface: ResponseSurface},
): Result<ParsedResponse, ResponseFileError> {
  if (raw.trim().length === 0) {
    return err(createResponseFileError('empty', 'Response file is empty'))
  }

  const split = splitFrontmatter(raw)
  if (split.success === false) {
    return err(split.error)
  }

  const {frontmatter, body} = split.data
  const trimmedBody = body.trim()

  if (trimmedBody.length === 0) {
    return err(createResponseFileError('empty', 'Response file body is empty'))
  }

  if (utf8ByteLength(trimmedBody) > MAX_BODY_BYTES) {
    return err(createResponseFileError('body-too-large', `Response file body exceeds ${MAX_BODY_BYTES} bytes`))
  }

  if (frontmatter == null) {
    return ok({body: trimmedBody})
  }

  const parsedFrontmatter = parseFrontmatterBlock(frontmatter)
  if (parsedFrontmatter.success === false) {
    return err(parsedFrontmatter.error)
  }

  const {verdict} = parsedFrontmatter.data

  if (verdict === undefined) {
    return ok({body: trimmedBody})
  }

  if (options.surface !== 'pr-review') {
    return err(
      createResponseFileError(
        'verdict-on-non-review',
        `"verdict" is only valid for surface "pr-review", got "${options.surface}"`,
      ),
    )
  }

  if (verdict.length === 0) {
    return err(createResponseFileError('missing-verdict-value', 'Frontmatter "verdict" key has no value'))
  }

  if (VERDICT_VALUES.has(verdict) === false) {
    return err(createResponseFileError('unknown-verdict', `Unknown verdict value: "${verdict}"`))
  }

  return ok({body: trimmedBody, verdict: verdict as ResponseFileVerdict})
}
