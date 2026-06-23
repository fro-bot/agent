#!/usr/bin/env node

// Scrub hidden Unicode characters from dist/ files, replacing each with its
// \uXXXX escape. Run via: node --experimental-strip-types scripts/escape-dist-hidden-unicode.ts
//
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. The test file uses .js imports for Vitest.

import process from 'node:process'
import {escapeDistHiddenUnicode} from './dist-hidden-unicode.ts'

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'dist'
  const results = await escapeDistHiddenUnicode(dir)

  if (results.length === 0) {
    console.log(`[dist:escape-hidden-unicode] ${dir}/ is clean — no hidden Unicode found`)
    return
  }

  for (const {file, replacements} of results) {
    console.log(`[dist:escape-hidden-unicode] scrubbed ${replacements} char(s) in ${file}`)
  }

  console.log(`[dist:escape-hidden-unicode] done — ${results.length} file(s) modified`)
}

try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[dist:escape-hidden-unicode] error: ${message}\n`)
  process.exitCode = 1
}
