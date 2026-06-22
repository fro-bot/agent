#!/usr/bin/env node

// Check dist/ files for raw hidden Unicode characters. Exits non-zero if any
// are found. Run via: node --experimental-strip-types scripts/check-dist-hidden-unicode.ts
//
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. The test file uses .js imports for Vitest.

import process from 'node:process'
import {checkDistHiddenUnicode} from './dist-hidden-unicode.ts'

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'dist'
  const violations = await checkDistHiddenUnicode(dir)

  if (violations.length === 0) {
    console.log(`[dist:check-hidden-unicode] ${dir}/ is clean — no hidden Unicode found`)
    return
  }

  for (const {file, line, codepoint} of violations) {
    process.stderr.write(`[dist:check-hidden-unicode] FAIL ${file}:${line} — raw ${codepoint}\n`)
  }

  process.stderr.write(
    `[dist:check-hidden-unicode] found ${violations.length} hidden Unicode character(s) in ${dir}/\n`,
  )
  process.stderr.write(`[dist:check-hidden-unicode] run 'pnpm run dist:escape-hidden-unicode' to fix\n`)
  process.exitCode = 1
}

try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[dist:check-hidden-unicode] error: ${message}\n`)
  process.exitCode = 1
}
