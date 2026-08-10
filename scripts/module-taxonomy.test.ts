import {readdir, readFile as readFileFromDisk} from 'node:fs/promises'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'

/** Closed taxonomy for the `module:` field in docs/solutions frontmatter. */
export const MODULE_TAXONOMY = [
  'gateway',
  'runtime',
  'harness-release',
  'workspace',
  'agent-execution',
  'response-delivery',
  'event-routing',
  'delegated-work',
  'setup',
  'ci-workflows',
  'build-tooling',
  'evals',
  'deploy',
  'release-notes',
  'development-workflow',
  'documentation',
  'dependency-management',
] as const

type CanonicalModule = (typeof MODULE_TAXONOMY)[number]

export interface ModuleTaxonomyDocument {
  readonly file: string
  readonly content: string
}

function isCanonicalModule(value: string): value is CanonicalModule {
  return (MODULE_TAXONOMY as readonly string[]).includes(value)
}

function parseModuleValue(content: string): string | null {
  const start = /^---\r?\n/.exec(content)
  if (start == null) return null

  const frontmatter = content.slice(start[0].length)
  const end = /\r?\n---(?:\r?\n|$)/.exec(frontmatter)
  if (end == null) return null

  const moduleLine = frontmatter
    .slice(0, end.index)
    .split(/\r?\n/)
    .find(line => /^module:\s*/.test(line))
  if (moduleLine == null) return null

  const rawValue = moduleLine.slice('module:'.length).trim()
  if (rawValue.length >= 2) {
    const first = rawValue[0]
    const last = rawValue.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return rawValue.slice(1, -1)
  }
  return rawValue
}

export function validateModuleTaxonomy(documents: readonly ModuleTaxonomyDocument[]): readonly string[] {
  const violations: string[] = []
  const usedModules = new Set<string>()

  for (const document of documents) {
    const module = parseModuleValue(document.content)
    if (module == null) {
      violations.push(`${document.file}: missing module:`)
      continue
    }

    if (isCanonicalModule(module)) {
      usedModules.add(module)
    } else {
      violations.push(`${document.file}: invalid module '${module}'`)
    }
  }

  for (const module of MODULE_TAXONOMY) {
    if (usedModules.has(module) === false) violations.push(`canonical module '${module}' is unused`)
  }

  return violations
}

async function collectMarkdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const files: string[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(path)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path)
    }
  }

  return files
}

function documentForModule(file: string, module: string): ModuleTaxonomyDocument {
  return {file, content: `---\nmodule: ${module}\n---\n`}
}

describe('validateModuleTaxonomy', () => {
  it('reports an invalid module with the offending file and value', () => {
    // #given a solution document that invents a taxonomy value
    const violations = validateModuleTaxonomy([documentForModule('docs/invented.md', 'invented-module')])

    // #when / #then
    expect(violations).toContain("docs/invented.md: invalid module 'invented-module'")
  })

  it('reports a missing module field with the offending file', () => {
    // #given a solution document without a module field
    const violations = validateModuleTaxonomy([{file: 'docs/missing.md', content: '---\ntitle: Missing\n---\n'}])

    // #when / #then
    expect(violations).toContain('docs/missing.md: missing module:')
  })

  it('reports a canonical value that is no longer used', () => {
    // #given documents covering every canonical value except evals
    const documents = MODULE_TAXONOMY.filter(module => module !== 'evals').map(module =>
      documentForModule(`docs/${module}.md`, module),
    )

    // #when
    const violations = validateModuleTaxonomy(documents)

    // #then
    expect(violations).toContain("canonical module 'evals' is unused")
  })
})

describe('docs/solutions module taxonomy', () => {
  it('keeps every solution document inside the canonical taxonomy', async () => {
    // #given every Markdown solution document on disk
    const root = process.cwd()
    const paths = await collectMarkdownFiles(join(root, 'docs/solutions'))
    const documents = await Promise.all(
      paths.map(async path => ({
        file: relative(root, path),
        content: await readFileFromDisk(path, 'utf8'),
      })),
    )

    // #when
    const violations = validateModuleTaxonomy(documents)

    // #then
    expect(violations.join('\n')).toBe('')
  })
})
