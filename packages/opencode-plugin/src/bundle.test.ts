/**
 * Shape of the built plugin: what `dist/` may import, and how the entry reaches the lazy tracing chunk.
 *
 * The `dist/` cases skip when the package is not built, like the real-binary suite. A plain `bun run test` does not build
 * the plugin, so they run where a build precedes the tests: the release workflow builds, then runs this file with
 * `FRO_BOT_REQUIRE_PLUGIN_BUNDLE=1`, which turns a missing `dist/` into a failure instead of a skip. The release
 * workflow's inline import check applies the same rules to what is about to be published.
 */

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(packageDir, 'dist')
const ENTRY = 'index.mjs'
const FORBIDDEN_NODE_MODULES = ['node:child_process', 'node:vm', 'node:worker_threads']
const required = process.env.FRO_BOT_REQUIRE_PLUGIN_BUNDLE === '1'
const built = existsSync(path.join(distDir, ENTRY))

interface Imports {
  /** `import x from 'a'`, `export … from 'a'` and `import 'a'`. */
  readonly static: readonly string[]
  /** `import('a')`. */
  readonly dynamic: readonly string[]
  /** `require('a')`: never expected in an ES module bundle. */
  readonly required: readonly string[]
}

/** Every module specifier a built file names, by how it is reached. */
export function scanImports(source: string): Imports {
  const take = (pattern: RegExp): string[] => [...source.matchAll(pattern)].map(match => match[1] ?? '')
  return {
    // Anchored to the start of a line: the bundler writes top-level imports and re-exports there, and an unanchored
    // `from "x"` also matches prose inside string literals and comments.
    static: [
      ...take(/^(?:import|export)\s[^"'`;]*\sfrom\s*["']([^"']+)["']/gm),
      // A bare side-effect import: `import "a"` (not `import("a")`, which has a parenthesis).
      ...take(/^import\s*["']([^"']+)["']/gm),
    ],
    dynamic: take(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    required: take(/(?<![\w$.])(?:__)?require\(\s*["']([^"']+)["']\s*\)/g),
  }
}

/** The packages the host provides, plus `node:` built-ins. Anything else must be inlined by the bundler. */
export function isHostProvided(specifier: string): boolean {
  return (
    specifier === 'effect' ||
    specifier.startsWith('effect/') ||
    specifier === '@opencode/plugin' ||
    specifier.startsWith('@opencode/plugin/') ||
    specifier.startsWith('node:')
  )
}

describe('scanImports', () => {
  it('tells static, dynamic and required specifiers apart', () => {
    // #given a source using each form
    const source = [
      'import {a} from "node:fs"',
      'import "node:path"',
      'export {b} from "effect"',
      'const m = await import("./tracing-abc.mjs")',
      'const c = __require("child_process")',
      'const note = "imported from \'somewhere\' in prose"',
    ].join('\n')

    // #when scanned
    const found = scanImports(source)

    // #then each form lands in its own list
    expect(found.static).toEqual(expect.arrayContaining(['node:fs', 'node:path', 'effect']))
    expect(found.dynamic).toEqual(['./tracing-abc.mjs'])
    expect(found.required).toEqual(['child_process'])
  })

  it('does not accept a bare Node built-in or an SDK package as host-provided', () => {
    // #given / #when / #then
    expect(isHostProvided('node:http')).toBe(true)
    expect(isHostProvided('effect/Effect')).toBe(true)
    expect(isHostProvided('@opencode/plugin')).toBe(true)
    expect(isHostProvided('fs')).toBe(false)
    expect(isHostProvided('child_process')).toBe(false)
    expect(isHostProvided('@opentelemetry/api')).toBe(false)
    expect(isHostProvided('effectful')).toBe(false)
  })
})

describe('the lazy boundary in the sources', () => {
  const sourceDir = path.join(packageDir, 'src')
  const staticTracingImports = (file: string): string[] =>
    scanImports(readFileSync(path.join(sourceDir, file), 'utf8')).static.filter(specifier =>
      specifier.includes('/tracing/'),
    )

  it('lets only the settings module be imported statically from outside the tracing directory', () => {
    // #given the files that make up the plugin's eager graph
    // #when / #then they import tracing code statically only through `settings.js`, which decides whether to load the rest
    expect(staticTracingImports('index.ts')).toEqual([])
    expect(staticTracingImports('setup.ts')).toEqual(['./tracing/settings.js'])
  })

  it('keeps the settings module free of the SDK and of the rest of the tracing code', () => {
    // #given the settings module
    const imports = scanImports(readFileSync(path.join(sourceDir, 'tracing/settings.ts'), 'utf8'))

    // #when / #then it imports only Node built-ins
    expect(imports.static.filter(specifier => !specifier.startsWith('node:'))).toEqual([])
  })
})

describe('the built plugin', () => {
  it.runIf(required)('is present when the build is required', () => {
    // #given the release workflow set the flag
    // #when / #then a missing build is a failure, not a skip
    expect(built).toBe(true)
  })

  describe.skipIf(!built)('dist/', () => {
    const files = built ? readdirSync(distDir).filter(file => file.endsWith('.mjs')) : []
    const read = (file: string): string => readFileSync(path.join(distDir, file), 'utf8')
    const chunks = files.filter(file => file !== ENTRY)

    it('has an entry that imports only what the host provides', () => {
      // #given the entry file
      const imports = scanImports(read(ENTRY))

      // #when / #then it names no relative file statically and nothing the host does not provide
      expect(imports.static.filter(specifier => !isHostProvided(specifier))).toEqual([])
      expect(imports.static).toContain('@opencode/plugin')
      expect(imports.required).toEqual([])
    })

    it('reaches the tracing chunk only through a dynamic import', () => {
      // #given the entry file
      const imports = scanImports(read(ENTRY))

      // #when / #then exactly one relative specifier is reached, dynamically, and it is an emitted tracing chunk
      const relative = imports.dynamic.filter(specifier => specifier.startsWith('./'))
      expect(relative).toHaveLength(1)
      expect(relative[0]).toMatch(/^\.\/tracing-[\w-]+\.mjs$/)
      expect(chunks).toContain(relative[0]?.slice(2))
      expect(imports.dynamic.filter(specifier => !specifier.startsWith('./'))).toEqual([])
    })

    it('emits the SDK in chunks whose imports pass the same allowlist and avoid process and thread modules', () => {
      // #given every emitted chunk
      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) {
        const imports = scanImports(read(chunk))
        const all = [...imports.static, ...imports.dynamic]

        // #when / #then it imports only host-provided or `node:` modules, or a regular file inside dist
        const unexpected = all.filter(specifier => {
          if (isHostProvided(specifier)) return false
          if (!specifier.startsWith('./')) return true
          const target = path.resolve(distDir, specifier)
          return !target.startsWith(`${distDir}${path.sep}`) || !existsSync(target) || !statSync(target).isFile()
        })
        expect({chunk, unexpected}).toEqual({chunk, unexpected: []})
        expect({chunk, forbidden: all.filter(specifier => FORBIDDEN_NODE_MODULES.includes(specifier))}).toEqual({
          chunk,
          forbidden: [],
        })
        expect({chunk, required: imports.required}).toEqual({chunk, required: []})
      }
    })

    it('keeps the settings decision in the entry and out of the lazy chunks', () => {
      // #given the launcher variable's name, which only the eager settings module owns
      const name = 'OPENCODE_FROBOT_TRACING'

      // #when / #then the entry holds it and no chunk does
      expect(read(ENTRY)).toContain(name)
      for (const chunk of chunks)
        expect({chunk, holdsLauncher: read(chunk).includes(name)}).toEqual({chunk, holdsLauncher: false})
    })

    it('names no forbidden Node module in any emitted file, however it is spelled', () => {
      // #given every emitted JavaScript file, entry included
      for (const file of files) {
        const source = read(file)

        // #when / #then none of the process, VM or thread modules appears with or without the `node:` prefix
        for (const name of FORBIDDEN_NODE_MODULES) {
          const bare = name.slice('node:'.length)
          expect({file, name, found: new RegExp(`["']${name}["']|["']${bare}["']`).test(source)}).toEqual({
            file,
            name,
            found: false,
          })
        }
      }
    })
  })
})
