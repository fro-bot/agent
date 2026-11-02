#!/usr/bin/env node

// Keeps the `effect` devDependency of packages/opencode-plugin equal to the exact `effect` version that the installed
// `@opencode/plugin` pins. Renovate bumps `@opencode/plugin` and runs this as `bun run postupgrade` on the update branch
// (.github/renovate.json5, the `@opencode/plugin` rule). It also runs by hand:
//
//   bun scripts/sync-opencode-plugin-effect.ts
//
// Why: `@opencode/plugin` depends on `effect` at an exact version, and the package imports `Schema` from `effect`
// directly. If the two versions differ, bun installs two copies of effect v4 and `tsc` reports "Two different types with
// this name exist" wherever a plugin type meets ours. Only the `devDependencies.effect` entry is rewritten, in place,
// so key order and formatting survive. The `effect` peerDependency range is left alone.
//
// It does nothing when the versions already match, so the shared `postupgrade` script stays harmless on every other
// bump. It exits 1 when the installed manifest is missing or pins `effect` as anything but an exact x.y.z version.
//
// No dependencies, and no runtime-specific API: it runs under bun (the Renovate runner) and under Node 24, which strips types.

import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const PLUGIN_PACKAGE_DIR = fileURLToPath(new URL('../packages/opencode-plugin', import.meta.url))
const SEMVER = /^\d+\.\d+\.\d+$/
const MANIFEST_NAME = '@opencode/plugin'

/**
 * The `effect` version the `@opencode/plugin` manifest pins. Throws unless it is an exact x.y.z version: a range would
 * let the two copies drift apart again.
 */
export function readPinnedEffect(manifest: unknown): string {
  const record = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : {}
  const dependencies =
    typeof record.dependencies === 'object' && record.dependencies !== null ? record.dependencies : {}
  const effect = (dependencies as Record<string, unknown>).effect
  if (typeof effect !== 'string') {
    throw new TypeError(`${MANIFEST_NAME} does not list \`effect\` in its dependencies`)
  }
  if (!SEMVER.test(effect)) {
    throw new Error(`${MANIFEST_NAME} pins \`effect\` as "${effect}", not an exact x.y.z version`)
  }
  return effect
}

const DEV_DEPENDENCIES_BLOCK = /("devDependencies"\s*:\s*\{)([^}]*)(\})/
const DEV_EFFECT = /("effect"\s*:\s*")([^"]*)(")/

/** The `devDependencies.effect` value in a package.json text, or undefined when it is not listed. */
export function readDevEffect(packageJsonText: string): string | undefined {
  const block = DEV_DEPENDENCIES_BLOCK.exec(packageJsonText)?.[2]
  return block === undefined ? undefined : DEV_EFFECT.exec(block)?.[2]
}

/** The package.json text with only `devDependencies.effect` changed. Throws when the entry does not exist. */
export function rewriteDevEffect(packageJsonText: string, version: string): string {
  if (readDevEffect(packageJsonText) === undefined) {
    throw new Error('packages/opencode-plugin/package.json has no `devDependencies.effect` to sync')
  }
  return packageJsonText.replace(
    DEV_DEPENDENCIES_BLOCK,
    (_match, open: string, body: string, close: string) =>
      `${open}${body.replace(DEV_EFFECT, (_inner, pre: string, _old: string, post: string) => `${pre}${version}${post}`)}${close}`,
  )
}

/**
 * The path of the `@opencode/plugin` manifest the package actually resolves: the nearest `node_modules/@opencode/plugin`
 * walking up from the package directory, which is Node's own lookup order. (`require.resolve` cannot be used: the
 * package's `exports` map hides package.json and has no CJS entry.)
 */
export function findInstalledManifest(startDir: string, exists: (file: string) => boolean): string | undefined {
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '@opencode', 'plugin', 'package.json')
    if (exists(candidate)) return candidate
    if (path.dirname(dir) === dir) return undefined
  }
}

/** The I/O the CLI performs, injected so it can be tested without the real workspace. */
export interface SyncIo {
  readonly packageDir: string
  readonly exists: (file: string) => boolean
  readonly readFile: (file: string) => string
  readonly writeFile: (file: string, contents: string) => void
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const defaultIo: SyncIo = {
  packageDir: PLUGIN_PACKAGE_DIR,
  exists: file => existsSync(file),
  readFile: file => readFileSync(file, 'utf8'),
  writeFile: (file, contents) => writeFileSync(file, contents),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

const USAGE = 'usage: bun scripts/sync-opencode-plugin-effect.ts'

/** The exit code for a rejected command line (distinct from 1, a failed sync). */
export const EXIT_USAGE = 2

/** Run the CLI and return its exit code: 0 when in step (or after rewriting), 1 on a failed sync, 2 on any argument. */
export function main(argv: readonly string[], io: SyncIo = defaultIo): number {
  if (argv.length > 0) {
    io.stderr(`sync-opencode-plugin-effect: takes no arguments, got: ${argv.join(' ')}\n${USAGE}\n`)
    return EXIT_USAGE
  }
  try {
    const manifestPath = findInstalledManifest(io.packageDir, io.exists)
    if (manifestPath === undefined) {
      throw new Error(`${MANIFEST_NAME} is not installed for ${io.packageDir}: run \`bun install\` first`)
    }
    const pinned = readPinnedEffect(JSON.parse(io.readFile(manifestPath)))

    const packageJsonPath = path.join(io.packageDir, 'package.json')
    const current = io.readFile(packageJsonPath)
    if (readDevEffect(current) === pinned) {
      io.stdout(`packages/opencode-plugin effect is already ${pinned}\n`)
      return 0
    }
    io.writeFile(packageJsonPath, rewriteDevEffect(current, pinned))
    io.stdout(`set packages/opencode-plugin effect to ${pinned} (pinned by ${MANIFEST_NAME})\n`)
    return 0
  } catch (error) {
    io.stderr(`sync-opencode-plugin-effect: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
