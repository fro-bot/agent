import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {basename, dirname, join, posix, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

// Vitest 5 no longer walks up the directory tree to find a config, so a package suite only gets the shared root
// `vitest.config.ts` (home isolation, incomplete-run reporter, excludes) when its `test` script says so explicitly.
// The workspace-test Docker stage also has to carry that config and every local module it imports, because that image
// copies only the one app. Both wirings fail silently when they drift (the suite still runs, just unguarded), so this
// guard pins them.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROOT_CONFIG = join(REPO_ROOT, 'vitest.config.ts')
const WORKSPACE_DOCKERFILE = join(REPO_ROOT, 'deploy/workspace.Dockerfile')
const WORKSPACE_TEST_STAGE_START = /^FROM build-deps AS workspace-test\s*$/m
const SETUP_FILE = 'scripts/vitest-home-isolation.setup.ts'

interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly testScript: string
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${path}: expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Expands the root `workspaces` globs (only the `dir/*` form is used here) into package directories. */
function discoverWorkspaceDirs(): readonly string[] {
  const workspaces = readJson(join(REPO_ROOT, 'package.json')).workspaces
  if (!Array.isArray(workspaces) || workspaces.length === 0) throw new Error('root package.json has no workspaces')
  const dirs: string[] = []
  for (const glob of workspaces) {
    if (typeof glob !== 'string' || !glob.endsWith('/*')) {
      throw new Error(`unsupported workspaces glob ${JSON.stringify(glob)}; extend discoverWorkspaceDirs`)
    }
    const parent = join(REPO_ROOT, glob.slice(0, -2))
    for (const entry of readdirSync(parent, {withFileTypes: true})) {
      const dir = join(parent, entry.name)
      if (entry.isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir)
    }
  }
  return dirs
}

/** Workspace packages whose `test` script runs vitest; packages that test some other way are out of scope. */
function discoverVitestPackages(): readonly WorkspacePackage[] {
  const packages: WorkspacePackage[] = []
  for (const dir of discoverWorkspaceDirs()) {
    const manifest = readJson(join(dir, 'package.json'))
    const scripts = manifest.scripts
    const testScript =
      scripts !== null && typeof scripts === 'object' ? (scripts as Record<string, unknown>).test : undefined
    if (typeof testScript === 'string' && /\bvitest\b/.test(testScript)) {
      packages.push({name: String(manifest.name ?? relative(REPO_ROOT, dir)), dir, testScript})
    }
  }
  return packages
}

/** Value of `--flag value` or `--flag=value` in a shell script line, or undefined when the flag is absent. */
function flagValue(script: string, flag: string): string | undefined {
  const tokens = script.split(/\s+/)
  for (const [index, token] of tokens.entries()) {
    if (token === flag) return tokens[index + 1]
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  }
  return undefined
}

describe('package test scripts load the shared root Vitest config', () => {
  const packages = discoverVitestPackages()

  it('discovers the vitest-running workspace packages', () => {
    // #given the root package.json workspaces globs
    // #when packages whose test script runs vitest are collected
    // #then the guard has something to check (a discovery bug must not turn the suite into a no-op)
    expect(packages.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(ROOT_CONFIG)).toBe(true)
  })

  it.each(packages.map(pkg => [pkg.name, pkg] as const))(
    '%s passes --config or --root that resolves to the root vitest.config.ts',
    (_name, pkg) => {
      // #given a workspace package whose test script runs vitest
      const config = flagValue(pkg.testScript, '--config')
      const root = flagValue(pkg.testScript, '--root')

      // #when the flag paths are resolved from the package directory
      const resolvedConfig = config === undefined ? undefined : resolve(pkg.dir, config)
      const resolvedRoot = root === undefined ? undefined : resolve(pkg.dir, root)

      // #then the script reaches the root config: either explicitly, or by rooting vitest at the repo root
      const hasRootConfig =
        config === undefined ? resolvedRoot === resolve(REPO_ROOT) : resolvedConfig === resolve(ROOT_CONFIG)
      expect({
        package: pkg.name,
        testScript: pkg.testScript,
        // Vitest 5 does not search parent directories: the script must pass --config ../../vitest.config.ts (or --root ../..)
        loadsRootConfig: hasRootConfig,
      }).toEqual({package: pkg.name, testScript: pkg.testScript, loadsRootConfig: true})
    },
  )
})

// ---------------------------------------------------------------------------
// Root config: import closure and Docker test stage
// ---------------------------------------------------------------------------

/** Relative specifiers a source file depends on: static imports/re-exports and `new URL('./x', import.meta.url)`. */
function localReferences(source: string): readonly string[] {
  const code = source
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
  const patterns = [
    /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /import\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g,
  ]
  const specifiers = new Set<string>()
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.add(match[1])
    }
  }
  return [...specifiers]
}

/** Maps a specifier to the file it names; `./x.js` resolves to `./x.ts` the way the bundler-style imports do. */
function resolveLocalFile(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) throw new Error(`${relative(REPO_ROOT, fromFile)}: cannot resolve "${specifier}"`)
  return found
}

/** Every repo-relative file the root config needs at load time, following local imports one level at a time. */
function configImportClosure(): readonly string[] {
  const visited = new Set<string>()
  let frontier = [ROOT_CONFIG]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const file of frontier) {
      if (visited.has(file)) continue
      visited.add(file)
      for (const specifier of localReferences(readFileSync(file, 'utf8'))) {
        next.push(resolveLocalFile(file, specifier))
      }
    }
    frontier = next
  }
  return [...visited].map(file => relative(REPO_ROOT, file)).sort()
}

interface CopyInstruction {
  readonly sources: readonly string[]
  readonly dest: string
}

/** `COPY` instructions (continuations joined, `--flags` dropped) in a Dockerfile fragment. */
function parseCopies(fragment: string): readonly CopyInstruction[] {
  const copies: CopyInstruction[] = []
  for (const line of fragment.replaceAll(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const match = /^\s*COPY[ \t]+(\S.*)$/.exec(line)
    if (match?.[1] === undefined) continue
    const args = match[1].split(/\s+/).filter(arg => arg.length > 0 && !arg.startsWith('--'))
    const dest = args.pop()
    if (dest !== undefined && args.length > 0) copies.push({sources: args, dest})
  }
  return copies
}

/** Paths (relative to the image WORKDIR) that the instructions place a given repo file at. */
function placedAt(copies: readonly CopyInstruction[], file: string): readonly string[] {
  const placements: string[] = []
  for (const copy of copies) {
    const intoDirectory = copy.dest.endsWith('/') || copy.sources.length > 1
    for (const source of copy.sources) {
      const cleaned = posix.normalize(source)
      if (cleaned === file) {
        placements.push(posix.normalize(intoDirectory ? posix.join(copy.dest, basename(file)) : copy.dest))
      } else if (file.startsWith(`${cleaned.replace(/\/$/, '')}/`)) {
        const rest = file.slice(cleaned.replace(/\/$/, '').length + 1)
        placements.push(posix.normalize(posix.join(copy.dest, rest)))
      }
    }
  }
  return placements
}

function workspaceTestStage(): string {
  const dockerfile = readFileSync(WORKSPACE_DOCKERFILE, 'utf8')
  const start = WORKSPACE_TEST_STAGE_START.exec(dockerfile)
  if (start === null) throw new Error('deploy/workspace.Dockerfile has no "FROM build-deps AS workspace-test" stage')
  const afterStart = dockerfile.slice(start.index + start[0].length)
  const nextFrom = /^FROM /m.exec(afterStart)
  return nextFrom === null ? afterStart : afterStart.slice(0, nextFrom.index)
}

describe('root vitest.config.ts', () => {
  const closure = configImportClosure()

  it('includes the config and the home-isolation modules in its local import closure', () => {
    // #given the root config source
    // #when its relative imports and `new URL('./…', import.meta.url)` references are followed transitively
    // #then the closure contains the config itself and the files it is known to pull in
    expect(closure).toEqual(
      expect.arrayContaining([
        'vitest.config.ts',
        SETUP_FILE,
        'scripts/vitest-home-isolation.ts',
        'scripts/vitest-incomplete-run-reporter.ts',
      ]),
    )
  })

  it('still registers the home-isolation setup file in setupFiles', () => {
    // #given the root config source
    const source = readFileSync(ROOT_CONFIG, 'utf8')

    // #when / #then setupFiles points at the isolation setup module (dropping it silently disables isolation)
    expect(/setupFiles:\s*\[[^\]]*vitest-home-isolation\.setup\.ts/.test(source)).toBe(true)
  })

  it('is copied, with every local module it imports, into the workspace-test Docker stage', () => {
    // #given the workspace-test stage of the workspace Dockerfile
    const copies = parseCopies(workspaceTestStage())

    // #when each file in the config's import closure is looked up in the stage's COPY instructions
    const missing = closure.filter(file => !placedAt(copies, file).includes(file))

    // #then every file lands at its repo-relative path inside the image; a gap breaks `--config ../../vitest.config.ts`
    expect(missing).toEqual([])
  })
})
