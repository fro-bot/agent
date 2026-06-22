/**
 * Shared utilities for scrubbing and checking hidden Unicode characters in dist/.
 *
 * The regex is a superset of Renovate's hidden-Unicode detector
 * (renovatebot/renovate lib/util/unicode.ts). It covers every codepoint
 * Renovate flags without matching legitimate chars like U+200D (ZWJ used in
 * emoji sequences).
 *
 * Renovate's set: \u00A0 \u00AD \u1680 \u2000-\u200A \u200B \u200C \u200E \u200F
 *                 \u2028 \u2029 \u202A-\u202E \u202F \u205F \u3000 \uFEFF
 *
 * Superset used here: \u00A0 \u00AD \u1680 \u2000-\u200C \u200E \u200F
 *                     \u2028 \u2029 \u202A-\u202F \u205F \u3000 \uFEFF
 *
 * The range \u2000-\u200C covers \u2000-\u200A (Renovate) plus \u200B \u200C.
 * \u200D (ZWJ) is intentionally excluded — it is NOT in Renovate's set and
 * appears legitimately in emoji sequences. \u200E \u200F are listed explicitly.
 * The range \u202A-\u202F covers \u202A-\u202E (Renovate) plus \u202F (narrow
 * no-break space, also in Renovate's explicit list). Every Renovate codepoint
 * is contained in this superset.
 *
 * Two instances are required: a stateless test regex (no /g flag) for the
 * per-file guard, and a /g-flagged replace regex. Stateful /g regexes leak
 * lastIndex across concurrent Promise.all iterations and silently skip matches.
 */

import {readdir, readFile, writeFile} from 'node:fs/promises'
import {extname, join} from 'node:path'

// Stateless test — safe for concurrent use
export const HIDDEN_UNICODE_TEST_RE =
  /[\u00A0\u00AD\u1680\u2000-\u200C\u200E\u200F\u2028\u2029\u202A-\u202F\u205F\u3000\uFEFF]/

// /g-flagged replace — must NOT be shared across concurrent calls (lastIndex is stateful)
export const HIDDEN_UNICODE_REPLACE_RE =
  /[\u00A0\u00AD\u1680\u2000-\u200C\u200E\u200F\u2028\u2029\u202A-\u202F\u205F\u3000\uFEFF]/g

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'br',
  'gif',
  'gz',
  'ico',
  'jpeg',
  'jpg',
  'otf',
  'pdf',
  'png',
  'tar',
  'ttf',
  'woff',
  'woff2',
  'zip',
])

export interface FileViolation {
  readonly file: string
  readonly line: number
  readonly codepoint: string
  readonly char: string
}

export interface ScrubResult {
  readonly file: string
  readonly replacements: number
}

function isBinary(filePath: string): boolean {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function escapeChar(char: string): string {
  const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
  return String.raw`\u${code}`
}

async function collectFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, {recursive: true, withFileTypes: true})
  const results: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = join(entry.parentPath, entry.name)
    if (!isBinary(filePath)) {
      results.push(filePath)
    }
  }
  return results
}

/**
 * Scrub all hidden Unicode characters from files under `dir`, replacing each
 * with its `\uXXXX` escape. Returns the list of files that were modified.
 */
export async function escapeDistHiddenUnicode(dir = 'dist'): Promise<readonly ScrubResult[]> {
  const files = await collectFiles(dir)
  const results: ScrubResult[] = []

  await Promise.all(
    files.map(async filePath => {
      const content = await readFile(filePath, 'utf8')
      if (!HIDDEN_UNICODE_TEST_RE.test(content)) return

      // Create a fresh /g regex per file to avoid lastIndex leakage
      const re = new RegExp(HIDDEN_UNICODE_REPLACE_RE.source, 'g')
      let count = 0
      const fixed = content.replaceAll(re, char => {
        count++
        return escapeChar(char)
      })

      await writeFile(filePath, fixed, 'utf8')
      results.push({file: filePath, replacements: count})
    }),
  )

  return results
}

/**
 * Check all files under `dir` for raw hidden Unicode characters.
 * Returns violations (file + line + codepoint). Empty array means clean.
 */
export async function checkDistHiddenUnicode(dir = 'dist'): Promise<readonly FileViolation[]> {
  const files = await collectFiles(dir)
  const allViolations: FileViolation[] = []

  await Promise.all(
    files.map(async filePath => {
      const content = await readFile(filePath, 'utf8')
      if (!HIDDEN_UNICODE_TEST_RE.test(content)) return

      const lines = content.split('\n')
      const violations: FileViolation[] = []

      for (const [lineIndex, line] of lines.entries()) {
        if (line === undefined) continue

        // Fresh /g regex per line to avoid lastIndex leakage
        const re = new RegExp(HIDDEN_UNICODE_REPLACE_RE.source, 'g')
        let match = re.exec(line)
        while (match !== null) {
          const char = match[0]
          violations.push({
            file: filePath,
            line: lineIndex + 1,
            codepoint: `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
            char,
          })
          match = re.exec(line)
        }
      }

      allViolations.push(...violations)
    }),
  )

  return allViolations
}
