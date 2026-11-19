/**
 * Shape of the built plugin: what `dist/` may import, and how the entry reaches the lazy tracing chunk.
 *
 * The `dist/` cases skip when the package is not built, like the real-binary suite. A plain `bun run test` does not build
 * the plugin, so they run where a build precedes the tests: the release workflow builds, then runs this file with
 * `FRO_BOT_REQUIRE_PLUGIN_BUNDLE=1`, which turns a missing `dist/` into a failure instead of a skip. The release
 * workflow's inline import check applies the same rules to what is about to be published.
 */

import type {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
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

/**
 * The ways code can load or evaluate something that the import scan above cannot see. A textual deny over every emitted
 * file, not a parser: it fails closed (a comment or string that spells one is flagged too, and has to be reworded).
 * The release workflow's inline check carries the same list; `the release workflow's check` below runs that script on the
 * same fixtures so the two cannot drift.
 */
export const LOADING_PRIMITIVES: readonly {readonly name: string; readonly pattern: RegExp}[] = [
  // A dynamic import whose argument is not a plain string literal: the scan only knows `import("./x.mjs")`.
  {name: 'dynamic import with a non-literal argument', pattern: /\bimport\s*\((?!\s*["'][^"'\n]*["']\s*\))/},
  {name: 'createRequire', pattern: /\bcreateRequire\b/},
  {name: 'import.meta.resolve', pattern: /\bimport\s*\.\s*meta\s*\.\s*resolve\b/},
  {name: 'process.binding or process.dlopen', pattern: /\bprocess\s*(?:\.|\[\s*["'`])\s*(?:binding|dlopen)\b/},
  {name: 'eval', pattern: /\beval\b/},
  {
    name: 'Function constructor',
    pattern: /\bnew\s+Function\b|(?<![\w$.])Function\s*\(|\bconstructor\s*\.\s*constructor\b/,
  },
]

/** The names of the loading primitives a built file contains. */
export function findLoadingPrimitives(source: string): string[] {
  return LOADING_PRIMITIVES.filter(({pattern}) => pattern.test(source)).map(({name}) => name)
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

describe('findLoadingPrimitives', () => {
  it.each([
    ['a computed dynamic import', 'const m = await import(path)', 'dynamic import with a non-literal argument'],
    [
      'a template-literal dynamic import',
      ['await import(`./', '$', '{name}.mjs`)'].join(''),
      'dynamic import with a non-literal argument',
    ],
    ['a concatenated dynamic import', 'await import("./a" + b)', 'dynamic import with a non-literal argument'],
    ['a spaced computed import', 'await import  (  x  )', 'dynamic import with a non-literal argument'],
    ['an import with no argument', 'import()', 'dynamic import with a non-literal argument'],
    ['createRequire', 'import {createRequire} from "node:module"', 'createRequire'],
    ['createRequire renamed', 'import {createRequire as r} from "node:module"', 'createRequire'],
    ['import.meta.resolve', 'const u = import.meta.resolve("x")', 'import.meta.resolve'],
    ['spaced import.meta.resolve', 'import . meta . resolve("x")', 'import.meta.resolve'],
    ['process.binding', 'process.binding("fs")', 'process.binding or process.dlopen'],
    ['process.dlopen', 'process.dlopen(m, f)', 'process.binding or process.dlopen'],
    ['process["binding"]', 'process["binding"]("fs")', 'process.binding or process.dlopen'],
    ["process['dlopen']", "process['dlopen'](m, f)", 'process.binding or process.dlopen'],
    ['eval', 'eval(code)', 'eval'],
    ['indirect eval', '(0, eval)(code)', 'eval'],
    ['globalThis.eval', 'globalThis.eval(code)', 'eval'],
    ['new Function', 'new Function("return 1")', 'Function constructor'],
    ['Function called', 'Function("return 1")()', 'Function constructor'],
    ['constructor.constructor', '(() => {}).constructor.constructor("return 1")', 'Function constructor'],
  ])('flags %s', (_label, source, expected) => {
    // #given / #when / #then
    expect(findLoadingPrimitives(source)).toContain(expected)
  })

  it.each([
    ['a literal dynamic import', 'const m = await import("./tracing-abc.mjs")'],
    ['a literal dynamic import with single quotes and spaces', "await import(  './tracing-abc.mjs'  )"],
    ['import.meta.url', 'const here = import.meta.url'],
    ['a function named like one', 'function evaluate() {} const retrieval = 1'],
    ['a static import', 'import {a} from "node:fs"'],
    ['an object with a Function-like key', 'const o = {Functions: 1, myFunction: 2}'],
    ['process.env', 'process.env.HOME'],
  ])('does not flag %s', (_label, source) => {
    // #given / #when / #then
    expect(findLoadingPrimitives(source)).toEqual([])
  })
})

describe('the release workflow’s check', () => {
  const workflow = readFileSync(path.join(packageDir, '../../.github/workflows/opencode-plugin-release.yaml'), 'utf8')
  /** The step's inline script, dedented: the very text the workflow runs. */
  const script = ((): string => {
    const start = workflow.indexOf("node --input-type=module <<'EOF'\n")
    const body = workflow.slice(start + "node --input-type=module <<'EOF'\n".length)
    const end = body.indexOf('\n          EOF')
    return body
      .slice(0, end)
      .split('\n')
      .map(line => line.slice(10))
      .join('\n')
  })()

  /** Runs the workflow's script over a fixture `dist/`; resolves to its exit status and its `::error::` lines. */
  const check = (files: Readonly<Record<string, string>>): {status: number; errors: string[]} => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plugin-dist-'))
    try {
      mkdirSync(path.join(dir, 'dist'))
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, 'dist', name), text)
      try {
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {cwd: dir, stdio: 'pipe'})
        return {status: 0, errors: []}
      } catch (error) {
        const failed = error as {status?: number; stderr?: Buffer}
        return {
          status: failed.status ?? 1,
          errors: (failed.stderr?.toString('utf8') ?? '').split('\n').filter(line => line.startsWith('::error::')),
        }
      }
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  }

  const ENTRY_OK =
    'import {x} from "@opencode/plugin"\nexport default async () => (await import("./tracing-a.mjs")).start()\n'
  const CHUNK_OK = 'import fs from "node:fs"\nexport const start = () => fs\n'

  it('passes a clean build', () => {
    // #given a build that follows every rule
    // #when / #then
    expect(check({'index.mjs': ENTRY_OK, 'tracing-a.mjs': CHUNK_OK})).toEqual({status: 0, errors: []})
  })

  it('carries the same list as this file, so the two cannot drift', () => {
    // #given the script text
    // #when / #then every pattern this file tests is in it, character for character
    for (const {pattern} of LOADING_PRIMITIVES) expect(script).toContain(pattern.source)
  })

  it.each([
    ['a computed dynamic import', 'export const a = (p) => import(p)\n'],
    ['a template dynamic import', ['export const a = (p) => import(`./', '$', '{p}.mjs`)\n'].join('')],
    ['createRequire', 'import {createRequire} from "node:module"\nexport const r = createRequire(import.meta.url)\n'],
    ['import.meta.resolve', 'export const u = import.meta.resolve("fs")\n'],
    ['process.binding', 'export const b = process.binding("fs")\n'],
    ['process["dlopen"]', 'export const b = process["dlopen"]\n'],
    ['eval', 'export const e = (c) => eval(c)\n'],
    ['indirect eval', 'export const e = (c) => (0, eval)(c)\n'],
    ['new Function', 'export const f = new Function("return 1")\n'],
    ['constructor.constructor', 'export const f = (() => {}).constructor.constructor("return 1")\n'],
  ])('rejects a chunk with %s', (_label, chunk) => {
    // #given a build whose lazy chunk uses a primitive that bypasses the import scan
    const result = check({'index.mjs': ENTRY_OK, 'tracing-a.mjs': `${CHUNK_OK}${chunk}`})

    // #then the build fails and the error names the file
    expect(result.status).toBe(1)
    expect(result.errors.some(line => line.includes('tracing-a.mjs'))).toBe(true)
  })

  it('rejects the same in the entry, not only in a chunk', () => {
    // #given
    const result = check({'index.mjs': `${ENTRY_OK}export const e = (c) => eval(c)\n`, 'tracing-a.mjs': CHUNK_OK})

    // #then
    expect(result.status).toBe(1)
    expect(result.errors.some(line => line.includes('index.mjs'))).toBe(true)
  })

  it('still rejects what it rejected before: a bare import, a static chunk import and a stray file', () => {
    // #given / #when / #then
    expect(check({'index.mjs': ENTRY_OK, 'tracing-a.mjs': 'import fs from "fs"\n'}).status).toBe(1)
    expect(
      check({'index.mjs': 'import "./tracing-a.mjs"\nimport "@opencode/plugin"\n', 'tracing-a.mjs': CHUNK_OK}).status,
    ).toBe(1)
    expect(check({'index.mjs': ENTRY_OK, 'tracing-a.mjs': CHUNK_OK, 'evil.cjs': 'x'}).status).toBe(1)
  })
})

describe('the lazy boundary in the sources', () => {
  const sourceDir = path.join(packageDir, 'src')
  // A type-only import is erased by the build, so it cannot pull tracing code into the entry.
  const withoutTypeImports = (source: string): string => source.replaceAll(/^import type [^\n]*$/gm, '')
  const staticTracingImports = (file: string): string[] =>
    scanImports(withoutTypeImports(readFileSync(path.join(sourceDir, file), 'utf8'))).static.filter(specifier =>
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

    it('contains none of the loading or evaluation primitives that would get around the import scan', () => {
      // #given every emitted JavaScript file, entry included
      for (const file of files) {
        // #when / #then none is present, the SDK's inlined code included
        expect({file, found: findLoadingPrimitives(read(file))}).toEqual({file, found: []})
      }
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
