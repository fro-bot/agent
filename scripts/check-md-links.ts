#!/usr/bin/env node

// Check tracked markdown files for dangling relative links. Exits non-zero if
// any are found. Run via: node --experimental-strip-types scripts/check-md-links.ts
//
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. The test file uses .js imports for Vitest.

import {execFile} from 'node:child_process'
import process from 'node:process'
import {promisify} from 'node:util'
import {collectMarkdownLinkReport} from './md-links.ts'

const execFileAsync = promisify(execFile)

const EXCLUDED_PREFIXES = ['.slim/', 'node_modules/', 'dist/']

/** Lists tracked markdown files via `git ls-files`, excluding vendored/build dirs. */
async function listTrackedMarkdownFiles(): Promise<readonly string[]> {
  const {stdout} = await execFileAsync('git', ['ls-files', '*.md'])
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(file => !EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix)))
}

async function main(): Promise<void> {
  const files = await listTrackedMarkdownFiles()
  const {filesScanned, linksChecked, violations} = await collectMarkdownLinkReport(files)

  if (violations.length === 0) {
    console.log(`[check-md-links] OK — ${linksChecked} links across ${filesScanned} files`)
    return
  }

  for (const {file, line, target} of violations) {
    process.stderr.write(`FAIL ${file}:${line} -> ${target}\n`)
  }

  process.stderr.write(`[check-md-links] found ${violations.length} dangling link(s)\n`)
  process.exitCode = 1
}

try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[check-md-links] error: ${message}\n`)
  process.exitCode = 1
}
