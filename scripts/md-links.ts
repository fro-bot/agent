// Shared logic for checking relative markdown links resolve to real files.
//
// Extracts inline `[text](target)` and `![alt](target)` links from tracked
// markdown files, skips fenced code blocks and inline code spans (both are
// full of illustrative link syntax and regex fragments that must never be
// flagged), skips external/anchor-only targets, and verifies every remaining
// relative target resolves to a file or directory that actually exists.
//
// Run via: node --experimental-strip-types scripts/check-md-links.ts
// (or import checkMarkdownLinks from other scripts/tests)
//
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. The test file uses .js imports for Vitest.

import {readFile as fsReadFile, stat as fsStat} from 'node:fs/promises'
import {posix} from 'node:path'

export interface LinkViolation {
  readonly file: string
  readonly line: number
  readonly target: string
  readonly resolved: string
}

export interface MarkdownLinkReport {
  readonly filesScanned: number
  readonly linksChecked: number
  readonly violations: readonly LinkViolation[]
}

export type ReadFileFn = (path: string) => Promise<string>
export type ExistsFn = (path: string) => Promise<boolean>

const defaultReadFile: ReadFileFn = async path => fsReadFile(path, 'utf8')

const defaultExists: ExistsFn = async path => {
  try {
    await fsStat(path)
    return true
  } catch {
    return false
  }
}

// Matches a fenced-code-block delimiter line: ``` or ~~~ (3+ chars), with
// optional leading indentation and trailing language info (ignored here).
const FENCE_RE = /^\s*(`{3,}|~{3,})/

// Matches a backtick-delimited inline code span, honoring the CommonMark rule
// that the closing delimiter must be the same length as the opening one.
const CODE_SPAN_RE = /(`+)(?:(?!\1)[\s\S])*?\1/g

// Matches inline links and image links: [text](target) / ![alt](target).
// The captured group may include a trailing ` "title"` which callers strip.
const LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g

interface ExtractedLink {
  readonly line: number
  readonly target: string
}

/** Replaces inline code spans with equal-length blanks so link syntax inside them is never matched. */
function maskInlineCode(line: string): string {
  CODE_SPAN_RE.lastIndex = 0
  return line.replace(CODE_SPAN_RE, match => ' '.repeat(match.length))
}

/** Extracts every candidate link target from markdown content, skipping fenced code blocks. */
function extractLinks(content: string): readonly ExtractedLink[] {
  const links: ExtractedLink[] = []
  const lines = content.split('\n')

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1]
      const char = marker[0] ?? ''
      const len = marker.length

      if (inFence) {
        if (char === fenceChar && len >= fenceLen) {
          inFence = false
        }
      } else {
        inFence = true
        fenceChar = char
        fenceLen = len
      }
      continue
    }

    if (inFence) continue

    const masked = maskInlineCode(line)
    LINK_RE.lastIndex = 0
    let match: RegExpExecArray | null = LINK_RE.exec(masked)
    while (match !== null) {
      const rawTarget = match[1] ?? ''
      const target = rawTarget.trim().split(/\s+/)[0] ?? ''
      if (target.length > 0) {
        links.push({line: index + 1, target})
      }
      match = LINK_RE.exec(masked)
    }
  }

  return links
}

/** True when a target is external (protocol-prefixed), anchor-only, or a data URI — never fs-checked. */
function isSkippedTarget(target: string): boolean {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('#') ||
    target.startsWith('data:') ||
    target.includes('://')
  )
}

/** Strips a trailing `#anchor` suffix; anchor validity is out of scope. */
function stripAnchor(target: string): string {
  const index = target.indexOf('#')
  return index === -1 ? target : target.slice(0, index)
}

/** URL-decodes a target (e.g. `%20` -> space); falls back to the raw string on malformed encoding. */
function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/**
 * Resolves a link target relative to its containing file's directory.
 * A leading `/` resolves from the repo root. Returns the normalized
 * repo-relative path and whether it escapes the repo root entirely.
 */
function resolveTarget(fileDir: string, target: string): {readonly resolved: string; readonly escapesRoot: boolean} {
  const base = target.startsWith('/') ? target.slice(1) : posix.join(fileDir, target)
  const resolved = posix.normalize(base)
  const escapesRoot = resolved === '..' || resolved.startsWith('../')
  return {resolved, escapesRoot}
}

/**
 * Checks relative markdown links across `files` (repo-root-relative paths)
 * and returns a full report: files scanned, links checked (after skipping
 * external/anchor-only targets), and every dangling-link violation found.
 */
export async function collectMarkdownLinkReport(
  files: readonly string[],
  readFile: ReadFileFn = defaultReadFile,
  exists: ExistsFn = defaultExists,
): Promise<MarkdownLinkReport> {
  const violations: LinkViolation[] = []
  let linksChecked = 0

  for (const file of files) {
    const content = await readFile(file)
    const links = extractLinks(content)
    const fileDir = posix.dirname(file)

    for (const {line, target} of links) {
      if (isSkippedTarget(target)) continue

      const decoded = decodeTarget(stripAnchor(target))
      const {resolved, escapesRoot} = resolveTarget(fileDir, decoded)

      linksChecked += 1

      if (escapesRoot) {
        violations.push({file, line, target, resolved})
        continue
      }

      const targetExists = await exists(resolved)
      if (!targetExists) {
        violations.push({file, line, target, resolved})
      }
    }
  }

  return {filesScanned: files.length, linksChecked, violations}
}

/**
 * Checks relative markdown links across `files` and returns the violations.
 * Thin wrapper over collectMarkdownLinkReport for callers that only need the
 * violation list (e.g. tests).
 */
export async function checkMarkdownLinks(
  files: readonly string[],
  readFile: ReadFileFn = defaultReadFile,
  exists: ExistsFn = defaultExists,
): Promise<readonly LinkViolation[]> {
  const {violations} = await collectMarkdownLinkReport(files, readFile, exists)
  return violations
}
