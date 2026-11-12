import type {ExecAdapter} from '../../services/setup/types.js'
import type {Logger} from '../../shared/logger.js'

import {TextDecoder, TextEncoder} from 'node:util'
import {toErrorMessage} from '../../shared/errors.js'
import {runTrustedGit} from './trusted-git.js'

export const MAX_COMMIT_SUBJECT_LENGTH = 72
export const MAX_COMMIT_BODY_BYTES = 4096
/** Bound on each optional message-lookup git call; the lookup is a nicety and must never eat finalize's budget. */
export const COMMIT_MESSAGE_LOOKUP_TIMEOUT_MS = 5_000
/** Sanitizing is monotonic (every pass only removes or shortens); this cap just guarantees termination. */
const MAX_SANITIZE_PASSES = 10

const SHA1_PATTERN = /^[0-9a-f]{40}$/i

/** Tokens GitHub (and common CI setups) honor to skip workflow runs on a push. */
const SKIP_WORKFLOW_TOKEN =
  /\[[ \t]*(?:skip[ \t]+ci|ci[ \t]+skip|no[ \t]+ci|skip[ \t]+actions|actions[ \t]+skip)[ \t]*\]|\*{3}NO_CI\*{3}/gi
/** A `Key: value` line as `git interpret-trailers` reads it (the colon must be followed by whitespace or end). */
const TRAILER_LINE = /^[A-Z0-9][A-Z0-9-]*[ \t]*:(?:[ \t]|$)/i
const TRAILER_CONTINUATION_LINE = /^[ \t]+\S/
/** Format characters (zero-width, BOM, bidi marks) are invisible; whitespace is anything `\s` or the Zs category covers. */
const FORMAT_CHARACTER = /^\p{Cf}$/u
const UNICODE_WHITESPACE = /^\s$/u
/** Attribution/skip trailers are stripped wherever they appear, so prose cannot be used to smuggle one past the block rule. */
const ATTRIBUTION_TRAILER_LINE =
  /^[ \t]*(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|skip-checks|cc)[ \t]*:/i

/**
 * Sanitize a model-authored commit message for the bot-authored brokered-push commit.
 *
 * Returns `null` when nothing usable remains (the subject is empty), so the caller falls back to its
 * generic message. The message is the same trust class as the file contents the broker already
 * delivers, but it must never be able to attribute co-authorship or silence the PR's CI.
 *
 * The pipeline reruns on its own output until it stops changing: trimming, collapsing and truncation
 * can each expose content the earlier filters could not see (for example a trailer that only becomes
 * a trailer once its prefix is gone, or a body cut that leaves a trailing `Key:` paragraph). The
 * result is therefore a fixed point — sanitizing it again returns it unchanged.
 */
export function sanitizeCommitMessage(raw: string): string | null {
  let current = raw
  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass += 1) {
    const next = sanitizePass(current)
    if (next == null) {
      return null
    }
    if (next === current) {
      return current
    }
    current = next
  }

  return null
}

function sanitizePass(raw: string): string | null {
  const normalized = normalizeCharacters(raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n'))
  // The subject is the first non-blank line of the message as written. Tokens never span lines, so stripping
  // them keeps the line structure and cannot promote a body line into an emptied subject.
  const subjectIndex = normalized.split('\n').findIndex(line => line.trim() !== '')
  if (subjectIndex === -1) {
    return null
  }
  const lines = stripSkipWorkflowTokens(normalized)
    .split('\n')
    .map(line => line.trimEnd())

  const subject = capSubject((lines[subjectIndex] ?? '').trim().replaceAll(/ {2,}/g, ' '))
  if (subject === '' || ATTRIBUTION_TRAILER_LINE.test(subject)) {
    return null
  }

  const body = sanitizeBody(lines.slice(subjectIndex + 1))
  return body === '' ? subject : `${subject}\n\n${body}`
}

/**
 * Resolve the commit message for a brokered push: the sanitized tip-commit message when the agent
 * committed locally (`trustedHeadSha..HEAD` is non-empty), otherwise `fallback`.
 *
 * Never throws and never shells a string the agent controls: every git call is argv-form, and the
 * only value taken from git output (the tip commit id) is validated as a full object id first.
 */
export async function resolveBrokeredPushCommitMessage(
  execAdapter: ExecAdapter,
  trustedHeadSha: string,
  repoRoot: string,
  logger: Logger,
  fallback: string,
): Promise<string> {
  if (SHA1_PATTERN.test(trustedHeadSha) === false) {
    return fallback
  }

  try {
    const revList = await runGit(
      execAdapter,
      ['rev-list', '--max-count=1', '--topo-order', `${trustedHeadSha}..HEAD`, '--'],
      repoRoot,
    )
    if (revList.kind === 'timed-out' || revList.kind === 'unavailable') {
      return warnLookupBounded(logger, revList.kind, fallback)
    }
    if (revList.exitCode !== 0) {
      logger.debug('Brokered push commit message lookup failed; using the generic message', {
        error: revList.stderr.trim(),
      })
      return fallback
    }

    const tipSha = revList.stdout.trim()
    if (tipSha === '') {
      return fallback
    }
    if (SHA1_PATTERN.test(tipSha) === false) {
      logger.debug('Brokered push commit message lookup returned an unexpected id; using the generic message')
      return fallback
    }

    // Signature display is forced off both ways: a repo-local `log.showSignature=true` would otherwise run
    // the configured verifier (which can hang) and prepend its output to the message.
    const log = await runGit(execAdapter, ['log', '-1', '--no-show-signature', '--format=%B', tipSha], repoRoot)
    if (log.kind === 'timed-out' || log.kind === 'unavailable') {
      return warnLookupBounded(logger, log.kind, fallback)
    }
    if (log.exitCode !== 0) {
      logger.debug('Brokered push commit message read failed; using the generic message', {error: log.stderr.trim()})
      return fallback
    }

    const message = sanitizeCommitMessage(log.stdout)
    if (message == null) {
      logger.debug('Tip commit message has no usable subject after sanitizing; using the generic message')
      return fallback
    }

    return message
  } catch (error) {
    logger.debug('Brokered push commit message lookup threw; using the generic message', {error: toErrorMessage(error)})
    return fallback
  }
}

type GitRun = Awaited<ReturnType<typeof runTrustedGit>>

/**
 * Run one argv-form git call under `COMMIT_MESSAGE_LOOKUP_TIMEOUT_MS`, through the trusted wrapper. The adapter's
 * `execWithTimeout` kills the child's whole process group on expiry; without it there is no bound, so the lookup is
 * skipped.
 */
async function runGit(execAdapter: ExecAdapter, args: readonly string[], repoRoot: string): Promise<GitRun> {
  return runTrustedGit(execAdapter, ['-c', 'log.showSignature=false', ...args], repoRoot, {
    timeoutMs: COMMIT_MESSAGE_LOOKUP_TIMEOUT_MS,
    requireTimeout: true,
  })
}

function warnLookupBounded(logger: Logger, kind: 'timed-out' | 'unavailable', fallback: string): string {
  logger.warning(
    kind === 'timed-out'
      ? 'Brokered push commit message lookup timed out; using the generic message'
      : 'Brokered push commit message lookup has no timeout-capable exec adapter; using the generic message',
    {timeoutMs: COMMIT_MESSAGE_LOOKUP_TIMEOUT_MS},
  )
  return fallback
}

/**
 * Drop control characters (except `\n`), drop format characters (`\p{Cf}`: zero-width space/joiners, BOM,
 * bidi marks), and map every other Unicode whitespace character to an ASCII space. This runs before any
 * matching so no later `trim()` can reveal a trailer hidden behind a character the matchers treat as text.
 */
function normalizeCharacters(value: string): string {
  let result = ''
  for (const character of value) {
    if (character === '\n') {
      result += character
      continue
    }
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || FORMAT_CHARACTER.test(character)) {
      continue
    }
    result += UNICODE_WHITESPACE.test(character) ? ' ' : character
  }

  return result
}

function stripSkipWorkflowTokens(value: string): string {
  // Loop to a fixed point: removing one token can splice the halves of another back together.
  let current = value
  for (;;) {
    const next = current.replaceAll(SKIP_WORKFLOW_TOKEN, '')
    if (next === current) {
      return current
    }
    current = next
  }
}

function capSubject(subject: string): string {
  return [...subject].slice(0, MAX_COMMIT_SUBJECT_LENGTH).join('').trimEnd()
}

function sanitizeBody(bodyLines: readonly string[]): string {
  const withoutAttribution: string[] = []
  let insideAttribution = false
  for (const line of bodyLines) {
    if (ATTRIBUTION_TRAILER_LINE.test(line)) {
      insideAttribution = true
      continue
    }
    if (insideAttribution && TRAILER_CONTINUATION_LINE.test(line)) {
      continue
    }
    insideAttribution = false
    withoutAttribution.push(line)
  }

  const remaining = stripTrailingTrailerBlocks(withoutAttribution)
  const collapsed = remaining
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()

  return capBodyBytes(collapsed)
}

/** Drop trailing paragraphs that are entirely trailers (`git interpret-trailers --parse` block semantics). */
function stripTrailingTrailerBlocks(lines: readonly string[]): string[] {
  let current = [...lines]
  for (;;) {
    while (current.length > 0 && (current.at(-1) ?? '').trim() === '') {
      current.pop()
    }

    let start = current.length
    while (start > 0 && (current[start - 1] ?? '').trim() !== '') {
      start -= 1
    }

    const paragraph = current.slice(start)
    if (paragraph.length === 0 || isTrailerBlock(paragraph) === false) {
      return current
    }

    current = current.slice(0, start)
  }
}

function isTrailerBlock(paragraph: readonly string[]): boolean {
  return paragraph.every((line, index) =>
    index === 0 ? TRAILER_LINE.test(line) : TRAILER_LINE.test(line) || TRAILER_CONTINUATION_LINE.test(line),
  )
}

function capBodyBytes(body: string): string {
  const bytes = new TextEncoder().encode(body)
  if (bytes.length <= MAX_COMMIT_BODY_BYTES) {
    return body
  }

  // Decoding a prefix that ends mid-character yields U+FFFD; drop it rather than ship a broken character.
  const decoded = new TextDecoder('utf-8').decode(bytes.slice(0, MAX_COMMIT_BODY_BYTES))
  return decoded.replaceAll(/\uFFFD+$/g, '').trimEnd()
}
